using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace HmoUpdater
{
    /// <summary>
    /// <c>updater.log</c>, next to <c>app.log</c> in the app's userData folder.
    ///
    /// Same line shape as <c>src/core/rotating-log.js</c> —
    /// <c>&lt;ISO&gt; &lt;event&gt; k=v k=v</c>, one event per line — so a reader
    /// who already knows app.log does not have to learn a second format, and the
    /// two files can be read side by side after a failed update.
    ///
    /// Two rules copied from the app side:
    /// - **Never throws.** This log exists for a run that is already going
    ///   wrong; a locked file must not become the second failure.
    /// - **Never writes a user path.** Everything under the user profile is
    ///   folded to <c>~</c> on the way in, exactly like
    ///   <c>src/shared/redact.js</c>, because this file is collected into the
    ///   diagnostic zip.
    ///
    /// Writes are unbuffered: the interesting runs are the ones that end with
    /// the process being killed, and a buffered tail would be the half that
    /// mattered.
    /// </summary>
    internal sealed class Log
    {
        /// <summary>Anything past this and the file starts again — it is never
        /// more than a few hundred lines per update, so a big one is a bug
        /// (or a hundred failed attempts) and the recent half is the useful half.</summary>
        private const long MaxBytes = 512 * 1024;

        private readonly string _path;
        private readonly string _home;
        private readonly object _lock = new object();
        private bool _broken;

        internal Log(string path)
        {
            _path = path;
            string home = null;
            try
            {
                home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }
            catch (Exception)
            {
            }
            _home = string.IsNullOrEmpty(home) ? null : home.TrimEnd('\\');
            Prepare();
        }

        /// <summary>The path as it was handed to us — the error screen shows it.</summary>
        internal string Path { get { return _path; } }

        private void Prepare()
        {
            try
            {
                string dir = System.IO.Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                FileInfo info = new FileInfo(_path);
                if (info.Exists && info.Length > MaxBytes) File.WriteAllText(_path, string.Empty, Encoding.UTF8);
            }
            catch (Exception)
            {
                _broken = true;
            }
        }

        /// <summary>Fold the user profile out of a string, like `redactHome`.</summary>
        internal string Redact(string text)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(_home)) return text;
            // Both separator spellings: an exception message can carry either.
            string forward = _home.Replace('\\', '/');
            text = text.Replace(_home, "~");
            text = text.Replace(forward, "~");
            return text;
        }

        /// <summary>One line. `pairs` is a flat key, value, key, value list.</summary>
        internal void Event(string name, params string[] pairs)
        {
            if (_broken) return;
            StringBuilder line = new StringBuilder();
            line.Append(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture));
            line.Append(' ');
            line.Append(name);
            if (pairs != null)
            {
                for (int i = 0; i + 1 < pairs.Length; i += 2)
                {
                    line.Append(' ');
                    line.Append(pairs[i]);
                    line.Append('=');
                    // Values never contain a newline: one event is one line,
                    // always, or a log reader's grep silently loses events.
                    string value = Redact(pairs[i + 1] == null ? string.Empty : pairs[i + 1]);
                    line.Append(value.Replace("\r", " ").Replace("\n", " "));
                }
            }
            line.Append(Environment.NewLine);
            lock (_lock)
            {
                try
                {
                    File.AppendAllText(_path, line.ToString(), Encoding.UTF8);
                }
                catch (Exception)
                {
                    // One unwritable line does not stop an update.
                }
            }
        }

        /// <summary>Numbers are logged in the invariant culture — an Italian
        /// Windows would otherwise write `12,5` and a parser would read 125.</summary>
        internal static string Num(double value)
        {
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        internal static string Num(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }
    }
}
