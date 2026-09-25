// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class NotificationWarningDismissalTests: XCTestCase {
    func testShowsWarningUntilDismissed() {
        XCTAssertTrue(
            NotificationWarningDismissal.shouldShowWarning(health: .permissionDenied, dismissed: false)
        )
        XCTAssertFalse(
            NotificationWarningDismissal.shouldShowWarning(health: .permissionDenied, dismissed: true)
        )
    }

    func testDismissalCoversEveryDegradedEpochState() {
        for health: PushDeliveryHealth in [.permissionDenied, .scheduledSummary, .alertsOff] {
            XCTAssertTrue(
                NotificationWarningDismissal.shouldShowWarning(health: health, dismissed: false),
                "\(health) should show before dismissal"
            )
            XCTAssertFalse(
                NotificationWarningDismissal.shouldShowWarning(health: health, dismissed: true),
                "\(health) should hide after dismissal"
            )
        }
    }

    func testUndecidedPermissionNeverShows() {
        // Undecided permission is not a fault to flag, dismissed or not.
        XCTAssertFalse(
            NotificationWarningDismissal.shouldShowWarning(health: .notDetermined, dismissed: false)
        )
        XCTAssertFalse(
            NotificationWarningDismissal.shouldShowWarning(health: .ok, dismissed: false)
        )
    }

    func testOnlyHealthyDeliveryOpensANewEpoch() {
        XCTAssertTrue(NotificationWarningDismissal.shouldResetDismissal(health: .ok))
        for health: PushDeliveryHealth in [.notDetermined, .permissionDenied, .scheduledSummary, .alertsOff] {
            XCTAssertFalse(
                NotificationWarningDismissal.shouldResetDismissal(health: health),
                "\(health) must not clear the dismissal"
            )
        }
    }
}
