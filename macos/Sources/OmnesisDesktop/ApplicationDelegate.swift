// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit

@MainActor
final class DesktopApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var store: DesktopStore?
    private var waitingForCleanup = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        guard !waitingForCleanup else { return .terminateLater }
        waitingForCleanup = true
        Task {
            do {
                try await store.cleanUpUpdateInstaller()
                await store.stopPrerequisiteMonitoring()
                sender.reply(toApplicationShouldTerminate: true)
            } catch {
                store.failure = error.localizedDescription
                waitingForCleanup = false
                sender.reply(toApplicationShouldTerminate: false)
            }
        }
        return .terminateLater
    }
}
