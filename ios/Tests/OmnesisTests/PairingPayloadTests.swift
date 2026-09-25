// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PairingPayloadTests: XCTestCase {
    func testRejectsHTTPSValuesThatAreNotGatewayOrigins() {
        let invalidURLs = [
            "https:///missing-host",
            "https://user:password@gateway.example.com",
            "https://gateway.example.com/api",
            "https://gateway.example.com?token=secret",
            "https://gateway.example.com#fragment",
        ]

        for url in invalidURLs {
            let raw = #"{"v":2,"gatewayUrl":"\#(url)","pairingCode":"ABCD-1234"}"#
            XCTAssertThrowsError(try PairingPayload.decode(from: raw), url) { error in
                XCTAssertEqual(error as? PairingPayloadError, .invalidURL)
            }
        }
    }

    func testDecodeV4SystemTrust() throws {
        let raw = #"{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"A1B2","tls":{"mode":"system"}}"#
        guard case .v4(let payload) = try PairingPayload.decode(from: raw) else {
            return XCTFail("expected V4")
        }
        XCTAssertEqual(payload.tls, .system)
    }

    func testDecodeV4PinnedLeaf() throws {
        let fingerprint = String(repeating: "a", count: 64)
        let raw = #"{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"A1B2","tls":{"mode":"pinned-leaf","fingerprint":"\#(fingerprint)"}}"#
        guard case .v4(let payload) = try PairingPayload.decode(from: raw) else {
            return XCTFail("expected V4")
        }
        XCTAssertEqual(payload.tls, .pinnedLeaf(fingerprint: fingerprint))
    }

    func testV4SystemTrustRejectsHTTP() {
        let raw = #"{"v":4,"gatewayUrl":"http://public-gateway.example.com","pairingCode":"A1B2","tls":{"mode":"system"}}"#
        XCTAssertThrowsError(try PairingPayload.decode(from: raw)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("http"))
        }
    }

    func testV4PinnedLeafRejectsHTTP() {
        let fingerprint = String(repeating: "a", count: 64)
        let raw = #"{"v":4,"gatewayUrl":"http://gateway.example.com","pairingCode":"A1B2","tls":{"mode":"pinned-leaf","fingerprint":"\#(fingerprint)"}}"#
        XCTAssertThrowsError(try PairingPayload.decode(from: raw)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("http"))
        }
    }

    func testV4CodableRoundTrip() throws {
        let payload = PairingPayload.V4(
            gatewayUrl: "https://public-gateway.example.com",
            pairingCode: "A1B2",
            tls: .system
        )
        let encoded = try JSONEncoder().encode(payload)
        XCTAssertEqual(try JSONDecoder().decode(PairingPayload.V4.self, from: encoded), payload)
    }

    // ── V3 (TLS-pinned) ───────────────────────────────────────────────────

    private let validFingerprint =
        "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb"

    private var validV3: String {
        """
        {
          "v": 3,
          "gatewayUrl": "https://mac.local:7600",
          "pairingCode": "A1B2-C3D4-EF",
          "fingerprint": "\(validFingerprint)"
        }
        """
    }

    func testDecodeV3Payload() throws {
        let payload = try PairingPayload.decode(from: validV3)
        guard case .v3(let p) = payload else {
            XCTFail("expected v3 case, got \(payload)")
            return
        }
        XCTAssertEqual(p.v, 3)
        XCTAssertEqual(p.gatewayUrl, "https://mac.local:7600")
        XCTAssertEqual(p.pairingCode, "A1B2-C3D4-EF")
        XCTAssertEqual(p.fingerprint, validFingerprint)
    }

    func testV3CodableRoundTripPreservesFingerprint() throws {
        let payload = PairingPayload.V3(
            gatewayUrl: "https://tailnet:7600",
            pairingCode: "ZZZZ-1111",
            fingerprint: validFingerprint
        )
        let encoded = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(PairingPayload.V3.self, from: encoded)
        XCTAssertEqual(decoded, payload)
        XCTAssertEqual(decoded.fingerprint, validFingerprint)

        // Round-trip via the top-level decode() too — exercises the
        // peek-then-dispatch path that the QR scanner actually uses.
        guard let json = String(data: encoded, encoding: .utf8) else {
            XCTFail("encoding produced non-utf8 data")
            return
        }
        guard case .v3(let p) = try PairingPayload.decode(from: json) else {
            XCTFail("expected v3 case")
            return
        }
        XCTAssertEqual(p.fingerprint, validFingerprint)
    }

    func testV3RejectsNonHexFingerprint() {
        // 64 chars but with a non-hex 'g'.
        let bad = String(repeating: "g", count: 64)
        let json = """
        {"v":3,"gatewayUrl":"https://mac.local:7600","pairingCode":"X","fingerprint":"\(bad)"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidFingerprint)
        }
    }

    func testV3RejectsShortFingerprint() {
        // 63 chars — should fail the length check.
        let short = String(repeating: "a", count: 63)
        let json = """
        {"v":3,"gatewayUrl":"https://mac.local:7600","pairingCode":"X","fingerprint":"\(short)"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidFingerprint)
        }
    }

    func testV3RejectsUppercaseFingerprint() {
        // Spec is lowercase hex; uppercase is rejected.
        let upper = String(repeating: "A", count: 64)
        let json = """
        {"v":3,"gatewayUrl":"https://mac.local:7600","pairingCode":"X","fingerprint":"\(upper)"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidFingerprint)
        }
    }

    func testV3RejectsEmptyFingerprint() {
        let json = """
        {"v":3,"gatewayUrl":"https://mac.local:7600","pairingCode":"X","fingerprint":""}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .missingField("fingerprint"))
        }
    }

    // ── Scheme allowlist (all versions) ───────────────────────────────────

    func testV3RejectsFileScheme() {
        let json = """
        {"v":3,"gatewayUrl":"file:///etc/passwd","pairingCode":"X","fingerprint":"\(validFingerprint)"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("file"))
        }
    }

    func testV3RejectsHTTP() {
        let json = """
        {"v":3,"gatewayUrl":"http://mac.local:7600","pairingCode":"X","fingerprint":"\(validFingerprint)"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("http"))
        }
    }

    func testV2RejectsDataScheme() {
        let json = """
        {"v":2,"gatewayUrl":"data:text/plain;base64,SGVsbG8=","pairingCode":"X"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("data"))
        }
    }

    func testV2RejectsHTTP() {
        let json = #"{"v":2,"gatewayUrl":"http://mac.local:7600","pairingCode":"X"}"#
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("http"))
        }
    }

    func testV1RejectsJavascriptScheme() {
        let json = """
        {"v":1,"url":"javascript:alert(1)","token":"omn_x","accountId":"a","name":"n"}
        """
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("javascript"))
        }
    }

    func testV1RejectsHTTP() {
        let json = #"{"v":1,"url":"http://mac.local:7600","token":"omn_x","accountId":"a","name":"n"}"#
        XCTAssertThrowsError(try PairingPayload.decode(from: json)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .invalidScheme("http"))
        }
    }

    // ── V2 ─────────────────────────────────────────────────────────────────

    private let validV2 = """
    {
      "v": 2,
      "gatewayUrl": "https://mac.local:7600",
      "pairingCode": "A1B2-C3D4-EF"
    }
    """

    func testDecodeV2Payload() throws {
        let payload = try PairingPayload.decode(from: validV2)
        guard case .v2(let p) = payload else {
            XCTFail("expected v2 case, got \(payload)")
            return
        }
        XCTAssertEqual(p.v, 2)
        XCTAssertEqual(p.gatewayUrl, "https://mac.local:7600")
        XCTAssertEqual(p.pairingCode, "A1B2-C3D4-EF")
    }

    func testDecodeV2TrimsWhitespace() throws {
        let padded = "\n  \(validV2)  \n"
        _ = try PairingPayload.decode(from: padded)
    }

    func testRejectsV2MissingGatewayUrl() {
        let broken = validV2.replacingOccurrences(
            of: "\"gatewayUrl\": \"https://mac.local:7600\"",
            with: "\"gatewayUrl\": \"\""
        )
        XCTAssertThrowsError(try PairingPayload.decode(from: broken)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .missingField("gatewayUrl"))
        }
    }

    func testRejectsV2MissingPairingCode() {
        let broken = validV2.replacingOccurrences(
            of: "\"pairingCode\": \"A1B2-C3D4-EF\"",
            with: "\"pairingCode\": \"\""
        )
        XCTAssertThrowsError(try PairingPayload.decode(from: broken)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .missingField("pairingCode"))
        }
    }

    // ── V1 (legacy back-compat) ────────────────────────────────────────────

    private let validV1 = """
    {
      "v": 1,
      "url": "https://mac.local:7600",
      "token": "omn_abcdefghijklmnopqrstuvwxyzabcdef",
      "accountId": "ios-abcdef123456",
      "name": "My Mac"
    }
    """

    func testDecodeV1Payload() throws {
        let payload = try PairingPayload.decode(from: validV1)
        guard case .v1(let p) = payload else {
            XCTFail("expected v1 case, got \(payload)")
            return
        }
        XCTAssertEqual(p.v, 1)
        XCTAssertEqual(p.url, "https://mac.local:7600")
        XCTAssertEqual(p.token, "omn_abcdefghijklmnopqrstuvwxyzabcdef")
        XCTAssertEqual(p.accountId, "ios-abcdef123456")
        XCTAssertEqual(p.name, "My Mac")
    }

    func testRejectsV1EmptyToken() {
        let broken = validV1.replacingOccurrences(
            of: "\"token\": \"omn_abcdefghijklmnopqrstuvwxyzabcdef\"",
            with: "\"token\": \"\""
        )
        XCTAssertThrowsError(try PairingPayload.decode(from: broken)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .missingField("token"))
        }
    }

    // ── Version gating ─────────────────────────────────────────────────────

    func testRejectsUnknownVersion() {
        let future = validV2.replacingOccurrences(of: "\"v\": 2", with: "\"v\": 99")
        XCTAssertThrowsError(try PairingPayload.decode(from: future)) { error in
            XCTAssertEqual(error as? PairingPayloadError, .unsupportedVersion(99))
        }
    }

    func testRejectsMissingVersion() {
        XCTAssertThrowsError(try PairingPayload.decode(from: "{\"foo\":1}"))
    }

    func testRejectsInvalidJSON() {
        XCTAssertThrowsError(try PairingPayload.decode(from: "not json at all"))
    }

    // ── Codable round-trips ────────────────────────────────────────────────

    func testV2CodableRoundTrip() throws {
        let payload = PairingPayload.V2(gatewayUrl: "https://tailnet:7600", pairingCode: "ZZZZ-1111")
        let encoded = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(PairingPayload.V2.self, from: encoded)
        XCTAssertEqual(decoded, payload)
    }

    func testV1CodableRoundTrip() throws {
        let payload = PairingPayload.V1(
            url: "https://tailnet:7600",
            token: "omn_xyz",
            accountId: "ios-zzz",
            name: "tailnet-mac"
        )
        let encoded = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(PairingPayload.V1.self, from: encoded)
        XCTAssertEqual(decoded, payload)
    }
}
