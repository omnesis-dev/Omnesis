// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PairingMigrationTests: XCTestCase {
    private var store: InMemoryStore!
    private var exchange: PairingMigrationStubExchange!
    private var service: PairingService!

    override func setUp() {
        super.setUp()
        store = InMemoryStore()
        exchange = PairingMigrationStubExchange()
        service = PairingService(
            store: store,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
    }

    private var sampleV1JSON: String {
        """
        {"v":1,"url":"https://mac.local:7600","token":"omn_x","accountId":"ios-a","name":"mac"}
        """
    }

    func testLegacySynchronizablePairingIsRejectedAndPurged() throws {
        seedLegacySynchronizablePairing(
            url: "https://gateway.example:7600",
            token: "omn_inherited",
            deviceId: "device-from-another-phone"
        )

        let state = try service.load()

        XCTAssertEqual(
            state,
            .legacyPairingRequiresRepair(
                PairingRecovery(gatewayURL: URL(string: "https://gateway.example:7600"))
            )
        )
        XCTAssertFalse(try store.hasLegacySynchronizableValues())
        XCTAssertNil(try service.current(), "a synchronized token must never become local authority")
    }

    func testPlaintextLegacyRecoveryPersistsWithoutAnInsecureHint() throws {
        seedLegacySynchronizablePairing(url: "http://gateway.example:7600")
        _ = try service.load()

        XCTAssertEqual(
            try service.load(),
            .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: nil))
        )
        XCTAssertNil(try store.get("gateway.recoveryGatewayURL"))
    }

    func testCompleteDeviceLocalPairingWinsOverConflictingLegacyRows() throws {
        _ = try service.pair(raw: sampleV1JSON)
        seedLegacySynchronizablePairing(
            url: "https://other-gateway.example:7600",
            token: "omn_other",
            deviceId: "other-device"
        )

        let state = try service.load()

        guard case .paired(let pairing) = state else {
            return XCTFail("expected the complete device-local pairing")
        }
        XCTAssertEqual(pairing.url.absoluteString, "https://mac.local:7600")
        XCTAssertEqual(pairing.token, "omn_x")
        XCTAssertEqual(pairing.deviceId, "ios-a")
        XCTAssertFalse(try store.hasLegacySynchronizableValues())
    }

    func testPartialDeviceLocalAndLegacyRowsNeverFormHybridPairing() throws {
        try store.set("https://local-gateway.example:7600", forKey: "gateway.url")
        seedLegacySynchronizablePairing(
            url: "https://legacy-gateway.example:7600",
            token: "omn_inherited",
            deviceId: "legacy-device"
        )

        let state = try service.load()

        guard case .legacyPairingRequiresRepair = state else {
            return XCTFail("expected legacy recovery")
        }
        XCTAssertEqual(
            try store.get("gateway.url"),
            "https://local-gateway.example:7600",
            "inert partial local state must not be deleted by a concurrent migration"
        )
        XCTAssertNil(try store.get("gateway.token"))
        XCTAssertNil(try service.current())

        // Simulate the foreground pairing write completing after the
        // migration read. It must remain able to form a valid local bundle.
        try store.set("omn_new", forKey: "gateway.token")
        try store.set("local", forKey: "gateway.accountId")
        try store.set("new-device", forKey: "gateway.deviceId")
        try store.set("iPad", forKey: "gateway.name")
        guard case .paired(let completed) = try service.load() else {
            return XCTFail("expected the completed device-local pairing")
        }
        XCTAssertEqual(completed.token, "omn_new")
        XCTAssertEqual(completed.deviceId, "new-device")
    }

    func testRecoveryKeepsOnlyValidatedGatewayURL() throws {
        seedLegacySynchronizablePairing(
            url: "javascript:alert(1)",
            token: "omn_inherited",
            deviceId: "legacy-device"
        )

        XCTAssertEqual(
            try service.load(),
            .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: nil))
        )
        XCTAssertNil(try store.get("gateway.token"))
        XCTAssertNil(try store.get("gateway.deviceId"))
        XCTAssertNil(try store.get("gateway.recoveryGatewayURL"))
    }

    func testRecoveryRejectsGatewayURLContainingCredentialsOrQueryData() throws {
        seedLegacySynchronizablePairing(
            url: "https://operator:secret@gateway.example:7600/base?token=sensitive"
        )

        XCTAssertEqual(
            try service.load(),
            .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: nil))
        )
        XCTAssertNil(try store.get("gateway.recoveryGatewayURL"))
    }

    func testRecoveryJournalSurvivesInterruptedLegacyCleanup() throws {
        let interruptedStore = PairingMigrationFailingLegacyDeleteStore()
        interruptedStore.backing.setLegacySynchronizable(
            "https://gateway.example:7600",
            forKey: "gateway.url"
        )
        interruptedStore.backing.setLegacySynchronizable("omn_old", forKey: "gateway.token")
        let interruptedService = PairingService(
            store: interruptedStore,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )

        XCTAssertThrowsError(try interruptedService.load())
        XCTAssertEqual(try interruptedStore.get("gateway.recoveryRequired"), "1")
        XCTAssertEqual(
            try interruptedStore.get("gateway.recoveryGatewayURL"),
            "https://gateway.example:7600"
        )

        XCTAssertEqual(
            try interruptedService.load(),
            .legacyPairingRequiresRepair(
                PairingRecovery(gatewayURL: URL(string: "https://gateway.example:7600"))
            )
        )
    }

    func testFreshPairClearsLegacyRecoveryState() async throws {
        seedLegacySynchronizablePairing(url: "https://gateway.example:7600")
        _ = try service.load()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "new-device", name: "iPad", kind: "ios"),
            tokenId: "new-token-id",
            token: "omn_new",
            scopes: ["read"]
        ))

        _ = try await service.pairAsync(
            raw: """
            {"v":2,"gatewayUrl":"https://gateway.example:7600","pairingCode":"AAAA-BBBB"}
            """
        )

        guard case .paired(let pairing) = try service.load() else {
            return XCTFail("expected new device-local pairing")
        }
        XCTAssertEqual(pairing.deviceId, "new-device")
        XCTAssertNil(try store.get("gateway.recoveryRequired"))
        XCTAssertNil(try store.get("gateway.recoveryGatewayURL"))
    }

    #if canImport(UIKit)
    @MainActor
    func testCoordinatorExposesLegacyRecoveryWithoutPairing() {
        seedLegacySynchronizablePairing(url: "https://gateway.example:7600")
        let coordinator = PairingCoordinator(service: service)

        coordinator.reload()

        XCTAssertNil(coordinator.pairing)
        XCTAssertEqual(
            coordinator.recovery,
            PairingRecovery(gatewayURL: URL(string: "https://gateway.example:7600"))
        )
    }

    @MainActor
    func testCoordinatorClearsStalePairingWhenReloadFails() {
        let failingStore = PairingMigrationFailingLoadStore()
        let failingService = PairingService(
            store: failingStore,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        let coordinator = PairingCoordinator(service: failingService)
        XCTAssertNotNil(coordinator.pair(raw: sampleV1JSON))
        failingStore.failLoads = true

        coordinator.reload()

        XCTAssertNil(coordinator.pairing)
        XCTAssertNil(coordinator.recovery)
    }

    @MainActor
    func testAppStoreTearsDownPairingBoundRuntimeWhenReloadFails() async {
        let failingStore = PairingMigrationFailingLoadStore()
        let failingService = PairingService(
            store: failingStore,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        _ = try? failingService.pair(raw: sampleV1JSON)
        // `init` reloads, and both directions of a pairing transition build
        // their runtime in a task — so each one is awaited before the runtime
        // is inspected.
        let appStore = AppStore(service: failingService, localSourceOwner: LocalSourceOwnerRecord(defaults: DictionaryDefaults()))
        await appStore.awaitPairingRuntimeForTesting()
        XCTAssertTrue(appStore.pairingTransportRuntimeActiveForTesting)
        failingStore.failLoads = true

        appStore.reload()
        await appStore.awaitPairingRuntimeForTesting()

        XCTAssertNil(appStore.pairing)
        XCTAssertFalse(appStore.pairingTransportRuntimeActiveForTesting)
        XCTAssertNotNil(appStore.lastError)
    }
    #endif

    private func seedLegacySynchronizablePairing(
        url: String,
        token: String = "omn_legacy",
        deviceId: String = "legacy-device"
    ) {
        store.setLegacySynchronizable(url, forKey: "gateway.url")
        store.setLegacySynchronizable(token, forKey: "gateway.token")
        store.setLegacySynchronizable("local", forKey: "gateway.accountId")
        store.setLegacySynchronizable(deviceId, forKey: "gateway.deviceId")
        store.setLegacySynchronizable("Legacy iPhone", forKey: "gateway.name")
        store.setLegacySynchronizable("[\"read\"]", forKey: "gateway.scopes")
    }
}

private final class PairingMigrationStubExchange: PairingExchangeHTTP, @unchecked Sendable {
    var response: Result<DevicePairResponse, Error> = .failure(
        GatewayClient.Error.serverError(status: 500, body: "unstubbed")
    )

    func exchange(
        gatewayUrl _: URL,
        pairingCode _: String,
        capabilities _: PairingCapabilities
    ) async throws
        -> DevicePairResponse {
        switch response {
        case .success(let result): return result
        case .failure(let error): throw error
        }
    }
}

private final class PairingMigrationFailingLegacyDeleteStore: PairingStore, @unchecked Sendable {
    enum Failure: Error { case interrupted }

    let backing = InMemoryStore()
    private var shouldFailDelete = true

    func set(_ value: String, forKey key: String) throws {
        try backing.set(value, forKey: key)
    }

    func get(_ key: String) throws -> String? {
        try backing.get(key)
    }

    func getLegacySynchronizable(_ key: String) throws -> String? {
        try backing.getLegacySynchronizable(key)
    }

    func hasLegacySynchronizableValues() throws -> Bool {
        try backing.hasLegacySynchronizableValues()
    }

    func deleteLegacySynchronizableValues() throws {
        if shouldFailDelete {
            shouldFailDelete = false
            throw Failure.interrupted
        }
        try backing.deleteLegacySynchronizableValues()
    }

    func delete(_ key: String) throws {
        try backing.delete(key)
    }

    func deleteAll() throws {
        try backing.deleteAll()
    }
}

#if canImport(UIKit)
private final class PairingMigrationFailingLoadStore: PairingStore, @unchecked Sendable {
    enum Failure: Error { case forced }

    private let backing = InMemoryStore()
    var failLoads = false

    func set(_ value: String, forKey key: String) throws {
        try backing.set(value, forKey: key)
    }

    func get(_ key: String) throws -> String? {
        if failLoads { throw Failure.forced }
        return try backing.get(key)
    }

    func getLegacySynchronizable(_ key: String) throws -> String? {
        if failLoads { throw Failure.forced }
        return try backing.getLegacySynchronizable(key)
    }

    func hasLegacySynchronizableValues() throws -> Bool {
        if failLoads { throw Failure.forced }
        return try backing.hasLegacySynchronizableValues()
    }

    func deleteLegacySynchronizableValues() throws {
        try backing.deleteLegacySynchronizableValues()
    }

    func delete(_ key: String) throws {
        try backing.delete(key)
    }

    func deleteAll() throws {
        try backing.deleteAll()
    }
}
#endif
