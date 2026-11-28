// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// DATA-free metadata query. Neither a selector nor an address confers collection authority.
public enum DesktopBackgroundNearbyQuery {
    public static func perform(
        _ encoded: String,
        runtime: URL,
        lease: DesktopRuntimeUsageLease,
        environment: [String: String]
    ) throws
        -> DesktopNearbyGatewayHints.Snapshot {
        guard lease.requiresDataUsage, environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else {
            throw DesktopDataUsageLease.Failure.missingAuthority
        }
        let descriptor = try DesktopBackgroundDaemonAuthority.decode(encoded, requiresNonce: false)
        guard descriptor.activation == nil, descriptor.epoch == runtime.lastPathComponent else {
            throw DesktopDataUsageLease.Failure.invalidScope
        }
        let profile = try DesktopBackgroundManagedProfile.matching(descriptor.scope.dataScope)
        try profile.validateIdentity()
        let request = DesktopBackgroundLaunchProtocol.Request(
            action: .nearbySnapshot, binding: profile.binding, expectedEpoch: descriptor.epoch
        )
        let reply = try DesktopBackgroundControlClient.exchange(request)
        guard reply.state == .nearbySnapshot, let nearby = reply.nearby else {
            throw DesktopBackgroundSocket.Failure.unavailable
        }
        return nearby
    }
}
