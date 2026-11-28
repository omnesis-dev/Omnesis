// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

@MainActor @Observable
final class DesktopMacServerPowerFlow {
    enum Status: Equatable { case needed, checking, ready, sleepEnabled, onBattery, unavailable }
    private(set) var status = Status.needed
    var ready: Bool {
        status == .ready
    }

    private var generation = UUID()
    private var pending: Task<DesktopMacServerPowerObservation, Never>?
    private var refreshAfterPending = false
    private let probe: @Sendable () async -> DesktopMacServerPowerObservation
    private let observeChanges: Bool
    private var monitoringEnabled = true
    @ObservationIgnored private var watcher: DesktopMacServerPowerWatcher?

    init(probe: (@Sendable () async -> DesktopMacServerPowerObservation)? = nil) {
        if let probe { self.probe = probe
            observeChanges = false
        } else { self.probe = { await DesktopMacServerPowerInspector.check() }
            observeChanges = true
        }
    }

    func refresh() async {
        guard monitoringEnabled else { return }
        guard pending == nil else {
            if status == .needed { refreshAfterPending = true }
            return
        }
        if observeChanges {
            if watcher == nil {
                watcher = DesktopMacServerPowerWatcher { [weak self] in
                    guard let self else { return }
                    self.invalidate()
                    Task { await self.refresh() }
                }
            }
            guard watcher?.start() == true else { invalidate()
                status = .unavailable
                return
            }
        }
        let current = generation
        status = .checking
        let probe = probe
        let work = Task { await probe() }
        pending = work
        let result = await withTaskCancellationHandler(operation: { await work.value }, onCancel: { work.cancel() })
        pending = nil
        guard generation == current else {
            if refreshAfterPending {
                refreshAfterPending = false
                // A new request must not inherit the canceled caller that owned the old check.
                let next = Task { await self.refresh() }
                await next.value
            }
            return
        }
        guard !Task.isCancelled else { status = .needed
            return
        }
        switch result.status {
        case .ready: status = .ready
        case .sleepEnabled: status = .sleepEnabled
        case .onBattery: status = .onBattery
        case .unavailable: status = .unavailable
        }
    }

    func invalidate() {
        generation = UUID()
        pending?.cancel()
        refreshAfterPending = pending != nil
        status = .needed
    }

    func startMonitoring() async {
        monitoringEnabled = true
        await refresh()
    }

    func stopMonitoring() {
        monitoringEnabled = false
        invalidate()
        refreshAfterPending = false
        watcher?.stop()
    }
}
