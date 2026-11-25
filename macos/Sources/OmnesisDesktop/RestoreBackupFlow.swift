// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

@MainActor @Observable
final class DesktopRestoreBackupFlow {
    typealias Request = @MainActor (String, [String: BridgeValue]) async throws -> BridgeValue
    private let request: Request
    private var operation: Task<Void, Never>?
    private(set) var busy = false
    private(set) var cancelling = false
    private(set) var slot: DesktopRestoreImport?
    private(set) var selected: DesktopRestoreFileSelection?
    private(set) var imported = false
    private(set) var preview: DesktopRestorePreview?
    private(set) var outcome: DesktopRestoreOutcome?
    private(set) var status: DesktopRestoreStatus?
    private(set) var startupVerified = false
    private(set) var requiresAccount = false
    private(set) var signup: DesktopState.Signup?
    private var publicationRequested = false
    var recoveryCode = ""
    var recoveryEnvelope: BridgeValue?
    var confirmReplacement = false
    var acknowledgeReadableOriginal = false
    var error: String?

    init(request: @escaping Request) {
        self.request = request
    }

    func observeAccountContext(_ state: DesktopState) {
        if state.phase == .accountRequired { requiresAccount = true
            signup = state.signup
        } else if state
            .canOpenLibrary ||
            (state.mode == "home" && state.encrypted == true && state.searchModel != nil) { requiresAccount = false }
    }

    func connectAccount(params: [String: BridgeValue]) {
        run {
            let state: DesktopState = try await self.call("connect", params: params)
            self.observeAccountContext(state)
            guard !self.requiresAccount, state.mode == "home", state.encrypted == true else {
                throw Self.refusal(state.message ?? "Finish account sign-in before continuing the restoration.")
            }
        }
    }

    func prepareHome(name: String) {
        run {
            let prepared: DesktopState = try await self.call("prepare", params: ["mode": .string("home"), "name": .string(name)])
            self.observeAccountContext(prepared)
            guard prepared.mode == "home", prepared.encrypted == true else {
                throw Self
                    .refusal(
                        "This Mac has not finished preparing encrypted storage. Keep this window open and try again after preparation finishes."
                    )
            }
            self.status = try await self.currentStatus()
            let slot: DesktopRestoreImport = try await self.call("restorePrepareImport")
            guard slot.selectable else { throw Self.refusal("Omnesis could not reserve safe storage for your backup.") }
            self.slot = slot
        }
    }

    var canApply: Bool {
        !busy && confirmReplacement && preview?.confirmation != nil &&
            (preview?.originalMayBeReadable == false || acknowledgeReadableOriginal)
    }

    var needsRecoveryAttention: Bool {
        publicationRequested && outcome == nil && status?.status != .complete && status?.status != .rolledBack
    }

    func begin() {
        run {
            let current = try await self.currentStatus()
            self.status = current
            guard current.status == .idle || current.status == .complete || current.status == .rolledBack else { return }
            let slot: DesktopRestoreImport = try await self.call("restorePrepareImport")
            guard slot.selectable else { throw Self.refusal("Omnesis could not reserve storage for the selected backup.") }
            self.slot = slot
        }
    }

    func select(_ selection: DesktopRestoreFileSelection) {
        guard let slot, slot.selectable, !imported, selection.bytes <= (slot.maxBytes ?? 0) else { return }
        selected = selection
        preview = nil
        confirmReplacement = false
        acknowledgeReadableOriginal = false
        run {
            let result: DesktopRestoreImport = try await self.call("restoreImport", params: [
                "importId": .string(slot.importId), "selection": .object(selection.parameters),
            ])
            guard result.valid, result.importId == slot.importId, result.imported == true, result.bytes == selection.bytes else {
                throw Self.refusal("Omnesis could not verify the selected backup import. Cancel and choose the original archive again.")
            }
            self.imported = true
            try await self.review(slot.importId)
        }
    }

    func unlockOrReview() {
        guard let slot, imported, recoveryCode.count <= 512 else { return }
        let code = recoveryCode
        let envelope = recoveryEnvelope
        recoveryCode = ""
        run { try await self.review(slot.importId, code: code, envelope: envelope) }
    }

