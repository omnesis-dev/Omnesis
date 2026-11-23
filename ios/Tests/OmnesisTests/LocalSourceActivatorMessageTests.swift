// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The copy an activation shows when the gateway step fails: a refusal the
/// gateway explained reads as that explanation, and only a request that never
/// got an answer reads as an unreachable gateway.
@MainActor
final class LocalSourceActivatorMessageTests: XCTestCase {
    func testAGatewayRefusalShowsTheGatewaysExplanation() {
        let refusal = GatewayClient.Error.serverError(
            status: 409,
            body: #"{"error":"device \"fictional-phone\" is revoked","code":"DEVICE_REVOKED"}"#
        )

        XCTAssertEqual(
            LocalSourceActivator.message(for: refusal),
            #"Device "fictional-phone" is revoked"#
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
