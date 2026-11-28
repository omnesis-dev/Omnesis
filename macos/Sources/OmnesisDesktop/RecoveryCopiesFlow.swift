// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

@MainActor @Observable
final class DesktopRecoveryCopiesFlow {
    typealias Request = @MainActor (String, [String: BridgeValue]) async throws -> BridgeValue
    private let request: Request
    @ObservationIgnored private var active: Task<BridgeValue, Error>?
    private var selectedStaging = false
    private(set) var catalog: DesktopRecoveryCopiesCatalog?
    private(set) var preview: DesktopRecoveryCleanupPreview?
    private(set) var busy = false
    private(set) var stopping = false
    private(set) var catalogCurrent = true
    private(set) var progress = "Checking recovery copies…"
    private(set) var error: String?
    private(set) var notice: String?
    var canStop: Bool {
        busy && active != nil
    }

    init(catalog: DesktopRecoveryCopiesCatalog? = nil, preview: DesktopRecoveryCleanupPreview? = nil, request: @escaping Request) {
        self.catalog = catalog?.valid == true ? catalog : nil
        self.preview = preview?.valid == true ? preview : nil
        self.request = request
    }

    func refresh() async {
        guard !busy else { return }
        begin("Checking recovery copies…")
        defer { busy = false }
        do { catalog = try await callCatalog("recoveryCopies")
            catalogCurrent = true
        } catch is CancellationError {} catch { self.error = error.localizedDescription
            catalogCurrent = false
        }
    }

