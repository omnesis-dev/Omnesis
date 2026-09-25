// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Unit coverage for the lazy fingerprint-routing helper that fronts every
/// transport client. Three seams are exercised: the pure routing logic via
/// `_resolveSession(tlsMode:fingerprint:)`, the cache lifecycle via
/// `_setCached(_:)` + `reset()`, and the full `shared` resolution against a
/// substitute `PairingStore` via `_setStore(_:)` — including a store that
/// cannot be read at all.
final class OmnesisURLSessionTests: XCTestCase {
    private let validHex = String(repeating: "ab", count: 32) // 64 chars
    private let validHexUpper = String(repeating: "AB", count: 32)

    override func setUp() async throws {
        try await super.setUp()
        OmnesisURLSession.reset()
    }

    override func tearDown() async throws {
        OmnesisURLSession._setStore(nil)
        OmnesisURLSession.reset()
        try await super.tearDown()
    }

    // MARK: - _resolveSession

    func test_resolve_nilFingerprint_fallsThroughToShared() {
        let session = OmnesisURLSession._resolveSession(tlsMode: nil, fingerprint: nil)
        XCTAssertTrue(session === URLSession.shared)
    }

    func test_resolve_explicitPinnedEmptyFingerprintRejectsTrust() {
        let session = OmnesisURLSession._resolveSession(tlsMode: "pinned-leaf", fingerprint: "")
        XCTAssertTrue(session.delegate is RejectingTrustSession)
    }

    func test_resolve_explicitPinnedShortFingerprintRejectsTrust() {
        // 63 chars — one short of the SHA-256 hex length.
        let short = String(repeating: "a", count: 63)
        let session = OmnesisURLSession._resolveSession(tlsMode: "pinned-leaf", fingerprint: short)
        XCTAssertTrue(session.delegate is RejectingTrustSession)
    }

    func test_resolve_explicitPinnedNonHexFingerprintRejectsTrust() {
        // Right length, wrong alphabet.
        let bogus = String(repeating: "z", count: 64)
        let session = OmnesisURLSession._resolveSession(tlsMode: "pinned-leaf", fingerprint: bogus)
        XCTAssertTrue(session.delegate is RejectingTrustSession)
    }

    func test_resolve_validLowercase_returnsPinnedDelegate() {
        let session = OmnesisURLSession._resolveSession(tlsMode: "pinned-leaf", fingerprint: validHex)
        XCTAssertFalse(session === URLSession.shared)
        // PinnedSession installs itself as the URLSession's delegate.
        XCTAssertTrue(
            session.delegate is PinnedSession,
            "expected PinnedSession delegate, got \(String(describing: session.delegate))"
        )
    }

    func test_resolve_validUppercase_returnsPinnedDelegate() {
        // Regex is case-insensitive; PinnedSession lowercases internally.
        let session = OmnesisURLSession._resolveSession(tlsMode: nil, fingerprint: validHexUpper)
        XCTAssertFalse(session === URLSession.shared)
        XCTAssertTrue(session.delegate is PinnedSession)
    }

    func test_resolve_systemTrust_ignoresStaleFingerprintAndUsesWebPKI() {
        let session = OmnesisURLSession._resolveSession(
            tlsMode: "system",
            fingerprint: validHex
        )
        XCTAssertTrue(session === URLSession.shared)
    }

    // MARK: - Cache lifecycle (reset / _setCached)

    func test_setCached_overridesShared() {
        let custom = URLSession(configuration: .ephemeral)
        OmnesisURLSession._setCached(custom)
        XCTAssertTrue(OmnesisURLSession.shared === custom)
    }

    func test_reset_clearsCache_nextSharedRebuilds() throws {
        let bundle = try Self.encodedBundle(tlsMode: "pinned-leaf", fingerprint: validHex)
        OmnesisURLSession._setStore(FakePairingStore(values: [PairingCredentialBundle.key: bundle]))
        let custom = URLSession(configuration: .ephemeral)
        OmnesisURLSession._setCached(custom)
        XCTAssertTrue(OmnesisURLSession.shared === custom)

        OmnesisURLSession.reset()

        // What `reset()` promises is that the cached session is dropped and the
        // next access resolves the stored contract afresh — here, the pinned
        // one the store holds.
        let rebuilt = OmnesisURLSession.shared
        XCTAssertFalse(rebuilt === custom)
        XCTAssertTrue(
            rebuilt.delegate is PinnedSession,
            "expected PinnedSession delegate, got \(String(describing: rebuilt.delegate))"
        )
    }

    // MARK: - Resolution against the persisted trust contract

    func test_shared_readsTheStoredPinnedContract() throws {
        let bundle = try Self.encodedBundle(tlsMode: "pinned-leaf", fingerprint: validHex)
        OmnesisURLSession._setStore(FakePairingStore(values: [PairingCredentialBundle.key: bundle]))

        let session = OmnesisURLSession.shared

        XCTAssertFalse(session === URLSession.shared)
        XCTAssertTrue(
            session.delegate is PinnedSession,
            "expected PinnedSession delegate, got \(String(describing: session.delegate))"
        )
    }

