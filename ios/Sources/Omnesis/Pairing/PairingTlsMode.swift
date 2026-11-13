// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Persisted TLS authority negotiated by the pairing payload.
/// This file is shared with the notification-service extension.
public enum PairingTlsMode: String, Equatable, Sendable {
    case legacy
    case system
    case pinnedLeaf = "pinned-leaf"
    /// Account/QR-verified relay key: a different WebPKI-valid certificate must not replace it.
    case pinnedLeafStrict = "pinned-leaf-strict"
    case pinnedKeyStrict = "pinned-key-strict"

    public var isStrict: Bool {
        self == .pinnedLeafStrict || self == .pinnedKeyStrict
    }

    public var requiresPin: Bool {
        self == .pinnedLeaf || self == .pinnedLeafStrict || self == .pinnedKeyStrict
    }
}
