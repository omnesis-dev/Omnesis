// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What each way an attempt can end tells the user, and what it does to the retry.
@available(iOS 17.0, macOS 14.0, *)
final class DeviceSocketStateReportingTests: DeviceSocketLifecycleTestCase {
    func testUnreachableGatewayIsATemporaryStateThatKeepsTheDiagnostic() async {
        await startObservingPath(wifi)
        _ = await failAttempt(0, sleepNumber: 1)

        let state = await socket.state()
        XCTAssertEqual(state, .reconnecting(.init(
            network: .available,
            lastError: refused.localizedDescription,
            failedAttemptsOnNetwork: 1
        )))
    }

    func testPathLossAndReturnUpdateTheReportedNetworkBetweenAttempts() async {
        await startObservingPath(wifi)
        _ = await failAttempt(0, sleepNumber: 1)

        await send(noNetwork)
        let offline = await socket.state()
        XCTAssertEqual(offline, .reconnecting(.init(
            network: .unavailable,
            lastError: refused.localizedDescription,
            failedAttemptsOnNetwork: 1
        )))
    }

    func testRetriesDoNotFlickerBackToConnecting() async {
        await startObservingPath(wifi)
        let delay = await failAttempt(0, sleepNumber: 1)
        let before = await socket.state()
        clock.advance(by: delay)
        let retry = await attempt(1)
        await waitForHelloSent(on: retry)

        let during = await socket.state()
        XCTAssertEqual(during, before)
    }

    func testAuthenticationRefusalIsPersistentAndIgnoresNetworkChanges() async throws {
        connector.configure = { $0.setHandshakeStatus(401) }
        await startObservingPath(wifi)
        let delay = await failAttempt(0, sleepNumber: 1, error: URLError(.badServerResponse))
        XCTAssertEqual(delay, DeviceSocketReconnectPolicy.Limits().refusedDelay)
        let state = await socket.state()
        guard case .failed(let failure) = state else { return XCTFail("got \(state)") }
        XCTAssertEqual(failure.kind, .authentication)

        await send(noNetwork)
        await send(cellular)
        await settle()
        XCTAssertEqual(connector.connections.count, 1, "a new network cannot fix a refused credential")

        // The user may have fixed it on the gateway, so returning re-checks once.
        await socket.appDidBecomeActive()
        _ = await attempt(1)
    }

    func testHelloRefusalKeepsTheGatewaysOwnMessage() async throws {
        await startObservingPath(wifi)
        let connection = await attempt(0)
        await waitForHelloSent(on: connection)
        try connection.rejectHello(code: "protocol_version_mismatch", message: "client protocol 1 != gateway 2")
        _ = await waitForBackoff(1)

        let state = await socket.state()
        XCTAssertEqual(state, .failed(.init(kind: .incompatible, detail: "client protocol 1 != gateway 2")))
    }

    func testPinRejectionReportsCertificateAndEveryRetryKeepsTheSameRequest() async throws {
        await startObservingPath(wifi)
        // `.cancelAuthenticationChallenge` surfaces as URLError.cancelled.
        let delay = await failAttempt(0, sleepNumber: 1, error: URLError(.cancelled))
        let state = await socket.state()
        guard case .failed(let failure) = state else { return XCTFail("got \(state)") }
        XCTAssertEqual(failure.kind, .certificate)

        clock.advance(by: delay)
        _ = await failAttempt(1, sleepNumber: 2, error: URLError(.serverCertificateUntrusted))
        await send(cellular)
        _ = await attempt(2)

        for request in connector.openedRequests {
            XCTAssertEqual(request.url?.absoluteString, "wss://gateway.example.com:7600/device/ws")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_test")
        }
    }

    func testRateLimitedUpgradeWaitsOutTheLimiterWindowAndIgnoresWakes() async throws {
        connector.configure = { $0.setHandshakeStatus(429) }
        await startObservingPath(wifi)
        let delay = await failAttempt(0, sleepNumber: 1, error: URLError(.badServerResponse))
        XCTAssertEqual(delay, .seconds(60))
        let state = await socket.state()
        guard case .reconnecting = state else { return XCTFail("rate limiting is temporary, got \(state)") }

        await send(cellular)
        await socket.appDidBecomeActive()
        await settle()
        XCTAssertEqual(connector.connections.count, 1)
    }

    func testDropAfterConnectingIsTemporaryAndRetriesFromTheBottomOfTheLadder() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()

        connection.fail(URLError(.networkConnectionLost))
        let delay = await waitForBackoff(1)
        XCTAssertEqual(delay, .seconds(1))
        let state = await socket.state()
        XCTAssertEqual(state, .reconnecting(.init(
            network: .available,
            lastError: URLError(.networkConnectionLost).localizedDescription,
            failedAttemptsOnNetwork: 1
        )))
    }

    func testEventsAreOnlySentOnAnAuthenticatedConnection() async throws {
        await startObservingPath(wifi)
        let connection = await attempt(0)
        await waitForHelloSent(on: connection)
        await socket.emitEvent(type: "sync.status", payload: [:])
        XCTAssertEqual(connection.sent.count, 1, "only the hello goes out before authentication")

        try connection.acceptHello()
        await eventually("the socket to connect") { await isConnected() }
        await socket.emitEvent(type: "sync.status", payload: [:])
        XCTAssertEqual(connection.sent.count, 2)
    }
}
