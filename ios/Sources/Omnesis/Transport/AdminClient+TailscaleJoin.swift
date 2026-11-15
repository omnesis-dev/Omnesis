// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The admin routes behind the Tailscale requests in Waiting for your OK: devices that
/// reached the gateway through the owner's Tailscale network and wait for a decision.
extension AdminClient: TailscaleJoinDeciding {
    public func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/tailscale/join-requests", body: nil)
        struct Envelope: Decodable { let requests: [TailscaleJoinRequest] }
        return try decodeOrThrow(Envelope.self, from: data).requests
    }

    public func decideTailscaleJoin(requestId: String, approve: Bool) async throws -> TailscaleJoinDecision {
        guard let segment = requestId.addingPercentEncoding(withAllowedCharacters: Self.pathSegmentAllowed),
              !segment.isEmpty else {
            throw GatewayClient.Error.invalidURL
        }
        struct Decision: Encodable { let approve: Bool }
        struct Outcome: Decodable { let status: TailscaleJoinDecision }
        let body = try encoder.encode(Decision(approve: approve))
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/tailscale/join-requests/\(segment)/decision",
            body: body
        )
        return try decodeOrThrow(Outcome.self, from: data).status
    }

    /// A request id is one path segment: anything but unreserved characters is escaped.
    private static let pathSegmentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )
}
