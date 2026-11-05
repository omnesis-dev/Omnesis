// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
import Network
@testable import Omnesis
import Security
import XCTest

@MainActor
final class GatewayProbeLifecycleTests: XCTestCase {
    func testQueuedExpiredDeadlinesCannotReplaceTheNextOrCompletedAttempt() async throws {
        let fixture = try trustFixture()
        let firstStarted = expectation(description: "Initial probe started")
        let nextStarted = expectation(description: "Next probe started")
        let script = ProbeScript(starts: [firstStarted, nextStarted])
        let clock = ProbeClock()
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route,
                attemptTimeout: 1,
                totalTimeout: 5,
                connectTLS: script.connector,
                clock: clock.clock
            ) { trust, host in
                fixture.verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let oldDeadline = clock.deadline(0)
        clock.advance(1)
        oldDeadline.fireQueuedEvent()
        await fulfillment(of: [nextStarted], timeout: 2)
        let current = script.attempt(1)
        oldDeadline.fireQueuedEvent()
        XCTAssertTrue(current.evaluate(fixture.trust))
        current.connection.state(.ready)
        let result = await task.value
        XCTAssertTrue(result)
        clock.deadline(1).fireQueuedEvent()
        oldDeadline.fireQueuedEvent()
        XCTAssertEqual(script.count, 2)
    }

    func testClosedOperationCannotReopenOrResumeItsContinuationTwice() async throws {
        let fixture = try trustFixture()
        let started = expectation(description: "Probe started")
        let script = ProbeScript(starts: [started])
        let clock = ProbeClock()
        let operation = GatewayDirectProbe.Operation(
            route: fixture.route,
            attemptTimeout: 1,
            totalTimeout: 5,
            connectTLS: script.connector,
            clock: clock.clock
        ) { _, _ in true }
        defer { operation.cancel() }
        let task = Task { await withCheckedContinuation { operation.start($0) } }
        await fulfillment(of: [started], timeout: 2)
        script.attempt(0).connection.state(.ready)
        let result = await task.value
        XCTAssertTrue(result)
        operation.queue.sync { operation.connectNext() }
        operation.cancel()
        clock.deadline(0).fireQueuedEvent()
        XCTAssertEqual(script.count, 1)
    }

    func testCancellationBeforeStartAndEmptyHintsNeverOpenAConnection() async throws {
        let fixture = try trustFixture()
        let script = ProbeScript(starts: [])
        let clock = ProbeClock()
        let operation = GatewayDirectProbe.Operation(
            route: fixture.route,
            attemptTimeout: 1,
            totalTimeout: 5,
            connectTLS: script.connector,
            clock: clock.clock
        ) { _, _ in XCTFail("Cancelled operation verified trust")
            return false
        }
        operation.cancel()
        operation.queue.sync {}
        let cancelled = await withCheckedContinuation { operation.start($0) }
        XCTAssertFalse(cancelled)
        let empty = try GatewayDirectRoute.maintained(origin: fixture.route.origin, candidates: [])
        let absent = await GatewayDirectProbe.reachable(
            route: empty,
            attemptTimeout: 1,
            totalTimeout: 5,
            connectTLS: script.connector,
            clock: clock.clock
        ) { _, _ in XCTFail("Empty probe verified trust")
            return false
        }
        XCTAssertFalse(absent)
        XCTAssertEqual(script.count, 0)
        XCTAssertEqual(clock.count, 0)
    }

    func testNetworkResetCanSelectAnotherCandidateButLateTrustCannotChangeItsIdentity() async throws {
        let fixture = try trustFixture()
        let firstStarted = expectation(description: "First TLS attempt started")
        let nextStarted = expectation(description: "Next TLS attempt started")
        let script = ProbeScript(starts: [firstStarted, nextStarted])
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route,
                attemptTimeout: 2,
                totalTimeout: 5,
                connectTLS: script.connector
            ) { trust, host in
                fixture.verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let first = script.attempt(0)
        first.connection.state(.waiting(.posix(.ENETDOWN)))
        first.connection.state(.failed(.posix(.ECONNRESET)))
        await fulfillment(of: [nextStarted], timeout: 2)
        let next = script.attempt(1)
        XCTAssertEqual(first.host, fixture.route.host)
        XCTAssertEqual(next.host, fixture.route.host)
        XCTAssertFalse(first.evaluate(fixture.trust), "A retired candidate must not re-enter trust evaluation")
        first.connection.state(.ready)
        XCTAssertTrue(next.evaluate(fixture.trust))
        next.connection.state(.ready)
        let result = await task.value
        XCTAssertTrue(result)
        XCTAssertFalse(next.evaluate(fixture.trust), "A completed probe must not authenticate another callback")
        next.connection.state(.cancelled)
        XCTAssertEqual(script.count, 2)
    }

    func testRejectedIdentityStopsImmediatelyWithoutTryingAnotherCandidate() async throws {
        let fixture = try trustFixture()
        let started = expectation(description: "TLS attempt started")
        let script = ProbeScript(starts: [started])
        let rejected = PinnedSession(spkiFingerprint: String(repeating: "0", count: 64), host: fixture.route.host)
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route,
                attemptTimeout: 2,
                totalTimeout: 5,
                connectTLS: script.connector
            ) { trust, host in rejected
                .resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let attempt = script.attempt(0)
        XCTAssertFalse(attempt.evaluate(fixture.trust))
        attempt.connection.state(.cancelled)
        let result = await task.value
        XCTAssertFalse(result)
        XCTAssertEqual(script.count, 1)
    }

