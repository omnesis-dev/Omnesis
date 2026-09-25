// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PairingServiceTests: XCTestCase {
    private var store: InMemoryStore!
    private var exchange: StubExchange!
    private var service: PairingService!

    override func setUp() {
        super.setUp()
        store = InMemoryStore()
        exchange = StubExchange()
        // `pinnedExchangeBuilder` returns nil so the V3 path uses the
        // injected stub instead of building a real `PinnedSession`-wrapped
        // URLSession (which would try to hit the network).
        service = PairingService(
            store: store,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
    }

    private func storedBundle() throws -> PairingCredentialBundle? {
        guard let raw = try store.get(PairingCredentialBundle.key) else { return nil }
        return try PairingCredentialBundle.decode(raw)
    }

    // MARK: - V1 (legacy)

    private var sampleV1JSON: String {
        """
        {"v":1,"url":"https://mac.local:7600","token":"omn_x","accountId":"ios-a","name":"mac"}
        """
    }

    func testV1PairStoresAllKeys() throws {
        let pairing = try service.pair(raw: sampleV1JSON)
        XCTAssertEqual(pairing.url.absoluteString, "https://mac.local:7600")
        XCTAssertEqual(pairing.token, "omn_x")
        // `Pairing.accountId` is hardcoded to "local". The V1 payload's
        // `accountId` field is reused as the legacy deviceId.
        XCTAssertEqual(pairing.accountId, "local")
        XCTAssertEqual(pairing.deviceId, "ios-a")
        XCTAssertEqual(pairing.gatewayName, "mac")
        XCTAssertTrue(pairing.scopes.isEmpty)
        let stored = try XCTUnwrap(storedBundle())
        XCTAssertEqual(stored.url, "https://mac.local:7600")
        XCTAssertEqual(stored.token, "omn_x")
        XCTAssertEqual(stored.accountId, "local")
        XCTAssertEqual(stored.deviceId, "ios-a")
        XCTAssertEqual(stored.name, "mac")
    }

    func testSyncPairRejectsV2() {
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"AAAA-BBBB\"}"
        XCTAssertThrowsError(try service.pair(raw: v2))
    }

    // MARK: - Install identity

    func testPairSendsAStableInstallIdentityAndThePreviousDeviceId() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_123", name: "phone-a1b2c3", kind: "ios"),
            tokenId: "tok_abc",
            token: "omn_paired_xyz",
            scopes: ["read"]
        ))
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"AAAA-BBBB\"}"

        _ = try await service.pairAsync(raw: v2)
        let first = try XCTUnwrap(exchange.lastCapabilities)
        let installId = try XCTUnwrap(first.installId)
        XCTAssertEqual(installId.count, 36)
        // Self-naming: hostname plus a slice of the identity, never the bare
        // generic model name two phones would share.
        XCTAssertTrue(try XCTUnwrap(first.suggestedName).hasSuffix("-\(installId.prefix(6))"))
        XCTAssertNil(first.previousDeviceId)
        XCTAssertEqual(first.multiDeviceModes["apple-health"], "replicated")
        XCTAssertEqual(first.multiDeviceModes["activity-segments"], "partitioned")
        XCTAssertEqual(first.multiDeviceModes["core-location-visits"], "partitioned")
        XCTAssertEqual(first.multiDeviceModes["photos"], "partitioned")
        XCTAssertEqual(first.replicaVersionPolicies["apple-health"], "source-updated-at")
        XCTAssertTrue(first.syncLease)

        // The identity is minted once (same store), and a re-pair names the
        // row this install was paired as before.
        _ = try await service.pairAsync(raw: v2)
        let second = try XCTUnwrap(exchange.lastCapabilities)
        XCTAssertEqual(second.installId, installId)
        XCTAssertEqual(second.previousDeviceId, "dev_123")
    }

    func testClearKeepsTheInstallIdentitySoARePairAdoptsTheSameRow() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_123", name: "phone-a1b2c3", kind: "ios"),
            tokenId: "tok_abc",
            token: "omn_paired_xyz",
            scopes: ["read"]
        ))
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"AAAA-BBBB\"}"
        _ = try await service.pairAsync(raw: v2)
        let installId = try XCTUnwrap(exchange.lastCapabilities).installId

        try service.clear()
        XCTAssertNil(try service.current())
        XCTAssertEqual(try store.get("install.id"), installId)

        // Unpaired, the phone no longer remembers a device id, but its identity
        // still lets the gateway adopt the row it had.
        _ = try await service.pairAsync(raw: v2)
        let again = try XCTUnwrap(exchange.lastCapabilities)
        XCTAssertEqual(again.installId, installId)
        XCTAssertNil(again.previousDeviceId)
    }

    // MARK: - V2 (exchange code via POST /devices/pair)

    func testV2PairAsyncExchangesAndStoresToken() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_123", name: "Bond's iPhone", kind: "ios"),
            tokenId: "tok_abc",
            token: "omn_paired_xyz",
            scopes: ["admin", "read", "write:apple-health"]
        ))

        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"AAAA-BBBB\"}"
        let pairing = try await service.pairAsync(raw: v2)

        XCTAssertEqual(pairing.url.absoluteString, "https://mac.local:7600")
        XCTAssertEqual(pairing.token, "omn_paired_xyz")
        XCTAssertEqual(pairing.pairingGeneration, "tok_abc")
        XCTAssertEqual(pairing.accountId, "local")
        XCTAssertEqual(pairing.deviceId, "dev_123")
        XCTAssertEqual(pairing.gatewayName, "Bond's iPhone")
        XCTAssertEqual(pairing.scopes, ["admin", "read", "write:apple-health"])

        XCTAssertEqual(exchange.lastGatewayUrl?.absoluteString, "https://mac.local:7600")
        XCTAssertEqual(exchange.lastPairingCode, "AAAA-BBBB")
        XCTAssertEqual(exchange.lastCapabilities?.platform, "ios")

        // Scopes persisted as JSON so current() restores them.
        XCTAssertEqual(try storedBundle()?.token, "omn_paired_xyz")
        let reloaded = try service.current()
        XCTAssertEqual(reloaded?.scopes, ["admin", "read", "write:apple-health"])
    }

    func testV2PairAsyncFailsOnServerError() async {
        exchange.response = .failure(GatewayClient.Error.serverError(status: 400, body: "invalid code"))
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"BAD\"}"
        do {
            _ = try await service.pairAsync(raw: v2)
            XCTFail("expected error")
        } catch {
            // Expected.
        }
        // Nothing should be persisted on failure.
        XCTAssertNil(try? service.current())
    }

    func testV2PairAsyncAlsoHandlesV1() async throws {
        let pairing = try await service.pairAsync(raw: sampleV1JSON)
        XCTAssertEqual(pairing.accountId, "local")
    }

    /// accountId is hardcoded to `"local"` on every pair, independent of
    /// whatever device id the gateway returns. The gateway-issued
    /// deviceId is preserved as a separate field for the device registry.
    func testV2PairAsyncSetsAccountIdToLocal() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_123", name: "iPhone", kind: "ios"),
            tokenId: "tok", token: "omn_t", scopes: ["admin"]
        ))
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"AA-BB\"}"
        let pairing = try await service.pairAsync(raw: v2)
        XCTAssertEqual(pairing.accountId, "local")
        XCTAssertEqual(pairing.deviceId, "dev_123")
        XCTAssertEqual(try storedBundle()?.accountId, "local")
        XCTAssertEqual(try storedBundle()?.deviceId, "dev_123")

        // Re-pair with a NEW gateway device id — accountId stays "local",
        // deviceId tracks whatever the gateway just minted.
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_NEW", name: "iPhone", kind: "ios"),
            tokenId: "tok2", token: "omn_t2", scopes: ["admin"]
        ))
        let repaired = try await service.pairAsync(raw: v2)
        XCTAssertEqual(repaired.accountId, "local")
        XCTAssertEqual(repaired.deviceId, "dev_NEW")
    }

    /// Legacy pairings that pre-date `deviceId` storage fall back to
    /// `accountId` on load so downstream code keeps working. After a
    /// V1 pair, the deviceId Keychain entry holds the V1 payload's
    /// `accountId` field (a legacy device-row identifier); the
    /// `Pairing.accountId` field is `"local"`. Deleting the deviceId
    /// Keychain entry collapses both to `"local"`.
    func testCurrentFallsBackToAccountIdWhenDeviceIdMissing() throws {
        try store.set("https://mac.local:7600", forKey: "gateway.url")
        try store.set("omn_x", forKey: "gateway.token")
        try store.set("local", forKey: "gateway.accountId")
        try store.set("mac", forKey: "gateway.name")
        let current = try service.current()
        XCTAssertEqual(current?.accountId, "local")
        XCTAssertEqual(current?.deviceId, "local", "legacy fallback: deviceId == accountId")
    }

    // MARK: - V3 (TLS-pinned exchange + persistence)

    func testV4SystemTrustPersistsExplicitModeWithoutFingerprint() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v4", name: "Public gateway", kind: "ios"),
            tokenId: "tok_v4",
            token: "omn_v4_token",
            scopes: ["admin", "read"]
        ))
        let raw = #"{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AAAA-BBBB","tls":{"mode":"system"}}"#
        let pairing = try await service.pairAsync(raw: raw)

        XCTAssertEqual(pairing.tlsMode, .system)
        XCTAssertNil(pairing.fingerprint)
        XCTAssertEqual(try storedBundle()?.tlsMode, "system")
        XCTAssertNil(try storedBundle()?.fingerprint)
        XCTAssertEqual(try service.current()?.tlsMode, .system)
    }

    func testV4PinnedLeafPersistsExplicitModeAndFingerprint() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v4", name: "Private gateway", kind: "ios"),
            tokenId: "tok_v4",
            token: "omn_v4_token",
            scopes: ["read"]
        ))
        let fingerprint = String(repeating: "b", count: 64)
        let raw = #"{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"AAAA-BBBB","tls":{"mode":"pinned-leaf","fingerprint":"\#(fingerprint)"}}"#
        let pairing = try await service.pairAsync(raw: raw)

        XCTAssertEqual(pairing.tlsMode, .pinnedLeaf)
        XCTAssertEqual(pairing.fingerprint, fingerprint)
        XCTAssertEqual(try storedBundle()?.tlsMode, "pinned-leaf")
    }

    func testInterruptedTrustReplacementNeverMixesNewTokenWithOldSystemMode() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "old-device", name: "Old gateway", kind: "ios"),
            tokenId: "old-token-id", token: "old-token", scopes: ["read"]
        ))
        let oldRaw = #"{"v":4,"gatewayUrl":"https://old.example.com","pairingCode":"OLD","tls":{"mode":"system"}}"#
        _ = try await service.pairAsync(raw: oldRaw)

        let interruptedStore = InterruptingStore(base: store)
        interruptedStore.failNextBundleWrite = true
        let replacementExchange = StubExchange()
        replacementExchange.response = .success(DevicePairResponse(
            device: .init(id: "new-device", name: "New gateway", kind: "ios"),
            tokenId: "new-token-id", token: "new-token", scopes: ["read"]
        ))
        let replacement = PairingService(
            store: interruptedStore,
            exchange: replacementExchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        let fingerprint = String(repeating: "c", count: 64)
        let newRaw = #"{"v":4,"gatewayUrl":"https://new.example.com","pairingCode":"NEW","tls":{"mode":"pinned-leaf","fingerprint":"\#(fingerprint)"}}"#

        do {
            _ = try await replacement.pairAsync(raw: newRaw)
            XCTFail("expected interrupted Keychain replacement")
        } catch InterruptingStore.Failure.interrupted {
            // Expected.
        }

        let current = try XCTUnwrap(replacement.current())
        XCTAssertEqual(current.url.absoluteString, "https://old.example.com")
        XCTAssertEqual(current.token, "old-token")
        XCTAssertEqual(current.tlsMode, .system)
    }

    func testInterruptedDeleteThenAddLeavesPairingUnusableInsteadOfFailingOpen() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "old-device", name: "Old gateway", kind: "ios"),
            tokenId: "old-token-id", token: "old-token", scopes: ["read"]
        ))
        let oldRaw = #"{"v":4,"gatewayUrl":"https://old.example.com","pairingCode":"OLD","tls":{"mode":"system"}}"#
        _ = try await service.pairAsync(raw: oldRaw)

        let interruptedStore = InterruptingStore(base: store)
        interruptedStore.failNextBundleWrite = true
        interruptedStore.deleteBundleBeforeFailure = true
        let replacementExchange = StubExchange()
        replacementExchange.response = .success(DevicePairResponse(
            device: .init(id: "new-device", name: "New gateway", kind: "ios"),
            tokenId: "new-token-id", token: "new-token", scopes: ["read"]
        ))
        let replacement = PairingService(
            store: interruptedStore,
            exchange: replacementExchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        let fingerprint = String(repeating: "d", count: 64)
        let newRaw = #"{"v":4,"gatewayUrl":"https://new.example.com","pairingCode":"NEW","tls":{"mode":"pinned-leaf","fingerprint":"\#(fingerprint)"}}"#

        do {
            _ = try await replacement.pairAsync(raw: newRaw)
            XCTFail("expected interrupted Keychain replacement")
        } catch InterruptingStore.Failure.interrupted {
            // Expected.
        }

        XCTAssertNil(try replacement.current())
        XCTAssertNil(try store.get("gateway.token"))
        XCTAssertNil(try store.get("gateway.tlsMode"))
    }

    func testRecoveryCleanupFailureAfterCommitStillReturnsNewPairing() async throws {
        let interruptedStore = InterruptingStore(base: store)
        try store.set("1", forKey: "gateway.recoveryRequired")
        interruptedStore.failingDeleteKey = "gateway.recoveryRequired"
        let successfulExchange = StubExchange()
        successfulExchange.response = .success(DevicePairResponse(
            device: .init(id: "new-device", name: "Public gateway", kind: "ios"),
            tokenId: "new-token-id", token: "new-token", scopes: ["read"]
        ))
        let replacement = PairingService(
            store: interruptedStore,
            exchange: successfulExchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        let raw = #"{"v":4,"gatewayUrl":"https://public.example.com","pairingCode":"NEW","tls":{"mode":"system"}}"#

        let pairing = try await replacement.pairAsync(raw: raw)

        XCTAssertEqual(pairing.token, "new-token")
        XCTAssertEqual(try replacement.current()?.token, "new-token")
        XCTAssertEqual(try replacement.current()?.tlsMode, .system)
    }

    func testCurrentRejectsExplicitPinnedStateWithMissingFingerprint() throws {
        try store.set("https://gateway.example.com", forKey: "gateway.url")
        try store.set("secret-token", forKey: "gateway.token")
        try store.set("local", forKey: "gateway.accountId")
        try store.set("dev-corrupt", forKey: "gateway.deviceId")
        try store.set("Corrupt gateway", forKey: "gateway.name")
        try store.set("pinned-leaf", forKey: "gateway.tlsMode")

        XCTAssertNil(try service.current())
    }

    func testSystemTrustURLUpdateCannotChangeSchemeOrAuthority() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v4", name: "Public gateway", kind: "ios"),
            tokenId: "tok_v4",
            token: "omn_v4_token",
            scopes: ["admin", "read"]
        ))
        let raw = #"{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AAAA-BBBB","tls":{"mode":"system"}}"#
        _ = try await service.pairAsync(raw: raw)

        XCTAssertThrowsError(
            try service.updateGatewayURL(XCTUnwrap(URL(string: "http://public-gateway.example.com")))
        )
        XCTAssertThrowsError(
            try service.updateGatewayURL(XCTUnwrap(URL(string: "https://other.example.com")))
        )
        try service.updateGatewayURL(XCTUnwrap(URL(string: "https://public-gateway.example.com/")))
        XCTAssertEqual(try service.current()?.url.absoluteString, "https://public-gateway.example.com/")
    }

    private let v3Fingerprint =
        "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb"

    private var sampleV3JSON: String {
        """
        {"v":3,"gatewayUrl":"https://mac.local:7600","pairingCode":"AAAA-BBBB","fingerprint":"\(v3Fingerprint)"}
        """
    }

    func testV3PairAsyncPersistsFingerprint() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v3", name: "iPhone-V3", kind: "ios"),
            tokenId: "tok_v3",
            token: "omn_v3_token",
            scopes: ["admin", "read"]
        ))
        let pairing = try await service.pairAsync(raw: sampleV3JSON)
        XCTAssertEqual(pairing.token, "omn_v3_token")
        XCTAssertEqual(pairing.fingerprint, v3Fingerprint)
        XCTAssertEqual(try storedBundle()?.fingerprint, v3Fingerprint)

        // current() should round-trip the fingerprint back.
        let reloaded = try service.current()
        XCTAssertEqual(reloaded?.fingerprint, v3Fingerprint)
    }

    func testV2PairClearsPriorFingerprint() async throws {
        // First pair V3 to seed a fingerprint.
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v3", name: "iPhone", kind: "ios"),
            tokenId: "t", token: "omn_v3", scopes: []
        ))
        _ = try await service.pairAsync(raw: sampleV3JSON)
        XCTAssertNotNil(try storedBundle()?.fingerprint)

        // Then re-pair with V2 — fingerprint must be wiped.
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_v2", name: "iPhone-V2", kind: "ios"),
            tokenId: "t2", token: "omn_v2", scopes: []
        ))
        let v2 = "{\"v\":2,\"gatewayUrl\":\"https://mac.local:7600\",\"pairingCode\":\"X\"}"
        let pairing = try await service.pairAsync(raw: v2)
        XCTAssertNil(pairing.fingerprint)
        XCTAssertNil(try storedBundle()?.fingerprint)
    }

    func testSyncPairRejectsV3() {
        XCTAssertThrowsError(try service.pair(raw: sampleV3JSON))
    }

    // MARK: - Lifecycle invariants

    func testCurrentReturnsNilWhenUnpaired() throws {
        XCTAssertNil(try service.current())
    }

    func testClearDropsAllKeys() throws {
        _ = try service.pair(raw: sampleV1JSON)
        try service.clear()
        XCTAssertNil(try store.get("gateway.url"))
        XCTAssertNil(try store.get("gateway.token"))
        XCTAssertNil(try store.get("gateway.accountId"))
        XCTAssertNil(try store.get("gateway.name"))
        XCTAssertNil(try store.get(PairingCredentialBundle.key))
        XCTAssertNil(try service.current())
    }

    func testPartialStoreYieldsNilCurrent() throws {
        try store.set("http://mac.local:7600", forKey: "gateway.url")
        // Token + accountId + name intentionally absent
        XCTAssertNil(try service.current())
    }

    func testLoadPurgesPlaintextCredentialBundleAndRequiresRepair() throws {
        let credential = PairingCredentialBundle(
            url: "http://gateway.example:7600",
            token: "omn_old",
            accountId: "local",
            deviceId: "old-device",
            name: "Old gateway",
            scopes: ["read"],
            tlsMode: PairingTlsMode.legacy.rawValue,
            fingerprint: nil
        )
        try store.set(credential.encoded(), forKey: PairingCredentialBundle.key)

        XCTAssertEqual(
            try service.load(),
            .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: nil))
        )
        XCTAssertNil(try store.get(PairingCredentialBundle.key))
        XCTAssertNil(try service.current())
    }

    func testLoadPurgesPlaintextSplitCredentialsAndRequiresRepair() throws {
        try store.set("http://gateway.example:7600", forKey: "gateway.url")
        try store.set("omn_old", forKey: "gateway.token")
        try store.set("local", forKey: "gateway.accountId")
        try store.set("old-device", forKey: "gateway.deviceId")
        try store.set("Old gateway", forKey: "gateway.name")

        XCTAssertEqual(
            try service.load(),
            .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: nil))
        )
        XCTAssertNil(try store.get("gateway.url"))
        XCTAssertNil(try store.get("gateway.token"))
        XCTAssertNil(try service.current())
    }

    func testUpdateGatewayURLSwapsURLKeepingOtherState() throws {
        _ = try service.pair(raw: sampleV1JSON)
        try service.updateGatewayURL(XCTUnwrap(URL(string: "https://mac.tailnet.example")))
        let current = try service.current()
        XCTAssertEqual(current?.url.absoluteString, "https://mac.tailnet.example")
        XCTAssertEqual(current?.token, "omn_x")
        XCTAssertEqual(current?.accountId, "local")
    }
}
