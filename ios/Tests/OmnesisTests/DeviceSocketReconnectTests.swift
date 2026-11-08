// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The reconnect lifecycle: when attempts happen and what stops them, with time,
/// network reports and connections all under the test's control.
@available(iOS 17.0, macOS 14.0, *)
final class DeviceSocketReconnectTests: DeviceSocketLifecycleTestCase {
    // MARK: Restoration during backoff

    func testRestorationDuringCappedBackoffRetriesWithoutWaitingForTheTimer() async throws {
        await startObservingPath(wifi)
        let climbed = await climbToCappedBackoff()
        await send(noNetwork)
        // Let the budget recover, as a long outage would.
        clock.advance(by: .seconds(29))
        await settle()
        XCTAssertEqual(connector.connections.count, climbed.attempts, "the 30s timer has one second left")

        pathObserver.send(wifi)
        let woken = await attempt(climbed.attempts)
        await waitForHelloSent(on: woken)
        try woken.acceptHello()
        await eventually("reconnection") { await isConnected() }
    }

    func testRestoredNetworkThatCannotReachTheGatewayClimbsBoundedBackoffAgain() async {
        await startObservingPath(wifi)
        let climbed = await climbToCappedBackoff()
        await send(noNetwork)
        clock.advance(by: .seconds(29))
        await settle()

        pathObserver.send(cellular)
        let delay = await failAttempt(climbed.attempts, sleepNumber: climbed.sleeps + 1)
        XCTAssertEqual(delay, .seconds(1), "a new network restarts the ladder")
        clock.advance(by: delay)
        let next = await failAttempt(climbed.attempts + 1, sleepNumber: climbed.sleeps + 2)
        XCTAssertGreaterThanOrEqual(next, .seconds(2), "and it keeps backing off while the gateway stays unreachable")

        // An identical path reports nothing new, so it wakes nothing.
        pathObserver.send(cellular)
        await settle()
        XCTAssertEqual(connector.connections.count, climbed.attempts + 2)
    }

    func testRestorationAfterAnUnsuccessfulForegroundRetryStillWakes() async throws {
        await startObservingPath(noNetwork)
        _ = await failAttempt(0, sleepNumber: 1, error: URLError(.notConnectedToInternet))
        await socket.appDidBecomeActive()
        let foregroundAttempt = await attempt(1)
        await waitForHelloSent(on: foregroundAttempt)
        foregroundAttempt.fail(URLError(.notConnectedToInternet))
        _ = await waitForBackoff(2)

        pathObserver.send(wifi)
        let woken = await attempt(2)
        await waitForHelloSent(on: woken)
        try woken.acceptHello()
        await eventually("reconnection") { await isConnected() }
    }

    // MARK: Unusable networks and storms

    func testRepeatedUnusableNetworkEventsNeitherAttemptNorResetBackoff() async {
        await startObservingPath(noNetwork)
        _ = await failAttempt(0, sleepNumber: 1)
        clock.advance(by: .seconds(1))
        let second = await failAttempt(1, sleepNumber: 2)
        XCTAssertEqual(second, .seconds(2))

        for _ in 0 ..< 20 {
            pathObserver.send(noNetwork)
        }
        await send(NetworkPathSnapshot(isUsable: false, interfaces: [.wifi]))
        await settle()

        XCTAssertEqual(connector.connections.count, 2)
        clock.advance(by: .seconds(2))
        let third = await failAttempt(2, sleepNumber: 3)
        XCTAssertEqual(third, .seconds(4), "the ladder kept its place")
    }

    func testFlappingNetworkCannotExceedTheAttemptBudget() async {
        await startObservingPath(wifi)
        // Every attempt fails immediately, so the flapping alone drives them.
        for _ in 0 ..< 200 {
            await send(noNetwork)
            await send(wifi)
            if let newest = connector.connections.last, !newest.sent.isEmpty, !newest.isCancelled {
                newest.fail(refused)
            }
        }
        await settle()
        XCTAssertLessThanOrEqual(
            connector.connections.count,
            DeviceSocketReconnectPolicy.Limits().attemptBurst,
            "no time passed, so the burst is all the budget there is"
        )
    }

    func testAttemptThatHasBeenInFlightIsReplacedWhenTheNetworkReturns() async throws {
        await startObservingPath(noNetwork)
        let stuck = await attempt(0)
        await waitForHelloSent(on: stuck)
        clock.advance(by: .seconds(3))

        pathObserver.send(wifi)
        await eventually("the stuck attempt to be cancelled") { stuck.isCancelled }
        let replacement = await attempt(1)
        await waitForHelloSent(on: replacement)
        try replacement.acceptHello()
        await eventually("reconnection") { await isConnected() }
        XCTAssertTrue(clock.requestedSleeps.isEmpty, "a replaced attempt earns no backoff")
    }