    func apply() {
        guard canApply, let token = preview?.confirmation else { return }
        publicationRequested = true
        recoveryCode = ""
        recoveryEnvelope = nil
        run {
            let result: DesktopRestoreOutcome = try await self.call("restoreApply", params: ["confirmationId": .string(token)])
            guard result.valid
            else {
                throw Self.refusal("Omnesis could not confirm that the backup was applied safely. Keep the app open and review recovery.")
            }
            self.outcome = result
            self.status = try await self.currentStatus()
        }
    }

    func startAndVerify(params: [String: BridgeValue] = [:]) {
        guard outcome?.valid == true || status?.status == .pending else { return }
        run {
            let connection: DesktopState = try await self.call("connect", params: params)
            self.observeAccountContext(connection)
            guard connection.canOpenLibrary
            else { throw Self.refusal("Your library did not finish its startup checks. The recovery copy is still available.") }
            let status = try await self.currentStatus()
            self.status = status
            let expected: DesktopRestoreStatus.Status = self.outcome?.status == .rolledBack ? .rolledBack : .complete
            guard status.status == expected
            else {
                throw Self.refusal("The library connected, but restoration has not been verified. Keep the recovery copy and try again.")
            }
            self.startupVerified = true
            self.requiresAccount = false
        }
    }

    func recoverPreviousLibrary() {
        guard let id = status?.recoveryOperation else { return }
        publicationRequested = true
        run {
            let result: DesktopRestoreOutcome = try await self.call("restoreRecover", params: ["operationId": .string(id)])
            guard result.valid,
                  result.status == .rolledBack
            else { throw Self.refusal("Omnesis could not confirm recovery of the previous library. Keep its recovery copy.") }
            self.outcome = result
            self.status = try await self.currentStatus()
        }
    }

    func refreshRecovery() {
        run { self.status = try await self.currentStatus() }
    }

    func cancel() async {
        guard !cancelling else { return }
        cancelling = true
        recoveryCode = ""
        recoveryEnvelope = nil
        operation?.cancel()
        await operation?.value
        do { status = try await currentStatus() }
        catch {
            self.error = "The cancellation outcome could not be checked. Keep your backup and review recovery before starting the library."
            cancelling = false
            return
        }
        // A commit acknowledged after Cancel is still a real commit; preserve its outcome.
        if outcome == nil, !needsRecoveryAttention, let slot {
            do {
                _ = try await request("restoreImportCancel", ["importId": .string(slot.importId)])
                self.slot = nil
                selected = nil
                imported = false
                preview = nil
            } catch { self.error = error.localizedDescription }
        }
        cancelling = false
    }

    private func review(_ id: String, code: String = "", envelope: BridgeValue? = nil) async throws {
        var params: [String: BridgeValue] = ["importId": .string(id)]
        if !code.isEmpty { params["recoveryCode"] = .string(code) }
        if let envelope { params["recoveryEnvelope"] = envelope }
        let value: DesktopRestorePreview = try await call("restorePreview", params: params)
        guard value.kind == "desktopRestorePreview", value.importId == id,
              value.needsRecoveryCode == (value.status == .needsRecoveryCode) else {
            throw Self.refusal("The backup review could not be verified. Cancel and choose the backup again.")
        }
        guard value.needsRecoveryCode || value.confirmation != nil else {
            throw Self.refusal("Omnesis could not verify the backup’s replacement plan and recovery copy. Keep your backup and try again.")
        }
        preview = value
        confirmReplacement = false
        acknowledgeReadableOriginal = false
    }

    private func currentStatus() async throws -> DesktopRestoreStatus {
        let current: DesktopRestoreStatus = try await call("restoreStatus")
        guard current.kind == "desktopRestoreStatus" else { throw Self.refusal("Omnesis could not check backup recovery.") }
        return current
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy, !cancelling else { return }
        busy = true
        error = nil
        operation = Task {
            defer { busy = false
                operation = nil
            }
            do { try await work() }
            catch is CancellationError {}
            catch { self.error = error.localizedDescription }
        }
    }

    private func call<T: Decodable>(_ name: String, params: [String: BridgeValue] = [:]) async throws -> T {
        let value = try await request(name, params)
        do { return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value)) }
        catch { throw Self.refusal("Omnesis returned an unverified backup response. Keep your backup and try again.") }
    }

    private static func refusal(_ message: String) -> DesktopBridgeReplyWaiter.Failure {
        .init(message)
    }
}
