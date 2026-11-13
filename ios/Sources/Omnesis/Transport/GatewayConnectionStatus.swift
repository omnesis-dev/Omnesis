// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What to tell the user about the device socket: wording only, so the copy
/// rules below can be tested without rendering a view.
///
/// Losing the internet must never read like a broken pairing. Temporary states
/// say that recovery is automatic, and advice about pairing appears only for a
/// credential or certificate refusal, or when a usable network has not reached
/// the gateway for long enough that the address itself is a likely cause.
struct GatewayConnectionStatus: Equatable {
    enum Tone: Equatable {
        case success, progress, waiting, warning
    }

    /// About half a minute of backoff on one network, long enough for a network
    /// that has just come back to have settled.
    static let sustainedFailureAttempts = 6

    let title: String
    let tone: Tone
    let explanation: String?
    let diagnostic: String?

    static func pathIndicator(state: DeviceSocket.ConnectionState, selected: GatewayConnectionPath?) -> GatewayConnectionPath? {
        guard let selected else { return nil }
        switch state {
        case .connected: return selected
        case .connecting, .authenticating, .reconnecting: return .reconnecting
        case .disconnected, .failed: return nil
        }
    }

    init(_ state: DeviceSocket.ConnectionState) {
        switch state {
        case .disconnected, .connecting, .authenticating:
            self.init(title: "Connecting…", tone: .progress)
        case .connected:
            self.init(title: "Connected", tone: .success)
        case .reconnecting(let status):
            self.init(reconnecting: status)
        case .failed(let failure):
            self.init(failure: failure)
        }
    }

    private init(title: String, tone: Tone, explanation: String? = nil, diagnostic: String? = nil) {
        self.title = title
        self.tone = tone
        self.explanation = explanation
        self.diagnostic = diagnostic
    }

    private init(reconnecting status: DeviceSocket.ReconnectStatus) {
        switch status.network {
        case .unavailable:
            self.init(
                title: "Waiting for network",
                tone: .waiting,
                explanation: "This phone is offline. Omnesis will reconnect automatically when the network returns.",
                diagnostic: status.lastError
            )
        case .available, .unknown:
            var explanation = "The gateway can't be reached right now. Omnesis keeps trying automatically."
            if status.failedAttemptsOnNetwork >= Self.sustainedFailureAttempts {
                explanation += " Check that the gateway is running. Away from home, connect Tailscale on this phone"
                    + " and the gateway. If this pairing uses a home-network address, re-pair using the gateway's"
                    + " Tailscale hostname."
            }
            self.init(
                title: "Reconnecting to gateway",
                tone: .progress,
                explanation: explanation,
                diagnostic: status.lastError
            )
        }
    }

    private init(failure: DeviceSocket.Failure) {
        switch failure.kind {
        case .authentication:
            self.init(
                title: "Authentication failed",
                tone: .warning,
                explanation: "The gateway rejected this device's pairing. Re-pair from Settings to continue.",
                diagnostic: failure.detail
            )
        case .certificate:
            self.init(
                title: "Couldn't verify gateway certificate",
                tone: .warning,
                explanation: "This phone refused the connection because the gateway's certificate didn't verify."
                    + " A Wi-Fi sign-in page can cause this until you finish signing in. If the gateway's address or"
                    + " certificate changed, re-pair using a new QR code.",
                diagnostic: failure.detail
            )
        case .incompatible:
            self.init(
                title: "App and gateway don't match",
                tone: .warning,
                explanation: "Update the app or the gateway so that both speak the same protocol.",
                diagnostic: failure.detail
            )
        }
    }
}
