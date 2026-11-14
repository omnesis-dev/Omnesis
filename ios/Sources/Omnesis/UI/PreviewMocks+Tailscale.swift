// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import Foundation

/// Invented fixtures for the embedded Tailscale screens: a gateway on a
/// fictional tailnet and devices waiting to join it.
extension PreviewMocks {
    static let tailnetGatewayHost = "omnesis-gateway.tail0a1b2c.ts.net"

    /// Two devices waiting: a collector requested a few minutes ago and a CLI just now.
    static var tailscaleJoinRows: [TailscaleJoinRequest] {
        let now = Date()
        return [
            TailscaleJoinRequest(
                id: "tsj-0001",
                name: "maya-laptop",
                kind: "collector",
                machine: "maya-laptop",
                os: "macOS",
                login: "maya@example.com",
                requestedAt: now.addingTimeInterval(-4 * 60),
                expiresAt: now.addingTimeInterval(6 * 60)
            ),
            TailscaleJoinRequest(
                id: "tsj-0002",
                name: "studio-cli",
                kind: "cli",
                machine: "studio-desktop",
                os: "Linux",
                login: "maya@example.com",
                requestedAt: now.addingTimeInterval(-20),
                expiresAt: now.addingTimeInterval(9 * 60)
            ),
        ]
    }

    static var tailscaleJoinRequestsTwo: PreviewTailscaleJoinRequests {
        PreviewTailscaleJoinRequests(rows: tailscaleJoinRows)
    }

    /// Serves fixed rows. `decisionGone` answers every decision as the gateway does for a
    /// request that expired; `unavailable` fails every read as an unreachable gateway does.
    struct PreviewTailscaleJoinRequests: TailscaleJoinDeciding {
        var rows: [TailscaleJoinRequest]
        var decisionGone = false
        var unavailable = false

        func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest] {
            if unavailable { throw URLError(.cannotConnectToHost) }
            return rows
        }

        func decideTailscaleJoin(requestId _: String, approve: Bool) async throws -> TailscaleJoinDecision {
            if decisionGone { throw GatewayClient.Error.notFound }
            return approve ? .approved : .denied
        }
    }
}
#endif
