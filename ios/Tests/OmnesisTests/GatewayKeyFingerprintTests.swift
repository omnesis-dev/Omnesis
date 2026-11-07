// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import Security
import XCTest

final class GatewayKeyFingerprintTests: XCTestCase {
    private struct Vectors: Decodable { let clock: Double
        let spkiVectors: [Entry]
    }

    private struct Entry: Decodable {
        let algorithm: String
        let certificate: String
        let spkiFingerprint: String
        let renewedCertificate: String?
        let expiredCertificate: String?
        let wrongHostnameCertificate: String?
        let replacementCertificate: String?
    }

    private func vectors() throws -> Vectors {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ?? bundle
            .url(
                forResource: "cloud-identity-vectors",
                withExtension: "json"
            ))
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func der(_ pem: String) throws -> Data {
        let base64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        return try XCTUnwrap(Data(base64Encoded: base64))
    }

    private func trust(_ pem: String) throws -> SecTrust {
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, der(pem) as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        return try XCTUnwrap(trust)
    }

    func testEveryPublicAlgorithmMatchesNodeCompleteSPKIDERVectors() throws {
        let values = try vectors().spkiVectors
        XCTAssertEqual(Set(values.map(\.algorithm)), ["RSA-2048", "EC-P256", "EC-P384", "EC-P521", "Ed25519"])
        for entry in values {
            XCTAssertEqual(try GatewayKeyFingerprint.spki(der(entry.certificate)), entry.spkiFingerprint, entry.algorithm)
        }
    }

    func testStrictKeyAcceptsRenewedCertificateOnlyForSameKeyHostnameAndValidDate() throws {
        let fixture = try vectors()
        let entry = try XCTUnwrap(fixture.spkiVectors.first { $0.algorithm == "EC-P256" })
        let original = try der(entry.certificate)
        let renewed = try der(XCTUnwrap(entry.renewedCertificate))
        XCTAssertNotEqual(original.sha256Hex, renewed.sha256Hex)
        XCTAssertEqual(try GatewayKeyFingerprint.spki(original), try GatewayKeyFingerprint.spki(renewed))
        let host = "gateway.example.test"
        let keyPinned = PinnedSession(spkiFingerprint: entry.spkiFingerprint, verificationDate: Date(timeIntervalSince1970: fixture.clock))
        let originalTrust = try trust(entry.certificate)
        let renewedTrust = try trust(XCTUnwrap(entry.renewedCertificate))
        XCTAssertEqual(keyPinned.resolve(originalTrust, challengeHost: host), .pinned(systemTrusted: false))
        XCTAssertEqual(keyPinned.resolve(renewedTrust, challengeHost: host), .pinned(systemTrusted: false))
        let exactLeaf = PinnedSession(
            fingerprintHex: original.sha256Hex,
            requireCertificateValidity: true,
            verificationDate: Date(timeIntervalSince1970: fixture.clock)
        )
        XCTAssertEqual(exactLeaf.resolve(renewedTrust, challengeHost: host), .rejected)
        XCTAssertEqual(keyPinned.resolve(originalTrust, challengeHost: "other.example.test"), .rejected)
        for pem in [entry.expiredCertificate, entry.wrongHostnameCertificate, entry.replacementCertificate] {
            XCTAssertEqual(try keyPinned.resolve(trust(XCTUnwrap(pem)), challengeHost: host), .rejected)
        }
        let neverFallback = PinnedSession(
            spkiFingerprint: String(repeating: "0", count: 64),
            host: host,
            systemTrust: { _, _ in XCTFail("Stable key pin adopted public CA trust")
                return true
            }
        )
        XCTAssertEqual(neverFallback.resolve(originalTrust, challengeHost: host), .rejected)
        let canonical = PinnedSession(
            spkiFingerprint: entry.spkiFingerprint,
            host: host,
            verificationDate: Date(timeIntervalSince1970: fixture.clock)
        )
        let anotherName = try trust(XCTUnwrap(entry.wrongHostnameCertificate))
        let unbound = PinnedSession(spkiFingerprint: entry.spkiFingerprint, verificationDate: Date(timeIntervalSince1970: fixture.clock))
        XCTAssertEqual(unbound.resolve(anotherName, challengeHost: "different.example.test"), .pinned(systemTrusted: false))
        XCTAssertEqual(canonical.resolve(anotherName, challengeHost: "different.example.test"), .rejected)
        XCTAssertEqual(canonical.resolve(originalTrust, challengeHost: "GATEWAY.EXAMPLE.TEST"), .pinned(systemTrusted: false))
        let other = PinnedSession(fingerprintHex: original.sha256Hex)
        XCTAssertEqual(other.resolve(originalTrust, challengeHost: "legacy-private-name.test"), .pinned(systemTrusted: false))
    }

    func testMalformedOrTruncatedStructuresCannotBecomePublicKeyPins() throws {
        let integer = node(2, [1])
        let sequence = node(0x30, [])
        let bitString = node(3, [0, 1])
        let key = node(0x30, sequence + bitString)
        let fields = integer + sequence + sequence + sequence + sequence
        let validV1 = node(0x30, node(0x30, fields + key) + sequence + bitString)
        XCTAssertEqual(try GatewayKeyFingerprint.spki(Data(validV1)), Data(key).sha256Hex)
        let version = node(0xA0, integer)
        let validV3 = node(0x30, node(0x30, version + fields + key) + sequence + bitString)
        XCTAssertEqual(try GatewayKeyFingerprint.spki(Data(validV3)), Data(key).sha256Hex)
        let malformed: [[UInt8]] = [
            [],
            [0],
            integer,
            [0x10, 0],
            sequence,
            node(0x30, integer + sequence + bitString),
            node(0x30, node(0x10, []) + sequence + bitString),
            node(0x30, sequence + sequence + bitString),
            node(0x30, node(0x30, fields) + sequence + bitString),
            node(0x30, node(0x30, version + fields) + sequence + bitString),
            node(0x30, node(0x30, fields + integer) + sequence + bitString),
            node(0x30, node(0x30, fields + node(0x10, [])) + sequence + bitString),
            node(0x30, node(0x30, fields + sequence) + sequence + bitString),
            node(0x30, node(0x30, fields + node(0x30, integer + bitString)) + sequence + bitString),
            node(0x30, node(0x30, fields + node(0x30, sequence + integer)) + sequence + bitString),
            validV3 + [0],
            Array(validV3.dropLast()),
        ]
        for bytes in malformed {
            XCTAssertThrowsError(try GatewayKeyFingerprint.spki(Data(bytes)))
        }
    }

    private func node(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
        precondition(content.count < 128)
        return [tag, UInt8(content.count)] + content
    }
}
