using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace HmoUpdater
{
    /// <summary>
    /// The install itself, on a worker thread. It touches the screen only
    /// through <see cref="UpdaterWindow"/>'s four setters, and it touches
    /// <c>--install-dir</c> only by <em>measuring</em> it: the helper never
    /// deletes or writes anything in there (spec §5.3). NSIS owns that folder.
    /// </summary>
    internal sealed class Runner
    {
        internal const string ReleasesUrl = "https://github.com/Davide-DevP/halloween-map-overlay/releases/latest";

        // ── The progress mapping ────────────────────────────────────────────
        //
        // This is what `"<installer>" /S --updated --force-run` does to the
        // install directory, in order:
        //
        //   1. CHECK_APP_RUNNING closes the app.                    size = S0
        //   2. uninstallOldVersion runs the old uninstaller.        S0 → 0
        //   3. `File /oname=$PLUGINSDIR\app-64.7z` writes the whole
        //      payload into %TEMP%, then Nsis7z::Extract unpacks it
        //      into $PLUGINSDIR\7z-out.                             size = 0
        //   4. CopyFiles $PLUGINSDIR\7z-out\* → $INSTDIR.           0 → S0
        //
        // **Measured** on the 0.5.0 test product (562 MB installed, a 292 MB
        // installer), by sampling the install directory every 400 ms while a
        // real uninstall and a real install ran:
        //
        //   uninstall  full for 6.6 s, then 562 MB → 0 in under one sample.
        //              It is a *cliff*, not a ramp: NSIS deletes the tree with
        //              one RMDir /r, which on NTFS is a metadata operation.
        //   install    0 for the first 6.1 s (all of step 3), then
        //              6.5 s: 47 KB · 10.2 s: 260 MB · 10.6 s: 559 MB ·
        //              11.0 s: 562 MB. The copy is ~4.5 s of the 11.
        //
        // At the idle priority the helper runs the installer at, the same work
        // took 27.4 s end to end (installer-started → installer-exit in a real
        // helper-driven run), i.e. roughly 2.5x.
        //
        // So **the folder size is useless as a progress source for four fifths
        // of the run**: it is 100 %, then 0, then 100 % again in three samples.
        // Two consequences, both deliberate:
        //
        // - The first two phases are driven by *time*, not by size, and they
        //   approach their ceiling exponentially. An exponential approach never
        //   arrives, so the bar is never once frozen on a value — which is the
        //   thing the spec forbids — and it cannot overrun the phase it is in
        //   however slow the machine is.
        // - Only the copy, the last stretch, is driven by the real measurement,
        //   and it gets the last ~25 % because that is about its share of the
        //   wall clock.
        //
        // The size *is* still what decides which phase we are in: the cliff to
        // zero ends "removing", and the first bytes landing end the stall.
        private const double ClosingPercent = 5;    // installer starting
        private const double RemovedPercent = 20;   // ceiling of the uninstall
        private const double CreepCapPercent = 75;  // ceiling of the %TEMP% unpack
        private const double InstalledPercent = 90; // ceiling of the copy
        // After the copy NSIS still writes shortcuts and the registry and then
        // deletes ~2x the app from %TEMP% (7z-out, old-install) at idle
        // priority. Measured in a real helper-driven update: folder full at
        // 43.6 s, installer exit at 53.2 s - 9.5 s during which a bar parked on
        // its ceiling looks exactly like a hang. So the copy stops at 90 and the
        // tail approaches 99, which it never reaches: never 100 before exit.
        private const double TailCapPercent = 99;
        private static readonly TimeSpan TailTau = TimeSpan.FromSeconds(8);

        /// <summary>
        /// Time constants of the two exponential approaches, chosen so that the
        /// measured phase durations land near the ceiling without touching it:
        /// at the measured 6.6 s the removal shows ~18 % of a 20 % ceiling, and
        /// at a ~13 s idle-priority unpack the stall shows ~62 % of 75 %.
        /// </summary>
        private static readonly TimeSpan RemoveTau = TimeSpan.FromSeconds(3.5);
        private static readonly TimeSpan UnpackTau = TimeSpan.FromSeconds(9);

        /// <summary>
        /// After this long with the folder still full, stop waiting for a
        /// shrink that may never come and move on to the unpack phase. The
        /// measured uninstall is 6.6 s at normal priority; 25 s covers it at
        /// idle priority several times over.
        /// </summary>
        private static readonly TimeSpan RemoveGiveUp = TimeSpan.FromSeconds(25);

        /// <summary>Poll cadence for the folder size. Off the UI thread.</summary>
        private const int PollMs = 400;

        /// <summary>The folder is "growing again" once this much has landed.</summary>
        private const long GrowthBytes = 8 * 1024 * 1024;

        /// <summary>Spec §1.3 — then carry on and let NSIS deal with it.</summary>
        private static readonly TimeSpan PidWait = TimeSpan.FromSeconds(20);

        /// <summary>`&lt;ready-file&gt;.abort` — written by the app when it gave up on
        /// the handshake (`ABORT_SUFFIX` in src/core/update-helper.js).</summary>
        private const string AbortSuffix = ".abort";

        /// <summary>Spec §1.6 — the new app's window.</summary>
        private static readonly TimeSpan RelaunchWait = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan RelaunchSelfStart = TimeSpan.FromSeconds(8);

        /// <summary>Spec §5.4 — the global watchdog.</summary>
        private static readonly TimeSpan Watchdog = TimeSpan.FromMinutes(10);

        private readonly Options _options;
        private readonly Log _log;
        private readonly UpdaterWindow _window;
        private readonly Stopwatch _clock = Stopwatch.StartNew();

        private long _startSize;
        private long _bottomSize = long.MaxValue;
        private bool _growing;
        private double _percent;
        private double _growthBase;
        private double _stallBase;

        internal Runner(Options options, Log log, UpdaterWindow window)
        {
            _options = options;
            _log = log;
            _window = window;
        }

        internal void Start()
        {
            Thread thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "hmo-updater";
            thread.Start();
        }

        private void Run()
        {
            try
            {
                if (_options.Demo) RunDemo();
                else RunReal();
            }
            catch (Exception ex)
            {
                // Rule 4: never a silent exit. Anything unforeseen still lands
                // on a screen the user can read and act on.
                _log.Event("unexpected", "message", ex.Message, "type", ex.GetType().Name);
                Fail("error.installerFailed", "code", "-1");
            }
        }

        // ── The real thing ──────────────────────────────────────────────────

        private void RunReal()
        {
            _log.Event("start",
                "version", _options.Version,
                "lang", _options.Lang,
                "pid", Log.Num(_options.WaitPid),
                "bounds", _options.X + "," + _options.Y + "," + _options.Width + "," + _options.Height);

            // Indeterminate for the whole "closing" phase, because that is
            // exactly what the app's own "updating" view is showing at the
            // moment this window opens on top of it. Starting at a determinate
            // 0 % would put a number and a differently-drawn bar on screen at
            // the instant of the hand-over, which is the one thing this feature
            // exists to avoid.
            _window.SetStep("step.closing");

            _startSize = MeasureInstallDir();
            _log.Event("measured", "bytes", Log.Num(_startSize), "ms", Log.Num(_clock.ElapsedMilliseconds));
            if (_startSize <= 0)
            {
                // No baseline means no honest percentage. The bar keeps moving,
                // it just stops claiming to know how far along it is.
                _log.Event("indeterminate", "reason", "install-dir unreadable or empty");
                _window.ShowIndeterminate();
            }

            WaitForApp();
            if (AbortedByApp())
            {
                // The app timed out on the handshake (this process was slow to
                // start), could not kill us, and has already started the stock
                // installer itself. Starting a second one on top of it is the
                // one thing that must not happen; the update is in the app's
                // hands, so this is the single case where leaving quietly is
                // correct.
                _log.Event("aborted-by-app", "ms", Log.Num(_clock.ElapsedMilliseconds));
                _window.FinishAndClose(3);
                return;
            }
            // The step changes here, *before* the installer is started, because
            // starting it is not instant: on this machine Process.Start on a
            // freshly built unsigned 292 MB installer took 22 s while the
            // antivirus read it. "Closing the app" would be a lie by then, and
            // the bar is still indeterminate, so nothing claims to know more
            // than it does.
            _window.SetStep("step.removing");

            if (!File.Exists(_options.InstallerPath))
            {
                _log.Event("installer-missing");
                Fail("error.installerMissing");
                return;
            }

            Process installer = StartInstaller();
            if (installer == null)
            {
                Fail("error.spawnFailed");
                return;
            }

            // First real number: the installer exists and is running, so from
            // here the bar means something.
            Show(ClosingPercent);
            int exitCode = Track(installer);
            _log.Event("installer-exit", "code", Log.Num(exitCode), "ms", Log.Num(_clock.ElapsedMilliseconds));

            if (exitCode == int.MinValue)
            {
                Fail("error.timeout");
                return;
            }
            if (exitCode != 0)
            {
                Fail("error.installerFailed", "code", exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture));
                return;
            }
            if (!File.Exists(_options.AppExe))
            {
                _log.Event("app-exe-missing");
                Fail("error.appMissing");
                return;
            }

            Show(100);
            _window.SetStep("step.starting");
            WaitForRelaunch();
            _log.Event("done", "ms", Log.Num(_clock.ElapsedMilliseconds));
            _window.FinishAndClose(0);
        }

        /// <summary>
        /// Wait for the app that asked for the update to go away. 20 s and then
        /// on regardless: NSIS has its own app-running check (and the customised
        /// banner text hook around it), so a stuck process is its problem, not
        /// a reason for the helper to hang.
        /// </summary>
        private bool AbortedByApp()
        {
            try
            {
                return !string.IsNullOrEmpty(_options.ReadyFile) && File.Exists(_options.ReadyFile + AbortSuffix);
            }
            catch (Exception)
            {
                return false;
            }
        }

        private void WaitForApp()
        {
            Process app = null;
            try
            {
                app = Process.GetProcessById(_options.WaitPid);
            }
            catch (ArgumentException)
            {
                _log.Event("app-already-gone");
                return;
            }
            catch (Exception ex)
            {
                _log.Event("app-wait-failed", "message", ex.Message);
                return;
            }
            Stopwatch wait = Stopwatch.StartNew();
            try
            {
                using (app)
                {
                    while (wait.Elapsed < PidWait)
                    {
                        if (app.WaitForExit(200)) break;
                    }
                }
            }
            catch (Exception ex)
            {
                // The pid was reused by a process we may not wait on (access
                // denied). That is "the app is gone", not a failed update.
                _log.Event("app-wait-failed", "message", ex.Message);
                return;
            }
            _log.Event("app-closed", "ms", Log.Num(wait.ElapsedMilliseconds),
                "timeout", wait.Elapsed >= PidWait ? "yes" : "no");
        }

        /// <summary>
        /// <c>"&lt;installer&gt;" /S --updated --force-run</c> at
        /// <see cref="ProcessPriorityClass.Idle"/>.
        ///
        /// Idle is not a CPU trick: Windows derives the **I/O** priority from
        /// the priority class, and unpacking ~350 MB with Defender reading every
        /// file is what made the owner's mouse stutter in 0.2.3. Same reasoning
        /// as `spawnInstallerAtLowPriority()` in `src/core/main-window.js` — but
        /// set on the real process rather than through `cmd /c start /LOW`,
        /// because here we need the handle to read the exit code.
        ///
        /// `/S` is the difference from the app's fallback path: the stock NSIS
        /// banner must not appear on top of this window. `--force-run` is what
        /// makes NSIS relaunch the app itself (`installSection.nsh`), and
        /// `--updated` is what `build/installer.nsh` branches its wording on.
        /// </summary>
        private Process StartInstaller()
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(_options.InstallerPath);
                info.Arguments = "/S --updated --force-run";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WorkingDirectory = Path.GetTempPath();
                Process process = Process.Start(info);
                if (process == null)
                {
                    _log.Event("installer-spawn-null");
                    return null;
                }
                try
                {
                    process.PriorityClass = ProcessPriorityClass.Idle;
                }
                catch (Exception ex)
                {
                    // A stuttery update beats no update — exactly the app's own
                    // fallback reasoning.
                    _log.Event("installer-priority-failed", "message", ex.Message);
                }
                _log.Event("installer-started", "pid", Log.Num(process.Id), "ms", Log.Num(_clock.ElapsedMilliseconds));
                return process;
            }
            catch (Exception ex)
            {
                _log.Event("installer-spawn-failed", "message", ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Poll the folder until the installer exits.
        /// Returns its exit code, or <c>int.MinValue</c> if the watchdog fired.
        /// </summary>
        private int Track(Process installer)
        {
            Stopwatch removing = Stopwatch.StartNew();
            Stopwatch bottomedOut = null;
            Stopwatch tail = null;
            double tailBase = 0;
            long lastSize = -1;
            int unchanged = 0;
            long lastLogged = -1;
            using (installer)
            {
                while (true)
                {
                    if (installer.WaitForExit(PollMs)) return installer.ExitCode;
                    if (_clock.Elapsed > Watchdog)
                    {
                        // The installer is deliberately *not* killed: stopping a
                        // half-finished NSIS run is how a user ends up with no
                        // app at all. The error screen offers the old version
                        // and the download page; the install may still land.
                        _log.Event("watchdog", "ms", Log.Num(_clock.ElapsedMilliseconds));
                        return int.MinValue;
                    }

                    long size = MeasureInstallDir();
                    if (size < 0)
                    {
                        _window.ShowIndeterminate();
                        continue;
                    }
                    if (size != lastLogged)
                    {
                        // The curve, straight into the log — this is the data
                        // the mapping above was tuned from, and the only way to
                        // retune it after a change to the installer.
                        _log.Event("size", "bytes", Log.Num(size), "ms", Log.Num(_clock.ElapsedMilliseconds));
                        lastLogged = size;
                    }
                    if (_startSize <= 0) continue;

                    if (size < _bottomSize) _bottomSize = size;
                    if (!_growing && size > _bottomSize + GrowthBytes && size > _startSize / 50)
                    {
                        _growing = true;
                        _growthBase = _percent;
                        _window.SetStep("step.installing");
                        _log.Event("growing", "base", Log.Num(_growthBase), "ms", Log.Num(_clock.ElapsedMilliseconds));
                    }

                    if (_growing)
                    {
                        // Continue from wherever the creep reached, so there is
                        // no jump in either direction at the hand-over.
                        double share = Math.Min(1.0, (double)size / _startSize);
                        unchanged = size == lastSize ? unchanged + 1 : 0;
                        lastSize = size;
                        // The copy is over when the folder is as big as it was,
                        // or (a smaller new version) has stopped growing.
                        if (tail == null && (share >= 0.98 || unchanged >= 3))
                        {
                            tail = Stopwatch.StartNew();
                            tailBase = Math.Max(_percent, _growthBase + (InstalledPercent - _growthBase) * share);
                            _log.Event("copied", "ms", Log.Num(_clock.ElapsedMilliseconds), "percent", Log.Num(tailBase));
                        }
                        if (tail != null) Show(Approach(tailBase, TailCapPercent, tail.Elapsed, TailTau));
                        else Show(_growthBase + (InstalledPercent - _growthBase) * share);
                        continue;
                    }

                    // Still more than a fiftieth of the old version on disk:
                    // the uninstaller has not finished. Measured, this stays
                    // exactly at S0 for ~6.6 s and then drops to 0 between two
                    // polls, so there is nothing here to map a bar onto — the
                    // bar is driven by the clock instead.
                    //
                    // `RemoveGiveUp` is not paranoia. NSIS only uninstalls the
                    // old version if it can read an UninstallString out of the
                    // registry, and an install whose registry entry never got
                    // written (a security product dropped it — seen on the
                    // development machine, see docs/agents/updater-and-installer.md)
                    // simply overwrites the
                    // files in place: the folder never shrinks at all. Without
                    // this the bar would asymptote at 20 % and sit there for the
                    // whole install, which is precisely the "frozen bar" the
                    // spec rules out.
                    if (size > _startSize / 50 && removing.Elapsed < RemoveGiveUp)
                    {
                        Show(Approach(ClosingPercent, RemovedPercent, removing.Elapsed, RemoveTau));
                        continue;
                    }

                    // The old version is gone and nothing has landed yet: NSIS
                    // is writing the payload into %TEMP% and unpacking it there.
                    // Nothing about that is visible in this folder.
                    if (bottomedOut == null)
                    {
                        bottomedOut = Stopwatch.StartNew();
                        // Where the second curve starts from is captured once:
                        // feeding it the *current* percentage every poll would
                        // make it converge in two ticks.
                        _stallBase = Math.Max(RemovedPercent, _percent);
                        _window.SetStep("step.installing");
                        _log.Event("removed", "ms", Log.Num(_clock.ElapsedMilliseconds),
                            "percent", Log.Num(_stallBase));
                    }
                    Show(Approach(_stallBase, CreepCapPercent, bottomedOut.Elapsed, UnpackTau));
                }
            }
        }

        /// <summary>
        /// NSIS relaunches the app itself (`--force-run` → `StartApp` →
        /// `${StdUtils.ExecShellAsUser}`), so normally there is nothing to do
        /// but watch for the window. If nothing has appeared after 8 s we start
        /// it ourselves; the app's single-instance lock makes a duplicate
        /// harmless (the second copy hands over and quits).
        /// </summary>
        private void WaitForRelaunch()
        {
            Stopwatch wait = Stopwatch.StartNew();
            bool selfStarted = false;
            while (wait.Elapsed < RelaunchWait)
            {
                if (HasVisibleWindow(_options.AppExe))
                {
                    _log.Event("app-window", "ms", Log.Num(wait.ElapsedMilliseconds),
                        "selfStarted", selfStarted ? "yes" : "no");
                    return;
                }
                if (!selfStarted && wait.Elapsed > RelaunchSelfStart)
                {
                    selfStarted = true;
                    try
                    {
                        // With `--updated`, exactly like NSIS's own StartApp: if
                        // the app *is* already starting and merely has no window
                        // yet, a second launch with no arguments puts up the
                        // "already running" message box (index.js); one with an
                        // argument hands over and quits silently.
                        Process.Start(_options.AppExe, "--updated");
                        _log.Event("app-start-self");
                    }
                    catch (Exception ex)
                    {
                        _log.Event("app-start-self-failed", "message", ex.Message);
                    }
                }
                Thread.Sleep(250);
            }
            // Not an error: the app may simply be slow on a cold, Defender-happy
            // disk. The exe exists and the install succeeded, so the helper's
            // job is done either way.
            _log.Event("app-window-timeout", "selfStarted", selfStarted ? "yes" : "no");
        }

        private static bool HasVisibleWindow(string exePath)
        {
            string name;
            try
            {
                name = Path.GetFileNameWithoutExtension(exePath);
            }
            catch (Exception)
            {
                return false;
            }
            Process[] all;
            try
            {
                all = Process.GetProcessesByName(name);
            }
            catch (Exception)
            {
                return false;
            }
            try
            {
                foreach (Process process in all)
                {
                    try
                    {
                        // Electron runs several processes under one exe name;
                        // only the browser process has a main window.
                        if (process.MainWindowHandle == IntPtr.Zero) continue;
                        string file = process.MainModule.FileName;
                        if (string.Equals(file, exePath, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    catch (Exception)
                    {
                        // Access denied on a process we do not own, or it exited
                        // between the enumeration and the read.
                    }
                }
            }
            finally
            {
                foreach (Process process in all)
                {
                    try
                    {
                        process.Dispose();
                    }
                    catch (Exception)
                    {
                    }
                }
            }
            return false;
        }

        // ── Measuring ───────────────────────────────────────────────────────

        /// <summary>
        /// Total bytes under <c>--install-dir</c>, or -1 when the folder cannot
        /// be read at all (which turns the bar indeterminate). A folder that is
        /// simply *not there* is 0, not an error: that is the normal state
        /// between the uninstall and the copy.
        ///
        /// Files vanish under the enumeration while the uninstaller works, so
        /// every single read is allowed to fail on its own.
        /// </summary>
        private long MeasureInstallDir()
        {
            string root = _options.InstallDir;
            if (string.IsNullOrEmpty(root)) return -1;
            if (!Directory.Exists(root)) return 0;
            long total = 0;
            Stack<string> stack = new Stack<string>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                string dir = stack.Pop();
                try
                {
                    foreach (string file in Directory.GetFiles(dir))
                    {
                        try
                        {
                            total += new FileInfo(file).Length;
                        }
                        catch (Exception)
                        {
                        }
                    }
                    foreach (string child in Directory.GetDirectories(dir)) stack.Push(child);
                }
                catch (DirectoryNotFoundException)
                {
                    // The uninstaller removed it between two polls — 0 bytes,
                    // which is the truth, not a failure to read.
                    if (dir == root) return 0;
                }
                catch (Exception)
                {
                    if (dir == root) return -1;
                }
            }
            return total;
        }

        // ── Screen ──────────────────────────────────────────────────────────

        /// <summary>
        /// An exponential approach from <paramref name="from"/> towards
        /// <paramref name="to"/>: `to - (to - from) * e^(-t/tau)`.
        ///
        /// It never arrives, which is the point. A linear creep with a cap
        /// stops dead the moment it reaches the cap, and a bar that has not
        /// moved in twenty seconds is what a hang looks like; this one keeps
        /// moving however long the phase lasts, just more and more slowly, and
        /// it can never overshoot into the next phase's range.
        /// </summary>
        private static double Approach(double from, double to, TimeSpan elapsed, TimeSpan tau)
        {
            double t = elapsed.TotalMilliseconds / tau.TotalMilliseconds;
            return to - (to - from) * Math.Exp(-t);
        }

        /// <summary>Monotonic by construction; the window enforces it again.</summary>
        private void Show(double percent)
        {
            if (percent < _percent) percent = _percent;
            _percent = percent;
            _window.SetPercent(percent);
        }

        private void Fail(string key)
        {
            Fail(key, null, null);
        }

        private void Fail(string key, string param, string value)
        {
            string sentence = param == null
                ? Strings.Get(_options.Lang, key)
                : Strings.Get(_options.Lang, key, param, value);
            _log.Event("failed", "reason", key);
            // After the watchdog the installer is still alive (it is never
            // killed) and may be half-way through replacing the files: offering
            // to reopen the app then would start an exe NSIS is about to delete.
            string relaunch = key == "error.timeout" ? null : Relaunchable();
            _log.Event("error-state", "relaunch", string.IsNullOrEmpty(relaunch) ? "no" : "yes");
            _window.ShowError(sentence, relaunch, key == "error.timeout" ? "error.timeoutHint" : null);
        }

        /// <summary>
        /// The app exe, but only if starting it would actually do something.
        ///
        /// `File.Exists(appExe)` is **not** enough, and this is measured rather
        /// than argued: an installer killed while `CopyFiles` was running left
        /// the 214 MB executable on disk and `resources\` still missing, and
        /// launching it did nothing at all — the process started and exited
        /// before a window appeared. A *Close and reopen the app* button that
        /// silently does nothing is worse than no button. `app.asar` is the
        /// file that makes an Electron install runnable, so that is what is
        /// checked; when it is gone the error screen says the installation has
        /// to be finished from the download page instead.
        /// </summary>
        private string Relaunchable()
        {
            try
            {
                if (string.IsNullOrEmpty(_options.AppExe) || !File.Exists(_options.AppExe)) return null;
                string dir = Path.GetDirectoryName(_options.AppExe);
                if (string.IsNullOrEmpty(dir)) return null;
                if (!File.Exists(Path.Combine(dir, "resources\\app.asar"))) return null;
                return _options.AppExe;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ── Demo ────────────────────────────────────────────────────────────

        /// <summary>
        /// A ~12 s simulation of the real curve above, for screenshots and for
        /// looking at the thing without building two installers. No installer
        /// is started and no folder is measured.
        /// </summary>
        private void RunDemo()
        {
            _log.Event("demo-start", "fail", _options.DemoFail ? "yes" : "no", "lang", _options.Lang);
            // Indeterminate first, exactly like the real run, then the same two
            // exponential approaches and the same size-driven tail — sped up so
            // the whole thing is ~12 s instead of ~30.
            _window.SetStep("step.closing");
            Thread.Sleep(1500);

            _window.SetStep("step.removing");
            Curve(ClosingPercent, RemovedPercent, 2600, TimeSpan.FromSeconds(1.4));

            _window.SetStep("step.installing");
            if (_options.DemoFail)
            {
                Curve(RemovedPercent, CreepCapPercent, 2000, TimeSpan.FromSeconds(3.5));
                Fail("error.installerFailed", "code", "2");
                return;
            }
            Curve(RemovedPercent, CreepCapPercent, 4000, TimeSpan.FromSeconds(3.5));
            Ramp(_percent, InstalledPercent, 2400);
            Show(100);
            _window.SetStep("step.starting");
            Thread.Sleep(1400);
            _window.FinishAndClose(0);
        }

        private void Ramp(double from, double to, int ms)
        {
            int steps = Math.Max(1, ms / PollMs);
            for (int i = 1; i <= steps; i++)
            {
                Show(from + (to - from) * i / steps);
                Thread.Sleep(PollMs);
            }
        }

        /// <summary>The demo's version of <see cref="Approach"/>.</summary>
        private void Curve(double from, double to, int ms, TimeSpan tau)
        {
            Stopwatch clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < ms)
            {
                Show(Approach(from, to, clock.Elapsed, tau));
                Thread.Sleep(PollMs);
            }
        }
    }
}
