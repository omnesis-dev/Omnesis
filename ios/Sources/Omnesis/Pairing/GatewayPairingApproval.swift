// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

public struct GatewayPairingApprovalRequest: Decodable, Equatable, Identifiable, Sendable {
    public let requestId: String
    public let kind: String
    public let name: String
    public let status: String
    public let verificationCode: String
    public let expiresAt: Double
    /// How the device signed in, once the gateway verified that sign-in.
    public var signIn: String?
    /// The gateway can add this request's sign-in to Trusted sign-ins.
    public var canTrustSignIn: Bool?
    /// Its device key belongs to a device the owner removed before.
    public var revokedDevice: Bool?
    public var id: String {
        requestId
    }
}

public protocol GatewayPairingApproving: Sendable {
    func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest]
    func decidePairingApproval(requestId: String, approve: Bool) async throws
    func decidePairingApproval(requestId: String, approve: Bool, trustSignIn: Bool) async throws
    /// The gateway's own page that approves `requestId` with the owner's passkey, for a phone the
    /// gateway asks to confirm it's the owner first.
    func approvalPage(requestId: String) -> URL?
}

extension GatewayPairingApproving {
    public func decidePairingApproval(requestId: String, approve: Bool, trustSignIn: Bool) async throws {
        try await decidePairingApproval(requestId: requestId, approve: approve)
    }

    public func approvalPage(requestId _: String) -> URL? {
        nil
    }
}

/// An approval the gateway would not take from this phone until the owner confirms it's them.
public struct PairingStepUp: Equatable, Sendable {
    public let requestId: String
    public let refusal: StepUpRefusal
}

/// The comparison belongs to this trusted phone and this exact pending SAS.
/// Server-side approval never substitutes for the new device's own comparison.
@MainActor
@Observable
public final class GatewayPairingApprovalModel {
    public private(set) var requests: [GatewayPairingApprovalRequest] = []
    public private(set) var busy = false
    public private(set) var error: Error?
    /// The approval the gateway asked to confirm on its own page. The request stays listed.
    public private(set) var stepUp: PairingStepUp?
    /// The device just denied, for the follow-up that offers to make every new device ask first.
    public private(set) var denied: GatewayPairingApprovalRequest?
    /// The follow-up was taken: new devices now always ask.
    public private(set) var askingFirst = false
    private var compared: [String: String] = [:]
    private var trustedSignIns: Set<String> = []
    private var generation = UUID()
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = Date.init) {
        self.now = now
    }

    public func refresh(client: any GatewayPairingApproving) async {
        guard !busy else { return }
        busy = true
        error = nil
        let operation = generation
        do {
            let incoming = try await client.pairingApprovalRequests()
            try Task.checkCancellation()
            guard operation == generation else { return }
            guard incoming.count <= 128, Set(incoming.map(\.id)).count == incoming.count,
                  incoming.allSatisfy(Self.valid) else { throw CloudPairingError.response }
            // Only what still needs a decision is listed. The gateway keeps a decided request for a
            // few minutes so the new device can read its answer; the owner has no use for it.
            requests = incoming.filter { $0.status == "pending" } + incoming.filter { $0.status == "approving" }
            compared = compared.filter { id, code in incoming.contains { $0.id == id && $0.verificationCode == code } }
            trustedSignIns = trustedSignIns.filter { id in incoming.contains { $0.id == id && $0.canTrustSignIn == true } }
            if let stepUp, !requests.contains(where: { $0.id == stepUp.requestId }) { self.stepUp = nil }
        } catch {
            guard operation == generation else { return }
            self.error = error
        }
        busy = false
    }

    public func setCompared(_ value: Bool, requestId: String) {
        guard let request = requests.first(where: { $0.id == requestId }), pending(request) else { return }
        compared[requestId] = value ? request.verificationCode : nil
    }

    public func isCompared(_ request: GatewayPairingApprovalRequest) -> Bool {
        compared[request.id] == request.verificationCode
    }

    /// Off by default: trusting a sign-in lets it join new devices without asking.
    public func setTrustSignIn(_ value: Bool, requestId: String) {
        guard requests.contains(where: { $0.id == requestId && $0.canTrustSignIn == true }) else { return }
        if value { trustedSignIns.insert(requestId) } else { trustedSignIns.remove(requestId) }
    }

    public func trustsSignIn(_ request: GatewayPairingApprovalRequest) -> Bool {
        trustedSignIns.contains(request.id)
    }

    public func canApprove(_ request: GatewayPairingApprovalRequest) -> Bool {
        !busy && requests.contains(request) && pending(request) && isCompared(request)
    }

    /// The button confirms the exact displayed request and approves it in one action.
    public func confirmAndApprove(_ request: GatewayPairingApprovalRequest, client: any GatewayPairingApproving) async {
        guard !busy, requests.contains(request), pending(request) else { return }
        compared[request.id] = request.verificationCode
        await decide(request, approve: true, client: client)
    }

    public func decide(_ request: GatewayPairingApprovalRequest, approve: Bool, client: any GatewayPairingApproving) async {
        guard !busy, requests.contains(request), pending(request), !approve || isCompared(request) else { return }
        busy = true
        error = nil
        stepUp = nil
        denied = nil
        let operation = generation
        do {
            if approve, trustsSignIn(request) {
                try await client.decidePairingApproval(requestId: request.id, approve: true, trustSignIn: true)
            } else {
                try await client.decidePairingApproval(requestId: request.id, approve: approve)
            }
            try Task.checkCancellation()
            guard operation == generation else { return }
            requests.removeAll { $0.id == request.id }
            compared[request.id] = nil
            trustedSignIns.remove(request.id)
            if !approve { denied = request }
        } catch {
            guard operation == generation else { return }
            // The gateway keeps the request; its own page can approve it with the owner's passkey.
            if approve, let refusal = StepUpRefusal(error) {
                stepUp = PairingStepUp(requestId: request.id, refusal: refusal)
            } else {
                self.error = error
            }
        }
        busy = false
    }

    /// After a denial: every new device asks first from now on. This only makes the gateway
    /// stricter, so the gateway never asks to confirm it.
    public func askFirst(client: any CloudRelayManaging) async {
        guard !busy, denied != nil, !askingFirst else { return }
        busy = true
        error = nil
        let operation = generation
        do {
            _ = try await client.cloudRelay(.setEnrollmentPolicy("ask"))
            guard operation == generation else { return }
            askingFirst = true
        } catch {
            guard operation == generation else { return }
            self.error = error
        }
        busy = false
    }

    public func stop() {
        generation = UUID()
        busy = false
        requests = []
        compared = [:]
        trustedSignIns = []
        error = nil
        stepUp = nil
        denied = nil
        askingFirst = false
    }

    private func pending(_ request: GatewayPairingApprovalRequest) -> Bool {
        request.status == "pending" && request.expiresAt > now().timeIntervalSince1970 * 1000
    }

    private static func valid(_ request: GatewayPairingApprovalRequest) -> Bool {
        UUID(uuidString: request.id) != nil && ["ios", "android", "collector", "cli", "portal"].contains(request.kind) &&
            !request.name.isEmpty && request.name.utf16.count <= 80 &&
            ["pending", "approving", "approved", "denied"].contains(request.status) &&
            request.expiresAt.isFinite && request.expiresAt > 0 &&
            PairingComparisonCode.canonical(request.verificationCode)
    }
}
