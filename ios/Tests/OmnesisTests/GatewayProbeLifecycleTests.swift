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
        XCTAssertTrue(script.attempt(0).evaluate(fixture.trust))
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

    func testRejectedHintCannotClearItsVerdictAndVerifiedNextHintCanPromote() async throws {
        let fixture = try trustFixture()
        let firstStarted = expectation(description: "Rejected hint started")
        let nextStarted = expectation(description: "Next hint started")
        let script = ProbeScript(starts: [firstStarted, nextStarted])
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route, attemptTimeout: 2, totalTimeout: 5, connectTLS: script.connector
            ) { trust, host in
                fixture.verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let first = script.attempt(0)
        XCTAssertFalse(try first.evaluate(TrustFixtures.servedTrust(TrustFixtures.leafOne)))
        XCTAssertFalse(first.evaluate(fixture.trust), "A rejected hint cannot replace its identity")
        first.connection.state(.ready) // A malformed SDK signal cannot authenticate a refused hint.
        await fulfillment(of: [nextStarted], timeout: 2)
        XCTAssertFalse(first.evaluate(fixture.trust))
        let next = script.attempt(1)
        XCTAssertTrue(next.evaluate(fixture.trust))
        next.connection.state(.ready)
        let accepted = await task.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(script.count, 2)
        XCTAssertTrue(first.connection.writes.isEmpty)
        XCTAssertTrue(next.connection.writes.isEmpty)
    }

    func testRefusedHintsAdvanceOnTheirDeadlinesWithoutAuthenticating() async throws {
        let fixture = try trustFixture()
        let firstStarted = expectation(description: "First refused hint started")
        let nextStarted = expectation(description: "Next refused hint started")
        let script = ProbeScript(starts: [firstStarted, nextStarted])
        let clock = ProbeClock()
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route, attemptTimeout: 1, totalTimeout: 3, connectTLS: script.connector, clock: clock.clock
            ) { _, _ in false }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        XCTAssertFalse(script.attempt(0).evaluate(fixture.trust))
        clock.advance(1)
        clock.deadline(0).fireQueuedEvent()
        await fulfillment(of: [nextStarted], timeout: 2)
        XCTAssertFalse(script.attempt(1).evaluate(fixture.trust))
        script.attempt(1).connection.state(.failed(.tls(-9807)))
        let accepted = await task.value
        XCTAssertFalse(accepted)
        XCTAssertEqual(script.count, 2)
    }

    func testUnverifiedReadyHintsCannotPromoteAndCancellationOrBudgetStopsAfterRejection() async throws {
        let fixture = try trustFixture()
        for cancel in [false, true] {
            let started = expectation(description: "Rejected hint started")
            let script = ProbeScript(starts: [started])
            let clock = ProbeClock()
            let task = Task {
                await GatewayDirectProbe.reachable(
                    route: fixture.route, attemptTimeout: 1, totalTimeout: 3, connectTLS: script.connector, clock: clock.clock
                ) { _, _ in false }
            }
            await fulfillment(of: [started], timeout: 2)
            XCTAssertFalse(script.attempt(0).evaluate(fixture.trust))
            if cancel { task.cancel() } else { clock.advance(3)
                clock.deadline(0).fireQueuedEvent()
            }
            let accepted = await task.value
            XCTAssertFalse(accepted)
            script.attempt(0).connection.state(.ready)
            XCTAssertEqual(script.count, 1)
        }
        let firstStarted = expectation(description: "Unverified hint started")
        let nextStarted = expectation(description: "Next unverified hint started")
        let script = ProbeScript(starts: [firstStarted, nextStarted])
        let task = Task {
            await GatewayDirectProbe.reachable(
                route: fixture.route, attemptTimeout: 1, totalTimeout: 3, connectTLS: script.connector
            ) { _, _ in XCTFail("Unverified SDK readiness did not supply a certificate")
                return false
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        script.attempt(0).connection.state(.ready)
        await fulfillment(of: [nextStarted], timeout: 2)
        script.attempt(1).connection.state(.ready)
        let accepted = await task.value
        XCTAssertFalse(accepted)
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

    func testQueuedVerifiedReadyCannotBeatAnExpiredAttemptOrTotalDeadline() async throws {
        let fixture = try trustFixture()
        for totalExpired in [false, true] {
            let firstStarted = expectation(description: "First hint started")
            let nextStarted = totalExpired ? nil : expectation(description: "Next hint started")
            let script = ProbeScript(starts: [firstStarted] + (nextStarted.map { [$0] } ?? []))
            let clock = ProbeClock()
            let task = Task {
                await GatewayDirectProbe.reachable(
                    route: fixture.route, attemptTimeout: 1, totalTimeout: 3, connectTLS: script.connector, clock: clock.clock
                ) { trust, host in
                    fixture.verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
                }
            }
            await fulfillment(of: [firstStarted], timeout: 2)
            let first = script.attempt(0)
            XCTAssertTrue(first.evaluate(fixture.trust))
            clock.advance(totalExpired ? 3 : 1)
            first.connection.state(.ready) // Readiness was queued before the timer callback could run.
            if let nextStarted {
                await fulfillment(of: [nextStarted], timeout: 2)
                let next = script.attempt(1)
                clock.deadline(0).fireQueuedEvent()
                XCTAssertTrue(next.evaluate(fixture.trust))
                next.connection.state(.ready)
            }
            let accepted = await task.value
            XCTAssertEqual(accepted, !totalExpired)
            XCTAssertEqual(script.count, totalExpired ? 1 : 2)
        }
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
