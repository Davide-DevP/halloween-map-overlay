const debugLogEnabled = true

module.exports.debugLog = function (...args) {
    if (!debugLogEnabled) {
        return
    }
    console.debug.apply(null, args)
}
