// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The comparison code, against the vectors every platform shares
/// (`CODE_VECTOR` in `packages/cloud-relay/src/device-enrollment.test.ts`), and the checks a
/// device makes on every reply before it shows one.
final class PairingComparisonCodeTests: XCTestCase {
    private let requestId = "11111111-2222-4333-8444-555555555555"
    private let secret = String(repeating: "a", count: 64)
    private let gateway = String(repeating: "c", count: 64)
    private let rows = [
        ("pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk", "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs", "465 774"),
        ("A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY", "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80", "081 434"),
        ("1uSZpIa4poPLc_3XyndwQ-G7g8lP8Pqu8nqTsJIylT4", "Dp9I5hCYSrL266BmkV4wY-XWhsBYfJBky-T5WZTnOos", "003 579"),
    ]

    private func request() throws -> CloudPairingChallenge {
        try CloudPairingChallenge(name: "Fictional phone", requestId: requestId, secret: secret)
    }

    func testSharedVectors() throws {
        let request = try request()
        for (codeNonce, challenge, code) in rows {
            XCTAssertEqual(try PairingComparisonCode.commitment(codeNonce: codeNonce), challenge)
            XCTAssertEqual(try request.comparisonCode(fingerprint: gateway, codeNonce: codeNonce), code)
        }
        // The first row's request seen through another certificate.
        XCTAssertEqual(try request.comparisonCode(fingerprint: String(repeating: "d", count: 64), codeNonce: rows[0].0), "531 664")
    }

    /// Six bytes, not four, and leading zeros are kept.
    func testTheCodeReadsSixDigestBytesAndKeepsItsZeros() {
        XCTAssertEqual(PairingComparisonCode.code(digest: [0, 0, 0, 0, 0, 7] + Array(repeating: 0xFF, count: 26)), "000 007")
        XCTAssertEqual(PairingComparisonCode.code(digest: [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0]), "710 655")
        XCTAssertEqual(PairingComparisonCode.code(digest: [0, 1, 0, 0, 0, 0]), "967 296")
    }

    func testTheOneFormatter() {
        XCTAssertEqual(PairingComparisonCode.format("465774"), "465 774")
        XCTAssertEqual(PairingComparisonCode.format(" 465-774\n"), "465 774")
        XCTAssertEqual(PairingComparisonCode.format("4 6 5 7 7 4"), "465 774")
        XCTAssertEqual(PairingComparisonCode.format("003 579"), "003 579")
        for input in ["", "46577", "4657745", "46577a", "４６５７７４", "AAAA-BBBB-CCCC-DDDD-EEEE"] {
            XCTAssertNil(PairingComparisonCode.format(input), input)
        }
        XCTAssertTrue(PairingComparisonCode.canonical("465 774"))
        for value in ["465774", "465  774", "465-774", " 465 774", "465 77a", "465\u{00A0}774"] {
            XCTAssertFalse(PairingComparisonCode.canonical(value), value)
        }
    }

    func testANonceOrChallengeOfTheWrongShapeIsRefused() throws {
        XCTAssertThrowsError(try PairingComparisonCode.commitment(codeNonce: "short"))
        XCTAssertThrowsError(try PairingComparisonCode.commitment(codeNonce: rows[0].0 + "="))
        XCTAssertThrowsError(try request().comparisonCode(fingerprint: gateway, codeNonce: ""))
        XCTAssertThrowsError(try request().comparisonCode(fingerprint: gateway.uppercased(), codeNonce: rows[0].0))
    }

    // MARK: - What a device checks on every reply

    private func confirmation() throws -> CloudPairingConfirmation {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ??
            bundle.url(forResource: "cloud-identity-vectors", withExtension: "json"))
        struct Root: Decodable { let gateway: GoogleGatewayBinding
            let clock: Double
        }
        let root = try JSONDecoder().decode(Root.self, from: Data(contentsOf: url))
        clock = root.clock
        return try CloudPairingConfirmation(challenge: request(), candidate: root.gateway, now: root.clock)
    }

    private var clock: Double = 0
    private var later: Double {
        (clock + 100) * 1000
    }

    func testNoCodeExistsUntilAReplyPassesEveryCheck() throws {
        var flow = try confirmation()
        XCTAssertNil(flow.verificationCode)
        // A reply before any challenge was taken proves nothing.
        XCTAssertThrowsError(try flow.receive(flow.reply(expiresAt: later), now: clock))
        XCTAssertNil(flow.verificationCode)
        try flow.commit(to: PairingCodeFixture.challenge)
        XCTAssertNil(flow.verificationCode)
        try flow.receive(flow.reply(expiresAt: later), now: clock)
        let shown = try XCTUnwrap(flow.verificationCode)
        XCTAssertEqual(shown, try request().comparisonCode(fingerprint: flow.fingerprint, codeNonce: PairingCodeFixture.nonce))
        XCTAssertTrue(PairingComparisonCode.canonical(shown))
    }

    func testACommitmentMismatchAbortsWithNoCode() throws {
        var flow = try confirmation().committed()
        let forged = try flow.reply(expiresAt: later, nonce: PairingCodeFixture.otherNonce)
        XCTAssertThrowsError(try flow.receive(forged, now: clock)) { XCTAssertEqual($0 as? CloudPairingError, .codeMismatch) }
        XCTAssertNil(flow.verificationCode)
        XCTAssertFalse(flow.approved)
    }

    func testAReplyCodeThatDiffersFromTheLocalOneAbortsWithNoCode() throws {
        var flow = try confirmation().committed()
        for code in ["000 000", "465774", ""] {
            let reply = try flow.reply("approved", expiresAt: later, pairingCode: "SYNTHETIC-CODE", code: code)
            XCTAssertThrowsError(try flow.receive(reply, now: clock)) { XCTAssertEqual($0 as? CloudPairingError, .codeMismatch) }
        }
        XCTAssertNil(flow.verificationCode)
        XCTAssertFalse(flow.approved)
    }

    /// The other nonce is offered with its own valid commitment's code, so only the change gives it away.
    func testANonceThatChangesBetweenRepliesAborts() throws {
        var flow = try confirmation().committed()
        try flow.receive(flow.reply(expiresAt: later), now: clock)
        let changed = try flow.reply("approved", expiresAt: later, pairingCode: "SYNTHETIC-CODE", nonce: PairingCodeFixture.otherNonce)
        XCTAssertThrowsError(try flow.receive(changed, now: clock)) { XCTAssertEqual($0 as? CloudPairingError, .codeMismatch) }
        XCTAssertFalse(flow.approved)
        XCTAssertThrowsError(try flow.pairingPayload(now: clock))
    }

    func testOneRequestAnswersExactlyOneChallenge() throws {
        var flow = try confirmation().committed()
        XCTAssertThrowsError(try flow.commit(to: PairingCodeFixture.otherChallenge))
        var other = try confirmation()
        XCTAssertThrowsError(try other.commit(to: "not-a-challenge"))
        // A second challenge never replaces the first, so a reply for it is still refused.
        let reply = try flow.reply(expiresAt: later, nonce: PairingCodeFixture.otherNonce)
        XCTAssertThrowsError(try flow.receive(reply, now: clock))
    }

    func testAReplyWithoutANonceDoesNotDecode() {
        let old = #"{"status":"pending","verificationCode":"465 774","expiresAt":1}"#
        XCTAssertThrowsError(try JSONDecoder().decode(CloudPairingProgress.self, from: Data(old.utf8)))
    }
}