    func testAFreshAttemptIsLeftToFinishButRetriedAtOnceIfItFails() async throws {
        await startObservingPath(noNetwork)
        let fresh = await attempt(0)
        await waitForHelloSent(on: fresh)

        await send(wifi)
        await settle()
        XCTAssertFalse(fresh.isCancelled)

        fresh.fail(refused)
        let retry = await attempt(1)
        await waitForHelloSent(on: retry)
        XCTAssertTrue(clock.requestedSleeps.isEmpty, "the path changed after this attempt started")
        try retry.acceptHello()
        await eventually("reconnection") { await isConnected() }
    }

    func testForegroundDuringAFreshAttemptRetriesAtOnceIfItFails() async {
        await startObservingPath(wifi)
        let climbed = await climbToCappedBackoff()
        clock.advance(by: .seconds(30))
        // The backoff fell due on resume, just ahead of the foreground signal.
        let attemptOnResume = await attempt(climbed.attempts)
        await waitForHelloSent(on: attemptOnResume)
        await socket.appDidBecomeActive()
        attemptOnResume.fail(refused)

        _ = await attempt(climbed.attempts + 1)
    }

    func testRefusalKeepsItsEarnedWaitWhenTheNetworkChangedDuringTheAttempt() async {
        connector.configure = { $0.setHandshakeStatus(401) }
        await startObservingPath(noNetwork)
        let connection = await attempt(0)
        await waitForHelloSent(on: connection)
        await send(wifi)
        connection.fail(URLError(.badServerResponse))

        let delay = await waitForBackoff(1)
        XCTAssertEqual(delay, DeviceSocketReconnectPolicy.Limits().refusedDelay)
    }

    func testAHelloThatNeverAnswersIsAbandonedWithItsOwnDiagnostic() async {
        await startObservingPath(wifi)
        let silent = await attempt(0)
        await waitForHelloSent(on: silent)
        clock.advance(by: clock.helloTimeout)

        await eventually("the attempt to be abandoned") { silent.isCancelled }
        await eventually("the temporary state") {
            if case .reconnecting = await socket.state() { return true }
            return false
        }
        let state = await socket.state()
        XCTAssertEqual(state, .reconnecting(.init(
            network: .available,
            lastError: "The gateway didn't answer in time.",
            failedAttemptsOnNetwork: 1
        )))
    }

    // MARK: Foreground and background

    func testForegroundCutsAPendingBackoffShortWithoutResettingIt() async {
        await startObservingPath(wifi)
        let climbed = await climbToCappedBackoff()
        clock.advance(by: .seconds(20))
        await socket.appDidBecomeActive()

        let delay = await failAttempt(climbed.attempts, sleepNumber: climbed.sleeps + 1)
        XCTAssertEqual(delay, .seconds(30), "returning to the app says nothing about the network")
    }

    func testPathRestoredInBackgroundWaitsForForegroundAndThenCountsAsRestoration() async throws {
        await startObservingPath(noNetwork)
        let delay = await failAttempt(0, sleepNumber: 1)
        await socket.appDidEnterBackground()

        await send(wifi)
        await settle()
        XCTAssertEqual(connector.connections.count, 1, "no early attempt while backgrounded")

        await socket.appDidBecomeActive()
        let woken = await attempt(1)
        await waitForHelloSent(on: woken)
        woken.fail(refused)
        let next = await waitForBackoff(2)
        XCTAssertEqual(next, .seconds(1), "the restoration restarted the ladder")
        XCTAssertEqual(delay, .seconds(1))
    }

    func testRefusalIsRecheckedOnForegroundEvenIfThePathAlsoChangedInBackground() async {
        connector.configure = { $0.setHandshakeStatus(401) }
        await startObservingPath(wifi)
        _ = await failAttempt(0, sleepNumber: 1, error: URLError(.badServerResponse))
        await socket.appDidEnterBackground()
        await send(cellular)
        await settle()
        XCTAssertEqual(connector.connections.count, 1)

        await socket.appDidBecomeActive()
        _ = await attempt(1)
    }

    func testBackoffTimerStillRunsWhileBackgrounded() async {
        await startObservingPath(wifi)
        let delay = await failAttempt(0, sleepNumber: 1)
        await socket.appDidEnterBackground()
        clock.advance(by: delay)
        _ = await attempt(1)
    }

    func testForegroundProbesAnOpenSocketAndKeepsItWhenItAnswers() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        await socket.appDidBecomeActive()
        await eventually("the ping") { connection.pings == 1 }
        connection.answerPing()
        await settle()

