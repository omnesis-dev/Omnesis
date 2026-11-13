// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Something the owner can do to a paired device from its row.
public enum DeviceAction: String, CaseIterable, Sendable {
    case repair, revoke, forget

    public var title: String {
        switch self {
        case .repair: "Repair device"
        case .revoke: "Revoke device"
        case .forget: "Forget device"
        }
    }

    public var symbol: String {
        switch self {
        case .repair: "arrow.triangle.2.circlepath"
        case .revoke, .forget: "trash"
        }
    }

    public var destructive: Bool {
        self != .repair
    }
}

/// One entry of a device's "…" menu.
public struct DeviceMenuItem: Equatable, Identifiable, Sendable {
    public let action: DeviceAction
    public var enabled = true
    public var id: DeviceAction {
        action
    }
}

/// The one list of what a device row offers, in menu order. Every device gets the same
/// actions however it joined: a device that joined by signing in has no extra shortcut.
/// The menu renders this list and nothing else, so changing what a device offers, or in
/// which order, is a change here alone.
public enum DeviceActions {
    /// Non-portal devices can be repaired while offline. A paired device can be revoked;
    /// a revoked device can be repaired or forgotten.
    public static func menu(for device: DeviceRecord, isThis: Bool) -> [DeviceMenuItem] {
        var items: [DeviceMenuItem] = []
        if device.kind != "portal" {
            items.append(DeviceMenuItem(action: .repair, enabled: !isThis && device.online != true))
        }
        items.append(DeviceMenuItem(action: device.isRevoked ? .forget : .revoke))
        return items
    }
}
