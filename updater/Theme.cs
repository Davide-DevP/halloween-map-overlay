using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;

namespace HmoUpdater
{
    /// <summary>
    /// The design tokens from <c>src/css/app.css</c>, transcribed.
    ///
    /// This window has to look like the app's <c>#loadingOverlay</c>, not like
    /// something that resembles it: the values below are the CSS custom
    /// properties verbatim, and anything that changes there has to change here
    /// in the same commit. Only the tokens this window actually uses are
    /// listed — a copy of the whole palette would just rot.
    /// </summary>
    internal static class Theme
    {
        // Surfaces
        internal static readonly Color Bg = Rgb(0x14, 0x10, 0x0f);          // --hmo-bg
        internal static readonly Color BgDeep = Rgb(0x0e, 0x0b, 0x0a);      // --hmo-bg-deep
        internal static readonly Color LoadingCore = Rgb(0x1b, 0x14, 0x12); // .loading-overlay inner stop
        internal static readonly Color Track = Rgb(0x2a, 0x23, 0x20);       // .loading-bar track

        // Hairlines
        internal static readonly Color LineStrong = Rgb(0x3a, 0x31, 0x2c);  // --hmo-line-strong

        // Text
        internal static readonly Color Text = Rgb(0xec, 0xe4, 0xdf);        // --hmo-text
        internal static readonly Color TextDim = Rgb(0xa2, 0x95, 0x8e);     // --hmo-text-dim
        internal static readonly Color TextMute = Rgb(0x8e, 0x82, 0x7c);    // --hmo-text-mute

        // The one accent
        internal static readonly Color Accent = Rgb(0xe8, 0x85, 0x3a);      // --hmo-accent
        internal static readonly Color AccentBright = Rgb(0xf0, 0x9a, 0x55);// --hmo-accent-bright
        internal static readonly Color AccentInk = Rgb(0x1a, 0x11, 0x09);   // --hmo-accent-ink
        internal static readonly Color Hover = Rgb(0x26, 0x20, 0x19);       // --hmo-hover

        // Radii (--hmo-r-sm / --hmo-r-pill)
        internal const double RadiusSm = 8;
        internal const double RadiusPill = 999;

        // Motion — cubic-bezier(.22,.61,.36,1), 150/200/250 ms
        internal const int DurFastMs = 150;
        internal const int DurMs = 200;
        internal const int DurSlowMs = 250;
        internal const int FadeInMs = 200;
        internal const int FadeOutMs = 350;

        private static Color Rgb(byte r, byte g, byte b)
        {
            return Color.FromRgb(r, g, b);
        }

        internal static SolidColorBrush Brush(Color color)
        {
            SolidColorBrush brush = new SolidColorBrush(color);
            brush.Freeze();
            return brush;
        }

        /// <summary>The app's `--hmo-ease`. A fresh instance per use is not
        /// worth it; the object is immutable once frozen.</summary>
        internal static readonly IEasingFunction Ease = MakeEase();

        private static IEasingFunction MakeEase()
        {
            CubicBezierEase ease = new CubicBezierEase(0.22, 0.61, 0.36, 1.0);
            ease.Freeze();
            return ease;
        }

        /// <summary>
        /// The <c>.loading-overlay</c> background:
        /// <c>radial-gradient(60rem 30rem at 50% 38%, #1b1412, #0e0b0a 78%)</c>.
        ///
        /// The radii are kept *relative* rather than converted to the CSS pixel
        /// sizes on purpose: 60rem is 960 px, which on a 560x380 helper window
        /// would flatten the whole gradient to one colour. Relative radii make
        /// the picture identical at the app's default size and at the minimum,
        /// which is the point — the same screen, not the same arithmetic.
        /// 0.98/0.70 are 960/984 and 480/681, the app window's own viewport.
        /// </summary>
        internal static Brush BackgroundBrush()
        {
            RadialGradientBrush brush = new RadialGradientBrush();
            brush.MappingMode = BrushMappingMode.RelativeToBoundingBox;
            brush.Center = new Point(0.5, 0.38);
            brush.GradientOrigin = new Point(0.5, 0.38);
            brush.RadiusX = 0.98;
            brush.RadiusY = 0.70;
            brush.GradientStops.Add(new GradientStop(LoadingCore, 0.0));
            brush.GradientStops.Add(new GradientStop(BgDeep, 0.78));
            brush.GradientStops.Add(new GradientStop(BgDeep, 1.0));
            brush.Freeze();
            return brush;
        }

