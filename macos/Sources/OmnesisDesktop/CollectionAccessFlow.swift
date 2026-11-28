// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import DesktopCore
import Foundation
import Observation

struct DesktopAccessTarget: Identifiable, Equatable, Encodable {
    let descriptorId: String
    let deviceId: String
    let sourceId: String?
    let accountId: String?
    let params: [String: String]
    var id: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return SHA256.hash(data: (try? encoder.encode(self)) ?? Data()).map { String(format: "%02x", $0) }.joined()
    }
}

extension DesktopAPI {
    func collectionAccess(_ target: DesktopAccessTarget) async throws -> DesktopPermissionObservation {
        var body: [String: Any] = ["deviceId": target.deviceId, "descriptorId": target.descriptorId]
        if target.sourceId == nil { body["params"] = target.params }
        if let source = target.sourceId { body["sourceId"] = source }
        if let account = target.accountId { body["accountId"] = account }
        let result: DesktopPermissionObservation = try await request("POST", "admin/sources/permissions", body: body)
        guard result.deviceId == target.deviceId, result.descriptorId == target.descriptorId, result.sourceId == target.sourceId,
              result.target == "unverified", result.evidenceDate != nil, result.scopeDigest.range(
                  of: "^[a-f0-9]{64}$",
                  options: .regularExpression
              ) != nil else {
            throw DesktopAPIError.message("The access check returned a different source or computer. Check again before continuing.")
        }
        return result
    }
}

@MainActor @Observable
final class DesktopCollectionAccessFlow {
    enum State: Equatable { case needed, checking, available, denied, unavailable, unsupported, notRequired }
    private(set) var target: DesktopAccessTarget?
    private(set) var observation: DesktopPermissionObservation?
    private(set) var state = State.needed
    private(set) var failure: String?
    var navigationMessage: String?
    var restartSuggested = false
    private(set) var restarting = false
    private(set) var unresolvedDenial = false
    private(set) var memberAccessProblem = false
    private var generation = UUID()
    private var request: Task<Void, Never>?
    private var apiIdentity: ObjectIdentifier?
    private var deniedScopeDigest: String?
    private var appliedHealthEvidence: String?
    private var verifiedCollection = false
    private let probe: @MainActor (DesktopAPI, DesktopAccessTarget) async throws -> DesktopPermissionObservation
    init(probe: @escaping @MainActor (DesktopAPI, DesktopAccessTarget) async throws -> DesktopPermissionObservation = { api, target in
        try await api.collectionAccess(target)
    }) {
        self.probe = probe
    }

    var allowsCollection: Bool {
        verifiedCollection && (state == .available || state == .notRequired)
    }

    var hasManagedPublicationGuard: Bool {
        observation?.publicationGuard == "managed-v1" && observation?.requirements?.contains(where: \.blocking) == true
    }

    func configure(_ target: DesktopAccessTarget, api: DesktopAPI) {
        guard self.target != target || apiIdentity != ObjectIdentifier(api) else { return }
        cancel()
        self.target = target
        apiIdentity = ObjectIdentifier(api)
        observation = nil
        verifiedCollection = false
        state = .needed
        failure = nil
        navigationMessage = nil
        restartSuggested = false
        unresolvedDenial = false
        memberAccessProblem = false
        deniedScopeDigest = nil
        appliedHealthEvidence = nil
    }

    func check(api: DesktopAPI) async {
        guard !Task.isCancelled, let target, apiIdentity == ObjectIdentifier(api) else { return }
        if let request {
            await request.value // Includes applying the evidence, not just receiving it.
            return
        }
        let current = generation
        observation = nil // Previous success is not current while fresh evidence is pending.
        verifiedCollection = false
        state = .checking
        failure = nil
        let pending = Task { [self] in
            defer { if generation == current { request = nil } }
            do {
                try Task.checkCancellation()
                let result = try await probe(api, target)
                guard !Task.isCancelled, generation == current, self.target == target else { return }
                observation = result
                let allowed = result.allowsCollection
                verifiedCollection = allowed
                switch result.status {
                case .readable: state = allowed ? .available : .unsupported
                case .notRequired: state = allowed ? .notRequired : .unsupported
                case .denied: state = .denied
                case .unavailable: state = .unavailable
                case .unsupported: state = .unsupported
                }
                if result.status == .denied { unresolvedDenial = true
                    deniedScopeDigest = result.scopeDigest
                } else if allowed || deniedScopeDigest != result.scopeDigest { unresolvedDenial = false
                    deniedScopeDigest = nil
                }
            } catch {
                guard generation == current else { return }
                if Task.isCancelled { state = .needed
                    return
                }
                state = .unavailable
                failure = "Access could not be checked on the selected computer. Keep it awake and connected, then check again."
            }
        }
        request = pending
        await withTaskCancellationHandler(operation: { await pending.value }, onCancel: { pending.cancel() })
    }

