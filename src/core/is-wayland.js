/**
 * Is this a Wayland session? Gate Wayland workarounds on this, never on
 * `process.platform === 'linux'`, so X11 users are not affected. Both env vars
 * are checked because some containers set only one.
 */
function isWaylandSession() {
    return (
        process.platform === 'linux' &&
        (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)
    );
}

module.exports = isWaylandSession;