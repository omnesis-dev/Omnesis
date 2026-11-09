// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Standard WebAuthn assertion bytes are verified by the account authority, never trusted as device authorization.
struct AccountPasskeyAssertion: Sendable {
    let credentialId: Data
    let clientData: Data
    let authenticatorData: Data
    let signature: Data
    let userId: Data

    func encoded() throws -> Data {
        guard !credentialId.isEmpty, credentialId.count <= 1024, !clientData.isEmpty, clientData.count <= 16384,
              !authenticatorData.isEmpty, authenticatorData.count <= 16384, !signature.isEmpty, signature.count <= 1024,
              !userId.isEmpty, userId.count <= 64 else { throw AccountPairingError.response }
        struct Response: Encodable { let clientDataJSON: String
            let authenticatorData: String
            let signature: String
            let userHandle: String
        }
        struct Credential: Encodable { let id: String
            let rawId: String
            let type: String
            let response: Response
            let clientExtensionResults: [String: String]
        }
        let id = Self.encode(credentialId)
        return try JSONEncoder().encode(Credential(
            id: id,
            rawId: id,
            type: "public-key",
            response: Response(
                clientDataJSON: Self.encode(clientData),
                authenticatorData: Self.encode(authenticatorData),
                signature: Self.encode(signature),
                userHandle: Self.encode(userId)
            ),
            clientExtensionResults: [:]
        ))
    }

    private static func encode(_ bytes: Data) -> String {
        let base64 = bytes.base64EncodedString()
        let urlSafe = base64.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return urlSafe.replacingOccurrences(of: "=", with: "")
    }
}

struct AccountPasskeyChallenge: Decodable {
    let rpId: String
    let challenge: String
    let userVerification: String
    func validated(expectedRpId: String) throws -> Data {
        guard rpId == expectedRpId, !rpId.isEmpty, userVerification == "required", challenge.range(
            of: "^[A-Za-z0-9_-]{43}$",
            options: .regularExpression
        ) != nil,
            let bytes = cloudBase64URL(challenge), bytes.count == 32 else { throw AccountPairingError.response }
        return bytes
    }
}
