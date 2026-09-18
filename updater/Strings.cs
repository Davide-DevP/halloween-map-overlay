using System.Collections.Generic;

namespace HmoUpdater
{
    /// <summary>
    /// The two string tables. The tables themselves are generated into
    /// <c>Strings.g.cs</c> by <c>scripts/build-updater.js</c> from
    /// <c>updater/strings.json</c>, so:
    ///
    /// - the helper reads no file at runtime (a missing or hand-edited JSON
    ///   cannot strand a user in front of a half-drawn window mid-update), and
    /// - <c>test/updater-strings.test.js</c> can assert key and placeholder
    ///   parity straight from the JSON, which is the single source.
    ///
    /// Same shape as the app's own i18n: flat dotted keys, <c>{param}</c>
    /// placeholders, no framework. An unknown key returns the key — visible in
    /// a screenshot, which is what a missing string should be.
    /// </summary>
    internal static partial class Strings
    {
        private static readonly Dictionary<string, string> En = new Dictionary<string, string>();
        private static readonly Dictionary<string, string> It = new Dictionary<string, string>();

        static Strings()
        {
            Fill(En, It);
        }

        internal static string Get(string lang, string key)
        {
            Dictionary<string, string> table = (lang == "it") ? It : En;
            string value;
            if (table.TryGetValue(key, out value)) return value;
            // Italian falling back to English beats showing a raw key.
            if (table != En && En.TryGetValue(key, out value)) return value;
            return key;
        }

        /// <summary>`Get` plus one `{name}` substitution.</summary>
        internal static string Get(string lang, string key, string param, string value)
        {
            return Get(lang, key).Replace("{" + param + "}", value == null ? string.Empty : value);
        }
    }
}
