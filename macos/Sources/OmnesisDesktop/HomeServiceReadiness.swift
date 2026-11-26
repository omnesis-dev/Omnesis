// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

@MainActor @Observable
final class DesktopHomeServiceReadiness {
    enum Status { case ready, checking, blocked, unavailable }
    private(set) var storage: Status = .unavailable
    private(set) var route: Status = .unavailable
    private struct Receipt {
        let evidence: DesktopServiceAdmission
        let wall: TimeInterval
        let monotonic: TimeInterval
        let deadline: TimeInterval?
        var invalidated = false
    }

    private struct Context: Equatable {
        let identity: String?
        let connection: DesktopConnection?
        let mode: String?
    }

    private var context: Context?
    private var storageReceipt: Receipt?
    private var routeReceipt: Receipt?
    private var generation = UUID()
    private var timer: Task<Void, Never>?
    private let wall: () -> TimeInterval
    private let monotonic: () -> TimeInterval

    init(
        wall: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
        monotonic: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.wall = wall
        self.monotonic = monotonic
    }

    func receive(_ state: DesktopState) {
        let next = Context(identity: state.installationId, connection: state.connection, mode: state.mode)
        let same = context == next
        context = next
        generation = UUID()
        timer?.cancel()
        timer = nil
        guard state.canOpenLibrary, state.mode == "home", state.installationId != nil else {
            storageReceipt = nil
            routeReceipt = nil
            storage = .unavailable
            route = .unavailable
            return
        }
        storageReceipt = receipt(state.storageAdmission, previous: same ? storageReceipt : nil)
        routeReceipt = receipt(state.remoteRoute, previous: same ? routeReceipt : nil)
        refreshClock()
        let epoch = generation
        timer = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = self?.nextDelay() else { return }
                // Check wall-clock discontinuities too; this task never refreshes server evidence.
                do { try await Task.sleep(for: .seconds(min(delay, 1))) } catch { return }
                guard let self, self.generation == epoch else { return }
                self.refreshClock()
            }
        }
    }

    private func receipt(_ evidence: DesktopServiceAdmission?, previous: Receipt?) -> Receipt? {
        guard let evidence else { return nil }
        if let previous, previous.evidence == evidence { return previous }
        let now = wall(), uptime = monotonic()
        let remaining = evidence.validUntil.map { $0 / 1000 - now }
        let deadline = remaining.flatMap { $0.isFinite && $0 > 0 ? uptime + $0 : nil }
        return Receipt(evidence: evidence, wall: now, monotonic: uptime, deadline: deadline)
    }

    /// Explicit foreground validation also detects a changed clock before the next timer tick.
    func refreshClock() {
        storage = status(storageReceipt)
        route = status(routeReceipt)
        if storage == .unavailable { storageReceipt?.invalidated = true }
        if route == .unavailable { routeReceipt?.invalidated = true }
    }

    private func status(_ receipt: Receipt?) -> Status {
        guard let receipt, !receipt.invalidated else { return .unavailable }
        switch receipt.evidence.state {
        case "checking": return .checking
        case "ready", "blocked":
            let elapsed = monotonic() - receipt.monotonic
            guard elapsed >= 0, abs((wall() - receipt.wall) - elapsed) < 2,
                  let deadline = receipt.deadline, monotonic() < deadline,
                  let expiry = receipt.evidence.validUntil, wall() * 1000 < expiry else { return .unavailable }
            return receipt.evidence.state == "ready" ? .ready : .blocked
        default: return .unavailable
        }
    }

    private func nextDelay() -> TimeInterval? {
        refreshClock()
        let deadlines = [(storage, storageReceipt), (route, routeReceipt)].compactMap { status, receipt in
            status == .ready || status == .blocked ? receipt?.deadline : nil
        }
        guard let next = deadlines.min() else { return nil }
        let delay = next - monotonic()
        guard delay > 0 else { refreshClock()
            return nil
        }
        return delay
    }
}
