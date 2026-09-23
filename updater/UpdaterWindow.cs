using System;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace HmoUpdater
{
    /// <summary>
    /// The window. It is the app's <c>#loadingOverlay</c> with four more lines
    /// on it: same radial background, same breathing icon, same hairline accent
    /// bar, same grain — so that the app's "updating" view, this window and the
    /// new version's loading screen are one continuous picture.
    ///
    /// Everything it draws is decided here; the install itself is
    /// <see cref="Runner"/>, which only ever calls the four public setters
    /// below, always through the dispatcher.
    /// </summary>
    internal sealed class UpdaterWindow : Window
    {
        private const double BarWidth = 320;
        private const double BarHeight = 3;
        /// <summary>`.loading-mark` is 84px. A short window (the 560x380
        /// minimum, used when the app was hidden in the tray) has to fit the
        /// error state's two extra paragraphs and a button row as well, so the
        /// mark shrinks rather than the text.</summary>
        private const double IconSize = 84;
        private const double IconSizeCompact = 60;
        private const double CompactHeight = 460;

        private readonly Options _options;
        private readonly Log _log;
        private readonly bool _animate;

        private TextBlock _headline;
        private TextBlock _step;
        private TextBlock _percent;
        private TextBlock _subline;
        private StackPanel _progressGroup;
        private StackPanel _errorGroup;
        private TextBlock _errorText;
        private TextBlock _errorLog;
        private TextBlock _errorHint;
        private Button _closeButton;
        private Border _barFill;
        private Border _barSlider;
        private Grid _barTrack;
        private Image _icon;
        private ScaleTransform _iconScale;

        private double _shownPercent = -1;
        private bool _indeterminate = true;
        private bool _allowClose;
        private bool _closing;

        /// <summary>Set when the error state is up and the old app is still
        /// installed: *Close* then puts the user back where they were.</summary>
        private string _relaunchExe;

        internal UpdaterWindow(Options options, Log log)
        {
            _options = options;
            _log = log;
            // "Show animations in Windows" (SystemParameters.ClientAreaAnimation)
            // is an accessibility setting, not a preference: someone who turned
            // it off gets the same screen without the breathing and the sliding.
            _animate = SystemParameters.ClientAreaAnimation;
            Build();
        }

        // ── Construction ────────────────────────────────────────────────────

        private void Build()
        {
            Title = "Halloween Map Overlay";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            // NOT AllowsTransparency: a layered window gets no DWM decoration,
            // so it would lose both the Windows 11 rounded corners and the
            // system drop shadow. The background is painted opaque instead.
            AllowsTransparency = false;
            ShowInTaskbar = true;
            // Never over other apps. The player may be in a fullscreen match and
            // this window is not more important than that.
            Topmost = false;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            Background = Theme.Brush(Theme.BgDeep);
            Opacity = _animate ? 0 : 1;
            // ShowActivated is set by Program before Show(); focus must not be
            // taken from a game.
            Width = _options.Width;
            Height = _options.Height;

            Grid root = new Grid();

            Border backdrop = new Border();
            backdrop.Background = Theme.BackgroundBrush();
            root.Children.Add(backdrop);

            Border ambient = new Border();
            ambient.Background = Theme.AmbientBrush();
            root.Children.Add(ambient);

            root.Children.Add(BuildColumn());

            Border grain = new Border();
            grain.Background = Theme.GrainBrush();
            grain.IsHitTestVisible = false;
            root.Children.Add(grain);

            Content = root;

            // Draggable by its body — there is no title bar to grab.
            MouseLeftButtonDown += OnDragBody;
            // No close button while installing, and Alt+F4 must not leave the
            // installer running with nothing on screen to explain it.
            Closing += OnClosing;
            // ShutdownMode is OnExplicitShutdown, so a window closed from the
            // taskbar or with Alt+F4 in the error state would otherwise leave a
            // window-less process running forever.
            Closed += delegate { if (!_closing) Shutdown(1); };
            SourceInitialized += OnSourceInitialized;
            ContentRendered += OnContentRendered;
        }

        private UIElement BuildColumn()
        {
            StackPanel column = new StackPanel();
            column.HorizontalAlignment = HorizontalAlignment.Center;
            column.VerticalAlignment = VerticalAlignment.Center;
            column.Margin = new Thickness(24);

            UIElement icon = BuildIcon();
            if (icon != null) column.Children.Add(icon);

            _headline = Text(Strings.Get(_options.Lang, "headline", "version", _options.Version),
                17, FontWeights.Medium, Theme.Text);
            _headline.Margin = new Thickness(0, icon == null ? 0 : (_options.Height < CompactHeight ? 18 : 24), 0, 0);
            column.Children.Add(_headline);

            _progressGroup = new StackPanel();
            _progressGroup.HorizontalAlignment = HorizontalAlignment.Center;
            column.Children.Add(_progressGroup);

            _step = Text(Strings.Get(_options.Lang, "step.closing"), 13, FontWeights.Normal, Theme.TextDim);
            _step.Margin = new Thickness(0, 9, 0, 0);
            _progressGroup.Children.Add(_step);

            _progressGroup.Children.Add(BuildBar());

            _percent = Text(string.Empty, 12, FontWeights.Normal, Theme.TextMute);
            _percent.FontFamily = Theme.Mono();
            // Tabular figures, so the number does not shuffle the layout every
            // time a 1 becomes a 7. Geist Mono is fixed-pitch anyway; this is
            // what keeps it right if the fallback font ever has to stand in.
            Typography.SetNumeralAlignment(_percent, FontNumeralAlignment.Tabular);
            _percent.Margin = new Thickness(0, 12, 0, 0);
            _percent.MinHeight = 16;
            _progressGroup.Children.Add(_percent);

            _subline = Text(Strings.Get(_options.Lang, "subline"), 12, FontWeights.Normal, Theme.TextMute);
            _subline.Margin = new Thickness(0, 18, 0, 0);
            _progressGroup.Children.Add(_subline);

            column.Children.Add(BuildErrorGroup());
            return column;
        }

        private UIElement BuildIcon()
        {
            BitmapImage source = LoadIcon();
            if (source == null) return null;
            double size = _options.Height < CompactHeight ? IconSizeCompact : IconSize;
            Image image = new Image();
            image.Source = source;
            image.Width = size;
            image.Height = size;
            image.Stretch = Stretch.Uniform;
            image.HorizontalAlignment = HorizontalAlignment.Center;
            image.RenderTransformOrigin = new Point(0.5, 0.5);
            _iconScale = new ScaleTransform(1, 1);
            image.RenderTransform = _iconScale;
            // drop-shadow(0 8px 26px rgba(232,133,58,.22)) from `.loading-mark`.
            DropShadowEffect glow = new DropShadowEffect();
            glow.Color = Theme.Accent;
            glow.BlurRadius = 26;
            glow.ShadowDepth = 8;
            glow.Direction = 270;
            glow.Opacity = 0.22;
            image.Effect = glow;
            image.Opacity = _animate ? 0.78 : 1;
            _icon = image;
            return image;
        }

        private BitmapImage LoadIcon()
        {
            try
            {
                string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.png");
                if (!File.Exists(file)) return null;
                BitmapImage image = new BitmapImage();
                image.BeginInit();
                // The helper runs while its own folder is being cleaned up by
                // the app on a later start; never keep the file open.
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.UriSource = new Uri(file, UriKind.Absolute);
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception)
            {
                // No icon is a plainer window, not a failed update.
                return null;
            }
        }

        private UIElement BuildBar()
        {
            _barTrack = new Grid();
            _barTrack.Width = BarWidth;
            _barTrack.Height = BarHeight;
            _barTrack.Margin = new Thickness(0, 20, 0, 0);
            _barTrack.ClipToBounds = true;
            _barTrack.HorizontalAlignment = HorizontalAlignment.Center;

            Border track = new Border();
            track.Background = Theme.Brush(Theme.Track);
            track.CornerRadius = new CornerRadius(Theme.RadiusPill);
            _barTrack.Children.Add(track);

            // Determinate fill: a capsule that grows from the left.
            _barFill = new Border();
            _barFill.HorizontalAlignment = HorizontalAlignment.Left;
            _barFill.Width = 0;
            _barFill.CornerRadius = new CornerRadius(Theme.RadiusPill);
            LinearGradientBrush fill = new LinearGradientBrush(Theme.Accent, Theme.AccentBright, 0);
            fill.Freeze();
            _barFill.Background = fill;
            _barFill.Visibility = Visibility.Collapsed;
            _barTrack.Children.Add(_barFill);

            // Indeterminate: `.loading-bar::after` — a 42 % wide gradient
            // sliding from -110 % to 270 % every 1.5 s.
            _barSlider = new Border();
            _barSlider.HorizontalAlignment = HorizontalAlignment.Left;
            _barSlider.Width = BarWidth * 0.42;
            LinearGradientBrush slide = new LinearGradientBrush();
            slide.StartPoint = new Point(0, 0.5);
            slide.EndPoint = new Point(1, 0.5);
            slide.GradientStops.Add(new GradientStop(Color.FromArgb(0, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B), 0));
            slide.GradientStops.Add(new GradientStop(Theme.Accent, 0.5));
            slide.GradientStops.Add(new GradientStop(Color.FromArgb(0, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B), 1));
            slide.Freeze();
            _barSlider.Background = slide;
            _barSlider.RenderTransform = new TranslateTransform(-BarWidth * 0.42, 0);
            _barTrack.Children.Add(_barSlider);

            return _barTrack;
        }

        private UIElement BuildErrorGroup()
        {
            _errorGroup = new StackPanel();
            _errorGroup.HorizontalAlignment = HorizontalAlignment.Center;
            _errorGroup.Visibility = Visibility.Collapsed;

            _errorText = Text(string.Empty, 13.5, FontWeights.Normal, Theme.Text);
            _errorText.TextWrapping = TextWrapping.Wrap;
            _errorText.MaxWidth = 420;
            _errorText.Margin = new Thickness(0, 10, 0, 0);
            _errorGroup.Children.Add(_errorText);

            _errorHint = Text(string.Empty, 12, FontWeights.Normal, Theme.TextDim);
            _errorHint.TextWrapping = TextWrapping.Wrap;
            _errorHint.MaxWidth = 420;
            _errorHint.Margin = new Thickness(0, 10, 0, 0);
            _errorGroup.Children.Add(_errorHint);

            _errorLog = Text(string.Empty, 11.5, FontWeights.Normal, Theme.TextMute);
            _errorLog.FontFamily = Theme.Mono();
            _errorLog.TextWrapping = TextWrapping.Wrap;
            _errorLog.MaxWidth = 440;
            _errorLog.Margin = new Thickness(0, 14, 0, 0);
            _errorGroup.Children.Add(_errorLog);

            StackPanel buttons = new StackPanel();
            buttons.Orientation = Orientation.Horizontal;
            buttons.HorizontalAlignment = HorizontalAlignment.Center;
            buttons.Margin = new Thickness(0, 22, 0, 0);

            Button download = MakeButton(Strings.Get(_options.Lang, "button.download"), true);
            download.Click += OnDownloadClick;
            buttons.Children.Add(download);

            _closeButton = MakeButton(Strings.Get(_options.Lang, "button.close"), false);
            _closeButton.Margin = new Thickness(10, 0, 0, 0);
            _closeButton.Click += OnCloseClick;
            buttons.Children.Add(_closeButton);

            _errorGroup.Children.Add(buttons);
            return _errorGroup;
        }

        private TextBlock Text(string text, double size, FontWeight weight, Color color)
        {
            TextBlock block = new TextBlock();
            block.Text = text;
            block.FontFamily = Theme.Ui();
            block.FontSize = size;
            block.FontWeight = weight;
            block.Foreground = Theme.Brush(color);
            block.HorizontalAlignment = HorizontalAlignment.Center;
            block.TextAlignment = TextAlignment.Center;
            return block;
        }

        /// <summary>
        /// The app's <c>.btn-primary</c> / <c>.btn-outline-secondary</c>, near
        /// enough: accent fill with the dark accent ink on it, or a hairline
        /// outline. Built as a <see cref="ControlTemplate"/> because the stock
        /// Aero button ignores Background on hover and would flash blue.
        /// </summary>
        private Button MakeButton(string text, bool primary)
        {
            Button button = new Button();
            button.Content = text;
            button.FontFamily = Theme.Ui();
            button.FontSize = 13;
            button.FontWeight = FontWeights.Medium;
            button.Focusable = true;
            button.Cursor = Cursors.Hand;
            button.Padding = new Thickness(16, 9, 16, 10);

            Brush idle = primary ? Theme.Brush(Theme.Accent) : Brushes.Transparent;
            Brush hover = primary ? Theme.Brush(Theme.AccentBright) : Theme.Brush(Theme.Hover);
            Brush border = primary ? Theme.Brush(Theme.Accent) : Theme.Brush(Theme.LineStrong);
            button.Foreground = Theme.Brush(primary ? Theme.AccentInk : Theme.Text);

            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory shell = new FrameworkElementFactory(typeof(Border), "shell");
            shell.SetValue(Border.BackgroundProperty, idle);
            shell.SetValue(Border.BorderBrushProperty, border);
            shell.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            shell.SetValue(Border.CornerRadiusProperty, new CornerRadius(Theme.RadiusSm));
            shell.SetValue(Border.PaddingProperty, button.Padding);
            FrameworkElementFactory content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            shell.AppendChild(content);
            template.VisualTree = shell;

            Trigger over = new Trigger();
            over.Property = UIElement.IsMouseOverProperty;
            over.Value = true;
            over.Setters.Add(new Setter(Border.BackgroundProperty, hover, "shell"));
            template.Triggers.Add(over);

            Trigger focused = new Trigger();
            focused.Property = UIElement.IsKeyboardFocusedProperty;
            focused.Value = true;
            focused.Setters.Add(new Setter(Border.BorderBrushProperty, Theme.Brush(Theme.Accent), "shell"));
            template.Triggers.Add(focused);

            button.Template = template;
            return button;
        }

        // ── Window plumbing ─────────────────────────────────────────────────

        private void OnSourceInitialized(object sender, EventArgs e)
        {
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            Native.RoundCorners(hwnd);
            ApplyBounds();
        }

        /// <summary>
        /// Put the window exactly where the app's window was, in physical
        /// pixels. Done twice on purpose: WPF re-applies its own Width/Height
        /// (which are DIPs) when the window is first shown, so a call made only
        /// in SourceInitialized is overwritten on any display that is not at
        /// 100 %.
        /// </summary>
        private void ApplyBounds()
        {
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            if (hwnd == IntPtr.Zero) return;
            Native.SetPhysicalBounds(hwnd, _options.X, _options.Y, _options.Width, _options.Height);
        }

        /// <summary>
        /// Raised once the window is genuinely on screen, i.e. after the first
        /// frame *and* after the fade-in. <see cref="Program"/> writes the
        /// ready-file here and nowhere else.
        ///
        /// The timing matters more than it looks: the app quits the moment the
        /// ready-file appears, so writing it right after <c>Show()</c> — before
        /// the first paint, with the window still at opacity 0 — would take the
        /// app's identical picture away while this one was still invisible, and
        /// the user would see the desktop for a fifth of a second. Waiting
        /// costs ~350 ms of the 15 s the app is prepared to wait.
        /// </summary>
        internal event Action Ready;

        private void OnContentRendered(object sender, EventArgs e)
        {
            ApplyBounds();
            if (_animate)
            {
                StartBreathing();
                StartSliding();
                DoubleAnimation fade = new DoubleAnimation(1, TimeSpan.FromMilliseconds(Theme.FadeInMs));
                fade.EasingFunction = Theme.Ease;
                fade.Completed += delegate { RaiseReady(); };
                BeginAnimation(OpacityProperty, fade);
            }
            else
            {
                RaiseReady();
            }
        }

        private void RaiseReady()
        {
            Action handler = Ready;
            if (handler == null) return;
            Ready = null; // once only
            // Runner starts before the fade-in ends. If it has already failed
            // (or been told to stand down), the app is still alive and must NOT
            // be told to quit: no ready-file, and it installs the stock way.
            if (_allowClose) return;
            try
            {
                handler();
            }
            catch (Exception)
            {
                // The app times out after 15 s and uses the stock installer,
                // which is the designed fallback, not a crash.
            }
        }

        private void OnDragBody(object sender, MouseButtonEventArgs e)
        {
            try
            {
                if (e.ButtonState == MouseButtonState.Pressed) DragMove();
            }
            catch (InvalidOperationException)
            {
                // DragMove throws when the button came up between the event and
                // the call. Nothing to do; the window simply does not move.
            }
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            // While the installer is running there is nothing to go back to and
            // no window left to explain what happened, so Alt+F4 does nothing.
            if (!_allowClose) e.Cancel = true;
        }

        // ── The four things Runner can do to the screen ─────────────────────

        internal void SetStep(string key)
        {
            Dispatch(new Action(delegate
            {
                _step.Text = Strings.Get(_options.Lang, key);
            }));
        }

        internal void SetPercent(double percent)
        {
            Dispatch(new Action(delegate
            {
                if (percent < 0)
                {
                    SetIndeterminate(true);
                    return;
                }
                SetIndeterminate(false);
                if (percent < _shownPercent) percent = _shownPercent; // monotonic, always
                _shownPercent = percent;
                _percent.Text = Math.Round(percent).ToString("0", CultureInfo.InvariantCulture) + "%";
                double target = BarWidth * Math.Max(0, Math.Min(100, percent)) / 100.0;
                if (_animate)
                {
                    // Eased on screen so the bar glides between two polls
                    // instead of stepping every 400 ms.
                    Animate(_barFill, WidthProperty, target, 420);
                }
                else
                {
                    _barFill.BeginAnimation(WidthProperty, null);
                    _barFill.Width = target;
                }
            }));
        }

        private void SetIndeterminate(bool on)
        {
            if (_indeterminate == on) return;
            _indeterminate = on;
            _barSlider.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            _barFill.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
            if (on)
            {
                _percent.Text = string.Empty;
                StartSliding();
            }
            else
            {
                _barSlider.RenderTransform.BeginAnimation(TranslateTransform.XProperty, null);
            }
        }

        internal void ShowIndeterminate()
        {
            Dispatch(new Action(delegate { SetIndeterminate(true); }));
        }

        /// <summary>
        /// The error state, in the same window: what happened in one sentence,
        /// where the log is, and the two ways out. Rule 4 of the spec's safety
        /// rules — the helper never exits silently.
        /// </summary>
        internal void ShowError(string sentence, string relaunchExe)
        {
            ShowError(sentence, relaunchExe, null);
        }

        /// <param name="hintKey">Overrides the "what to do next" line; null picks it from <paramref name="relaunchExe"/>.</param>
        internal void ShowError(string sentence, string relaunchExe, string hintKey)
        {
            Dispatch(new Action(delegate
            {
                _relaunchExe = relaunchExe;
                _headline.Text = Strings.Get(_options.Lang, "error.headline");
                _progressGroup.Visibility = Visibility.Collapsed;
                _errorText.Text = sentence;
                // What the user should do next depends on what is left on disk:
                // a working old version means "nothing was lost", a half-copied
                // one means "finish the job from the download page".
                _errorHint.Text = Strings.Get(_options.Lang, hintKey != null ? hintKey :
                    string.IsNullOrEmpty(relaunchExe) ? "error.reinstallGone" : "error.reinstall");
                _errorLog.Text = Strings.Get(_options.Lang, "error.log", "path", _log.Path);
                _errorGroup.Visibility = Visibility.Visible;
                _closeButton.Content = Strings.Get(_options.Lang,
                    string.IsNullOrEmpty(relaunchExe) ? "button.close" : "button.closeReopen");
                // The user is now in charge, so the window may be closed.
                _allowClose = true;
                StopBreathing();
            }));
        }

        /// <summary>Fade out and end the process with this exit code.</summary>
        internal void FinishAndClose(int exitCode)
        {
            Dispatch(new Action(delegate { Close(exitCode); }));
        }

        private void Close(int exitCode)
        {
            if (_closing) return;
            _closing = true;
            _allowClose = true;
            if (!_animate)
            {
                Shutdown(exitCode);
                return;
            }
            DoubleAnimation fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(Theme.FadeOutMs));
            fade.EasingFunction = Theme.Ease;
            fade.Completed += delegate { Shutdown(exitCode); };
            BeginAnimation(OpacityProperty, fade);
        }

        private void Shutdown(int exitCode)
        {
            try
            {
                Application app = Application.Current;
                if (app != null) app.Shutdown(exitCode);
            }
            catch (Exception)
            {
                Environment.Exit(exitCode);
            }
        }

        // ── Buttons ─────────────────────────────────────────────────────────

        private void OnDownloadClick(object sender, RoutedEventArgs e)
        {
            // User-initiated, through the shell — exactly like the Credits
            // links in the app. The helper itself still makes no network
            // request of its own; it hands a URL to the browser.
            try
            {
                _log.Event("error-download-page");
                System.Diagnostics.Process.Start(Runner.ReleasesUrl);
            }
            catch (Exception ex)
            {
                _log.Event("error-download-page-failed", "message", ex.Message);
            }
        }

        private void OnCloseClick(object sender, RoutedEventArgs e)
        {
            // Rule 4: the helper always ends with the new app running, the old
            // app back, or a visible error. This is the middle one.
            if (!string.IsNullOrEmpty(_relaunchExe))
            {
                try
                {
                    _log.Event("relaunch-old-version");
                    System.Diagnostics.Process.Start(_relaunchExe);
                }
                catch (Exception ex)
                {
                    _log.Event("relaunch-failed", "message", ex.Message);
                }
            }
            Close(1);
        }

        // ── Animation ───────────────────────────────────────────────────────

        private void StartBreathing()
        {
            if (!_animate || _iconScale == null || _icon == null) return;
            Image icon = _icon;

            // `@keyframes hmo-breathe`: opacity .78 → 1 → .78 and scale 1 →
            // 1.025 → 1 over 3.4 s, forever.
            DoubleAnimation opacity = new DoubleAnimation(0.78, 1, TimeSpan.FromMilliseconds(1700));
            opacity.AutoReverse = true;
            opacity.RepeatBehavior = RepeatBehavior.Forever;
            opacity.EasingFunction = Theme.Ease;
            icon.BeginAnimation(OpacityProperty, opacity);

            DoubleAnimation scale = new DoubleAnimation(1, 1.025, TimeSpan.FromMilliseconds(1700));
            scale.AutoReverse = true;
            scale.RepeatBehavior = RepeatBehavior.Forever;
            scale.EasingFunction = Theme.Ease;
            _iconScale.BeginAnimation(ScaleTransform.ScaleXProperty, scale);
            _iconScale.BeginAnimation(ScaleTransform.ScaleYProperty, scale);
        }

        private void StopBreathing()
        {
            if (_iconScale == null) return;
            _iconScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            _iconScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
        }

        private void StartSliding()
        {
            if (!_animate || _barSlider == null || !_indeterminate) return;
            double width = BarWidth * 0.42;
            DoubleAnimation slide = new DoubleAnimation(-width * 1.1, BarWidth + width * 0.3,
                TimeSpan.FromMilliseconds(1500));
            slide.RepeatBehavior = RepeatBehavior.Forever;
            slide.EasingFunction = Theme.Ease;
            _barSlider.RenderTransform.BeginAnimation(TranslateTransform.XProperty, slide);
        }

        private static void Animate(IAnimatable target, DependencyProperty property, double to, int ms)
        {
            DoubleAnimation animation = new DoubleAnimation(to, TimeSpan.FromMilliseconds(ms));
            animation.EasingFunction = Theme.Ease;
            target.BeginAnimation(property, animation);
        }

        private void Dispatch(Action action)
        {
            if (Dispatcher.CheckAccess()) action();
            else Dispatcher.BeginInvoke(DispatcherPriority.Normal, action);
        }
    }
}