    func cancel() {
        generation = UUID()
        request?.cancel()
        request = nil
        restarting = false
        if state == .checking { state = .needed }
    }

    func invalidateEvidenceKeepingDenial() {
        cancel()
        observation = nil
        verifiedCollection = false
        state = .needed
    }

    func invalidateSelection() {
        cancel()
        target = nil
        observation = nil
        verifiedCollection = false
        unresolvedDenial = false
        memberAccessProblem = false
        deniedScopeDigest = nil
        appliedHealthEvidence = nil
        state = .needed
        navigationMessage = nil
    }

    func restartCollector(api: DesktopAPI, execute: @MainActor () async throws -> BridgeValue) async {
        guard let target, apiIdentity == ObjectIdentifier(api), target.deviceId == api.connection.collectorDeviceId, !restarting,
              request == nil else { return }
        let current = generation
        restarting = true
        observation = nil
        verifiedCollection = false
        state = .needed
        defer { if generation == current { restarting = false } }
        do {
            struct Acknowledgement: Decodable { let kind: String
                let status: String
                let deviceId: String
                let permissionRecheckRequired: Bool
            }
            let value = try await execute()
            let ack = try JSONDecoder().decode(Acknowledgement.self, from: JSONEncoder().encode(value))
            guard ack.kind == "desktopCollectorRestart", ack.status == "ready", ack.deviceId == target.deviceId,
                  ack.permissionRecheckRequired else {
                throw DesktopAPIError.message("The collection restart could not be confirmed for this Mac.")
            }
            guard generation == current, !Task.isCancelled else { return }
            navigationMessage = "Collection restarted. Checking its access again…"
        } catch {
            guard generation == current else { return }
            navigationMessage = "The restart was not confirmed. Its access must still be checked; your source choices are kept."
        }
        guard generation == current else { return }
        await check(api: api) // Neither acknowledgment nor cancellation proves file access.
    }

    func foreground(api: DesktopAPI) async {
        // A quick return from System Settings can carry a real permission change.
        // Coalesce the request in check(), without discarding a later activation.
        await check(api: api)
    }

    func observeDenial(scopeDigest: String, checkedAt: String) {
        let key = scopeDigest + ":" + checkedAt
        guard appliedHealthEvidence != key else { return }
        appliedHealthEvidence = key
        memberAccessProblem = true
        let date = ISO8601DateFormatter()
        date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let observed = observation, observed.allowsCollection, let prior = observed.evidenceDate,
           let denial = date.date(from: checkedAt) ?? ISO8601DateFormatter().date(from: checkedAt), denial <= prior { return }
        // A changed digest is a different scope: require a new check, never reuse old approval.
        let matches = observation?.scopeDigest == scopeDigest
        cancel()
        observation = nil
        verifiedCollection = false
        state = matches ? .denied : .needed
        unresolvedDenial = matches
        deniedScopeDigest = matches ? scopeDigest : nil
    }

    func observeSuccessfulCollection() {
        memberAccessProblem = false
    }
}

@MainActor @Observable
final class DesktopCollectionAccessRegistry {
    private(set) var flows: [String: DesktopCollectionAccessFlow] = [:]
    private(set) var context = ""
    private var apiIdentity: ObjectIdentifier?
    var ready: Bool {
        flows.values.allSatisfy { $0.allowsCollection && !$0.memberAccessProblem }
    }

    func configure(targets: [DesktopAccessTarget], api: DesktopAPI?, context: String) {
        guard self.context != context else { return }
        let previous = api.map(ObjectIdentifier.init) == apiIdentity ? flows : [:]
        for flow in flows.values {
            flow.invalidateEvidenceKeepingDenial()
        }
        flows = [:]
        self.context = context
        apiIdentity = api.map(ObjectIdentifier.init)
        guard let api else { return }
        for target in targets {
            // Retain known member failures across metadata refreshes. A root check
            // must not erase a descendant denial while collection is retrying.
            let flow = previous[target.id] ?? DesktopCollectionAccessFlow()
            flow.configure(target, api: api)
            flows[target.id] = flow
        }
    }

    func foreground(api: DesktopAPI?) async {
        guard let api, apiIdentity == ObjectIdentifier(api) else { return }
        let expected = context
        let owned = flows
        for flow in owned.values {
            guard !Task.isCancelled, context == expected else { return }
            await flow.foreground(api: api)
        }
    }

    func observe(api: DesktopAPI?, refreshInterval: Duration = .seconds(30)) async {
        guard let api else { return }
        let owned = flows
        let expectedContext = context
        defer {
            if context == expectedContext { for flow in owned.values {
                flow.cancel()
            } }
        }
        while !Task.isCancelled {
            for flow in owned.values {
                guard !Task.isCancelled, context == expectedContext else { return }
                await flow.check(api: api)
            }
            do { try await Task.sleep(for: refreshInterval) } catch { return }
        }
    }
}
