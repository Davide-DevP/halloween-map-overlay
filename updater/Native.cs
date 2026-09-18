using System;
using System.Runtime.InteropServices;

namespace HmoUpdater
{
    /// <summary>
    /// The handful of Win32 calls the helper needs. Everything here is
    /// best-effort: a failure means the window looks slightly less like
    /// Windows 11, never that the update stops.
    /// </summary>
    internal static class Native
    {
        // --- Window placement -------------------------------------------------
        //
        // The bounds come from Electron in *physical* pixels (screen.dipToScreenRect)
        // and WPF lays out in device-independent units, so the window is placed
        // with SetWindowPos rather than with Window.Left/Top/Width/Height. That
        // is correct at every DPI and under every DPI-awareness mode, which
        // Left/Top are not: on a 150 % monitor a WPF Left of 100 is 150 physical
        // pixels, and the app's window was never at 150.

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        private const int MONITOR_DEFAULTTONEAREST = 2;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromRect([In] ref RECT lprc, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;

        /// <summary>Move/resize a window in physical screen pixels.</summary>
        internal static void SetPhysicalBounds(IntPtr hwnd, int x, int y, int width, int height)
        {
            try
            {
                SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            catch (Exception)
            {
                // A window that ends up where WPF put it is still a working window.
            }
        }

        /// <summary>
        /// The work area (no taskbar) of the monitor the rectangle mostly sits
        /// on. Falls back to the rectangle itself when the call fails, which
        /// makes the caller's clamp a no-op rather than a wrong answer.
        /// </summary>
        internal static RECT WorkAreaFor(int x, int y, int width, int height)
        {
            RECT rect;
            rect.Left = x;
            rect.Top = y;
            rect.Right = x + width;
            rect.Bottom = y + height;
            try
            {
                IntPtr monitor = MonitorFromRect(ref rect, MONITOR_DEFAULTTONEAREST);
                if (monitor != IntPtr.Zero)
                {
                    MONITORINFO info = new MONITORINFO();
                    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                    if (GetMonitorInfo(monitor, ref info)) return info.rcWork;
                }
            }
            catch (Exception)
            {
            }
            return rect;
        }

        // --- Windows 11 rounded corners ---------------------------------------
        //
        // DWMWA_WINDOW_CORNER_PREFERENCE is Windows 11 21H2 and later. On
        // Windows 10 DwmSetWindowAttribute returns E_INVALIDARG for it, which is
        // exactly what "ignore failure on Windows 10" means — there is nothing
        // to detect and nothing to fall back to.
        //
        // Trap: this only works because the window is *not* AllowsTransparency.
        // A WPF window with AllowsTransparency = true is a layered window that
        // DWM does not decorate at all, so it would keep square corners and lose
        // the drop shadow. That is why the background is painted opaque instead.

        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute,
            ref int value, int size);

        internal static void RoundCorners(IntPtr hwnd)
        {
            try
            {
                int preference = DWMWCP_ROUND;
                DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
            }
            catch (Exception)
            {
                // Windows 10, or dwmapi missing entirely. Square corners it is.
            }
        }
    }
}
