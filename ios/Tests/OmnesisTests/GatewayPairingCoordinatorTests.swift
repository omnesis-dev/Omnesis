// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class GatewayPairingCoordinatorTests: XCTestCase {
    private let original = Pairing(
        url: URL(string: "https://gateway.example.test")!,
        token: "device-token",
        pairingGeneration: "generation",
        accountId: "local",
        deviceId: "device",
        gatewayName: "Gateway",
        scopes: ["read"],
        spkiFingerprint: String(repeating: "ab", count: 32),
        tlsMode: .pinnedKeyStrict
    )
    private let facts = [GatewayDirectCandidate(address: "10.0.0.4", port: 8443)]

    private func service() throws -> PairingService {
        let store = InMemoryStore()
        try store.set(
            PairingCredentialBundle(original, url: original.url, tlsMode: original.tlsMode, fingerprint: nil).encoded(),
            forKey: PairingCredentialBundle.key
        )
        return PairingService(store: store)
    }

    func testFreshFactsUpdatePersistedAndObservableSnapshotsBeforePublishingWithoutRebuild() async throws {
        let service = try service()
        let coordinator = PairingCoordinator(service: service)
        _ = coordinator.reload()
        let discovery = Facts(candidates: facts)
        var published = 0
        let refresher = try XCTUnwrap(coordinator.hintRefresher(pairing: original, discovery: discovery) { current in
            XCTAssertEqual(coordinator.pairing, current)
            XCTAssertTrue(current.sameAuthority(as: self.original))
            published += 1
        })
        let changed = try await refresher.refresh { _ in }
        XCTAssertTrue(changed)
        XCTAssertEqual(coordinator.pairing?.directCandidates, facts)
        XCTAssertEqual(coordinator.pairing, try service.current())
        XCTAssertEqual(published, 1)
        // Default discovery construction is optional; no provider/network is touched until a refresh is requested.
        XCTAssertNotNil(coordinator.hintRefresher(pairing: original) { _ in })
        let direct = Pairing(url: original.url, token: "direct-token", accountId: "local", deviceId: "direct-device", gatewayName: "Direct")
        XCTAssertNil(coordinator.hintRefresher(pairing: direct) { _ in XCTFail("Legacy pairing acquired cloud refresh") })
    }

    func testUnloadedOrReleasedCoordinatorCannotPublishAnInMemoryAuthority() async throws {
        let service = try service()
        let unloaded = PairingCoordinator(service: service)
        let refresher = try XCTUnwrap(unloaded.hintRefresher(pairing: original, discovery: Facts(candidates: facts)) { _ in
            XCTFail("Unloaded coordinator published a credential")
        })
        let changed = try await refresher.refresh { _ in }
        XCTAssertTrue(changed)
        XCTAssertNil(unloaded.pairing)
        var released: PairingCoordinator? = PairingCoordinator(service: service)
        _ = released?.reload()
        weak var reference = released
        let orphan = try XCTUnwrap(released?.hintRefresher(pairing: original, discovery: Facts(candidates: [])) { _ in
            XCTFail("Released coordinator published a credential")
        })
        released = nil
        XCTAssertNil(reference)
        let cleared = try await orphan.refresh { _ in }
        XCTAssertTrue(cleared)
        XCTAssertNil(try service.current()?.directCandidates)
    }

    func testReplacingThePairingRejectsOldMetadataWithoutRevertingObservableState() async throws {
        let service = try service()
        let coordinator = PairingCoordinator(service: service)
        _ = coordinator.reload()
        let old = try XCTUnwrap(coordinator.hintRefresher(pairing: original, discovery: Facts(candidates: facts)) { _ in
            XCTFail("Obsolete pairing published LAN hints")
        })
        let direct = try XCTUnwrap(coordinator
            .pair(raw: #"{"v":1,"url":"https://direct.example.test","token":"direct-token","accountId":"local","name":"Direct"}"#))
        let changed = try await old.refresh { _ in XCTFail("Obsolete routing lease updated") }
        XCTAssertFalse(changed)
        XCTAssertEqual(coordinator.pairing, direct)
        XCTAssertEqual(try service.current(), direct)
    }

    func testCurrentAsyncExchangePublishesItsCommittedPairingAndEndsRepairMode() async throws {
        let started = expectation(description: "Pair exchange started")
        let exchange = ControlledExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange)
        let coordinator = PairingCoordinator(service: service)
        var errors: [String?] = []
        coordinator.setOnError { errors.append($0) }
        coordinator.enterRepairMode()
        let operation = Task { await coordinator.pairAsync(raw: exchangePayload) }
        await fulfillment(of: [started], timeout: 5)
        await exchange.finish(.success(response()))
        let paired = await operation.value
        XCTAssertEqual(paired?.pairingGeneration, "new-issued-generation")
        XCTAssertEqual(coordinator.pairing, paired)
        XCTAssertEqual(try service.current(), paired)
        XCTAssertFalse(coordinator.isRepairing)
        XCTAssertNil(coordinator.recovery)
        XCTAssertEqual(errors.count, 2)
        XCTAssertEqual(errors.last, .some(nil))
    }

    func testCurrentAsyncFailureAndCancellationNeverPublishCredentialsOrEndRepairMode() async throws {
        for cancel in [false, true] {
            let started = expectation(description: "Pair exchange reached suspension")
            let exchange = ControlledExchange(started: started)
            let service = PairingService(store: InMemoryStore(), exchange: exchange)
            let coordinator = PairingCoordinator(service: service)
            var errors: [String?] = []
            coordinator.setOnError { errors.append($0) }
            coordinator.enterRepairMode()
            let operation = Task { await coordinator.pairAsync(raw: exchangePayload) }
            await fulfillment(of: [started], timeout: 5)
            if cancel { operation.cancel() }
            await exchange.finish(cancel ? .success(response()) : .failure(URLError(.notConnectedToInternet)))
            let result = await operation.value
            XCTAssertNil(result)
            XCTAssertNil(coordinator.pairing)
            XCTAssertNil(try service.current())
            XCTAssertTrue(coordinator.isRepairing)
            XCTAssertEqual(errors.count, 2)
            XCTAssertNotNil(try XCTUnwrap(errors.last))
        }
    }

    func testUnpairAndReplacementInvalidateLateExchangeResultsAndTheirErrors() async throws {
        for replace in [false, true] {
            let started = expectation(description: "Old pair exchange reached suspension")
            let exchange = ControlledExchange(started: started)
            let service = PairingService(store: InMemoryStore(), exchange: exchange)
            let coordinator = PairingCoordinator(service: service)
            var errors: [String?] = []
            coordinator.setOnError { errors.append($0) }
            let operation = Task { await coordinator.pairAsync(raw: exchangePayload) }
            await fulfillment(of: [started], timeout: 5)
            let expected: Pairing?
            if replace {
                expected = try XCTUnwrap(coordinator
                    .pair(
                        raw: #"{"v":1,"url":"https://replacement.example.test","token":"replacement-token","accountId":"replacement-device","name":"Replacement gateway"}"#
                    ))
            } else {
                XCTAssertTrue(coordinator.clear())
                expected = nil
            }
            let errorCount = errors.count
            // A transport may complete successfully after unpair or fail after another pairing wins.
            await exchange.finish(replace ? .failure(URLError(.networkConnectionLost)) : .success(response()))
            let obsolete = await operation.value
            XCTAssertNil(obsolete)
            XCTAssertEqual(coordinator.pairing, expected)
            XCTAssertEqual(try service.current(), expected)
            XCTAssertEqual(errors.count, errorCount, "An obsolete exchange cannot replace the current presentation's error")
        }
    }

    func testACompletedOlderExchangeCannotExitANewerRepairPresentation() async throws {
        let started = expectation(description: "Pair exchange reached suspension")
        let exchange = ControlledExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange)
        let coordinator = PairingCoordinator(service: service)
        var errors: [String?] = []
        coordinator.setOnError { errors.append($0) }
        let operation = Task { await coordinator.pairAsync(raw: exchangePayload) }
        await fulfillment(of: [started], timeout: 5)
        coordinator.enterRepairMode()
        let errorCount = errors.count
        await exchange.finish(.success(response()))
        let obsolete = await operation.value
        XCTAssertNil(obsolete)
        XCTAssertNil(coordinator.pairing)
        XCTAssertTrue(coordinator.isRepairing)
        XCTAssertEqual(errors.count, errorCount)
        // The service's commit succeeded, but it no longer owns the coordinator's newer presentation.
        XCTAssertEqual(try service.current()?.pairingGeneration, "new-issued-generation")
    }

    func testStagedUnpairAndSuccessfulOrRejectedURLChangesInvalidateThePendingPairing() async throws {
        for action in ["stage-unpair", "change-url", "reject-url"] {
            let started = expectation(description: "Old pair exchange started")
            let exchange = ControlledExchange(started: started)
            let vault = InMemoryStore()
            try vault.set(
                PairingCredentialBundle(original, url: original.url, tlsMode: original.tlsMode, fingerprint: nil).encoded(),
                forKey: PairingCredentialBundle.key
            )
            let service = PairingService(store: vault, exchange: exchange)
            let coordinator = PairingCoordinator(service: service)
            _ = coordinator.reload()
            var errors: [String?] = []
            coordinator.setOnError { errors.append($0) }
            let operation = Task { await coordinator.pairAsync(raw: exchangePayload) }
            await fulfillment(of: [started], timeout: 5)
            if action == "stage-unpair" {
                XCTAssertEqual(coordinator.stageUnpair(), original)
                XCTAssertEqual(coordinator.pendingRevocation(), original)
            } else if action == "change-url" {
                try coordinator.updateGatewayURL(XCTUnwrap(URL(string: "https://moved.example.test")))
                _ = coordinator.reload()
                XCTAssertEqual(coordinator.pairing?.url.absoluteString, "https://moved.example.test")
            } else {
                XCTAssertThrowsError(try coordinator.updateGatewayURL(XCTUnwrap(URL(string: "http://rejected.example.test"))))
                XCTAssertEqual(coordinator.pairing, original)
            }
            let expected = coordinator.pairing, errorCount = errors.count
            await exchange.finish(.success(response()))
            let obsolete = await operation.value
            XCTAssertNil(obsolete)
            XCTAssertEqual(coordinator.pairing, expected)
            XCTAssertEqual(try service.current(), expected)
            XCTAssertEqual(errors.count, errorCount)
        }
    }

    private var exchangePayload: String {
        #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
    }

    private func response() -> DevicePairResponse {
        .init(
            device: .init(id: "new-test-phone", name: "Test phone", kind: "ios"),
            tokenId: "new-issued-generation",
            token: "new-test-token",
            scopes: ["read"]
        )
    }

    private actor ControlledExchange: PairingExchangeHTTP {
        let started: XCTestExpectation
        private var continuation: CheckedContinuation<DevicePairResponse, Error>?
        init(started: XCTestExpectation) {
            self.started = started
        }

        func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                started.fulfill()
            }
        }

        func finish(_ result: Result<DevicePairResponse, Error>) {
            continuation?.resume(with: result)
            continuation = nil
        }
    }

    private struct Facts: GatewayDirectDiscovering {
        let candidates: [GatewayDirectCandidate]
        func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
            candidates
        }
    }
}
