// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Why the app is showing onboarding after previously appearing paired.
///
/// Only the gateway URL is retained, as an untrusted convenience hint for
/// manual entry. The inherited token and device identity are always removed.
public struct PairingRecovery: Equatable, Sendable {
    public let gatewayURL: URL?

    public init(gatewayURL: URL?) {
        self.gatewayURL = gatewayURL
    }
}

/// Result of loading the device's pairing state.
public enum PairingLoadState: Equatable, Sendable {
    case unpaired
    case paired(Pairing)
    case legacyPairingRequiresRepair(PairingRecovery)
}

/// A paired gateway, materialized from Keychain.
///
/// `accountId` is the per-source-instance suffix in source ids like
/// `apple-health:<accountId>`. Hardcoded to `"local"`: Omnesis is
/// single-user / single-iPhone, so a constant suffices and survives
/// re-pair, reinstall, and full device wipe. The field stays a
/// string so a future multi-persona world can route via
/// `<persona-id>` from this same site.
///
/// `deviceId` is the gateway-issued device row UUID, used for the
/// device registry / source ownership. Under V1 pairings (legacy)
/// this falls back to the V1 payload's `accountId` field.
///
/// `fingerprint` is the lowercase-hex SHA-256 of the gateway's
/// self-signed leaf cert when the pairing came from a V3 QR. Nil for
/// V1/V2 legacy pairings (no TLS pinning was negotiated). Downstream
/// `URLSession` users should plumb this through `PinnedSession` to
/// pin the gateway cert on every connection.
public struct Pairing: Equatable, Sendable {
    public let url: URL
    public let token: String
    /// Gateway-issued token id. Unlike `deviceId`, this changes on every
    /// successful pair and therefore fences durable work from an older pairing.
    public let pairingGeneration: String?
    public let accountId: String
    public let deviceId: String
    public let gatewayName: String
    /// Granted scopes as returned by the gateway at pair time. Empty for
    /// V1 pairings that predate scoped tokens.
    public let scopes: [String]
    /// Pinned-cert fingerprint (lowercase hex SHA-256) for V3 pairings;
    /// nil for V1/V2 legacy pairings.
    public let fingerprint: String?
    public let spkiFingerprint: String?
    public let directCandidates: [GatewayDirectCandidate]?
    public let tlsMode: PairingTlsMode

    public init(
        url: URL,
        token: String,
        pairingGeneration: String? = nil,
        accountId: String,
        deviceId: String,
        gatewayName: String,
        scopes: [String] = [],
        fingerprint: String? = nil,
        spkiFingerprint: String? = nil,
        directCandidates: [GatewayDirectCandidate]? = nil,
        tlsMode: PairingTlsMode? = nil
    ) {
        self.url = url
        self.token = token
        self.pairingGeneration = pairingGeneration
        self.accountId = accountId
        self.deviceId = deviceId
        self.gatewayName = gatewayName
        self.scopes = scopes
        self.fingerprint = fingerprint
        self.spkiFingerprint = spkiFingerprint
        self.directCandidates = directCandidates
        self.tlsMode = tlsMode ?? (fingerprint == nil ? .legacy : .pinnedLeaf)
    }
}

extension Pairing {
    var directRoute: GatewayDirectRoute? {
        if tlsMode == .pinnedKeyStrict { return try? GatewayDirectRoute.maintained(origin: url, candidates: directCandidates ?? []) }
        guard tlsMode.isStrict, let directCandidates else { return nil }
        return try? GatewayDirectRoute(origin: url, candidates: directCandidates)
    }

    /// The device a hello must answer for. Off the cloud build flag any answer is accepted.
    func expectedSocketDeviceId(cloudRelayEnabled: Bool = CloudRelayFeature.enabled) -> String? {
        cloudRelayEnabled && pairingGeneration != nil ? deviceId : nil
    }

    func makeSocketRoutingSession() -> PinnedSession? {
        guard let route = directRoute else { return nil }
        switch tlsMode {
        case .pinnedKeyStrict:
            return PinnedSession(spkiFingerprint: spkiFingerprint, host: url.host, directRoute: route)
        case .pinnedLeafStrict:
            return PinnedSession(fingerprintHex: fingerprint ?? "", requireCertificateValidity: true, directRoute: route)
        default: return nil
        }
    }
}

/// Response from `POST /devices/pair`. Decoded verbatim from the gateway.
public struct DevicePairResponse: Decodable, Sendable {
    public struct Device: Decodable, Sendable {
        public let id: String
        public let name: String
        public let kind: String
    }

    public let device: Device
    public let tokenId: String
    public let token: String
    public let scopes: [String]
}
