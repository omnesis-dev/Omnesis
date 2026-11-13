// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One address a device could pair with, judged by the gateway for that device.
/// Mirrors `PairingAddressOption` in `@omnesis/core/pairing-address.ts`: every
/// word shown for an address (`label`, `summary`, `reason`) is the gateway's.
public struct PairingAddressOption: Decodable, Equatable, Sendable, Identifiable {
    public var id: String {
        gatewayUrl
    }

    /// The address to hand back to the gateway unchanged when it encodes the QR.
    public let gatewayUrl: String
    public let host: String
    public let label: String
    public let usable: Bool
    /// Why the device cannot use the address; set on a refused one.
    public let reason: String?
    /// Where a device paired with the address works; set on a usable one.
    public let summary: String?
    public let reach: String?
    /// Whether the gateway encodes this address with platform trust, which is
    /// what lets a person type the address and the code by hand.
    public let systemTrust: Bool?
    /// `relay` on the gateway's Omnesis address, absent on every other one.
    public let kind: String?

    public init(
        gatewayUrl: String,
        host: String,
        label: String,
        usable: Bool = true,
        reason: String? = nil,
        summary: String? = nil,
        reach: String? = nil,
        systemTrust: Bool? = nil,
        kind: String? = nil
    ) {
        self.gatewayUrl = gatewayUrl
        self.host = host
        self.label = label
        self.usable = usable
        self.reason = reason
        self.summary = summary
        self.reach = reach
        self.systemTrust = systemTrust
        self.kind = kind
    }
}

/// What the operator can do when no offered address reaches beyond the local network.
public struct PairingAwayFromHomeHint: Decodable, Equatable, Sendable {
    public let onTailnet: Bool
    public let tailscaleName: String?

    public init(onTailnet: Bool, tailscaleName: String? = nil) {
        self.onTailnet = onTailnet
        self.tailscaleName = tailscaleName
    }
}

/// The gateway's answer to `POST /admin/devices/pair-addresses`.
public struct PairingAddressPlan: Decodable, Equatable, Sendable {
    static let path = "/admin/devices/pair-addresses"

    /// `ios` or `android` for a phone's code, nil for any other device.
    public let platform: String?
    /// Usable addresses best first, then the refused ones.
    public let addresses: [PairingAddressOption]
    public let recommendedUrl: String?
    public let awayFromHome: PairingAwayFromHomeHint?

    public init(
        platform: String?,
        addresses: [PairingAddressOption],
        recommendedUrl: String?,
        awayFromHome: PairingAwayFromHomeHint? = nil
    ) {
        self.platform = platform
        self.addresses = addresses
        self.recommendedUrl = recommendedUrl
        self.awayFromHome = awayFromHome
    }

    public var usable: [PairingAddressOption] {
        addresses.filter(\.usable)
    }

    public var refused: [PairingAddressOption] {
        addresses.filter { !$0.usable }
    }

    /// The usable address at `url`. A refused or unknown address is never selected.
    public func option(at url: String?) -> PairingAddressOption? {
        usable.first { $0.gatewayUrl == url }
    }

    /// "<label> · <host>", marked when it is the gateway's recommendation.
    public func title(_ option: PairingAddressOption) -> String {
        let name = "\(option.label) · \(option.host)"
        return option.usable && option.gatewayUrl == recommendedUrl ? "\(name) (recommended)" : name
    }
}

/// The gateway's address chooser for a pairing code, and the QR it encodes for the chosen address.
public protocol PairingAddressProviding: Sendable {
    func pairAddresses(pairingCode: String) async throws -> PairingAddressPlan
    func buildPairQr(pairingCode: String, gatewayUrl: String) async throws -> String
}

extension AdminClient: PairingAddressProviding {}
