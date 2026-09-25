// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import UserNotifications
import XCTest

final class PushDeliveryHealthTests: XCTestCase {
    func testDeniedIsPermissionDeniedRegardlessOfOtherSettings() {
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .denied, scheduledDelivery: .enabled, alert: .enabled),
            .permissionDenied
        )
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .denied, scheduledDelivery: .disabled, alert: .disabled),
            .permissionDenied
        )
    }

    func testNotDetermined() {
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .notDetermined, scheduledDelivery: .disabled, alert: .enabled),
            .notDetermined
        )
    }

    func testScheduledSummaryWinsWhenAuthorizedAndBatched() {
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .authorized, scheduledDelivery: .enabled, alert: .enabled),
            .scheduledSummary
        )
        // Scheduled Summary takes priority over alerts-off (batching is the
        // reason the user sees nothing "now", which is the surprising case).
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .authorized, scheduledDelivery: .enabled, alert: .disabled),
            .scheduledSummary
        )
    }

    func testAlertsOffWhenAuthorizedNotBatchedButAlertsDisabled() {
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .authorized, scheduledDelivery: .disabled, alert: .disabled),
            .alertsOff
        )
    }

    func testOkWhenAuthorizedAlertsOnNotBatched() {
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .authorized, scheduledDelivery: .disabled, alert: .enabled),
            .ok
        )
    }

    func testProvisionalTreatedAsAuthorized() {
        // `.provisional` (and `.ephemeral`, iOS-only) fall through the same
        // default branch as `.authorized` — derivation then keys off the
        // scheduled-delivery / alert settings.
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .provisional, scheduledDelivery: .disabled, alert: .enabled),
            .ok
        )
        XCTAssertEqual(
            PushDeliveryHealth.from(authorization: .provisional, scheduledDelivery: .enabled, alert: .enabled),
            .scheduledSummary
        )
    }

    func testWarningIsNilOnlyWhenOk() {
        XCTAssertNil(PushDeliveryHealth.ok.warning)
        for health: PushDeliveryHealth in [.notDetermined, .permissionDenied, .scheduledSummary, .alertsOff] {
            XCTAssertNotNil(health.warning, "\(health) should surface a warning")
        }
    }

    func testScheduledSummaryWarningNamesScheduledSummary() {
        let warning = PushDeliveryHealth.scheduledSummary.warning
        XCTAssertNotNil(warning)
        XCTAssertTrue(warning?.detail.contains("Scheduled Summary") == true)
    }

    func testGatewayStatusesMatchWireContract() {
        XCTAssertEqual(PushDeliveryHealth.ok.gatewayStatus, "healthy")
        XCTAssertEqual(PushDeliveryHealth.notDetermined.gatewayStatus, "not-determined")
        XCTAssertEqual(PushDeliveryHealth.permissionDenied.gatewayStatus, "permission-denied")
        XCTAssertEqual(PushDeliveryHealth.scheduledSummary.gatewayStatus, "scheduled-summary")
        XCTAssertEqual(PushDeliveryHealth.alertsOff.gatewayStatus, "alerts-disabled")
    }
}
