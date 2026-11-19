// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class CloudRelaySetupVerificationTests: XCTestCase {
    private let check = "https://dns.example.test/_dns/v2/enroll?ticket=fictional"
    private let signIn = "https://relay.example.test/_relay/v3/signup/begin?request=fictional"

    private func status(url: String?, expiry: Double, authorize: String? = nil) throws -> CloudRelayStatus {
        var connect: [String: Any] = ["state": "waiting"]
        if let url { connect["verification"] = ["url": url, "expiresAt": expiry] }
        if let authorize { connect["authorizeUrl"] = authorize }
        return try JSONDecoder().decode(CloudRelayStatus.self, from: JSONSerialization.data(withJSONObject: ["connect": connect]))
    }

    func testSecurityCheckDecodesMillisecondsAndTakesPrecedenceOverSignIn() throws {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let fresh = try status(url: check, expiry: 1_900_000_120_000, authorize: signIn)
        XCTAssertEqual(fresh.phase, .waiting)
        XCTAssertEqual(fresh.connect?.verification?.expiresAt?.date, now.addingTimeInterval(120))
        XCTAssertEqual(CloudRelayPresentation.connectBrowserURL(fresh.connect, now: now)?.absoluteString, check)
        XCTAssertEqual(CloudRelayPresentation.hero(fresh).title, "Verify this gateway setup")
        let clockSkew = try status(url: check, expiry: 1_900_000_650_000)
        XCTAssertEqual(CloudRelayPresentation.connectBrowserURL(clockSkew.connect, now: now)?.absoluteString, check)
    }

    func testInvalidExpiredOrUnboundedSecurityCheckNeverFallsThroughToSignIn() throws {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        for (url, expiry) in [
            ("http://dns.example.test/check", 1_900_000_120_000.0),
            (check, 1_899_999_999_000.0),
            (check, 1_900_000_661_000.0),
        ] {
            let fresh = try status(url: url, expiry: expiry, authorize: signIn)
            XCTAssertNil(CloudRelayPresentation.connectBrowserURL(fresh.connect, now: now))
        }
        let legacy = try status(url: nil, expiry: 0, authorize: signIn)
        XCTAssertEqual(CloudRelayPresentation.connectBrowserURL(legacy.connect, now: now)?.absoluteString, signIn)
    }

    @MainActor
    func testBrowserContinuesFromSecurityCheckToSignInExactlyOnce() async throws {
        let pending = try status(url: check, expiry: Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        let gateway = VerificationGateway(reply: pending)
        let browser = VerificationBrowser()
        let model = OmnesisAccountModel(browser: browser)
        await model.connect(.create, client: gateway)
        XCTAssertEqual(browser.urls.map(\.absoluteString), [check])
        try await gateway.set(status(url: nil, expiry: 0))
        await model.load(client: gateway)
        XCTAssertEqual(browser.urls.map(\.absoluteString), [check])
        try await gateway.set(status(url: nil, expiry: 0, authorize: signIn))
        await model.load(client: gateway)
        await model.load(client: gateway)
        XCTAssertEqual(browser.urls.map(\.absoluteString), [check, signIn])
        try await gateway.set(JSONDecoder().decode(CloudRelayStatus.self, from: Data("{}".utf8)))
        await model.perform(.cancelConnect, client: gateway)
        XCTAssertEqual(browser.closes, 1)
    }

    @MainActor
    func testAStatusReadDoesNotOpenABrowserThePersonNeverOpened() async throws {
        let pending = try status(url: check, expiry: Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        let browser = VerificationBrowser()
        let model = OmnesisAccountModel(browser: browser, status: pending)
        let gateway = try VerificationGateway(reply: status(url: nil, expiry: 0, authorize: signIn))
        await model.load(client: gateway)
        XCTAssertTrue(browser.urls.isEmpty)
    }
}

private actor VerificationGateway: CloudRelayManaging {
    var reply: CloudRelayStatus
    init(reply: CloudRelayStatus) {
        self.reply = reply
    }

    func set(_ reply: CloudRelayStatus) {
        self.reply = reply
    }

    func cloudRelayStatus() async throws -> CloudRelayStatus {
        reply
    }

    func cloudRelay(_: CloudRelayOperation) async throws -> CloudRelayStatus {
        reply
    }
}

@MainActor
private final class VerificationBrowser: OmnesisAccountBrowsing {
    var urls: [URL] = []
    var closes = 0
    func open(_ url: URL) {
        urls.append(url)
    }

    func close() {
        closes += 1
    }
}
