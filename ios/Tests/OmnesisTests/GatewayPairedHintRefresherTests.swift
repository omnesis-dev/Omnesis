// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class GatewayPairedHintRefresherTests: XCTestCase {
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
    private let first = [GatewayDirectCandidate(address: "10.0.0.2", port: 8443)]

    private func service(_ pairing: Pairing) throws -> PairingService {
        let store = InMemoryStore()
        let bundle = PairingCredentialBundle(pairing, url: pairing.url, tlsMode: pairing.tlsMode, fingerprint: pairing.fingerprint)
        try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
        return PairingService(store: store)
    }

    func testInitialEmptyHintsAcquireAndClearFactsWithoutChangingAuthority() async throws {
        let service = try service(original)
        let discovery = Discovery(.success(first))
        var updated: [Pairing] = []
        let refresher = GatewayPairedHintRefresher(expected: original, service: service, discovery: discovery) { updated.append($0) }
        let applied = Applied()
        let changedFirst = try await refresher.refresh { applied.append($0) }
        XCTAssertTrue(changedFirst)
        XCTAssertEqual(try service.current()?.directCandidates, first)
        XCTAssertTrue(try XCTUnwrap(service.current()).sameAuthority(as: original))
        XCTAssertEqual(updated.count, 1)
        XCTAssertEqual(updated.first?.directCandidates, first)
        XCTAssertEqual(applied.snapshot, [first])
        // Repeated facts keep the same persisted authority and still refresh live leases.
        let changedRepeated = try await refresher.refresh { applied.append($0) }
        XCTAssertTrue(changedRepeated)
        await discovery.set(.success([]))
        let changedEmpty = try await refresher.refresh { applied.append($0) }
        XCTAssertTrue(changedEmpty)
        XCTAssertEqual(try service.current(), original)
        XCTAssertNil(updated.last?.directCandidates)
        XCTAssertEqual(applied.snapshot, [first, first, []])
        let defaultPublisher = GatewayPairedHintRefresher(expected: original, service: service, discovery: discovery)
        let defaultChanged = try await defaultPublisher.refresh { _ in }
        XCTAssertTrue(defaultChanged)
        let request = await discovery.lastRequest
        XCTAssertEqual(request?.origin, original.url)
        XCTAssertEqual(request?.token, original.token)
        XCTAssertEqual(request?.spkiFingerprint, original.spkiFingerprint)
    }

    func testTemporaryConnectivityAndAvailabilityRetainOldFactsButRefusalsPropagate() async throws {
        let service = try service(original)
        XCTAssertTrue(try service.updateDirectCandidates(expected: original, candidates: first))
        let temporary: [Error] = [
            URLError(.cannotConnectToHost),
            CloudPairingError.httpStatus(404),
            CloudPairingError.httpStatus(429),
            CloudPairingError.httpStatus(503),
        ]
        for error in temporary {
            let refresher = GatewayPairedHintRefresher(expected: original, service: service, discovery: Discovery(.failure(error)))
            let changed = try await refresher.refresh { _ in XCTFail("Unavailable metadata applied") }
            XCTAssertFalse(changed)
            XCTAssertEqual(try service.current()?.directCandidates, first)
        }
        let terminal: [Error] = [
            URLError(.serverCertificateUntrusted),
            URLError(.cancelled),
            CloudPairingError.httpStatus(401),
            CloudPairingError.httpStatus(403),
            CloudPairingError.httpStatus(400),
            CloudPairingError.response,
        ]
        for error in terminal {
            let refresher = GatewayPairedHintRefresher(expected: original, service: service, discovery: Discovery(.failure(error)))
            do { _ = try await refresher.refresh { _ in XCTFail("Refused metadata applied") }
                XCTFail("Refusal ignored")
            } catch { XCTAssertEqual(try service.current()?.directCandidates, first) }
        }
        let malformed = GatewayPairedHintRefresher(
            expected: original,
            service: service,
            discovery: Discovery(.success([.init(address: "8.8.8.8", port: 443)]))
        )
        do { _ = try await malformed.refresh { _ in XCTFail("Malformed facts applied") }
            XCTFail("Malformed facts accepted")
        } catch { XCTAssertEqual(try service.current()?.directCandidates, first) }
    }

    func testUnpairAndCancellationFenceLateDiscoveryEvenWhenItIgnoresCancellation() async throws {
        for cancel in [false, true] {
            let service = try service(original)
            let gate = Gate()
            let refresher = GatewayPairedHintRefresher(expected: original, service: service, discovery: gate)
            let task = Task { try await refresher.refresh { _ in XCTFail("Obsolete facts applied") } }
            await gate.wait()
            if cancel { task.cancel() } else { try service.clear() }
            await gate.finish(first)
            do { let changed = try await task.value
                XCTAssertFalse(changed)
                XCTAssertFalse(cancel)
            } catch is CancellationError { XCTAssertTrue(cancel) }
            if !cancel { XCTAssertNil(try service.current()) } else { XCTAssertEqual(try service.current(), original) }
        }
    }

    func testStaleAndConventionalPairingsCannotChangeCurrentCredential() async throws {
        let service = try service(original)
        let stale = Pairing(
            url: original.url,
            token: "other-token",
            accountId: "local",
            deviceId: "device",
            gatewayName: "Gateway",
            spkiFingerprint: original.spkiFingerprint,
            tlsMode: .pinnedKeyStrict
        )
        XCTAssertFalse(try service.updateDirectCandidates(expected: stale, candidates: first))
        let direct = Pairing(
            url: original.url,
            token: original.token,
            accountId: "local",
            deviceId: "device",
            gatewayName: "Gateway",
            tlsMode: .system
        )
        XCTAssertFalse(try service.updateDirectCandidates(expected: direct, candidates: first))
        let refresher = GatewayPairedHintRefresher(expected: direct, service: service, discovery: Discovery(.success(first)))
        do { _ = try await refresher.refresh { _ in XCTFail("Direct authority modified") }
            XCTFail("Unpinned metadata requested")
        } catch { XCTAssertEqual(try service.current(), original) }
        let noKey = Pairing(
            url: original.url,
            token: original.token,
            accountId: "local",
            deviceId: "device",
            gatewayName: "Gateway",
            tlsMode: .pinnedKeyStrict
        )
        let missing = GatewayPairedHintRefresher(expected: noKey, service: service, discovery: Discovery(.success(first)))
        do { _ = try await missing.refresh { _ in XCTFail("Missing key accepted") }
            XCTFail("Missing key requested")
        } catch { XCTAssertEqual(try service.current(), original) }
    }

    struct Request {
        let origin: URL
        let token: String
        let spkiFingerprint: String
    }

    private actor Discovery: GatewayDirectDiscovering {
        private var result: Result<[GatewayDirectCandidate], Error>
        var lastRequest: Request?
        init(_ result: Result<[GatewayDirectCandidate], Error>) {
            self.result = result
        }

        func set(_ result: Result<[GatewayDirectCandidate], Error>) {
            self.result = result
        }

        func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
            lastRequest = Request(origin: origin, token: token, spkiFingerprint: spkiFingerprint)
            return try result.get()
        }
    }

    private final class Applied: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [[GatewayDirectCandidate]] = []
        func append(_ candidates: [GatewayDirectCandidate]) {
            lock.lock()
            values.append(candidates)
            lock.unlock()
        }

        var snapshot: [[GatewayDirectCandidate]] {
            lock.lock()
            defer { lock.unlock() }
            return values
        }
    }

    private actor Gate: GatewayDirectDiscovering {
        private var continuation: CheckedContinuation<[GatewayDirectCandidate], Never>?
        private var ready: CheckedContinuation<Void, Never>?
        func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
            await withCheckedContinuation { continuation = $0
                ready?.resume()
                ready = nil
            }
        }

        func wait() async {
            if continuation != nil { return }
            await withCheckedContinuation { ready = $0 }
        }

        func finish(_ candidates: [GatewayDirectCandidate]) {
            continuation?.resume(returning: candidates)
            continuation = nil
        }
    }
}
