// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit

/// Owns the status item independently of the lifetime of any library window.
@MainActor
final class DesktopStatusMenu: NSObject, NSMenuDelegate {
    struct Actions {
        let openMain: @MainActor () -> Void
        let openSettings: @MainActor () -> Void
        let quit: @MainActor () -> Void
    }

    private enum Command: Int { case ask, search, sources, review, open, settings, quit }
    let menu = NSMenu(title: "Omnesis")
    private(set) var statusItem: NSStatusItem?
    private let store: DesktopStore
    private let actions: Actions
    private let status = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let message = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var commands: [Command: NSMenuItem] = [:]
    private var invalidated = false

    init(store: DesktopStore, actions: Actions) {
        self.store = store
        self.actions = actions
        super.init()
        menu.autoenablesItems = false
        menu.delegate = self
        menu.addItem(status)
        menu.addItem(message)
        menu.addItem(.separator())
        add("Ask Omnesis", .ask)
        add("Search", .search)
        add("Sources", .sources)
        add("Review setup", .review)
        add("Open Omnesis", .open)
        add("Settings…", .settings)
        menu.addItem(.separator())
        add("Quit Omnesis", .quit)
    }

    func install() {
        guard !invalidated, statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        if let button = item.button {
            button.title = "Omnesis"
            button.image = DesktopMenuBarImage.make()
            button.imagePosition = button.image == nil ? .noImage : .imageOnly
            button.toolTip = "Omnesis"
            button.setAccessibilityLabel("Omnesis")
            button.setAccessibilityIdentifier("Omnesis")
        }
        item.menu = menu
        refresh()
    }

    func invalidate() {
        guard !invalidated else { return }
        invalidated = true
        menu.cancelTracking()
        menu.delegate = nil
        for item in menu.items {
            item.isEnabled = false
            item.action = nil
            item.target = nil
        }
        if let item = statusItem {
            item.menu = nil
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        if menu === self.menu { refresh() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === self.menu { refresh() }
    }

    private func refresh() {
        guard !invalidated, statusItem != nil else { return }
        status.title = store.menuStatusLabel
        status.isEnabled = false
        let summary = (store.state.message ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        message.title = summary.count > 80 ? String(summary.prefix(79)) + "…" : summary
        message.isHidden = message.title.isEmpty
        message.isEnabled = false
        for command in [Command.ask, .search, .sources] {
            commands[command]?.isEnabled = store.state.canOpenLibrary
        }
        commands[.review]?.isHidden = !store.state.canOpenLibrary || store.requiredSetupReady
        commands[.review]?.isEnabled = store.state.canOpenLibrary && !store.requiredSetupReady
        for command in [Command.open, .settings, .quit] {
            commands[command]?.isEnabled = true
        }
    }

    private func add(_ title: String, _ command: Command) {
        let item = NSMenuItem(title: title, action: #selector(invoke(_:)), keyEquivalent: "")
        item.setAccessibilityLabel(title)
        item.target = self
        item.tag = command.rawValue
        commands[command] = item
        menu.addItem(item)
    }

    @objc private func invoke(_ sender: NSMenuItem) {
        guard !invalidated, statusItem != nil, let command = Command(rawValue: sender.tag), commands[command] === sender else { return }
        switch command {
        case .ask: show(.ask)
        case .search: show(.search)
        case .sources: show(.sources)
        case .review: show(.setup)
        case .open: actions.openMain()
        case .settings: actions.openSettings()
        case .quit: actions.quit()
        }
    }

    private func show(_ destination: DesktopStore.Destination) {
        guard store.state.canOpenLibrary else { return }
        if destination == .setup, store.requiredSetupReady { return }
        store.destination = destination
        actions.openMain()
    }
}
