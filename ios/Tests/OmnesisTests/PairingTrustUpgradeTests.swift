// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A pinned pairing whose gateway now presents a publicly trusted certificate
/// for its DNS name is rewritten as system-trusted, keeping everything else
/// the pairing holds.
final class PairingTrustUpgradeTests: XCTestCase {
    private var store: InMemoryStore!
    private var exchange: StubExchange!
    private var service: PairingService!
    private let pin = String(repeating: "b", count: 64)

    override func setUp() {
        super.setUp()
        store = InMemoryStore()
        exchange = StubExchange()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_pinned", name: "Example gateway", kind: "ios"),
            tokenId: "tok_generation",
            token: "omn_pinned_token",
            scopes: ["read", "write"]
        ))
        service = PairingService(store: store, exchange: exchange, pinnedExchangeBuilder: { _ in nil })
        OmnesisURLSession._setStore(store)
    }

    override func tearDown() {
        OmnesisURLSession._setStore(nil)
        OmnesisURLSession.reset()
        super.tearDown()
    }

    private func pairPinned(_ gatewayUrl: String) async throws {
        let raw = #"{"v":4,"gatewayUrl":"\#(gatewayUrl)","pairingCode":"AAAA-BBBB","tls":{"mode":"pinned-leaf","fingerprint":"\#(pin)"}}"#
        _ = try await service.pairAsync(raw: raw)
    }

    /// Reports that a session pinned to `fingerprint` saw `host` verify under
    /// the system roots.
    private func upgrade(host: String = "gateway.example.com", fingerprint: String? = nil) throws -> Bool {
        try service.upgradeTrustToSystem(verifiedHost: host, pinnedFingerprint: fingerprint ?? pin)
    }

    private func storedBundle() throws -> PairingCredentialBundle {
        try PairingCredentialBundle.decode(XCTUnwrap(store.get(PairingCredentialBundle.key)))
    }

    func testUpgradeRewritesAPinnedDNSPairingAsSystemTrusted() async throws {
        try await pairPinned("https://gateway.example.com:7600")
        let before = try storedBundle()
        XCTAssertTrue(OmnesisURLSession.shared.delegate is PinnedSession)

        XCTAssertTrue(try upgrade())

        let after = try storedBundle()
        XCTAssertEqual(after.tlsMode, "system")
        XCTAssertNil(after.fingerprint)
        XCTAssertEqual(after.pairingGeneration, "tok_generation")
        XCTAssertEqual(after.url, before.url)
        XCTAssertEqual(after.token, before.token)
        XCTAssertEqual(after.accountId, before.accountId)
        XCTAssertEqual(after.deviceId, before.deviceId)
        XCTAssertEqual(after.name, before.name)
        XCTAssertEqual(after.scopes, before.scopes)
        XCTAssertEqual(try service.current()?.tlsMode, .system)
        // The shared session was dropped and re-resolves to system trust.
        XCTAssertTrue(OmnesisURLSession.shared === URLSession.shared)

        XCTAssertFalse(try upgrade(), "a system pairing has nothing to upgrade")
    }

    func testUpgradeLeavesAPinnedIPPairingStrictlyPinned() async throws {
        try await pairPinned("https://192.0.2.10:7600")
        let before = try storedBundle()

        XCTAssertFalse(try upgrade(host: "192.0.2.10"))

        XCTAssertEqual(try storedBundle(), before)
    }

    func testUpgradeMatchesTheHostAndPinCaseInsensitively() async throws {
        try await pairPinned("https://gateway.example.com:7600")

        XCTAssertTrue(try upgrade(host: "Gateway.Example.COM", fingerprint: pin.uppercased()))

        XCTAssertEqual(try storedBundle().tlsMode, "system")
    }

    func testUpgradeIgnoresAReportForAnotherHost() async throws {
        // A session built for the earlier address can still finish a handshake
        // after the pairing moved to a new one with the same pin.
        try await pairPinned("https://gateway.example.com:7600")
        try service.updateGatewayURL(XCTUnwrap(URL(string: "https://gateway.example.org:7600")))
        let before = try storedBundle()

        XCTAssertFalse(try upgrade(host: "gateway.example.com"))

        XCTAssertEqual(try storedBundle(), before)
        XCTAssertEqual(try service.current()?.tlsMode, .pinnedLeaf)
    }

    func testUpgradeIgnoresAReportForAnotherPin() async throws {
        try await pairPinned("https://gateway.example.com:7600")
        let before = try storedBundle()

        XCTAssertFalse(try upgrade(fingerprint: String(repeating: "c", count: 64)))

        XCTAssertEqual(try storedBundle(), before)
        XCTAssertEqual(try service.current()?.fingerprint, pin)
    }

    func testUpgradeIgnoresSystemAndUnpairedStates() async throws {
        XCTAssertFalse(try upgrade())

        let raw = #"{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"AAAA-BBBB","tls":{"mode":"system"}}"#
        _ = try await service.pairAsync(raw: raw)
        let before = try storedBundle()

        XCTAssertFalse(try upgrade())
        XCTAssertEqual(try storedBundle(), before)
    }

    func testUpdateGatewayURLKeepsThePairingGenerationAndTrust() async throws {
        try await pairPinned("https://gateway.example.com:7600")
        XCTAssertTrue(OmnesisURLSession.shared.delegate is PinnedSession)
        OmnesisURLSession._setCached(URLSession(configuration: .ephemeral))

        try service.updateGatewayURL(XCTUnwrap(URL(string: "https://192.0.2.10:7600")))

        let after = try storedBundle()
        XCTAssertEqual(after.url, "https://192.0.2.10:7600")
        XCTAssertEqual(after.pairingGeneration, "tok_generation")
        XCTAssertEqual(after.tlsMode, "pinned-leaf")
        XCTAssertEqual(after.fingerprint, pin)
        XCTAssertEqual(try service.current()?.pairingGeneration, "tok_generation")
        // The pinned session knows its host, so a new address re-resolves it.
        XCTAssertTrue(OmnesisURLSession.shared.delegate is PinnedSession)
    }

    func testNotificationCredentialIsReMintedAfterTheUpgrade() async throws {
        try await pairPinned("https://gateway.example.com:7600")
        let claimStore = InMemoryStore()
        let mints = MintCounter()
        let pinned = try XCTUnwrap(service.current())
        try await NotificationClaimCredentialProvisioner(pairing: pinned, store: claimStore, request: mints.mint).ensure()
        XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: claimStore)?.tlsMode, "pinned-leaf")

        XCTAssertTrue(try upgrade())
        let upgraded = try XCTUnwrap(service.current())
        try await NotificationClaimCredentialProvisioner(pairing: upgraded, store: claimStore, request: mints.mint).ensure()

        XCTAssertEqual(mints.count, 2)
        let stored = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: claimStore))
        XCTAssertEqual(stored.tlsMode, "system")
        XCTAssertNil(stored.fingerprint)
        XCTAssertEqual(stored.token, "claim-token-2")
    }
}

/// Answers each `/admin/tokens` mint with a fresh `push:claim` token.
private final class MintCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var mints = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return mints
    }

    lazy var mint: NotificationClaimCredentialProvisioner.Request = { [unowned self] request in
        let number = self.next()
        let body = #"{"deviceId":"dev_pinned","scopes":["push:claim"],"token":"claim-token-\#(number)"}"#
        let response = try XCTUnwrap(HTTPURLResponse(
            url: XCTUnwrap(request.url),
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        ))
        return (Data(body.utf8), response)
    }

    private func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        mints += 1
        return mints
    }
}
