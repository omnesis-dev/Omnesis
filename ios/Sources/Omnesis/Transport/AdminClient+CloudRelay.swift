// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Whether the person connecting a gateway is making an Omnesis account or already has one.
public enum CloudRelayConnectIntent: String, Encodable, Equatable, Sendable {
    case create, existing
}

/// A change made from the Omnesis account screen. Each one answers the gateway's new relay status.
public enum CloudRelayOperation: Equatable, Sendable {
    case connect(CloudRelayConnectIntent)
    case cancelConnect
    case enable
    case disable
    case reconnect
    case accountUnlink
    case googleUnlink
    case setEnrollmentPolicy(String)

    var method: String {
        if case .setEnrollmentPolicy = self { "PUT" } else { "POST" }
    }

    /// The route under `/admin/cloud-relay/`.
    var route: String {
        switch self {
        case .connect: "connect"
        case .cancelConnect: "connect/cancel"
        case .enable: "enable"
        case .disable: "disable"
        case .reconnect: "reconnect"
        case .accountUnlink: "account/unlink"
        case .googleUnlink: "google/unlink"
        case .setEnrollmentPolicy: "enrollment"
        }
    }

    func body(_ encoder: JSONEncoder) throws -> Data {
        struct Connect: Encodable {
            let termsAccepted = true
            let intent: CloudRelayConnectIntent
        }
        struct Policy: Encodable { let policy: String }
        return switch self {
        case .connect(let intent): try encoder.encode(Connect(intent: intent))
        case .setEnrollmentPolicy(let policy): try encoder.encode(Policy(policy: policy))
        default: Data("{}".utf8)
        }
    }
}

public protocol CloudRelayManaging: Sendable {
    /// Throws `GatewayClient.Error.notFound` when this gateway offers no Omnesis account.
    func cloudRelayStatus() async throws -> CloudRelayStatus
    func cloudRelay(_ operation: CloudRelayOperation) async throws -> CloudRelayStatus
}

extension AdminClient: CloudRelayManaging {
    public func cloudRelayStatus() async throws -> CloudRelayStatus {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/cloud-relay", body: nil)
        return try decodeOrThrow(CloudRelayStatus.self, from: data)
    }

    public func cloudRelay(_ operation: CloudRelayOperation) async throws -> CloudRelayStatus {
        let (data, _) = try await dispatch(
            method: operation.method,
            path: "/admin/cloud-relay/\(operation.route)",
            body: operation.body(encoder)
        )
        return try decodeOrThrow(CloudRelayStatus.self, from: data)
    }
}
