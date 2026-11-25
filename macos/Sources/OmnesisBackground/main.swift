// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore

/// The registered login item owns only the desktop daemon. Runtime lifecycle
/// and its single-instance lock remain in the portable desktop package.
final class BackgroundDelegate: NSObject, NSApplicationDelegate {
    private var daemon: Process?
    private var runtime: URL?
    private var presenter: ApplicationPresenter?
    private var retirement: Process?
    private var retirementRequested = false
    private var retryCount = 0
    private var usageLease: DesktopRuntimeUsageLease?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainBundle = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        Task {
            do {
                let prepared = try await Task.detached(priority: .utility) {
                    let runtime = try DesktopRuntimeBootstrap.prepare(appBundle: mainBundle)
                    return try (runtime, DesktopRuntimeUsageLease.acquire(runtime: runtime))
                }.value
                usageLease = prepared.1
                runtime = prepared.0
                presenter = ApplicationPresenter(application: mainBundle) { [weak self] moved in
                    DispatchQueue.main.async { self?.applicationMoved(to: moved) }
                }
                launch(prepared.0)
            } catch { NSApp.terminate(nil) }
        }
    }

    private func launch(_ runtime: URL) {
        let child = Process()
        child.executableURL = runtime.appendingPathComponent("runtime-exec")
        child.arguments = ["--node", runtime.appendingPathComponent("packages/cli/dist/index.js").path, "desktop", "daemon"]
        child.currentDirectoryURL = runtime
        child.environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: runtime)
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        // Another owned daemon may already exist. Keep the native observer resident either way.
        child.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                if self?.daemon === finished { self?.daemon = nil }
            }
        }
        do { try child.run()
            daemon = child
        } catch { NSApp.terminate(nil) }
    }

    private func applicationMoved(to location: URL?) {
        if let location {
            guard let trash = try? FileManager.default.url(
                for: .trashDirectory,
                in: .userDomainMask,
                appropriateFor: location,
                create: false
            ),
                DesktopApplicationLocation.isInTrash(location, trash: trash) else { return }
        }
        retirementRequested = true
        retireOwnedLibrary()
    }

    private func retireOwnedLibrary() {
        guard retirementRequested, retirement == nil, let runtime else { return }
        let child = Process()
        child.executableURL = runtime.appendingPathComponent("runtime-exec")
        child.arguments = [
            "--node",
            runtime.appendingPathComponent("packages/cli/dist/index.js").path,
            "desktop",
            "system-retire",
        ]
        child.currentDirectoryURL = runtime
        child.environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: runtime)
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self else { return }
                self.retirement = nil
                if finished.terminationStatus == 0 { NSApp.terminate(nil) }
                else if self.retryCount < 5 {
                    self.retryCount += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.retireOwnedLibrary() }
                }
            }
        }
        do { try child.run()
            retirement = child
        } catch {
            if retryCount < 5 {
                retryCount += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.retireOwnedLibrary() }
            }
        }
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