    func testIdentityRefusalRemainsTerminalIfTheEngineOnlyReportsItsDeadline() async throws {
        let fixture = try trustFixture()
        let started = expectation(description: "TLS attempt started")
        let script = ProbeScript(starts: [started])
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route,
                attemptTimeout: 1,
                totalTimeout: 3,
                connectTLS: script.connector
            ) { _, _ in false }
        }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertFalse(script.attempt(0).evaluate(fixture.trust))
        let result = await task.value
        XCTAssertFalse(result)
        XCTAssertEqual(script.count, 1)
    }

    func testCancellationCannotBeReversedByAlreadyQueuedReadyOrTrustCallbacks() async throws {
        let fixture = try trustFixture()
        let started = expectation(description: "TLS attempt started")
        let script = ProbeScript(starts: [started])
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route,
                attemptTimeout: 2,
                totalTimeout: 5,
                connectTLS: script.connector
            ) { _, _ in XCTFail("Cancelled probe evaluated trust")
                return true
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let attempt = script.attempt(0)
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result)
        XCTAssertFalse(attempt.evaluate(fixture.trust))
        attempt.connection.state(.ready)
        attempt.connection.state(.failed(.posix(.ECONNRESET)))
        XCTAssertEqual(script.count, 1)
    }

    private struct TrustFixture: @unchecked Sendable {
        let trust: SecTrust
        let route: GatewayDirectRoute
        let verifier: PinnedSession
    }

    private func trustFixture() throws -> TrustFixture {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ??
            bundle.url(forResource: "cloud-identity-vectors", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let gateway = try XCTUnwrap(root["gateway"] as? [String: Any])
        let originValue = try XCTUnwrap(gateway["publicOrigin"] as? String)
        let origin = try XCTUnwrap(URL(string: originValue))
        let hostname = try XCTUnwrap(origin.host)
        let pem = try XCTUnwrap(gateway["certificate"] as? String)
        let bytes = try XCTUnwrap(Data(base64Encoded: pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()))
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, bytes as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, hostname as CFString), &trust), errSecSuccess)
        let values = try XCTUnwrap(root["spkiVectors"] as? [[String: Any]])
        let pin = try XCTUnwrap(values.first?["spkiFingerprint"] as? String)
        let clock = try XCTUnwrap(root["clock"] as? Double)
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: 49150),
                GatewayDirectCandidate(address: "127.0.0.1", port: 49151),
            ],
            allowLoopbackForTesting: true
        ))
        let verifier = PinnedSession(spkiFingerprint: pin, host: route.host, verificationDate: Date(timeIntervalSince1970: clock))
        return try TrustFixture(trust: XCTUnwrap(trust), route: route, verifier: verifier)
    }
}

private final class ProbeScript: @unchecked Sendable {
    struct Attempt {
        let connection: ScriptedGatewayConnection
        let host: String
        let queue: DispatchQueue
        let verify: @Sendable (SecTrust) -> Bool
        func evaluate(_ trust: SecTrust) -> Bool {
            queue.sync { verify(trust) }
        }
    }

    private let lock = NSLock()
    private let starts: [XCTestExpectation]
    private var attempts: [Attempt] = []
    init(starts: [XCTestExpectation]) {
        self.starts = starts
    }

    var connector: GatewayTLSNetworkConnection.Connector {
        { _, host, queue, verify in
            let connection = ScriptedGatewayConnection()
            self.lock.lock()
            let index = self.attempts.count
            self.attempts.append(Attempt(connection: connection, host: host, queue: queue, verify: verify))
            self.lock.unlock()
            queue.async {
                if index < self.starts.count {
                    self.starts[index].fulfill()
                } else {
                    XCTFail("Probe exceeded its configured candidate count")
                }
            }
            return connection
        }
    }

    func attempt(_ index: Int) -> Attempt {
        lock.lock()
        defer { lock.unlock() }
        return attempts[index]
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return attempts.count
    }
}

private final class ProbeClock: @unchecked Sendable {
    final class Deadline: GatewayDeadline {
        let queue: DispatchQueue
        let action: () -> Void
        private(set) var scheduled: DispatchTime?
        private(set) var cancellations = 0
        init(queue: DispatchQueue, action: @escaping () -> Void) {
            self.queue = queue
            self.action = action
        }

        func schedule(deadline: DispatchTime) {
            scheduled = deadline
        }

        func cancel() {
            cancellations += 1
        }

        /// Dispatch may already have submitted an expiry callback when cancellation occurs.
        func fireQueuedEvent() {
            queue.sync { action() }
        }
    }

    private let lock = NSLock()
    private var now = DispatchTime(uptimeNanoseconds: 1_000_000_000)
    private var deadlines: [Deadline] = []
    var clock: GatewayDeadlineClock {
        GatewayDeadlineClock(now: {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.now
        }, make: { queue, action in
            let deadline = Deadline(queue: queue, action: action)
            self.lock.lock()
            self.deadlines.append(deadline)
            self.lock.unlock()
            return deadline
        })
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        let advanced = now + seconds
        now = advanced
        lock.unlock()
    }

    func deadline(_ index: Int) -> Deadline {
        lock.lock()
        defer { lock.unlock() }
        return deadlines[index]
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return deadlines.count
    }
}
#endif
