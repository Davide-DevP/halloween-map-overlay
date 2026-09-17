const debugLogEnabled = true // Set to false to disable debug logging

module.exports.debugLog = function (...args) {
    if (!debugLogEnabled) {
        return
    }
    console.debug.apply(null, args)
}
