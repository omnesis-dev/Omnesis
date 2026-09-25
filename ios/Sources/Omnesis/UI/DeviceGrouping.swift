// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Compact relative time for a unix-millisecond instant (e.g. "3 days ago").
/// Device / token timestamps are unix-ms on the wire (unlike the ISO strings
/// `formatTimeAgo` consumes), so this is the numeric companion. Kept here
/// (UIKit-free) so both the SwiftUI view and the sim-less logic lane use it.
@available(iOS 17.0, *)
func formatUnixMillisAgo(_ millis: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    return date.formatted(.relative(presentation: .named))
}

/// Pure grouping + status helpers for the Devices screen. Kept free of SwiftUI
/// so the logic lane (`swift test`) exercises them without a simulator, and so
/// the This device / Live connections / Other devices rules match the web portal's
/// `device-grouping.js` and the Android `DeviceGrouping`.
enum DeviceGrouping {
    struct Grouped: Equatable {
        /// The device backing the current app session (pinned at the top), or
        /// nil when it isn't in the list / isn't known.
        var thisDevice: DeviceRecord?
        /// Devices with a live WebSocket (minus this device), newest activity first.
        var live: [DeviceRecord]
        /// Other paired devices (minus this device), newest activity first.
        var other: [DeviceRecord]
    }

    /// Split the device list into the three rendered buckets. The current
    /// device is pinned regardless of whether it has a live socket, so the "you are
    /// here" anchor never disappears. A revoked device is never live — a socket
    /// it still holds is being evicted — and sorts after the paired devices.
    static func group(_ devices: [DeviceRecord], thisDeviceId: String?) -> Grouped {
        var thisDevice: DeviceRecord?
        var live: [DeviceRecord] = []
        var other: [DeviceRecord] = []
        for device in devices {
            if let id = thisDeviceId, device.id == id {
                thisDevice = device
                continue
            }
            if device.online == true, !device.isRevoked {
                live.append(device)
            } else {
                other.append(device)
            }
        }
        let byLastSeen: (DeviceRecord, DeviceRecord) -> Bool = {
            ($0.lastSeenAt ?? 0) > ($1.lastSeenAt ?? 0)
        }
        let byRevokedLast: (DeviceRecord, DeviceRecord) -> Bool = {
            if $0.isRevoked != $1.isRevoked { return !$0.isRevoked }
            return byLastSeen($0, $1)
        }
        return Grouped(
            thisDevice: thisDevice,
            live: live.sorted(by: byLastSeen),
            other: other.sorted(by: byRevokedLast)
        )
    }

    /// A revoked device is described as such before anything else. Loading
    /// the list proves the current authenticated client is active. Other live
    /// WebSockets are identified as transport connections; devices without one
    /// are described by recorded activity, not called offline.
    @available(iOS 17.0, *)
    static func statusLine(_ device: DeviceRecord, isCurrent: Bool = false) -> String {
        if let revokedAt = device.revokedAt { return "Revoked \(formatUnixMillisAgo(revokedAt))" }
        if isCurrent { return "Active now" }
        if device.online == true { return "Live connection" }
        if let last = device.lastSeenAt { return "Last active \(formatUnixMillisAgo(last))" }
        return "No activity recorded"
    }

    /// Device WebSockets live in the gateway's current snapshot; a revoked
    /// device's socket is on its way out and does not count.
    static func liveConnectionCount(_ devices: [DeviceRecord]) -> Int {
        devices.count { $0.online == true && !$0.isRevoked }
    }

    /// Devices whose access has been revoked; they keep their row and sources.
    static func revokedCount(_ devices: [DeviceRecord]) -> Int {
        devices.count { $0.isRevoked }
    }
}
