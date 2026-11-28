// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation

/// Store-owned monitoring continues while no main window is mounted.
@MainActor
final class DesktopPrerequisiteMonitor {
    struct Intervals {
        var collection: Duration = .seconds(30)
        var system: Duration = .seconds(60)
    }

    private enum Lane: Hashable, Sendable { case startup, power, metadata, health, access, foreground }
    private struct Slot: Sendable {
        let id: UUID
        let key: String
        let task: Task<Void, Never>
    }

    private weak var store: DesktopStore?
    private let intervals: Intervals
    private var lanes: [Lane: Slot] = [:]
    private var subscription: DesktopPrerequisiteSubscription?
    private var running = true

    init(store: DesktopStore, intervals: Intervals = .init(), notifications: NotificationCenter = .default) {
        self.store = store
        self.intervals = intervals
        let token = notifications.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) {
            [weak self] _ in Task { @MainActor [weak self] in self?.foreground() }
        }
        subscription = DesktopPrerequisiteSubscription { notifications.removeObserver(token) }
        reconcile()
    }

    func reconcile() {
        guard running, let store else { return }
        let scope = "\(store.state.mode ?? ""):\(store.state.installationId ?? ""):\(store.state.retired == true)"
        let api = store.api
        let apiKey = scope + ":" + String(describing: api.map(ObjectIdentifier.init))
        let enabled = store.state.retired != true
        replace(.startup, key: scope) { [weak store, intervals] in
            while !Task.isCancelled {
                guard store != nil else { return }
                store?.automaticStartup.refresh()
                do { try await Task.sleep(for: intervals.system) } catch { return }
            }
        }
        if !enabled || store.state.mode != "home" { store.serverPower.stopMonitoring() }
        replace(.power, key: enabled && store.state.mode == "home" ? scope : nil) { [weak store, intervals] in
            guard let power = store?.serverPower else { return }
            await power.startMonitoring()
            while !Task.isCancelled {
                do { try await Task.sleep(for: intervals.system) } catch { return }
                guard !Task.isCancelled else { return }
                await power.refresh()
            }
        }
        let metadataKey = enabled && api != nil ? apiKey : nil
        if lanes[.metadata]?.key != metadataKey { store.cancelPrerequisiteMetadata() }
        replace(.metadata, key: metadataKey) { [weak store, weak api, intervals] in
            while !Task.isCancelled {
                guard store != nil, api != nil, store?.api === api else { return }
                await store?.refreshPrerequisiteMetadata()
                do { try await Task.sleep(for: intervals.collection) } catch { return }
            }
        }
        replaceHealth(key: enabled && api != nil ? apiKey : nil, api: api)
        let context = store.permissionContext
        store.collectionAccess.configure(targets: store.requiredAccessTargets, api: enabled ? api : nil, context: context)
        store.applyCollectionHealthEvidence()
        let access = store.collectionAccess
        replace(.access, key: enabled && api != nil ? apiKey + ":" + context : nil) { [access, weak api, intervals] in
            guard let api else { return }
            await access.observe(api: api, refreshInterval: intervals.collection)
        }
        // A foreground operation is bound to the same role, incarnation and API.
        if let pending = lanes[.foreground], pending.key != apiKey { replace(.foreground, key: nil, operation: {}) }
    }

    private func replaceHealth(key: String?, api: DesktopAPI?, force: Bool = false) {
        guard let store else { return }
        if force || lanes[.health]?.key != key { store.collectionHealth.invalidate() }
        let health = store.collectionHealth
        replace(.health, key: key, force: force) { [health, weak api, intervals] in
            guard let api else { return }
            await health.observe(api: api, refreshInterval: intervals.collection)
        }
    }

    func foreground() {
        guard running, let store else { return }
        store.homeServices.refreshClock()
        store.automaticStartup.refresh()
        let api = store.api
        let key = "\(store.state.mode ?? ""):\(store.state.installationId ?? ""):\(store.state.retired == true):" +
            String(describing: api.map(ObjectIdentifier.init))
        guard lanes[.foreground]?.key != key else { return }
        replaceHealth(key: store.state.retired == true || api == nil ? nil : key, api: api, force: true)
        replace(.foreground, key: key) { [weak store, weak api] in
            guard let store else { return }
            if store.state.mode == "home", store.state.retired != true { await store.serverPower.refresh() }
            guard !Task.isCancelled, store.api === api else { return }
            await store.refreshPrerequisiteMetadata()
            guard !Task.isCancelled, store.api === api else { return }
            await store.collectionAccess.foreground(api: api)
        }
    }

    func stop() async {
        running = false
        subscription?.cancel()
        subscription = nil
        let owned = lanes.values.map(\.task)
        lanes = [:]
        owned.forEach { $0.cancel() }
        store?.serverPower.stopMonitoring()
        store?.collectionHealth.invalidate()
        store?.cancelPrerequisiteMetadata()
        for task in owned {
            await task.value
        }
    }

    private func replace(_ lane: Lane, key: String?, force: Bool = false, operation: @escaping @MainActor () async -> Void) {
        if !force, let key, lanes[lane]?.key == key { return }
        let previous = lanes.removeValue(forKey: lane)?.task
        previous?.cancel()
        guard let key else {
            if let previous {
                let id = UUID()
                let joining = Task { await previous.value }
                lanes[lane] = Slot(id: id, key: "stopping", task: joining)
            }
            return
        }
        let id = UUID()
        let task = Task { [weak self] in
            defer {
                if lane == .foreground, self?.lanes[lane]?.id == id { self?.lanes.removeValue(forKey: lane) }
            }
            await previous?.value
            guard !Task.isCancelled, self?.running == true, self?.lanes[lane]?.id == id else { return }
            await operation()
        }
        lanes[lane] = Slot(id: id, key: key, task: task)
    }

    deinit {
        lanes.values.forEach { $0.task.cancel() }
        subscription?.cancel()
    }
}

private final class DesktopPrerequisiteSubscription: @unchecked Sendable {
    private let lock = NSLock()
    private var remove: (() -> Void)?
    init(_ remove: @escaping () -> Void) {
        self.remove = remove
    }

    func cancel() {
        let action = lock.withLock { let current = remove
            remove = nil
            return current
        }
        action?()
    }

    deinit { cancel() }
}
