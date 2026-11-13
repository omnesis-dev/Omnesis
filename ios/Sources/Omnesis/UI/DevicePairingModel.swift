// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

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

/// Which pair-a-device sheet a build presents. With the cloud build flag off it is the
/// sheet of a build without cloud connectivity: it lists `GET /admin/network-identities`,
/// lets the person pick a host and swaps it into the gateway's origin (`swapHost`).
/// With the flag on the gateway judges the addresses (`PairingAddressModel`).
enum PairDeviceSheetStyle: Equatable {
    case networkIdentities
    case addressPlan

    init(cloudRelayEnabled: Bool = CloudRelayFeature.enabled) {
        self = cloudRelayEnabled ? .addressPlan : .networkIdentities
    }
}

/// The address a pairing code will carry: the gateway's plan for the code, the
/// person's choice among its usable addresses, and the QR for that choice.
///
/// The chosen address goes back to the gateway exactly as the gateway gave it.
/// The app never builds one from its own origin: a phone that reaches the
/// gateway through its Omnesis address knows neither the gateway's home
/// addresses nor the port it listens on there.
@MainActor
@Observable
final class PairingAddressModel {
    let pairingCode: String
    /// Phones get a QR for the chosen address; other devices only need the address.
    let encodesQr: Bool
    private(set) var plan: PairingAddressPlan?
    private(set) var planError: Error?
    private(set) var selectedUrl: String?
    private(set) var payload: String?
    private(set) var qrError: Error?

    /// `plan` and `payload` seed a preview or snapshot that never reaches a gateway.
    init(pairingCode: String, encodesQr: Bool, plan: PairingAddressPlan? = nil, payload: String? = nil) {
        self.pairingCode = pairingCode
        self.encodesQr = encodesQr
        self.plan = plan
        self.payload = payload
        selectedUrl = plan?.recommendedUrl
    }

    /// The usable address in effect, or nil while there is none to use.
    var selected: PairingAddressOption? {
        plan?.option(at: selectedUrl)
    }

    /// Typing the address and the code by hand works only where the phone's own trust accepts the gateway.
    var offersManualEntry: Bool {
        selected?.systemTrust == true
    }

    /// Asks the gateway which addresses this code can carry and opens on its recommendation.
    func load(client: any PairingAddressProviding) async {
        guard plan == nil else { return }
        planError = nil
        do {
            let fresh = try await client.pairAddresses(pairingCode: pairingCode)
            plan = fresh
            selectedUrl = fresh.recommendedUrl
        } catch {
            planError = error
            return
        }
        await encode(client: client)
    }

    func select(_ option: PairingAddressOption, client: (any PairingAddressProviding)?) async {
        guard option.usable, option.gatewayUrl != selectedUrl else { return }
        selectedUrl = option.gatewayUrl
        payload = nil
        qrError = nil
        if let client { await encode(client: client) }
    }

    private func encode(client: any PairingAddressProviding) async {
        guard encodesQr, let url = selected?.gatewayUrl else { return }
        payload = nil
        qrError = nil
        do {
            let encoded = try await client.buildPairQr(pairingCode: pairingCode, gatewayUrl: url)
            // A newer choice made meanwhile owns the screen.
            if selectedUrl == url { payload = encoded }
        } catch {
            if selectedUrl == url { qrError = error }
        }
    }
}

/// The pairing screen's own words around the gateway's address plan, matching the
/// portal's pairing dialog (`devices.js`). Labels, summaries and reasons are the gateway's.
enum PairingAddressPresentation {
    static let awayFromHomeDocs = URL(string: "https://omnesis.dev/docs/setup#away-from-home")

    /// What the pairing screen calls the device a code is for.
    static func noun(kind: String) -> String {
        switch kind {
        case "ios": "iPhone"
        case "android": "Android phone"
        default: "device"
        }
    }

    /// "an iPhone", "an Android phone", "a device".
    static func withArticle(_ noun: String) -> String {
        "\(noun == "device" ? "a" : "an") \(noun)"
    }

    static func alternativesTitle(_ plan: PairingAddressPlan) -> String? {
        if plan.usable.count > 1 { return "Use a different address" }
        return plan.refused.isEmpty ? nil : "Why other addresses aren't offered"
    }

    /// Both phones need the gateway host and the phone on one tailnet; an iPhone also
    /// needs a Tailscale certificate, which needs the host's Tailscale name.
    static func awayFromHomeSteps(_ hint: PairingAwayFromHomeHint, platform: String?, noun: String) -> [String] {
        let needsCertificate = platform == "ios"
        var steps: [String] = []
        if !hint.onTailnet {
            steps.append("Install Tailscale on the gateway computer and on the \(noun), and sign both in to the same tailnet.")
        }
        if needsCertificate, hint.onTailnet, hint.tailscaleName == nil {
            steps.append("Turn on MagicDNS for your tailnet in the Tailscale admin console.")
        }
        if needsCertificate {
            let name = hint.tailscaleName.map { " for \($0)" } ?? ""
            steps.append(
                "Turn on HTTPS certificates for your tailnet, then run omnesis tls provision on the gateway computer. "
                    + "It gets a certificate\(name) from Tailscale. Any phone you paired before this step will need to pair again."
            )
        }
        steps.append("Create a new pairing code here and scan it.")
        return steps
    }
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
