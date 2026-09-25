// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Each source's setup step against a fake host: how its permission and
/// enable result become an outcome, including the awkward paths.
@MainActor
final class PhoneSetupStepTests: XCTestCase {
    func testAppleHealthIsUnavailableWithoutHealthKitAndOnOnceEnabled() async {
        let host = FakePhoneSetupHost()
        let step = AppleHealthSetupStep(host: host)
        host.healthDataAvailable = false
        XCTAssertEqual(step.rowState, .unavailable(reason: "Not available on this iPhone"))

        host.healthDataAvailable = true
        XCTAssertEqual(step.rowState, .selectable)
        XCTAssertNil(step.currentOutcome())

        let outcome = await step.enable(choice: nil)
        XCTAssertEqual(outcome, .on)
        XCTAssertEqual(step.rowState, .alreadyOn)
        XCTAssertEqual(step.currentOutcome(), .on, "HealthKit reports no read denial, so an enabled source is on")
    }

    func testAppleHealthPassesTheFailureMessageThrough() async {
        let host = FakePhoneSetupHost()
        host.appleHealthResult = .failed(message: "Turn on at least one Health category first.")
        let outcome = await AppleHealthSetupStep(host: host).enable(choice: nil)
        XCTAssertEqual(outcome, .failed(message: "Turn on at least one Health category first."))
    }

    func testPlacesWhileUsingIsPartialAndDeniedIsNotAllowed() async {
        let host = FakePhoneSetupHost()
        let step = PlacesSetupStep(host: host)
        XCTAssertNil(LocationVisitsPermissionState.notDetermined.setupAuthorization)
        XCTAssertEqual(LocationVisitsPermissionState.always.setupAuthorization, .granted(.full))
        XCTAssertEqual(LocationVisitsPermissionState.restricted.setupAuthorization, .notAllowed)

        host.placesResult = .enabled(.foregroundOnly)
        let outcome = await step.enable(choice: nil)
        XCTAssertEqual(outcome, .partial)
        XCTAssertEqual(step.currentOutcome(), .partial)

        host.coreLocationVisitsEnabled = false
        host.locationVisitsPermission = .denied
        XCTAssertEqual(step.currentOutcome(), .notAllowed)
        host.locationVisitsPermission = .always
        XCTAssertNil(step.currentOutcome(), "allowed but not turned on says nothing yet")
    }

    func testPhotosLimitedLibraryIsLimitedAndOffersTheExistingChoices() async {
        let host = FakePhoneSetupHost()
        let step = PhotosSetupStep(host: host)
        XCTAssertEqual(PhotosAccessState.limited.setupAuthorization, .granted(.limited))
        XCTAssertEqual(PhotosAccessState.denied.setupAuthorization, .notAllowed)
        XCTAssertNil(PhotosAccessState.notDetermined.setupAuthorization)

        host.photosResult = .enabled(.limited)
        let outcome = await step.enable(choice: nil)
        XCTAssertEqual(outcome, .limited)
        XCTAssertEqual(step.currentOutcome(), .limited)
        XCTAssertEqual(step.choices(for: .exclusive).map(\.choice), [.keepOther, .takeOver])

        host.photosResult = .notAllowed
        host.photosEnabled = false
        host.photosAccess = .denied
        let refused = await step.enable(choice: nil)
        XCTAssertEqual(refused, .notAllowed)
        XCTAssertEqual(step.currentOutcome(), .notAllowed)
    }

    func testMovementWithoutMotionHardwareIsUnavailable() async {
        let host = FakePhoneSetupHost()
        let step = MovementSetupStep(host: host)
        host.motionActivityPermission = .unavailable
        XCTAssertEqual(step.rowState, .unavailable(reason: "Not available on this iPhone"))
        XCTAssertEqual(step.currentOutcome(), .unavailable(reason: "Not available on this iPhone"))

        host.motionActivityPermission = .notDetermined
        host.movementResult = .unavailable(reason: "Not available on this iPhone")
        let outcome = await step.enable(choice: nil)
        XCTAssertEqual(outcome, .unavailable(reason: "Not available on this iPhone"))
    }

    func testNotificationsFollowTheUsersDecision() async {
        let host = FakePhoneSetupHost()
        let step = NotificationsSetupStep(host: host)
        XCTAssertEqual(step.group, .also)
        XCTAssertNil(step.statusSourceId)
        XCTAssertNil(step.copy.ledger)
        XCTAssertEqual(step.copy.highlights.count, 3)
        XCTAssertEqual(step.rowState, .selectable)
        XCTAssertNil(step.currentOutcome())

        let allowed = await step.enable(choice: nil)
        XCTAssertEqual(allowed, .on)
        XCTAssertEqual(step.rowState, .alreadyOn)

        host.notificationPermission = .notDetermined
        host.notificationGrant = false
        let refused = await step.enable(choice: nil)
        XCTAssertEqual(refused, .notAllowed)
        XCTAssertEqual(step.rowState, .unavailable(reason: "Off in Settings"))
        XCTAssertEqual(step.currentOutcome(), .notAllowed)

        await step.refresh()
        XCTAssertEqual(host.pushDeliveryRefreshes, 1)
    }

    func testEverySourceStepShowsItsOwnSyncStatusAndDeclaresALedger() {
        let host = FakePhoneSetupHost()
        for step in PhoneSetupRegistry.ios(host: host) where step.group == .source {
            XCTAssertEqual(step.statusSourceId, step.id)
            XCTAssertNotNil(step.copy.ledger, step.id)
            XCTAssertNotNil(step.copy.ask, step.id)
            XCTAssertFalse(step.copy.ledger?.sent.isEmpty ?? true, step.id)
        }
    }
}
