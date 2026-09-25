// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PairingRevocationLifecycleTests: XCTestCase {
    private var store: InMemoryStore!
    private var exchange: StubExchange!
    private var service: PairingService!

    override func setUp() {
        super.setUp()
        store = InMemoryStore()
        exchange = StubExchange()
        service = PairingService(
            store: store,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
    }

    func testStagedUnpairSurvivesRestartUntilRemoteRevocationSettles() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_fictional", name: "Fictional iPhone", kind: "ios"),
            tokenId: "generation_fictional",
            token: "omn_fictional",
            scopes: ["admin"]
        ))
        let payload = "{\"v\":2,\"gatewayUrl\":\"https://gateway.example.com:7600\",\"pairingCode\":\"AA-BB\"}"
        let paired = try await service.pairAsync(raw: payload)

        let staged = try service.stageUnpair()
        XCTAssertEqual(staged, paired)
        XCTAssertNil(try service.current())

        let relaunched = PairingService(
            store: store,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        XCTAssertEqual(try relaunched.pendingRevocation(), paired)
        try relaunched.settlePendingRevocation(paired)
        XCTAssertNil(try relaunched.pendingRevocation())
    }

    func testStagedUnpairInterruptionNeverArmsRevocationForAnActivePairing() async throws {
        let deletionOrder = [
            "gateway.url", "gateway.token", "gateway.accountId", "gateway.deviceId",
            "gateway.name", "gateway.scopes", "gateway.fingerprint", "gateway.tlsMode",
            "gateway.recoveryRequired", "gateway.recoveryGatewayURL",
            PairingCredentialBundle.key,
        ]
        for failingKey in deletionOrder {
            let base = InMemoryStore()
            let interrupting = InterruptingStore(base: base)
            let stub = StubExchange()
            stub.response = .success(DevicePairResponse(
                device: .init(id: "dev_atomic", name: "Fictional Phone", kind: "ios"),
                tokenId: "generation_atomic",
                token: "omn_atomic",
                scopes: ["admin"]
            ))
            let subject = PairingService(
                store: interrupting,
                exchange: stub,
                pinnedExchangeBuilder: { _ in nil }
            )
            let payload = "{\"v\":2,\"gatewayUrl\":\"https://gateway.example.com:7600\",\"pairingCode\":\"AA-BB\"}"
            let paired = try await subject.pairAsync(raw: payload)
            interrupting.failingDeleteKey = failingKey

            XCTAssertThrowsError(
                try subject.stageUnpair(),
                "expected interruption at \(failingKey)"
            )
            XCTAssertEqual(try subject.current(), paired)
            XCTAssertNil(
                try subject.pendingRevocation(),
                "active generation must keep its journal dormant"
            )

            interrupting.failingDeleteKey = nil
            XCTAssertEqual(try subject.stageUnpair(), paired)
            XCTAssertNil(try subject.current())
            XCTAssertEqual(try subject.pendingRevocation(), paired)
        }
    }

    func testRevocationOutboxKeepsTwoOfflineUnpairsAndSettlesExactGeneration() async throws {
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_a", name: "Fictional Phone", kind: "ios"),
            tokenId: "generation_a",
            token: "omn_a",
            scopes: ["admin"]
        ))
        let payload = "{\"v\":2,\"gatewayUrl\":\"https://gateway.example.com:7600\",\"pairingCode\":\"AA-BB\"}"
        let first = try await service.pairAsync(raw: payload)
        _ = try service.stageUnpair()

        exchange.response = .success(DevicePairResponse(
            device: .init(id: "dev_b", name: "Fictional Tablet", kind: "ios"),
            tokenId: "generation_b",
            token: "omn_b",
            scopes: ["admin"]
        ))
        let second = try await service.pairAsync(raw: payload)
        _ = try service.stageUnpair()

        let relaunched = PairingService(
            store: store,
            exchange: exchange,
            pinnedExchangeBuilder: { _ in nil }
        )
        XCTAssertEqual(try relaunched.pendingRevocation(), first)
        try relaunched.settlePendingRevocation(first)
        XCTAssertEqual(try relaunched.pendingRevocation(), second)
        try relaunched.settlePendingRevocation(second)
        XCTAssertNil(try relaunched.pendingRevocation())
    }

    func testLegacyRevocationFromAnotherGatewayIsNotMistakenForActivePairing() throws {
        let first = try service.pair(raw: """
        {"v":1,"url":"https://gateway-a.example.com:7600","token":"omn_a","accountId":"local","name":"Gateway A"}
        """)
        XCTAssertEqual(try service.stageUnpair(), first)
        let second = try service.pair(raw: """
        {"v":1,"url":"https://gateway-b.example.com:7600","token":"omn_b","accountId":"local","name":"Gateway B"}
        """)

        XCTAssertEqual(try service.current(), second)
        XCTAssertEqual(try service.pendingRevocation(), first)
    }
}
