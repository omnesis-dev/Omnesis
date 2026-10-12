// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension PairingCredentialBundle {
    /// The bundle that persists `pairing` at `url` under the given trust.
    /// Every other field, including the pairing generation, is carried over,
    /// so a rewrite of one field never drops another.
    init(_ pairing: Pairing, url: URL, tlsMode: PairingTlsMode, fingerprint: String?) {
        self.init(
            url: url.absoluteString,
            token: pairing.token,
            pairingGeneration: pairing.pairingGeneration,
            accountId: pairing.accountId,
            deviceId: pairing.deviceId,
            name: pairing.gatewayName,
            scopes: pairing.scopes,
            tlsMode: tlsMode.rawValue,
            fingerprint: fingerprint
        )
    }
}
