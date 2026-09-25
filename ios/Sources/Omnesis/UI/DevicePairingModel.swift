// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Pure helpers behind the device screens and the pair-a-device flow. Kept
// outside the UIKit-gated views so the simulator-free SwiftPM lane can verify
// kind visibility and the agent setup commands.

/// Build the `gatewayUrl` baked into a pairing QR by swapping the chosen
/// network identity's host into the gateway's own origin — preserving the real
/// scheme and port the gateway is served on. Mirrors the portal's
/// `swapHostForUrl(window.location.origin, host)`. Falls back to an
/// `https://host` URL when no origin is known (no port assumed).
func swapHost(into origin: URL?, host: String) -> String {
    guard var components = origin.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else {
        return "https://\(host)"
    }
    components.host = host
    // Drop a trailing empty path so the URL is just scheme://host[:port].
    if components.path == "/" { components.path = "" }
    return components.string ?? "https://\(host)"
}

/// Resolve an agent setup URL from the selected advertised identity. The
/// gateway's scheme and port stay authoritative; only the host is substituted.
func agentGatewayURL(gatewayOrigin: URL?, identityAddresses: [String], selectedIndex: Int) -> String? {
    guard !identityAddresses.isEmpty else {
        return gatewayOrigin?.absoluteString
    }
    let boundedIndex = min(max(selectedIndex, 0), identityAddresses.count - 1)
    return swapHost(into: gatewayOrigin, host: identityAddresses[boundedIndex])
}

/// Exact one-shot setup commands shown after minting an agent-integration
/// pairing code. Agent harnesses redeem the code through `omnesis connect`;
/// the generic device-pair endpoint is not their operator-facing setup path.
func agentConnectCommands(gatewayURL: String?, pairingCode: String) -> [String] {
    var gateway = gatewayURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    while gateway.hasSuffix("/") {
        gateway.removeLast()
    }
    if gateway.isEmpty {
        gateway = "<gateway-url>"
    }
    return ["openclaw", "hermes"].map {
        "omnesis connect \($0) --gateway-url \(gateway) --code \(pairingCode)"
    }
}

/// Generic device-kind metadata shared by device screens and pairing logic.
/// The scopes a kind is granted are the gateway's decision: pairing sends the
/// kind alone and the gateway fills in its canonical grant.
enum DeviceKindMeta {
    static func label(_ kind: String) -> String {
        switch kind {
        case "collector": "Collector"
        case "cli": "CLI"
        case "portal": "Portal"
        case "ios": "iOS app"
        case "android": "Android app"
        case "agent": "Agent integration"
        case "integration": "Integration"
        case "browser": "Browser extension"
        default: kind
        }
    }

    static func icon(_ kind: String) -> String {
        switch kind {
        case "collector": "laptopcomputer"
        case "cli": "terminal"
        case "portal": "macwindow"
        case "ios": "iphone"
        case "android": "candybarphone"
        case "agent": "network"
        // Third-party code plugged into Omnesis, matching the portal's plug glyph.
        case "integration": "powerplug"
        case "browser": "puzzlepiece.extension"
        default: "laptopcomputer"
        }
    }

    static func usesQr(_ kind: String) -> Bool {
        kind == "ios" || kind == "android"
    }

    /// Device kinds offered when pairing (the portal's `DEVICE_KINDS`, less
    /// `integration`: an integration's access level is chosen with its code,
    /// which only a portal session may do).
    static let pairKinds = ["collector", "cli", "portal", "ios", "android", "agent", "browser"]
}
