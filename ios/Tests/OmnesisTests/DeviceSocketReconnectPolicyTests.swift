// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class DeviceSocketReconnectPolicyTests: XCTestCase {
    private let networkFailure = DeviceSocketAttemptFailure.network(detail: "x")

    func testBackoffClimbsToItsCapWithBoundedJitter() {
        var policy = DeviceSocketReconnectPolicy()
        var delays: [Duration] = []
        for _ in 0 ..< 7 {
            policy.recordFailure(networkFailure)
            delays.append(policy.retryDelay(jitter: 0))
        }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, 30].map { .seconds($0) })
        XCTAssertEqual(policy.retryDelay(jitter: 1), .milliseconds(37500))
    }

    func testRestoredConnectivityRestartsTheLadderButKeepsTheLastFailure() {
        var policy = DeviceSocketReconnectPolicy()
        for _ in 0 ..< 6 {
            policy.recordFailure(networkFailure)
        }
        policy.connectivityRestored()
        XCTAssertEqual(policy.lastFailure, networkFailure)
        policy.recordFailure(networkFailure)
        XCTAssertEqual(policy.retryDelay(jitter: 0), .seconds(1))
    }

    /// Simulates an attempt as often as the budget allows and checks the bounds
    /// the gateway's upgrade limiter requires, over every sliding window.
    func testBudgetStaysBelowTheGatewayUpgradeLimits() {
        var policy = DeviceSocketReconnectPolicy()
        var now: Duration = .seconds(100)
        var attempts: [Duration] = []
        while now < .seconds(100 + 3600) {
            let wait = policy.budgetDelay(at: now)
            now += wait
            policy.recordAttemptStarted(at: now)
            attempts.append(now)
        }
        func most(within window: Duration) -> Int {
            attempts.indices.map { start in
                attempts[start...].prefix { $0 - attempts[start] < window }.count
            }.max() ?? 0
        }
        XCTAssertLessThanOrEqual(most(within: .seconds(61)), 8)
        XCTAssertLessThan(most(within: .seconds(3600)), 200)
    }

    func testPlainBackoffLadderIsNeverStretchedByTheBudget() {
        var policy = DeviceSocketReconnectPolicy()
        var now: Duration = .seconds(100)
        for _ in 0 ..< 500 {
            policy.recordAttemptStarted(at: now)
            policy.recordFailure(networkFailure)
            let backoff = policy.retryDelay(jitter: 0)
            XCTAssertEqual(policy.budgetDelay(at: now + backoff), .zero)
            now += backoff
        }
    }

    func testBudgetRefillsWithTime() {
        var policy = DeviceSocketReconnectPolicy()
        let start: Duration = .seconds(100)
        for _ in 0 ..< 5 {
            XCTAssertEqual(policy.budgetDelay(at: start), .zero)
            policy.recordAttemptStarted(at: start)
        }
        XCTAssertEqual(policy.budgetDelay(at: start), .seconds(20))
        XCTAssertEqual(policy.budgetDelay(at: start + .seconds(20)), .zero)
    }

    func testRefusalsAcceptOnlyAForegroundCheck() {
        var policy = DeviceSocketReconnectPolicy()
        policy.recordFailure(.authentication(detail: "x"))
        XCTAssertFalse(policy.accepts(.connectivityRestored))
        XCTAssertTrue(policy.accepts(.foreground))
        policy.recordFailure(.rateLimited)
        XCTAssertFalse(policy.accepts(.connectivityRestored))
        XCTAssertFalse(policy.accepts(.foreground))
        policy.recordFailure(.trust(detail: "x"))
        XCTAssertTrue(policy.accepts(.connectivityRestored), "a Wi-Fi sign-in page can be the cause")
        policy.recordConnected()
        XCTAssertTrue(policy.accepts(.connectivityRestored))
    }

    func testClassification() {
        typealias Failure = DeviceSocketAttemptFailure
        func classify(_ error: Error, status: Int? = nil, helloCompleted: Bool = false) -> Failure {
            Failure.classify(error, handshakeStatus: status, helloCompleted: helloCompleted)
        }
        let refusedDetail = refused.localizedDescription
        XCTAssertEqual(classify(refused), .network(detail: refusedDetail))
        XCTAssertEqual(classify(POSIXError(.ENOTCONN)), .network(detail: POSIXError(.ENOTCONN).localizedDescription))
        XCTAssertEqual(classify(URLError(.badServerResponse), status: 503), .server(status: 503))
        XCTAssertEqual(classify(URLError(.badServerResponse), status: 429), .rateLimited)
        for status in [401, 403] {
            guard case .authentication = classify(URLError(.badServerResponse), status: status) else {
                return XCTFail("status \(status)")
            }
        }
        for code: URLError.Code in [.cancelled, .serverCertificateUntrusted, .secureConnectionFailed] {
            guard case .trust = classify(URLError(code)) else { return XCTFail("code \(code.rawValue)") }
        }
        // A TLS session the peer dropped is a network event, not a verdict on its certificate.
        let aborted = URLError(.secureConnectionFailed, userInfo: ["_kCFStreamErrorCodeKey": -9806])
        guard case .network = classify(aborted) else { return XCTFail("errSSLClosedAbort") }
        let badCertificate = URLError(.secureConnectionFailed, userInfo: ["_kCFStreamErrorCodeKey": -9807])
        guard case .trust = classify(badCertificate) else { return XCTFail("errSSLXCertChainInvalid") }
        guard case .network = classify(URLError(.cancelled), status: 101) else {
            return XCTFail("an HTTP response means TLS already passed")
        }
        // After the hello the transport has already been verified.
        guard case .network = classify(URLError(.cancelled), status: 101, helloCompleted: true) else {
            return XCTFail("a drop after the hello is a network event")
        }
        func hello(_ code: String) -> Failure {
            classify(Failure.HelloRejection(code: code, message: "m"))
        }
        XCTAssertEqual(hello("invalid_token"), .authentication(detail: "m"))
        XCTAssertEqual(hello("device_not_found"), .authentication(detail: "m"))
        XCTAssertEqual(hello("rate_limited"), .rateLimited)
        XCTAssertEqual(hello("protocol_version_mismatch"), .incompatible(detail: "m"))
    }

    func testPathTransitions() {
        XCTAssertEqual(wifi.transition(from: nil), .unchanged, "the first report is not a change")
        XCTAssertEqual(wifi.transition(from: wifi), .unchanged)
        XCTAssertEqual(noNetwork.transition(from: wifi), .lost)
        XCTAssertEqual(noNetwork.transition(from: noNetwork), .unchanged)
        XCTAssertEqual(
            noNetwork.transition(from: NetworkPathSnapshot(isUsable: false, interfaces: [.wifi])),
            .unchanged
        )
        XCTAssertEqual(wifi.transition(from: noNetwork), .restored)
        XCTAssertEqual(cellular.transition(from: wifi), .restored)
        XCTAssertEqual(
            NetworkPathSnapshot(isUsable: true, interfaces: [.wifi, .other]).transition(from: wifi),
            .restored,
            "a VPN coming up can give the gateway a route"
        )
    }
}
