// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The ways a new device can wait for the owner's OK that this phone reviews. Each sits
/// behind its own opt-in, and only a phone with the admin scope reviews either; with both
/// off, Devices shows no Waiting for your OK entry and nothing asks the gateway.
public struct DeviceApprovalKinds: Equatable, Sendable {
    /// Devices that signed in with the owner's Omnesis account: a build with the cloud relay.
    public let cloud: Bool
    /// Devices that reached the gateway through the owner's Tailscale network: a gateway
    /// that runs its own Tailscale device.
    public let tailscale: Bool

    public static let neither = DeviceApprovalKinds(cloud: false, tailscale: false)

    public init(cloud: Bool, tailscale: Bool) {
        self.cloud = cloud
        self.tailscale = tailscale
    }

    /// `tailscaleEmbed` is the gateway saying it runs its own Tailscale device: its status,
    /// or a `tailscale-join` notification it sent before this phone read that status.
    public init(cloudRelayEnabled: Bool, tailscaleEmbed: Bool, scopes: [String]?) {
        let admin = scopes?.contains("admin") == true
        self.init(cloud: cloudRelayEnabled && admin, tailscale: tailscaleEmbed && admin)
    }

    public var any: Bool {
        cloud || tailscale
    }
}
