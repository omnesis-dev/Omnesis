// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, macOS 14.0, *)
final class GatewayConnectionStatusTests: XCTestCase {
    private func reconnecting(
        _ network: DeviceSocket.ReconnectStatus.Network,
        attempts: Int = 1
    )
        -> GatewayConnectionStatus {
        GatewayConnectionStatus(.reconnecting(.init(
            network: network,
            lastError: "Could not connect to the server.",
            failedAttemptsOnNetwork: attempts
        )))
    }

    private func mentionsPairing(_ status: GatewayConnectionStatus) -> Bool {
        let text = (status.explanation ?? "").lowercased()
        return text.contains("pair")
    }

    func testOfflineIsCalmAndNeverMentionsPairingHoweverLongItLasts() {
        let status = reconnecting(.unavailable, attempts: 500)
        XCTAssertEqual(status.title, "Waiting for network")
        XCTAssertEqual(status.tone, .waiting)
        XCTAssertFalse(mentionsPairing(status))
        XCTAssertEqual(status.diagnostic, "Could not connect to the server.")
    }

    func testBriefUnreachabilityDoesNotMentionPairing() {
        let status = reconnecting(.available, attempts: GatewayConnectionStatus.sustainedFailureAttempts - 1)
        XCTAssertEqual(status.title, "Reconnecting to gateway")
        XCTAssertEqual(status.tone, .progress)
        XCTAssertFalse(mentionsPairing(status))
        XCTAssertEqual(status.diagnostic, "Could not connect to the server.")
    }

    func testSustainedUnreachabilityOnAUsableNetworkAddsAddressAdvice() {
        let status = reconnecting(.available, attempts: GatewayConnectionStatus.sustainedFailureAttempts)
        XCTAssertEqual(status.tone, .progress, "it is still retrying")
        XCTAssertTrue(status.explanation?.contains("Tailscale") == true)
        XCTAssertTrue(mentionsPairing(status))
    }

    func testUnknownNetworkReadsAsRetrying() {
        XCTAssertEqual(reconnecting(.unknown).title, "Reconnecting to gateway")
    }

    func testPersistentFailuresKeepTheirDetailAndWarn() {
        for kind: DeviceSocket.Failure.Kind in [.authentication, .certificate, .incompatible] {
            let status = GatewayConnectionStatus(.failed(.init(kind: kind, detail: "gateway said no")))
            XCTAssertEqual(status.tone, .warning)
            XCTAssertEqual(status.diagnostic, "gateway said no")
        }
    }

    func testCertificateAdviceDoesNotSendEveryoneToRepairFirst() {
        let status = GatewayConnectionStatus(.failed(.init(kind: .certificate, detail: "x")))
        XCTAssertTrue(status.explanation?.contains("sign-in page") == true)
    }

    func testSteadyStatesHaveNoExplanation() {
        XCTAssertEqual(GatewayConnectionStatus(.connecting).title, "Connecting…")
        let connected = GatewayConnectionStatus(.connected(deviceId: "d", deviceName: "n", scopes: []))
        XCTAssertEqual(connected.title, "Connected")
        XCTAssertNil(connected.explanation)
        XCTAssertNil(connected.diagnostic)
    }

    func testPathIndicatorNeverShowsAStaleSuccessfulRouteDuringRecoveryOrFailure() {
        let connected = DeviceSocket.ConnectionState.connected(deviceId: "d", deviceName: "n", scopes: [])
        for path in [GatewayConnectionPath.local, .relay, .reconnecting] {
            XCTAssertEqual(GatewayConnectionStatus.pathIndicator(state: connected, selected: path), path)
            for state in [
                DeviceSocket.ConnectionState.connecting,
                .authenticating,
                .reconnecting(.init(network: .unavailable, lastError: nil, failedAttemptsOnNetwork: 0)),
            ] {
                XCTAssertEqual(GatewayConnectionStatus.pathIndicator(state: state, selected: path), .reconnecting)
            }
            XCTAssertNil(GatewayConnectionStatus.pathIndicator(state: .disconnected, selected: path))
            XCTAssertNil(GatewayConnectionStatus.pathIndicator(state: .failed(.init(kind: .certificate, detail: "x")), selected: path))
        }
        XCTAssertNil(GatewayConnectionStatus.pathIndicator(state: connected, selected: nil))
        XCTAssertNil(GatewayConnectionStatus.pathIndicator(state: .connecting, selected: nil))
    }
}
