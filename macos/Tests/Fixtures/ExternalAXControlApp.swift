// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit

/// Test-action-only standard AppKit baseline. No Omnesis modules or runtime.
@main
@MainActor
final class ExternalAXControlApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    static func main() {
        let application = NSApplication.shared
        let delegate = ExternalAXControlApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Fictional accessibility control"
        window.identifier = NSUserInterfaceItemIdentifier("external-ax-control-window")
        window.isRestorable = false
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "Fictional AppKit control is ready")
        label.setAccessibilityIdentifier("external-ax-control-label")
        label.frame = NSRect(x: 24, y: 76, width: 372, height: 24)
        window.contentView?.addSubview(label)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
