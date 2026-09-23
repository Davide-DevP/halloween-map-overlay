using System;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace HmoUpdater
{
    /// <summary>
    /// <c>hmo-updater.exe</c> — the themed face of a self-update.
    ///
    /// It shows the app's loading screen while the NSIS installer does the
    /// actual work, and it exists for exactly one reason: on the happy path the
    /// user never sees a Windows installer, only one continuous picture from
    /// the app's "updating" view to the new version's loading overlay.
    ///
    /// It is deliberately unimportant. It makes no network request, writes
    /// nothing inside the install directory, never elevates, and the app it was
    /// launched from refuses to quit until this process has proved it is on
    /// screen (the ready-file). Every way this can fail leaves the app on the
    /// old, working version — see docs/SPEC-UPDATER.md §5.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        internal static int Main(string[] args)
        {
            Options options = Options.Parse(args);
            if (options.Error != null)
            {
                // Exit 2 *before* anything is drawn. A window that appears and
                // then dies is worse than no window: the app would have taken
                // the ready-file as proof and quit.
                Console.Error.WriteLine("hmo-updater: " + options.Error);
                if (!string.IsNullOrEmpty(options.LogPath))
                {
                    try
                    {
                        new Log(options.LogPath).Event("bad-arguments", "message", options.Error);
                    }
                    catch (Exception)
                    {
                    }
                }
                return 2;
            }

            Log log = new Log(options.LogPath);
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            UpdaterWindow window = new UpdaterWindow(options, log);
            // Never take focus from a game. The app tells us whether its own
            // window was focused; when it was not (tray, or the player is in a
            // match) the helper appears without activating.
            window.ShowActivated = !options.NoActivate;

            // Anything that escapes on the UI thread still has to end on a
            // screen the user can act on, not in a WPF crash dialog.
            app.DispatcherUnhandledException += delegate (object sender, DispatcherUnhandledExceptionEventArgs e)
            {
                log.Event("dispatcher-exception", "message", e.Exception.Message, "type", e.Exception.GetType().Name);
                e.Handled = true;
            };

            // The handshake. The app is still alive, showing an identical
            // picture, and it quits only once this file appears — which is what
            // makes an antivirus block or a crashed helper harmless: no file,
            // no quit, stock installer path instead
            // (src/core/update-helper.js). `Ready` fires after the first frame
            // and the fade-in, never before.
            window.Ready += delegate { WriteReadyFile(options, log); };
            window.Show();

            if (!string.IsNullOrEmpty(options.ScreenshotPath))
            {
                ScheduleScreenshot(window, options, log);
            }

            new Runner(options, log, window).Start();
            return app.Run();
        }

        private static void WriteReadyFile(Options options, Log log)
        {
            if (string.IsNullOrEmpty(options.ReadyFile)) return;
            try
            {
                string dir = Path.GetDirectoryName(options.ReadyFile);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(options.ReadyFile, "ready\r\n");
                log.Event("ready-file", "ok", "yes");
            }
            catch (Exception ex)
            {
                // The app will time out after 15 s and use the stock installer.
                // That is the designed outcome, so it is a log line, not a
                // reason to stop: if the app does quit anyway the helper is
                // still the best thing on screen.
                log.Event("ready-file", "ok", "no", "message", ex.Message);
            }
        }

        /// <summary>
        /// Debug: render the window to a PNG and exit.
        ///
        /// A real screen capture picks up the DWM corners and shadow but needs
        /// the window to be visible and unobstructed; this one is deterministic
        /// and works from a script. Both were used — see docs/BUILD.md.
        /// </summary>
        private static void ScheduleScreenshot(UpdaterWindow window, Options options, Log log)
        {
            DispatcherTimer timer = new DispatcherTimer();
            timer.Interval = TimeSpan.FromMilliseconds(Math.Max(120, options.ScreenshotAfterMs));
            timer.Tick += delegate
            {
                timer.Stop();
                try
                {
                    int width = (int)Math.Round(window.ActualWidth);
                    int height = (int)Math.Round(window.ActualHeight);
                    RenderTargetBitmap target = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
                    target.Render(window);
                    PngBitmapEncoder encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(target));
                    string dir = Path.GetDirectoryName(options.ScreenshotPath);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    using (FileStream stream = File.Create(options.ScreenshotPath))
                    {
                        encoder.Save(stream);
                    }
                    log.Event("screenshot", "ok", "yes", "path", options.ScreenshotPath);
                }
                catch (Exception ex)
                {
                    log.Event("screenshot", "ok", "no", "message", ex.Message);
                }
                Application.Current.Shutdown(0);
            };
            timer.Start();
        }
    }
}
