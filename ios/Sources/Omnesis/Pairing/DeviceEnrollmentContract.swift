// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Swift half of `packages/cloud-relay/src/device-enrollment.ts`. Every value
/// must match it byte for byte; `DeviceEnrollmentContractTests` holds the shared
/// cross-platform vectors, so a change here is a change on all platforms.
enum DeviceEnrollmentContract {
    enum Failure: Error, Equatable {
        case invalidField
        case invalidPublicKey
    }

    /// SHA-256 hex of the DER SubjectPublicKeyInfo, used wherever a device key is named.
    static func thumbprint(devicePublicKey: String) throws -> String {
        guard let der = cloudBase64URL(devicePublicKey) else { throw Failure.invalidPublicKey }
        return der.sha256Hex
    }

    /// The one value a sign-in commits to: it names this request and this device key.
    static func enrollmentNonce(
        requestId: String,
        kind: String,
        name: String,
        secret: String,
        devicePublicKey: String
    ) throws
        -> String {
        try cloudDigestURL(transcript([
            "omnesis-device-enrollment-v3",
            requestId,
            kind,
            textDigest(name),
            textDigest(secret),
            thumbprint(devicePublicKey: devicePublicKey),
        ]))
    }

    static func googleProofNonce(salt: String, nonce: String) throws -> String {
        try cloudDigestURL(transcript(["omnesis-google-proof-v3", salt, nonce]))
    }

    /// `issuedAt` is Unix seconds as a decimal string.
    static func passkeyProofChallenge(salt: String, issuedAt: String, nonce: String) throws -> String {
        try cloudDigestURL(transcript(["omnesis-passkey-proof-v3", salt, issuedAt, nonce]))
    }

    // swiftlint:disable:next function_parameter_count
    static func enrollmentSignatureTranscript(
        requestId: String,
        kind: String,
        name: String,
        gatewaySpkiFingerprint: String,
        challenge: String,
        devicePublicKey: String
    ) throws
        -> Data {
        try transcript([
            "omnesis-device-enrollment-signature-v3",
            requestId,
            kind,
            textDigest(name),
            gatewaySpkiFingerprint,
            challenge,
            thumbprint(devicePublicKey: devicePublicKey),
        ])
    }

    static func tokenRotationTranscript(
        deviceId: String,
        gatewaySpkiFingerprint: String,
        challenge: String,
        devicePublicKey: String
    ) throws
        -> Data {
        try transcript([
            "omnesis-device-token-rotation-v1",
            deviceId,
            gatewaySpkiFingerprint,
            challenge,
            thumbprint(devicePublicKey: devicePublicKey),
        ])
    }

    /// `JSON.stringify` of an array of ASCII strings. Written out rather than left to a
    /// JSON encoder, whose spacing and slash escaping are not part of this contract.
    /// Anything that JavaScript would escape is refused instead of being signed.
    static func transcript(_ values: [String]) throws -> Data {
        let quoted = try values.map { value -> String in
            guard value.unicodeScalars.allSatisfy({ (0x20 ... 0x7E).contains($0.value) && $0 != "\"" && $0 != "\\" }) else {
                throw Failure.invalidField
            }
            return "\"\(value)\""
        }
        return Data("[\(quoted.joined(separator: ","))]".utf8)
    }

    private static func textDigest(_ value: String) -> String {
        Data(value.utf8).sha256Hex
    }
}