        XCTAssertFalse(connection.isCancelled)
        XCTAssertEqual(connector.connections.count, 1)
        let connected = await isConnected()
        XCTAssertTrue(connected)
    }

    func testRestoredPathProbesAnOpenSocketRatherThanReplacingIt() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        await send(noNetwork)
        let stillConnected = await isConnected()
        XCTAssertTrue(stillConnected, "a path notification alone does not end a session")

        pathObserver.send(cellular)
        await eventually("the ping") { connection.pings == 1 }
        XCTAssertFalse(connection.isCancelled)
    }

    func testSocketThatStopsAnsweringIsReplacedAfterTheProbeTimeout() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        await socket.appDidBecomeActive()
        await eventually("the ping") { connection.pings == 1 }
        await eventually("the probe timer") { clock.pendingSleeps == 1 }
        clock.advance(by: DeviceSocketReconnectPolicy.Limits().probeTimeout)

        await eventually("the silent socket to be cancelled") { connection.isCancelled }
        let replacement = await attempt(1)
        await waitForHelloSent(on: replacement)
        try replacement.acceptHello()
        await eventually("reconnection") { await isConnected() }
    }

    func testPingErrorReplacesTheSocketAndReportsATemporaryState() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        await socket.appDidBecomeActive()
        await eventually("the ping") { connection.pings == 1 }
        connection.answerPing(error: URLError(.networkConnectionLost))

        let replacement = await attempt(1)
        let state = await socket.state()
        guard case .reconnecting(let status) = state else {
            return XCTFail("expected a temporary state, got \(state)")
        }
        XCTAssertEqual(status.lastError, URLError(.networkConnectionLost).localizedDescription)
        replacement.fail(refused)
    }

    // MARK: Stale callbacks

    func testLateHelloFromAReplacedAttemptDoesNotConnectOrResetBackoff() async throws {
        connector.configure = { $0.holdsReceiveAcrossCancel = true }
        await startObservingPath(wifi)
        let firstDelay = await failAttempt(0, sleepNumber: 1)
        clock.advance(by: firstDelay)
        let secondDelay = await failAttempt(1, sleepNumber: 2)
        clock.advance(by: secondDelay)

        let stale = await attempt(2)
        await waitForHelloSent(on: stale)
        clock.advance(by: .seconds(3))
        await socket.appDidBecomeActive()
        await eventually("the attempt to be abandoned") { stale.isCancelled }
        try stale.acceptHello()
        // The abandoned attempt ends here, as a slow network callback would.
        stale.fail(URLError(.cancelled))

        let replacement = await attempt(3)
        await settle()
        let connected = await isConnected()
        XCTAssertFalse(connected, "an abandoned connection's answer must not count")
        await waitForHelloSent(on: replacement)
        replacement.fail(refused)
        let delay = await waitForBackoff(3)
        XCTAssertEqual(delay, .seconds(4), "the stale answer must not have reset the ladder")
    }

    func testLateFailureFromAReplacedAttemptIsNotReported() async throws {
        connector.configure = { $0.holdsReceiveAcrossCancel = true }
        await startObservingPath(noNetwork)
        let stale = await attempt(0)
        await waitForHelloSent(on: stale)
        clock.advance(by: .seconds(3))
        connector.configure = { _ in }

        pathObserver.send(wifi)
        await eventually("the attempt to be abandoned") { stale.isCancelled }
        // A certificate failure from the abandoned attempt must not surface.
        stale.fail(URLError(.serverCertificateUntrusted))

        let replacement = await attempt(1)
        let state = await socket.state()
        XCTAssertEqual(state, .authenticating, "still the first connection, with no failure to report")
        await waitForHelloSent(on: replacement)
        try replacement.acceptHello()
        await eventually("reconnection") { await isConnected() }
    }

    func testStalePongFromAReplacedSocketLeavesTheNewSessionAlone() async throws {
        await startObservingPath(wifi)
        let first = try await connectFirstAttempt()

        await socket.appDidBecomeActive()
        await eventually("the first ping") { first.pings == 1 }
        await eventually("the probe timer") { clock.pendingSleeps == 1 }
        clock.advance(by: DeviceSocketReconnectPolicy.Limits().probeTimeout)
        await eventually("the silent socket to be cancelled") { first.isCancelled }

        let second = await attempt(1)
        await waitForHelloSent(on: second)
        try second.acceptHello()
        await eventually("reconnection") { await isConnected() }

        first.answerPing(error: URLError(.networkConnectionLost))
        await settle()
        XCTAssertFalse(second.isCancelled)
        XCTAssertEqual(connector.connections.count, 2)
    }

    // MARK: Stop

    func testStopDuringBackoffPreventsLaterEventsFromReconnecting() async {
        await startObservingPath(noNetwork)
        _ = await failAttempt(0, sleepNumber: 1)

        await socket.stop()
        pathObserver.send(wifi)
        await socket.appDidBecomeActive()
        clock.advance(by: .seconds(600))
        await settle()

        XCTAssertEqual(connector.connections.count, 1)
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
    }

    func testStopDuringAnAttemptPreventsItsLateAnswerFromConnecting() async throws {
        connector.configure = { $0.holdsReceiveAcrossCancel = true }
        await startObservingPath(wifi)
        let connection = await attempt(0)
        await waitForHelloSent(on: connection)

        await socket.stop()
        XCTAssertTrue(connection.isCancelled)
        try connection.acceptHello()
        await settle()

        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
        XCTAssertEqual(connector.connections.count, 1)
    }

    func testStopWhileConnectedEndsTheSessionForGood() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        await socket.appDidBecomeActive()
        await eventually("the ping") { connection.pings == 1 }
        await socket.stop()
        XCTAssertTrue(connection.isCancelled)
        connection.answerPing(error: URLError(.networkConnectionLost))
        clock.advance(by: .seconds(600))
        await settle()

        XCTAssertEqual(connector.connections.count, 1)
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
    }
}
