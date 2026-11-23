// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The copy an activation shows when the gateway step fails: a refusal the
/// gateway explained reads as that explanation, and only a request that never
/// got an answer reads as an unreachable gateway.
@MainActor
final class LocalSourceActivatorMessageTests: XCTestCase {
    func testAKnownRefusalReadsAsPlainCopy() {
        let revoked = GatewayClient.Error.serverError(
            status: 409,
            body: #"{"error":"device \"fictional-phone\" is revoked","code":"DEVICE_REVOKED"}"#
        )
        let outdated = GatewayClient.Error.serverError(
            status: 409,
            body: #"{"error":"device does not support the partitioned contract","code":"MULTI_DEVICE_CONTRACT_UNSUPPORTED"}"#
        )

        XCTAssertEqual(
            LocalSourceActivator.message(for: revoked),
            "A device that sent this source is no longer paired with your gateway. Nothing was changed."
        )
        XCTAssertEqual(
            LocalSourceActivator.message(for: outdated),
            "Another device that sends this source needs an Omnesis update first. Nothing was changed."
        )
    }

    func testAnUnknownRefusalShowsTheGatewaysExplanation() {
        let refusal = GatewayClient.Error.serverError(
            status: 409,
            body: #"{"error":"source fictional:local is paused by policy","code":"FICTIONAL_REFUSAL"}"#
        )

        XCTAssertEqual(
            LocalSourceActivator.message(for: refusal),
            "Source fictional:local is paused by policy"
        )
    }

    func testAServerErrorWithoutAnExplanationSaysTheGatewayRefused() {
        let failure = GatewayClient.Error.serverError(status: 502, body: "<html>Bad gateway</html>")

        XCTAssertEqual(
            LocalSourceActivator.message(for: failure),
            "Your gateway refused to turn this on. Nothing was changed."
        )
    }

    func testAuthorizationFailuresSayWhatToDo() {
        XCTAssertEqual(
            LocalSourceActivator.message(for: GatewayClient.Error.unauthorized),
            "Your gateway no longer accepts this device. Pair it again from Settings."
        )
        XCTAssertEqual(
            LocalSourceActivator.message(for: GatewayClient.Error.forbidden),
            "This device isn't allowed to change this source on your gateway."
        )
        XCTAssertEqual(
            LocalSourceActivator.message(for: GatewayClient.Error.notFound),
            "Your gateway no longer has this source. Try again."
        )
    }

    func testOnlyARequestWithoutAnAnswerReadsAsUnreachable() {
        XCTAssertEqual(
            LocalSourceActivator.message(for: URLError(.cannotConnectToHost)),
            LocalSourceActivator.unreachableMessage
        )
        XCTAssertEqual(
            LocalSourceActivator.message(for: GatewayClient.Error.invalidResponse),
            LocalSourceActivator.unreachableMessage
        )
    }

    func testAnActivationErrorKeepsItsOwnDescription() {
        XCTAssertEqual(
            LocalSourceActivator.message(for: MobileSourceActivationError.hostChanged),
            MobileSourceActivationError.hostChanged.errorDescription
        )
    }
}
