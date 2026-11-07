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
    public var id: String {
        requestId
    }
}

public protocol GatewayPairingApproving: Sendable {
    func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest]
    func decidePairingApproval(requestId: String, approve: Bool) async throws
}

/// The comparison belongs to this trusted phone and this exact pending SAS.
/// Server-side approval never substitutes for the new device's own comparison.
@MainActor
@Observable
public final class GatewayPairingApprovalModel {
    public private(set) var requests: [GatewayPairingApprovalRequest] = []
    public private(set) var busy = false
    public private(set) var error: Error?
    private var compared: [String: String] = [:]
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
            requests = incoming
            compared = compared.filter { id, code in incoming.contains { $0.id == id && $0.verificationCode == code } }
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

    public func canApprove(_ request: GatewayPairingApprovalRequest) -> Bool {
        !busy && requests.contains(request) && pending(request) && isCompared(request)
    }

    public func decide(_ request: GatewayPairingApprovalRequest, approve: Bool, client: any GatewayPairingApproving) async {
        guard !busy, requests.contains(request), pending(request), !approve || isCompared(request) else { return }
        busy = true
        error = nil
        let operation = generation
        do {
            try await client.decidePairingApproval(requestId: request.id, approve: approve)
            try Task.checkCancellation()
            guard operation == generation else { return }
            requests.removeAll { $0.id == request.id }
            compared[request.id] = nil
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
        error = nil
    }

    private func pending(_ request: GatewayPairingApprovalRequest) -> Bool {
        request.status == "pending" && request.expiresAt > now().timeIntervalSince1970 * 1000
    }

    private static func valid(_ request: GatewayPairingApprovalRequest) -> Bool {
        UUID(uuidString: request.id) != nil && ["ios", "android", "collector", "cli", "portal"].contains(request.kind) &&
            !request.name.isEmpty && request.name.utf16.count <= 80 &&
            ["pending", "approving", "approved", "denied"].contains(request.status) &&
            request.expiresAt.isFinite && request.expiresAt > 0 &&
            request.verificationCode.range(of: "^[0-9A-F]{4}(-[0-9A-F]{4}){4}$", options: .regularExpression) != nil
    }
}
