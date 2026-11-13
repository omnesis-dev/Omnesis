// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension AdminClient {
    /// GET `/admin/network-identities` — the addresses this gateway is
    /// reachable at (LAN, mDNS, Tailscale). The pairing flow lets the user
    /// pick which one bakes into the QR's `gatewayUrl` so the new phone can
    /// reach the gateway from whatever network it's on. The pair sheet of a
    /// build with the cloud build flag off (`LegacyPairDeviceView`) lists them.
    public func listNetworkIdentities() async throws -> [NetworkIdentity] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/network-identities", body: nil)
        return try decodeOrThrow(Page<NetworkIdentity>.self, from: data).items
    }
}
