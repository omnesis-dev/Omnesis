// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore

/// The registered login item owns only the desktop daemon. Runtime lifecycle
/// and its single-instance lock remain in the portable desktop package.
final class BackgroundDelegate: NSObject, NSApplicationDelegate {
    private var daemon: Process?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainBundle = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let runtime = mainBundle.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        let child = Process()
        child.executableURL = runtime.appendingPathComponent("node")
        child.arguments = [runtime.appendingPathComponent("packages/cli/dist/index.js").path, "desktop", "daemon"]
        child.currentDirectoryURL = runtime
        child.environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: runtime)
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
        do { try child.run()
            daemon = child
        } catch { NSApp.terminate(nil) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if daemon?.isRunning == true { daemon?.terminate() }
    }
}

let app = NSApplication.shared
let delegate = BackgroundDelegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
