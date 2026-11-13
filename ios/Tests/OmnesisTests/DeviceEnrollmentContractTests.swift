// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
@testable import Omnesis
import XCTest

/// The shared vectors from `packages/cloud-relay/src/device-enrollment.test.ts`. A change
/// to one of these values is a change on every platform.
final class DeviceEnrollmentContractTests: XCTestCase {
    private let requestId = "11111111-2222-4333-8444-555555555555"
    private let kind = "ios"
    private let deviceName = "Maya\u{2019}s iPhone \"16\"/\u{E9}"
    private let secret = String(repeating: "a", count: 64)
    private let devicePublicKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGDyDirEL2lrGjSPy-YBjzDVmi8d4E-aXEboSjkFDnKjznab2Nbec2vu4J71RIvZmTL820xIfaxzOyXItT91cdQ"
    private let salt = "c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ"
    private let issuedAt = "1794240000"
    private let challenge = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw"
    private let gatewaySpkiFingerprint = String(repeating: "b", count: 64)
    private let nonce = "omSCKSEVp23kSohLBrNIqacoYRMiGzYGcjIUhbS6Utw"

    func testThumbprint() throws {
        XCTAssertEqual(
            try DeviceEnrollmentContract.thumbprint(devicePublicKey: devicePublicKey),
            "cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"
        )
    }

    func testEnrollmentNonce() throws {
        XCTAssertEqual(
            try DeviceEnrollmentContract.enrollmentNonce(
                requestId: requestId,
                kind: kind,
                name: deviceName,
                secret: secret,
                devicePublicKey: devicePublicKey
            ),
            nonce
        )
    }

    func testGoogleNonce() throws {
        XCTAssertEqual(
            try DeviceEnrollmentContract.googleProofNonce(salt: salt, nonce: nonce),
            "Z8TU9qZKGsXtT1SY13KcNLty5tRqlNr5UOvTqPcJeLc"
        )
    }

    func testPasskeyChallenge() throws {
        XCTAssertEqual(
            try DeviceEnrollmentContract.passkeyProofChallenge(salt: salt, issuedAt: issuedAt, nonce: nonce),
            "f-WX4FvBop2svycIMkHI019J6CxVseoBQsoKmoY5fHo"
        )
    }

    func testSignatureTranscript() throws {
        let transcript = try DeviceEnrollmentContract.enrollmentSignatureTranscript(
            requestId: requestId,
            kind: kind,
            name: deviceName,
            gatewaySpkiFingerprint: gatewaySpkiFingerprint,
            challenge: challenge,
            devicePublicKey: devicePublicKey
        )
        XCTAssertEqual(
            String(bytes: transcript, encoding: .utf8),
            #"["omnesis-device-enrollment-signature-v3","11111111-2222-4333-8444-555555555555","ios","#
                + #""5c543853f1bb8064d21e95a3a933cfbbb10f33c138e380e7003a483501b0b7a9","#
                + #""bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","#
                + #""Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","#
                + #""cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]"#
        )
    }

    func testRotationTranscript() throws {
        let transcript = try DeviceEnrollmentContract.tokenRotationTranscript(
            deviceId: "99999999-8888-4777-8666-555555555555",
            gatewaySpkiFingerprint: gatewaySpkiFingerprint,
            challenge: challenge,
            devicePublicKey: devicePublicKey
        )
        XCTAssertEqual(
            String(bytes: transcript, encoding: .utf8),
            #"["omnesis-device-token-rotation-v1","99999999-8888-4777-8666-555555555555","#
                + #""bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","#
                + #""Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","#
                + #""cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]"#
        )
    }

    func testTranscriptNeverEscapesSlashesAndRefusesWhatJavaScriptWouldEscape() throws {
        XCTAssertEqual(try DeviceEnrollmentContract.transcript(["a/b", "c d"]), Data(#"["a/b","c d"]"#.utf8))
        for value in ["quote\"", "back\\slash", "caf\u{E9}", "line\nbreak", "\u{7F}"] {
            XCTAssertThrowsError(try DeviceEnrollmentContract.transcript([value]))
        }
    }

    func testAKeyIsKeptPerInstallAndSignsWhatAGatewayVerifies() throws {
        let store = InMemoryStore()
        let key = try DeviceEnrollmentKey.loadOrCreate(store: store, enclaveAvailable: false)
        let again = try DeviceEnrollmentKey.loadOrCreate(store: store, enclaveAvailable: false)
        XCTAssertEqual(key.publicKey, again.publicKey)
        XCTAssertNotEqual(key.publicKey, try DeviceEnrollmentKey.loadOrCreate(store: InMemoryStore(), enclaveAvailable: false).publicKey)

        let transcript = Data("transcript".utf8)
        let publicKey = try P256.Signing.PublicKey(derRepresentation: XCTUnwrap(cloudBase64URL(key.publicKey)))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(cloudBase64URL(key.sign(transcript))))
        XCTAssertTrue(publicKey.isValidSignature(signature, for: transcript))
        XCTAssertFalse(publicKey.isValidSignature(signature, for: Data("other".utf8)))
    }

    func testAKeychainThatCannotBeReadIsNotAnsweredWithANewKey() throws {
        let store = FailingStore()
        XCTAssertThrowsError(try DeviceEnrollmentKey.loadOrCreate(store: store, enclaveAvailable: false))
        XCTAssertEqual(store.writes, 0)
    }

    func testAnUnusableItemIsReplaced() throws {
        let store = InMemoryStore()
        try store.set("software:not-base64!", forKey: "device.enrollment.key.v1")
        let key = try DeviceEnrollmentKey.loadOrCreate(store: store, enclaveAvailable: false)
        XCTAssertEqual(key.publicKey, try DeviceEnrollmentKey.loadOrCreate(store: store, enclaveAvailable: false).publicKey)
    }

    func testEmbeddedSCTScanFindsTheExtensionAndNothingElse() {
        let oid: [UInt8] = [0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0xD6, 0x79, 0x02, 0x04, 0x02]
        XCTAssertTrue(GatewayPublicCertificateCheck.containsEmbeddedSCT(Data([0x30, 0x10] + oid + [0x04, 0x02])))
        XCTAssertTrue(GatewayPublicCertificateCheck.containsEmbeddedSCT(Data(oid + [0x01, 0x01, 0xFF, 0x04, 0x02])))
        XCTAssertFalse(GatewayPublicCertificateCheck.containsEmbeddedSCT(Data([0x30, 0x10, 0x04, 0x02])))
        XCTAssertFalse(GatewayPublicCertificateCheck.containsEmbeddedSCT(Data(oid)))
        XCTAssertFalse(GatewayPublicCertificateCheck.containsEmbeddedSCT(Data(oid + [0x13, 0x02])))
    }

    private final class FailingStore: PairingStore, @unchecked Sendable {
        var writes = 0
        func set(_ value: String, forKey key: String) throws {
            writes += 1
        }

        func get(_ key: String) throws -> String? {
            throw Keychain.Error.unexpectedStatus(-25308)
        }

        func getLegacySynchronizable(_ key: String) throws -> String? {
            nil
        }

        func hasLegacySynchronizableValues() throws -> Bool {
            false
        }

        func deleteLegacySynchronizableValues() throws {}
        func delete(_ key: String) throws {}
        func deleteAll() throws {}
    }
}
