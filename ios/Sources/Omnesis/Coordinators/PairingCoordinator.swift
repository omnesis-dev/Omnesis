// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)

/// Owns the pairing service + persisted pairing record.
///
/// This is one of three coordinators extracted
/// from the former 1267-line `AppStore` god class. Responsibilities:
///   - Read / pair / unpair via `PairingService`.
///   - Persist + rehydrate `pairing` across app launches (Keychain via
///     `PairingService.current()`).
///   - Drive the `isRepairing` flag the onboarding view watches so a
///     re-pair flow can skip the welcome copy.
///
/// Cross-coordinator side-effects (rebuilding the collector, restarting
/// the admin client, wiping persisted UserDefaults entries) are NOT
/// done here — `AppStore` orchestrates those after `pair*` / `unpair`
/// succeed. The coordinator only owns the pairing record itself plus
/// the buffer-directory wipe that's pairing-bound (because the buffer
/// payloads are scoped to the old pairing's token).
///
/// Errors funnel through the `onError` closure so `AppStore.lastError`
/// remains the single source of truth for views.
@available(iOS 17.0, *)
@MainActor
@Observable
final class PairingCoordinator {
    /// The currently-loaded pairing record. `nil` when unpaired or
    /// in the gap between `unpair()` and the next successful pair.
    private(set) var pairing: Pairing?

    /// Present when a legacy iCloud-synchronized credential was rejected.
    /// Drives an explanatory onboarding state and may carry only the
    /// non-secret gateway URL as a manual-entry hint.
    private(set) var recovery: PairingRecovery?

    /// True between `beginRepair()` and the next successful pair. Lets
    /// OnboardingView skip its welcome copy and jump straight into the
    /// QR scanner.
    private(set) var isRepairing: Bool = false

    @ObservationIgnored
    private let service: PairingService

    @ObservationIgnored
    private var onError: @MainActor (String?) -> Void = { _ in }

    init(service: PairingService) {
        self.service = service
    }

    /// Wire the error funnel. AppStore calls this once during its own
    /// init after constructing the coordinator (two-phase init: the
    /// coordinator exists before the closure can capture `self`).
    func setOnError(_ handler: @escaping @MainActor (String?) -> Void) {
        self.onError = handler
    }

    /// Hydrate `pairing` from the keychain. Called at launch and after
    /// any pairing-state change AppStore wants to re-read.
    @discardableResult
    func reload() -> PairingLoadState? {
        do {
            let state = try service.load()
            switch state {
            case .paired(let loaded):
                pairing = loaded
                recovery = nil
            case .legacyPairingRequiresRepair(let reason):
                pairing = nil
                recovery = reason
            case .unpaired:
                pairing = nil
                recovery = nil
            }
            onError(nil)
            return state
        } catch {
            // Never leave stale in-memory authority active after a failed
            // Keychain reload.
            pairing = nil
            recovery = nil
            onError("Keychain error: \(error)")
            return nil
        }
    }

    /// Synchronous pair entrypoint. Only supports V1 payloads; V2 needs
    /// `pairAsync(raw:)`.
    /// Returns the new pairing on success so the caller can run cross-
    /// coordinator setup (rebuild collector / admin) without re-reading.
    @discardableResult
    func pair(raw: String) -> Pairing? {
        do {
            let p = try service.pair(raw: raw)
            pairing = p
            recovery = nil
            isRepairing = false
            onError(nil)
            return p
        } catch {
            onError(PairingErrorMessage.message(for: error, payload: raw))
            return nil
        }
    }

    /// Async pair entrypoint. Handles the V2 exchange-code handshake
    /// (POST /devices/pair). Also falls back to V1 for legacy QR payloads.
    @discardableResult
    func pairAsync(raw: String) async -> Pairing? {
        do {
            let p = try await service.pairAsync(raw: raw)
            pairing = p
            recovery = nil
            isRepairing = false
            onError(nil)
            return p
        } catch {
            onError(PairingErrorMessage.message(for: error, payload: raw))
            return nil
        }
    }

    /// Wipe the pairing record from the keychain. Used by both `unpair`
    /// and `beginRepair`. Returns true on success so AppStore knows
    /// whether to proceed with the rest of the unpair sequence.
    @discardableResult
    func clear() -> Bool {
        do {
            try service.clear()
            pairing = nil
            recovery = nil
            return true
        } catch {
            onError("Unpair failed: \(error)")
            return false
        }
    }

    /// Move the active credential into the secure revoke outbox, then expose
    /// the app as unpaired immediately. The returned pairing is safe to use
    /// for this pass; a later launch can reload the same outbox entry.
    func stageUnpair() -> Pairing? {
        do {
            let staged = try service.stageUnpair()
            pairing = nil
            recovery = nil
            return staged
        } catch {
            onError("Unpair failed: \(error)")
            return nil
        }
    }

    func pendingRevocation() -> Pairing? {
        try? service.pendingRevocation()
    }

    func settlePendingRevocation(_ pairing: Pairing) {
        try? service.settlePendingRevocation(pairing)
    }

    /// Mark `isRepairing = true` without touching the keychain. Called
    /// after `clear()` from `beginRepair` so the OnboardingView jumps
    /// straight to the QR scanner.
    func enterRepairMode() {
        isRepairing = true
        onError(nil)
    }

    /// Reset the repairing flag (typically when AppStore decides we're
    /// done with a re-pair flow without it succeeding).
    func exitRepairMode() {
        isRepairing = false
    }

    /// Remove every batch file from the offline buffer directory. Called
    /// on `beginRepair()` so stale batches tied to the old pairing don't
    /// flush against the new gateway. Static because there's no live
    /// pairing at the moment this runs (we're between pairings).
    static func wipeBufferDirectory() {
        let dir = bufferDirectory()
        let fm = FileManager.default
        guard fm.fileExists(atPath: dir.path) else { return }
        if let contents = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil
        ) {
            for url in contents {
                try? fm.removeItem(at: url)
            }
        }
    }

    /// `~/Library/Application Support/Omnesis/buffer/`. Shared with
    /// `SyncCoordinator` (which uses it as the OfflineBuffer root).
    static func bufferDirectory() -> URL {
        let root = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return root.appendingPathComponent("Omnesis/buffer", isDirectory: true)
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension PairingCoordinator {
    func installPreviewState(pairing: Pairing?, recovery: PairingRecovery?) {
        self.pairing = pairing
        self.recovery = recovery
    }
}
#endif

#endif
