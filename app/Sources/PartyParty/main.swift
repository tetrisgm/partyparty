import AppKit

// AppKit entry point (no @main so we can keep explicit lifecycle control).
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