    func setPinned(_ id: String, _ pinned: Bool) async {
        guard !busy, catalogCurrent, let catalog, catalog.pending == nil,
              let copy = catalog.items.first(where: { $0.id == id }), copy.disposition != .unavailable else { return }
        begin("Saving your keep choice…")
        defer { busy = false }
        do {
            let fresh = try await callCatalog("recoveryCopyPin", params: ["id": .string(id), "pinned": .bool(pinned)])
            try Task.checkCancellation()
            guard fresh.items.contains(where: { $0.id == id && $0.pinned == pinned }) else {
                throw Failure("Omnesis did not confirm your keep choice. Refresh the list before trying again.")
            }
            self.catalog = fresh
            notice = "Keep choice saved. Copies still needed for recovery remain protected."
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    func review(_ id: String, staging: Bool = false, partial: Bool = false) async {
        guard !busy, catalogCurrent, let catalog, catalog.pending == nil else { return }
        if partial {
            guard catalog.partialCopies
                .contains(where: { $0.id == id && $0.staging == staging && $0.ownership == .verified && $0.canReview }) else { return }
        } else {
            guard catalog.items.contains(where: { $0.id == id && !$0.pinned && $0.canReview &&
                    [.redundantSnapshot, .lastCopyOldEpoch].contains($0.disposition)
            }) else { return }
        }
        begin("Verifying the selected recovery copy…")
        preview = nil
        defer { busy = false
            stopping = false
        }
        do {
            let value = try await execute("recoveryCopyPreview", params: ["id": .string(id), "incompleteStaging": .bool(staging)])
            let result = try decode(DesktopRecoveryCleanupPreview.self, value)
            guard !stopping, !Task.isCancelled else { notice = "Review cancelled. No copy was removed."
                return
            }
            guard result.valid, result.id == id, (result.mode == .incompleteOwned) == partial else {
                throw Failure("The recovery copy could not be verified. Refresh the list before trying again.")
            }
            selectedStaging = staging
            preview = result
        } catch is CancellationError { notice = "Review cancelled. No copy was removed." }
        catch { self.error = error.localizedDescription }
        stopping = false
    }

    func dismissReview() {
        if !busy { preview = nil }
    }

    func cancelActive() {
        guard busy, active != nil else { return }
        stopping = true
        active?.cancel()
    }

    func removeReviewed(confirmationId: String? = nil) async {
        guard !busy, catalogCurrent, let preview, preview.valid,
              confirmationId == nil || preview.confirmationId == confirmationId else { return }
        let staging = selectedStaging
        self.preview = nil
        await mutate(
            "recoveryCopyRemove",
            params: [
                "id": .string(preview.id),
                "confirmationId": .string(preview.confirmationId),
                "incompleteStaging": .bool(staging),
            ],
            snapshotId: preview.id,
            partial: preview.mode == .incompleteOwned,
            staging: staging
        )
    }

    func retryPending(expectedId: String? = nil) async {
        guard !busy, catalogCurrent, let pending = catalog?.pending, pending.hasCleanupBinding,
              expectedId == nil || expectedId == pending.id,
              let id = pending.snapshotId, let staging = pending.staging, let mode = pending.mode else { return }
        await mutate(
            "recoveryCopyRetry",
            params: ["operationId": .string(pending.id)],
            snapshotId: id,
            partial: mode == .incompleteOwned,
            staging: staging,
            expectedOperation: pending.id
        )
    }

    func cancelPending(expectedId: String? = nil) async {
        guard !busy, catalogCurrent, let pending = catalog?.pending, pending.hasCleanupBinding,
              expectedId == nil || expectedId == pending.id,
              pending.phase == .planned, pending.canCancel else { return }
        begin("Cancelling the pending removal…")
        catalogCurrent = false
        defer { busy = false
            stopping = false
        }
        var confirmed = false
        do {
            let value = try await execute("recoveryCopyCancel", params: ["operationId": .string(pending.id)])
            let result = try decode(DesktopRecoveryCopiesCatalog.self, value)
            guard result.valid, result.pending == nil else { throw Failure("Omnesis has not confirmed cancellation.") }
            catalog = result
            confirmed = true
        } catch { self.error = error.localizedDescription }
        if await refreshAfterMutation() {
            let available = pending.mode == .incompleteOwned
                ? catalog?.partialCopies
                .contains(where: { $0.id == pending.snapshotId && $0.staging == pending.staging && $0.ownership == .verified }) == true
                : catalog?.items.contains(where: { $0.id == pending.snapshotId && $0.disposition != .unavailable }) == true
            if confirmed, catalog?.pending == nil, available { notice = "Pending removal cancelled. Recovery copies were kept."
                error = nil
            } else { error = "Cancellation could not be confirmed. Review the current list before continuing." }
        }
    }

    private func mutate(
        _ command: String,
        params: [String: BridgeValue],
        snapshotId: String,
        partial: Bool,
        staging: Bool,
        expectedOperation: String? = nil
    ) async {
        begin("Removing the selected automatic recovery copy…")
        catalogCurrent = false
        defer { busy = false
            stopping = false
        }
        var confirmed: DesktopRecoveryCleanupOutcome?
        do {
            let result = try await decode(DesktopRecoveryCleanupOutcome.self, execute(command, params: params))
            guard result.valid, result.id == snapshotId,
                  expectedOperation == nil || result.operationId == expectedOperation else {
                throw Failure("Omnesis did not confirm removal of the selected copy.")
            }
            confirmed = result
        } catch { self.error = error.localizedDescription }
        if await refreshAfterMutation() {
            if let confirmed, let catalog, catalog.pending?.id != confirmed.operationId,
               partial ? !catalog.partialCopies.contains(where: { $0.id == snapshotId && $0.staging == staging })
               : !catalog.items.contains(where: { $0.id == snapshotId }) {
                notice = stopping ? "Removal finished before stopping. The current list is shown." : "Automatic recovery copy removed."
                error = nil
            } else if catalog?.pending != nil {
                error = "Removal has not finished. Review the pending operation below. Other copies were kept."
            } else {
                error = "Removal could not be confirmed. The current list is shown; review it before continuing."
            }
        }
    }

    /// A fresh task is intentionally not cancelled with the drained mutation: its observed journal
    /// decides whether removal committed, remains pending, or needs another refresh.
    private func refreshAfterMutation() async -> Bool {
        progress = "Checking the current recovery-copy status…"
        do {
            let fresh = try await Task { @MainActor in try await self.callCatalog("recoveryCopies") }.value
            catalog = fresh
            catalogCurrent = true
            return true
        } catch {
            self.error = "The current recovery-copy status is unavailable. Refresh the list before continuing."
            catalogCurrent = false
            return false
        }
    }

    private func begin(_ text: String) {
        busy = true
        stopping = false
        progress = text
        error = nil
        notice = nil
    }

    private func execute(_ name: String, params: [String: BridgeValue]) async throws -> BridgeValue {
        let task = Task { @MainActor in try await request(name, params) }
        active = task
        defer { active = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: BridgeValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    private func callCatalog(_ name: String, params: [String: BridgeValue] = [:]) async throws -> DesktopRecoveryCopiesCatalog {
        let result = try await decode(DesktopRecoveryCopiesCatalog.self, request(name, params))
        guard result.valid else { throw Failure("Omnesis could not read the recovery-copy list safely. Refresh it and try again.") }
        return result
    }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) {
            errorDescription = message
        }
    }
}