        /// <summary>
        /// The warm ambient the app paints at the top of every page
        /// (<c>body::before</c>, <c>rgba(232,133,58,.11)</c> falling off by 62 %).
        /// Drawn over the radial above, so the top edge is warm rather than grey.
        ///
        /// The alpha is 0x05, not the CSS 0.11: in the app this glow sits
        /// *behind* the opaque loading overlay and only the edge of it shows
        /// through the page. Measured against the real thing
        /// (scratchpad `00-loading.png`): the app's top-middle pixel is #16100f
        /// against #12100e in the corners, i.e. about +4 of red. At 0x1C the
        /// helper measured #251b15 there — a different, much browner screen.
        /// If this is ever retuned, retune it by sampling, not by eye.
        /// </summary>
        internal static Brush AmbientBrush()
        {
            RadialGradientBrush brush = new RadialGradientBrush();
            brush.MappingMode = BrushMappingMode.RelativeToBoundingBox;
            brush.Center = new Point(0.5, -0.20);
            brush.GradientOrigin = new Point(0.5, -0.20);
            brush.RadiusX = 1.0;
            brush.RadiusY = 0.85;
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x05, 0xe8, 0x85, 0x3a), 0.0));
            brush.GradientStops.Add(new GradientStop(Color.FromArgb(0x00, 0xe8, 0x85, 0x3a), 0.62));
            brush.Freeze();
            return brush;
        }

        /// <summary>
        /// The film grain. In the app it is an SVG feTurbulence tile at 4.5 %
        /// opacity; WPF has no such filter, so the tile is generated once here.
        ///
        /// The seed is fixed so two screenshots of the same state are
        /// byte-comparable — noise that changes per run makes a visual diff
        /// useless, and nobody can see the difference between one fixed noise
        /// field and another.
        /// </summary>
        internal static Brush GrainBrush()
        {
            const int size = 180;
            byte[] pixels = new byte[size * size * 4];
            Random random = new Random(0x484d4f); // "HMO"
            for (int i = 0; i < size * size; i++)
            {
                // fractalNoise is grey noise around mid-grey, not black speckle:
                // a narrow band around 128 is what keeps it a texture instead of
                // a dirty screen.
                byte level = (byte)(96 + random.Next(0, 64));
                int p = i * 4;
                pixels[p] = level;     // B
                pixels[p + 1] = level; // G
                pixels[p + 2] = level; // R
                pixels[p + 3] = 255;   // A
            }
            BitmapSource tile = BitmapSource.Create(size, size, 96, 96, PixelFormats.Bgra32, null, pixels, size * 4);
            tile.Freeze();
            ImageBrush brush = new ImageBrush(tile);
            brush.TileMode = TileMode.Tile;
            brush.ViewportUnits = BrushMappingMode.Absolute;
            brush.Viewport = new Rect(0, 0, size, size);
            brush.Stretch = Stretch.None;
            brush.Opacity = 0.045;
            brush.Freeze();
            return brush;
        }

        /// <summary>
        /// Geist / Geist Mono, loaded from the <c>fonts</c> folder next to the
        /// exe. WPF cannot use the app's variable woff2 files, so the static
        /// TTFs from the official release ship beside the helper.
        ///
        /// The fallback after the comma is what makes a missing (or
        /// quarantined) font folder a slightly different-looking window rather
        /// than a crash: WPF walks the list and lands on Segoe UI.
        /// </summary>
        internal static FontFamily Ui()
        {
            return Family("./#Geist", "Segoe UI");
        }

        internal static FontFamily Mono()
        {
            return Family("./#Geist Mono", "Consolas");
        }

        private static FontFamily Family(string wanted, string fallback)
        {
            try
            {
                string dir = AppDomain.CurrentDomain.BaseDirectory;
                string fonts = Path.Combine(dir, "fonts");
                if (Directory.Exists(fonts))
                {
                    // The trailing separator is load-bearing: without it WPF
                    // treats the last segment as a file name and resolves
                    // "./#Geist" against the exe's own folder, finding nothing.
                    Uri baseUri = new Uri(fonts + Path.DirectorySeparatorChar, UriKind.Absolute);
                    return new FontFamily(baseUri, wanted + ", " + fallback);
                }
            }
            catch (Exception)
            {
            }
            return new FontFamily(fallback);
        }
    }

    /// <summary>
    /// CSS's <c>cubic-bezier(x1, y1, x2, y2)</c> as a WPF easing function.
    ///
    /// WPF ships no cubic-bezier easing, and <c>KeySpline</c> — which is
    /// literally this curve — keeps its solver <c>internal</c>, so the only way
    /// to get the app's <c>--hmo-ease</c> here is to solve it: Newton-Raphson
    /// on x, then evaluate y, which is exactly what a browser does.
    ///
    /// <c>EasingMode</c> is pinned to <c>EaseIn</c> in the constructor because
    /// the base class's default is <c>EaseOut</c>, which would evaluate
    /// <c>1 - f(1 - t)</c> and silently mirror every curve.
    /// </summary>
    internal sealed class CubicBezierEase : EasingFunctionBase
    {
        private readonly double _x1, _y1, _x2, _y2;

        internal CubicBezierEase(double x1, double y1, double x2, double y2)
        {
            _x1 = x1;
            _y1 = y1;
            _x2 = x2;
            _y2 = y2;
            EasingMode = EasingMode.EaseIn;
        }

        private static double Curve(double t, double a, double b)
        {
            // The standard cubic with P0 = 0 and P3 = 1.
            double mt = 1 - t;
            return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
        }

        private static double Slope(double t, double a, double b)
        {
            double mt = 1 - t;
            return 3 * mt * mt * a + 6 * mt * t * (b - a) + 3 * t * t * (1 - b);
        }

        protected override double EaseInCore(double normalizedTime)
        {
            if (normalizedTime <= 0) return 0;
            if (normalizedTime >= 1) return 1;
            double t = normalizedTime;
            for (int i = 0; i < 8; i++)
            {
                double x = Curve(t, _x1, _x2) - normalizedTime;
                if (Math.Abs(x) < 1e-5) break;
                double d = Slope(t, _x1, _x2);
                if (Math.Abs(d) < 1e-6) break;
                t -= x / d;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
            }
            return Curve(t, _y1, _y2);
        }

        protected override Freezable CreateInstanceCore()
        {
            return new CubicBezierEase(_x1, _y1, _x2, _y2);
        }
    }
}
