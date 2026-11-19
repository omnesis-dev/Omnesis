// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class GatewayPairingGenerationTests: XCTestCase {
    private let key = String(repeating: "a1", count: 32)
    private let legacy = """
    {"v":1,"url":"https://direct.example.test","token":"replacement-token","accountId":"replacement","name":"Direct gateway"}
    """

    private var keyQR: String {
        """
        {"v":4,"gatewayUrl":"https://gateway.example.test","pairingCode":"SYNTHETIC","tls":{"mode":"pinned-key-strict","spkiFingerprint":"\(
            key
        )"}}
        """
    }

    func testDelayedMetadataCannotResurrectUnpairedCredential() async throws {
        let gate = CandidateGate()
        let service = makeService(gate)
        let pending = Task { try await service.pairAsync(raw: keyQR) }
        await gate.waitUntilStarted()
        try service.clear()
        await gate.finish([.init(address: "192.168.1.2", port: 443)])
        await assertCancelled(pending)
        XCTAssertNil(try service.current())
    }

    func testDelayedMetadataCannotReplaceNewerDirectPairing() async throws {
        let gate = CandidateGate()
        let service = makeService(gate)
        let pending = Task { try await service.pairAsync(raw: keyQR) }
        await gate.waitUntilStarted()
        let replacement = try service.pair(raw: legacy)
        await gate.finish([])
        await assertCancelled(pending)
        XCTAssertEqual(try service.current(), replacement)
        XCTAssertNil(try service.current()?.spkiFingerprint)
        XCTAssertNil(try service.current()?.directCandidates)
    }

    func testCancelledMetadataDoesNotCommitEvenIfProviderIgnoresCancellation() async throws {
        let gate = CandidateGate()
        let service = makeService(gate)
        let pending = Task { try await service.pairAsync(raw: keyQR) }
        await gate.waitUntilStarted()
        pending.cancel()
        await gate.finish([])
        await assertCancelled(pending)
        XCTAssertNil(try service.current())
    }

    func testOptionalFactsPersistAlongsideSameAuthorityAndToken() async throws {
        let gate = CandidateGate()
        let service = makeService(gate)
        let pending = Task { try await service.pairAsync(raw: keyQR) }
        await gate.waitUntilStarted()
        let candidates = [GatewayDirectCandidate(address: "10.4.2.1", port: 7600)]
        await gate.finish(candidates)
        let paired = try await pending.value
        XCTAssertEqual(paired.directCandidates, candidates)
        XCTAssertEqual(paired.spkiFingerprint, key)
        XCTAssertEqual(paired.token, "synthetic-token")
        XCTAssertEqual(try service.current(), paired)
        XCTAssertNotNil(paired.directRoute)
        let staged = try service.stageUnpair()
        XCTAssertEqual(staged, paired)
        XCTAssertNil(try service.current())
        XCTAssertEqual(try service.pendingRevocation(), paired)
        try service.settlePendingRevocation(paired)
        XCTAssertNil(try service.pendingRevocation())
    }

    func testInvalidOptionalHintsCannotChangeAuthority() async throws {
        let gate = CandidateGate()
        let service = makeService(gate)
        let pending = Task { try await service.pairAsync(raw: keyQR) }
        await gate.waitUntilStarted()
        await gate.finish([.init(address: "8.8.8.8", port: 443)])
        do { _ = try await pending.value
            XCTFail("Malformed LAN metadata committed")
        } catch { XCTAssertNil(try service.current()) }
    }

    func testStoredKeyPinsRequireTheSameASCIIHexContractAsQRAndAndroid() throws {
        for pin in [String(repeating: "ａ", count: 64), String(repeating: "A", count: 64), "bad", ""] {
            let store = InMemoryStore()
            let bundle = PairingCredentialBundle(
                url: "https://gateway.example.test",
                token: "test-token",
                pairingGeneration: "generation",
                accountId: "local",
                deviceId: "test-device",
                name: "Test gateway",
                scopes: ["read"],
                tlsMode: "pinned-key-strict",
                fingerprint: nil,
                spkiFingerprint: pin
            )
            try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
            XCTAssertNil(try PairingService(store: store).current())
        }
    }

    func testConcurrentPairingAttemptsUseOneStableInstallIdentityAndAtomicCredentials() async throws {
        let store = InMemoryStore()
        let exchange = IdentityExchange()
        let service = PairingService(store: store, exchange: exchange)
        await withTaskGroup(of: Void.self) { group in
            for index in 0 ..< 32 {
                group.addTask {
                    let raw = #"{"v":2,"gatewayUrl":"https://direct.example.test","pairingCode":"SYNTHETIC-\#(index)"}"#
                    do { _ = try await service.pairAsync(raw: raw) } catch is CancellationError {} catch {
                        XCTFail("Unexpected pairing error: \(error)")
                    }
                }
            }
        }
        let identities = await exchange.identities()
        XCTAssertEqual(identities.count, 32)
        XCTAssertEqual(Set(identities.compactMap { $0 }).count, 1)
        XCTAssertEqual(try store.get("install.id"), try XCTUnwrap(identities.compactMap { $0 }.first))
        let current = try XCTUnwrap(service.current())
        XCTAssertEqual(current.token, current.pairingGeneration)
    }

    func testFenceReleasesAfterThrownCommitAndReplacement() throws {
        let fence = PairingMutationFence()
        let first = fence.begin()
        XCTAssertThrowsError(try fence.commit(first) { throw Synthetic.failure })
        XCTAssertEqual(try fence.commit(first) { 7 }, 7)
        XCTAssertThrowsError(try fence.replace { throw Synthetic.failure })
        XCTAssertThrowsError(try fence.commit(first) { 0 })
        let fresh = fence.begin()
        XCTAssertEqual(try fence.commit(fresh) { fence.serialized { 9 } }, 9)
    }

    private func makeService(_ gate: CandidateGate) -> PairingService {
        PairingService(
            store: InMemoryStore(),
            exchange: SyntheticExchange(),
            keyPinnedExchangeBuilder: { _, _ in nil },
            directDiscovery: gate
        )
    }

    private func assertCancelled(_ task: Task<Pairing, Error>, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await task.value
            XCTFail("Stale credential committed", file: file, line: line)
        } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)", file: file, line: line) }
    }

    private enum Synthetic: Error { case failure }

    private struct SyntheticExchange: PairingExchangeHTTP {
        func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
            DevicePairResponse(
                device: .init(id: "synthetic-device", name: "Test gateway", kind: "ios"),
                tokenId: "synthetic-generation",
                token: "synthetic-token",
                scopes: ["read", "admin"]
            )
        }
    }

    private actor IdentityExchange: PairingExchangeHTTP {
        private var ids: [String?] = []
        func identities() -> [String?] {
            ids
        }

        func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
            ids.append(capabilities.installId)
            return DevicePairResponse(
                device: .init(id: "same-device", name: "Test gateway", kind: "ios"),
                tokenId: pairingCode,
                token: pairingCode,
                scopes: ["read"]
            )
        }
    }

    private actor CandidateGate: GatewayDirectDiscovering {
        private var started = false
        private var ready: CheckedContinuation<Void, Never>?
        private var continuation: CheckedContinuation<[GatewayDirectCandidate], Never>?

        func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                started = true
                ready?.resume()
                ready = nil
            }
        }

        func waitUntilStarted() async {
            if started { return }
            await withCheckedContinuation { ready = $0 }
        }

        func finish(_ candidates: [GatewayDirectCandidate]) {
            continuation?.resume(returning: candidates)
            continuation = nil
        }
    }
}