    func test_shared_cachesAReadContract() throws {
        let bundle = try Self.encodedBundle(tlsMode: "pinned-leaf", fingerprint: validHex)
        let store = FakePairingStore(values: [PairingCredentialBundle.key: bundle])
        OmnesisURLSession._setStore(store)

        let first = OmnesisURLSession.shared
        let readsAfterFirst = store.readCount
        let second = OmnesisURLSession.shared

        XCTAssertTrue(first === second)
        XCTAssertEqual(store.readCount, readsAfterFirst, "a cached contract must not be re-read")
    }

    func test_shared_unreadableStore_rejectsTrustInsteadOfFallingBackToWebPKI() {
        OmnesisURLSession._setStore(FakePairingStore(readsFail: true))

        let session = OmnesisURLSession.shared

        XCTAssertFalse(session === URLSession.shared)
        XCTAssertTrue(
            session.delegate is RejectingTrustSession,
            "expected RejectingTrustSession delegate, got \(String(describing: session.delegate))"
        )
    }

    func test_shared_unreadableStore_reusesOneRejectingSessionWhileRetrying() {
        let store = FakePairingStore(readsFail: true)
        OmnesisURLSession._setStore(store)

        let first = OmnesisURLSession.shared
        let readsAfterFirst = store.readCount
        let second = OmnesisURLSession.shared

        // A URLSession holds its delegate until it is invalidated, so minting
        // one per failed read would pile them up for as long as the store
        // stays unreadable.
        XCTAssertTrue(first === second, "the rejecting session must be reused, not rebuilt")
        XCTAssertGreaterThan(store.readCount, readsAfterFirst, "each access must re-read the store")
    }

    func test_shared_unreadableStore_isNotCached_soALaterReadWins() {
        // A pairing item stored `AfterFirstUnlockThisDeviceOnly` is unreadable
        // until the first unlock after a reboot. Caching that verdict would
        // leave a push-launched process unable to reach the gateway for its
        // whole lifetime.
        let store = FakePairingStore(
            values: [OmnesisURLSession.fingerprintKeychainKey: validHex],
            readsFail: true
        )
        OmnesisURLSession._setStore(store)
        XCTAssertTrue(OmnesisURLSession.shared.delegate is RejectingTrustSession)

        store.readsFail = false

        let resolved = OmnesisURLSession.shared
        XCTAssertTrue(
            resolved.delegate is PinnedSession,
            "the next access must re-read the store rather than reuse the failure"
        )
        // …and the retrying stops there: the contract that was finally read
        // becomes the cached session, so access is not an unbounded Keychain hit.
        let readsAfterSuccess = store.readCount
        XCTAssertTrue(OmnesisURLSession.shared === resolved)
        XCTAssertEqual(store.readCount, readsAfterSuccess, "a read contract must not be re-read")
    }

    func test_shared_malformedStoredBundle_rejectsTrustAndStands() {
        let store = FakePairingStore(values: [PairingCredentialBundle.key: "not-json"])
        OmnesisURLSession._setStore(store)

        let first = OmnesisURLSession.shared
        XCTAssertTrue(first.delegate is RejectingTrustSession)
        // Unusable stored state is a verdict about this pairing, not a
        // transient failure: only a re-pair changes it, and that calls reset().
        XCTAssertTrue(OmnesisURLSession.shared === first)
    }

    private static func encodedBundle(tlsMode: String, fingerprint: String?) throws -> String {
        try PairingCredentialBundle(
            url: "https://gateway.example:7600",
            token: "omn_test",
            accountId: "local",
            deviceId: "device-1",
            name: "Test iPhone",
            scopes: ["read"],
            tlsMode: tlsMode,
            fingerprint: fingerprint
        ).encoded()
    }
}

/// A `PairingStore` whose reads can be made to fail, so the fail-closed
/// contract can be driven without a live Keychain.
///
/// `OmnesisURLSession` reads `get(_:)` and nothing else. Every other member
/// fails the test rather than throwing quietly: `resolve` turns any thrown
/// error into the fail-closed verdict, so an unexpected call would otherwise be
/// absorbed and leave a test green while asserting the wrong thing.
private final class FakePairingStore: PairingStore, @unchecked Sendable {
    enum Failure: Error { case unreadable, unexpectedCall }

    private let values: [String: String]

    /// While true, every read throws — standing in for a Keychain whose items
    /// are not yet accessible.
    var readsFail: Bool

    private(set) var readCount = 0

    init(values: [String: String] = [:], readsFail: Bool = false) {
        self.values = values
        self.readsFail = readsFail
    }

    func get(_ key: String) throws -> String? {
        readCount += 1
        if readsFail { throw Failure.unreadable }
        return values[key]
    }

    func getLegacySynchronizable(_: String) throws -> String? {
        throw unexpected("getLegacySynchronizable")
    }

    func hasLegacySynchronizableValues() throws -> Bool {
        throw unexpected("hasLegacySynchronizableValues")
    }

    func set(_: String, forKey _: String) throws {
        throw unexpected("set")
    }

    func deleteLegacySynchronizableValues() throws {
        throw unexpected("deleteLegacySynchronizableValues")
    }

    func delete(_: String) throws {
        throw unexpected("delete")
    }

    func deleteAll() throws {
        throw unexpected("deleteAll")
    }

    private func unexpected(_ member: String) -> Failure {
        XCTFail("OmnesisURLSession called \(member) on the pairing store; it should only read")
        return .unexpectedCall
    }
}
