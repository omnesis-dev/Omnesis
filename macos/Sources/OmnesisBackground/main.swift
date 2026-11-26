// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore

/// The registered login item owns only the desktop daemon. Runtime lifecycle
/// and its single-instance lock remain in the portable desktop package.
final class BackgroundDelegate: NSObject, NSApplicationDelegate {
    private var service: BackgroundService?
    private var terminating = false
    private var runtime: URL?
    private var retirement: DesktopBackgroundDaemonProcess?
    private var retirementRequested = false
    private var retryCount = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainBundle = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        Task {
            do {
                let service = BackgroundService(application: mainBundle) { [weak self] location in self?.applicationMoved(to: location) }
                self.service = service
                try await service.prepare()
                runtime = service.runtime
                // The daemon remains independently supervised if opening presentation fails.
                try? await BackgroundMainApplication.openIfNeeded(mainBundle)
            } catch { NSApp.terminate(nil) }
        }
    }

    @MainActor private func applicationMoved(to location: URL?) {
        if let location {
            guard let trash = try? FileManager.default.url(
                for: .trashDirectory,
                in: .userDomainMask,
                appropriateFor: location,
                create: false
            ),
                (try? DesktopBackgroundApplicationOrigin.canonicalTrashContains(location, trash: trash)) == true else { return }
        }
        service?.freezeStarts()
        retirementRequested = true
        retireOwnedLibrary()
    }

    private func retireOwnedLibrary() {
        guard retirementRequested, retirement == nil, let runtime else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let descriptor = try DesktopBackgroundDaemonAuthority.descriptor(
                    profile: DesktopBackgroundManagedProfile.current(), epoch: runtime.lastPathComponent, activation: nil
                )
                let child = try DesktopBackgroundDaemonProcess.launchRetirement(runtime: runtime, descriptor: descriptor)
                retirement = child
                service?.registerRetirement(child)
                let result = await child.waitForExit()
                guard retirement === child else { return }
                retirement = nil
                service?.registerRetirement(nil)
                if result.clean { NSApp.terminate(nil) }
                else { retryRetirement() }
            } catch { retryRetirement() }
        }
    }

    private func retryRetirement() {
        guard retryCount < 5 else { return }
        retryCount += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.retireOwnedLibrary() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task { @MainActor [weak self] in
            if let retirement = self?.retirement { _ = await retirement.stopAndJoin() }
            await self?.service?.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = BackgroundDelegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
