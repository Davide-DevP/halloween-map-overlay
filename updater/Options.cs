using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace HmoUpdater
{
    /// <summary>
    /// The command line. Built by <c>src/core/update-helper.js</c>
    /// (<c>buildUpdaterArgs</c>) — the two sides have to agree exactly, so the
    /// switch names live in one place on each side and nowhere else.
    ///
    /// Nothing here touches the screen: a bad command line is a log line and
    /// exit code 2, *before* a window appears. A helper that puts up a window
    /// and then dies is worse than one that never showed — the app quits only
    /// after the ready-file appears, and the ready-file is written after the
    /// window is up.
    /// </summary>
    internal sealed class Options
    {
        internal string InstallerPath;
        internal string InstallDir;
        internal string AppExe;
        internal string Version;
        internal string Lang;
        internal int WaitPid;
        internal int X, Y, Width, Height;
        internal string LogPath;
        internal string ReadyFile;

        /// <summary>Simulated run, no installer, for screenshots.</summary>
        internal bool Demo;

        /// <summary>Simulated run that ends in the error state.</summary>
        internal bool DemoFail;

        /// <summary>
        /// The app window was not focused (or is hidden in the tray), so the
        /// helper must not steal focus — the user may be in a game.
        /// </summary>
        internal bool NoActivate;

        /// <summary>
        /// Debug: render the window with RenderTargetBitmap to this PNG and
        /// exit. Documented in docs/BUILD.md; it is how the design was
        /// iterated against the app's own loading overlay.
        /// </summary>
        internal string ScreenshotPath;

        /// <summary>How long to let the demo run before the screenshot.</summary>
        internal int ScreenshotAfterMs;

        /// <summary>Why parsing failed; null when it did not.</summary>
        internal string Error;

        /// <summary>Smallest window that still reads as the app's loading screen.</summary>
        internal const int MinWidth = 560;
        internal const int MinHeight = 380;

        private Options()
        {
            Lang = "en";
            WaitPid = 0;
            Width = MinWidth;
            Height = MinHeight;
        }

        internal static Options Parse(string[] args)
        {
            Options o = new Options();
            string bounds = null;
            if (args == null) args = new string[0];

            for (int i = 0; i < args.Length; i++)
            {
                string key = args[i];
                switch (key)
                {
                    case "--demo": o.Demo = true; continue;
                    case "--demo-fail": o.Demo = true; o.DemoFail = true; continue;
                    case "--no-activate": o.NoActivate = true; continue;
                }
                // Everything else takes a value.
                if (i + 1 >= args.Length)
                {
                    o.Error = "missing value for " + key;
                    return o;
                }
                string value = args[++i];
                switch (key)
                {
                    case "--installer": o.InstallerPath = value; break;
                    case "--install-dir": o.InstallDir = value; break;
                    case "--app-exe": o.AppExe = value; break;
                    case "--version": o.Version = value; break;
                    case "--lang": o.Lang = value; break;
                    case "--log": o.LogPath = value; break;
                    case "--ready-file": o.ReadyFile = value; break;
                    case "--bounds": bounds = value; break;
                    case "--screenshot": o.ScreenshotPath = value; break;
                    case "--screenshot-after":
                        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out o.ScreenshotAfterMs))
                        {
                            o.Error = "--screenshot-after is not a number: " + value;
                            return o;
                        }
                        break;
                    case "--wait-pid":
                        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out o.WaitPid))
                        {
                            o.Error = "--wait-pid is not a number: " + value;
                            return o;
                        }
                        break;
                    default:
                        o.Error = "unknown argument " + key;
                        return o;
                }
            }

            if (o.Lang != "en" && o.Lang != "it") o.Lang = "en";

            if (!o.Demo)
            {
                List<string> missing = new List<string>();
                if (string.IsNullOrEmpty(o.InstallerPath)) missing.Add("--installer");
                if (string.IsNullOrEmpty(o.InstallDir)) missing.Add("--install-dir");
                if (string.IsNullOrEmpty(o.AppExe)) missing.Add("--app-exe");
                if (string.IsNullOrEmpty(o.Version)) missing.Add("--version");
                if (string.IsNullOrEmpty(o.LogPath)) missing.Add("--log");
                if (string.IsNullOrEmpty(o.ReadyFile)) missing.Add("--ready-file");
                if (bounds == null) missing.Add("--bounds");
                if (o.WaitPid <= 0) missing.Add("--wait-pid");
                if (missing.Count > 0)
                {
                    o.Error = "missing required argument(s): " + string.Join(", ", missing.ToArray());
                    return o;
                }
            }
            else
            {
                if (string.IsNullOrEmpty(o.Version)) o.Version = "0.0.0";
                if (string.IsNullOrEmpty(o.LogPath))
                {
                    o.LogPath = Path.Combine(Path.GetTempPath(), "hmo-updater-demo.log");
                }
            }

            if (bounds != null && !o.ParseBounds(bounds)) return o;
            o.ClampBounds();
            return o;
        }

        private bool ParseBounds(string value)
        {
            string[] parts = value.Split(',');
            if (parts.Length != 4)
            {
                Error = "--bounds must be x,y,w,h";
                return false;
            }
            int[] numbers = new int[4];
            for (int i = 0; i < 4; i++)
            {
                if (!int.TryParse(parts[i].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out numbers[i]))
                {
                    Error = "--bounds is not four numbers: " + value;
                    return false;
                }
            }
            X = numbers[0];
            Y = numbers[1];
            Width = numbers[2];
            Height = numbers[3];
            return true;
        }

        /// <summary>
        /// Keep the window on a monitor that exists and big enough to read.
        ///
        /// The app's bounds can name a display that was unplugged between the
        /// download and the click, or a window the user had dragged mostly off
        /// screen. A helper nobody can see is a helper that looks like a hang.
        /// </summary>
        private void ClampBounds()
        {
            if (Width < MinWidth) Width = MinWidth;
            if (Height < MinHeight) Height = MinHeight;
            Native.RECT work = Native.WorkAreaFor(X, Y, Width, Height);
            int workWidth = work.Right - work.Left;
            int workHeight = work.Bottom - work.Top;
            if (workWidth <= 0 || workHeight <= 0) return;
            if (Width > workWidth) Width = workWidth;
            if (Height > workHeight) Height = workHeight;
            if (X < work.Left) X = work.Left;
            if (Y < work.Top) Y = work.Top;
            if (X + Width > work.Right) X = work.Right - Width;
            if (Y + Height > work.Bottom) Y = work.Bottom - Height;
        }
    }
}
