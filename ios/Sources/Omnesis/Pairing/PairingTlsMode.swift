// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Persisted TLS authority negotiated by the pairing payload.
/// This file is shared with the notification-service extension.
public enum PairingTlsMode: String, Equatable, Sendable {
    case legacy
    case system
    case pinnedLeaf = "pinned-leaf"
}
