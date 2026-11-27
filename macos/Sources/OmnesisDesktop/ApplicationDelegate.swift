// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit

@MainActor
final class DesktopApplicationDelegate: NSObject, NSApplicationDelegate {
    private(set) var store: DesktopStore?
    private(set) var statusMenu: DesktopStatusMenu?
    private var actions: DesktopStatusMenu.Actions?
    private var launched = false
    private var waitingForCleanup = false

    func configure(store: DesktopStore, actions: DesktopStatusMenu.Actions) {
        if let current = self.store {
            // The App owns one Store and one immutable set of scene actions for its lifetime.
            assert(current === store, "The application Store must remain app-lifetime scoped")
            return
        }
        self.store = store
        self.actions = actions
        installMenuIfReady()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        launched = true
        installMenuIfReady()
    }

    private func installMenuIfReady() {
        guard launched, statusMenu == nil, let store, let actions else { return }
        let controller = DesktopStatusMenu(store: store, actions: actions)
        statusMenu = controller
        controller.install()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusMenu?.invalidate()
        statusMenu = nil
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        guard !waitingForCleanup else { return .terminateLater }
        waitingForCleanup = true
        Task {
            do {
                try await store.cleanUpUpdateInstaller()
                try await store.shutdownRuntime()
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
