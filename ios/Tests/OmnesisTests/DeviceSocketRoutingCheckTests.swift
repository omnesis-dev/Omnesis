// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A routed socket reaches the gateway through a loopback endpoint that iOS can close while the
/// app is suspended. Before the retry that follows a wake signal or a refused connection, the
/// socket asks its route to prove that endpoint.
@available(iOS 17.0, macOS 14.0, *)
final class DeviceSocketRoutingCheckTests: DeviceSocketLifecycleTestCase {
    private var routing: RecordingRouting!

    override func setUp() async throws {
        try await super.setUp()
        await socket.stop()
        routing = RecordingRouting()
        socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_test",
            connector: connector,
            pathObserver: pathObserver,
            clock: clock,
            limits: {
                var limits = DeviceSocketReconnectPolicy.Limits()
                limits.helloTimeout = clock.helloTimeout
                return limits
            }(),
            routingOwner: routing,
            randomUnit: { 0 }
        )
    }

    override func tearDown() async throws {
        routing.holds = false
        routing.release()
        try await super.tearDown()
    }

    func testForegroundVerifiesTheRouteBeforeReconnecting() async {
        await startObservingPath(wifi)
        _ = await failAttempt(0, sleepNumber: 1, error: URLError(.timedOut))
        XCTAssertEqual(routing.calls, 0, "A failure that is not a refusal asks for no check")

        routing.holds = true
        await socket.appDidBecomeActive()
        await eventually("the route to be verified") { self.routing.calls == 1 }
        await settle()
        XCTAssertEqual(connector.connections.count, 1, "The retry waits for the route's answer")

        routing.release()
        let retry = await attempt(1)
        await waitForHelloSent(on: retry)
        XCTAssertEqual(routing.calls, 1)
    }

    func testRestoredConnectivityVerifiesTheRouteBeforeReconnecting() async {
        await startObservingPath(noNetwork)
        _ = await failAttempt(0, sleepNumber: 1, error: URLError(.notConnectedToInternet))
        XCTAssertEqual(routing.calls, 0)

        routing.holds = true
        pathObserver.send(wifi)
        await eventually("the route to be verified") { self.routing.calls == 1 }
        await settle()
        XCTAssertEqual(connector.connections.count, 1)

        routing.release()
        _ = await attempt(1)
    }

    func testARefusedConnectionVerifiesOnceWithinTheRateLimit() async {
        await startObservingPath(wifi)
        var elapsed: Duration = .zero
        var attempts = 0
        // Refusals keep coming, as from a gateway that is really unreachable.
        while elapsed < GatewayRoutingCheck.failureInterval - .seconds(8) {
            let delay = await failAttempt(attempts, sleepNumber: attempts + 1)
            XCTAssertEqual(routing.calls, attempts == 0 ? 0 : 1, "The check runs after the wait, once")
            clock.advance(by: delay)
            elapsed += delay
            attempts += 1
            _ = await attempt(attempts)
            XCTAssertEqual(routing.calls, 1)
        }
        XCTAssertGreaterThanOrEqual(attempts, 3)

        // Past the interval the next refusal may ask again.
        clock.advance(by: GatewayRoutingCheck.failureInterval)
        let delay = await failAttempt(attempts, sleepNumber: attempts + 1)
        clock.advance(by: delay)
        _ = await attempt(attempts + 1)
        XCTAssertEqual(routing.calls, 2)
    }

    func testAnOpenSocketIsPingedAndItsRouteCheckedOnlyWhenItReconnects() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()
        await socket.appDidBecomeActive()
        await eventually("the liveness ping") { connection.pings == 1 }
        await settle()
        XCTAssertEqual(routing.calls, 0, "Nothing is retried while the socket answers")

        connection.answerPing(error: URLError(.networkConnectionLost))
        _ = await attempt(1)
        XCTAssertEqual(routing.calls, 1, "The reconnect that follows the foreground proves the route first")
    }

    func testStoppingDuringACheckOpensNoFurtherAttempt() async {
        await startObservingPath(wifi)
        _ = await failAttempt(0, sleepNumber: 1, error: URLError(.timedOut))
        routing.holds = true
        await socket.appDidBecomeActive()
        await eventually("the route to be verified") { self.routing.calls == 1 }

        await socket.stop()
        routing.release()
        await settle()
        XCTAssertEqual(connector.connections.count, 1)
        XCTAssertEqual(routing.calls, 1)
    }

    func testWithoutARoutedSessionNoCheckIsEverRequested() async throws {
        await socket.stop()
        socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_test",
            connector: connector,
            pathObserver: pathObserver,
            clock: clock,
            randomUnit: { 0 }
        )
        await startObservingPath(wifi)
        let delay = await failAttempt(0, sleepNumber: 1)
        await socket.appDidBecomeActive()
        clock.advance(by: delay)
        _ = await attempt(1)
        let pending = await socket.routingCheck.pending
        XCTAssertFalse(pending)
        XCTAssertEqual(routing.calls, 0)
    }

    func testTheRateLimitAllowsOneRefusalPerInterval() {
        var check = GatewayRoutingCheck()
        XCTAssertFalse(check.take())
        XCTAssertTrue(check.noteRefusal(at: .seconds(100)))
        XCTAssertFalse(check.noteRefusal(at: .seconds(101)))
        XCTAssertTrue(check.take())
        XCTAssertFalse(check.take())
        XCTAssertFalse(check.noteRefusal(at: .seconds(129)))
        XCTAssertFalse(check.take(), "A refusal inside the interval asks for nothing")
        check.noteWake()
        XCTAssertTrue(check.take(), "A wake signal is never rate limited")
        XCTAssertTrue(check.noteRefusal(at: .seconds(130)))
        XCTAssertTrue(check.take())
    }
}

/// A route that records each verification and can hold its answer.
private final class RecordingRouting: GatewaySocketRouting, @unchecked Sendable {
    private let lock = NSLock()
    private var verifications = 0
    private var holding = false
    private var held: [CheckedContinuation<Bool, Never>] = []

    var calls: Int {
        lock.withLock { verifications }
    }

    var holds: Bool {
        get { lock.withLock { holding } }
        set { lock.withLock { holding = newValue } }
    }

    var session: URLSession {
        .shared
    }

    var connectionPath: GatewayConnectionPath? {
        nil
    }

    func observeRoutePath(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void) -> UUID? {
        nil
    }

    func removeRoutePathObserver(_ id: UUID) {}

    func directPathAvailable() async -> Bool {
        false
    }

    func updateCandidates(_ candidates: [GatewayDirectCandidate]) throws {}

    func retireRouting() {}

    func verifyRouting() async -> Bool {
        await withCheckedContinuation { continuation in
            let answerNow = lock.withLock { () -> Bool in
                verifications += 1
                if holding { held.append(continuation) }
                return !holding
            }
            if answerNow { continuation.resume(returning: true) }
        }
    }

    func release() {
        let waiting = lock.withLock { () -> [CheckedContinuation<Bool, Never>] in
            defer { held = [] }
            return held
        }
        for continuation in waiting {
            continuation.resume(returning: true)
        }
    }
}
