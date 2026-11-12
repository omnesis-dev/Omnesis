// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis

/// A gateway's part of a comparison code, for tests that play the gateway: the first rows of
/// `CODE_VECTOR` in `packages/cloud-relay/src/device-enrollment.test.ts`.
enum PairingCodeFixture {
    static let nonce = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk"
    static let challenge = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs"
    static let otherNonce = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
    static let otherChallenge = "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80"
    /// What `POST /devices/{account,google}/challenge` answers.
    static let challengeReply = Data(#"{"challenge":"\#(challenge)","expiresAt":4102444800000}"#.utf8)

    /// The reply an honest gateway gives a request. `nonce` and `code` let a test lie.
    static func reply(
        to request: CloudPairingChallenge,
        fingerprint: String,
        status: String = "pending",
        expiresAt: Double,
        pairingCode: String? = nil,
        nonce: String = PairingCodeFixture.nonce,
        code: String? = nil
    ) throws
        -> CloudPairingProgress {
        try CloudPairingProgress(
            status: status,
            verificationCode: code ?? request.comparisonCode(fingerprint: fingerprint, codeNonce: nonce),
            codeNonce: nonce,
            expiresAt: expiresAt,
            pairingCode: pairingCode
        )
    }
}

extension CloudPairingConfirmation {
    /// This confirmation after the gateway's challenge arrived, before any reply.
    func committed(to challenge: String = PairingCodeFixture.challenge) throws -> CloudPairingConfirmation {
        var value = self
        try value.commit(to: challenge)
        return value
    }

    /// The reply an honest gateway gives this request. `nonce` and `code` let a test lie.
    func reply(
        _ status: String = "pending",
        expiresAt: Double,
        pairingCode: String? = nil,
        nonce: String = PairingCodeFixture.nonce,
        code: String? = nil
    ) throws
        -> CloudPairingProgress {
        try PairingCodeFixture.reply(
            to: challenge,
            fingerprint: fingerprint,
            status: status,
            expiresAt: expiresAt,
            pairingCode: pairingCode,
            nonce: nonce,
            code: code
        )
    }
}
