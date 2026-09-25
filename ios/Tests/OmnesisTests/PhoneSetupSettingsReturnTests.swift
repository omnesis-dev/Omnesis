// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Coming back from iOS Settings, the Settings instruction on an outcome, and
/// the words on busy buttons.
@MainActor
final class PhoneSetupSettingsReturnTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let places = PlacesSetupStep.sourceId
    private let movement = MovementSetupStep.sourceId

    private func makeSetup(host: FakePhoneSetupHost, defaults: DictionaryDefaults = DictionaryDefaults()) -> PhoneSetupCoordinator {
        let setup = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: defaults))
        setup.install(host: host, steps: PhoneSetupRegistry.ios(host: host))
        return setup
    }

    private func openOnStep(_ id: String, host: FakePhoneSetupHost) -> PhoneSetupCoordinator {
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(id)
        setup.startSelectedSteps()
        return setup
    }

    func testComingBackFromSettingsWithAccessContinuesTheStepByItself() async {
        let host = FakePhoneSetupHost()
        host.movementResult = .notAllowed
        let setup = openOnStep(movement, host: host)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[movement], .notAllowed)

        setup.didOpenSettings()
        host.motionActivityPermission = .authorized
        host.movementResult = .enabled(.full)
        await setup.refreshLiveState()

        XCTAssertEqual(setup.busyStepId, movement, "the step runs again without showing its page")
        XCTAssertEqual(setup.flow.outcomes[movement], .notAllowed, "the outcome page stays up while it runs")
        let finished = await eventually { setup.busyStepId == nil }
        XCTAssertTrue(finished, "the step finished running")
        XCTAssertEqual(setup.flow.outcomes[movement], .on)
    }

    func testAccessGrantedWithoutTheSettingsRoundTripDoesNotRunTheStep() async {
        let host = FakePhoneSetupHost()
        host.movementResult = .notAllowed
        let setup = openOnStep(movement, host: host)
        await setup.runCurrentStep()

        host.motionActivityPermission = .authorized
        await setup.refreshLiveState()

        XCTAssertNil(setup.busyStepId)
    }

    func testASourceAlreadyOnTakesItsNewAccessWithoutTurningOnAgain() async {
        let host = FakePhoneSetupHost()
        host.placesResult = .enabled(.foregroundOnly)
        let setup = openOnStep(places, host: host)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[places], .partial)

        setup.didOpenSettings()
        host.locationVisitsPermission = .always
        host.placesResult = .failed(message: "turned on a second time")
        await setup.refreshLiveState()

        XCTAssertNil(setup.busyStepId)
        XCTAssertEqual(setup.flow.outcomes[places], .on)
    }

    func testAccessCountsAsImprovedOnlyWhenItGrowsBeyondTheOutcome() {
        XCTAssertTrue(PhoneSetupCoordinator.accessImproved(from: .notAllowed, to: .granted(.foregroundOnly)))
        XCTAssertTrue(PhoneSetupCoordinator.accessImproved(from: .limited, to: .granted(.full)))
        XCTAssertTrue(PhoneSetupCoordinator.accessImproved(from: .partial, to: .granted(.full)))
        XCTAssertFalse(PhoneSetupCoordinator.accessImproved(from: .partial, to: .granted(.foregroundOnly)))
        XCTAssertFalse(PhoneSetupCoordinator.accessImproved(from: .notAllowed, to: .notAllowed))
        XCTAssertFalse(PhoneSetupCoordinator.accessImproved(from: .notAllowed, to: nil))
        XCTAssertFalse(PhoneSetupCoordinator.accessImproved(from: .failed(message: nil), to: .granted(.full)))
    }

    func testOutcomesThatOpenSettingsSayWhatToChangeThere() {
        XCTAssertEqual(
            PlacesSetupStep.copy.settingsInstruction(.notAllowed),
            "In Settings, tap Location, choose Always, and turn on Precise Location."
        )
        XCTAssertEqual(
            PlacesSetupStep.copy.settingsInstruction(.partial),
            "In Settings, tap Location, choose Always, and keep Precise Location on."
        )
        XCTAssertEqual(PhotosSetupStep.copy.settingsInstruction(.notAllowed), "In Settings, tap Photos and choose Full Access.")
        XCTAssertNil(PhotosSetupStep.copy.settingsInstruction(.limited), "adding photos is the way on from limited")
        XCTAssertEqual(MovementSetupStep.copy.settingsInstruction(.notAllowed), "In Settings, turn on Motion & Fitness.")
        XCTAssertEqual(
            NotificationsSetupStep.copy.settingsInstruction(.notAllowed),
            "In Settings, tap Notifications and turn on Allow Notifications."
        )
        XCTAssertNil(AppleHealthSetupStep.copy.settingsInstruction(.notAllowed))
    }

    func testBusyButtonsSayWhatIsBeingTurnedOn() {
        XCTAssertEqual(PlacesSetupStep.copy.turningOnLabel, "Turning on Places…")
        XCTAssertEqual(NotificationsSetupStep.copy.turningOnLabel, "Turning on notifications…")
    }

    // MARK: - Success ring

    /// The outcome mark takes `successDraws` as its identity, so a success
    /// reached in place gives it a new one and it draws the ring in again.
    func testAnOutcomeThatBecomesASuccessInPlaceRenewsItsMark() async throws {
        let host = FakePhoneSetupHost()
        host.movementResult = .notAllowed
        let setup = openOnStep(movement, host: host)
        try await bounded { await setup.runCurrentStep() }
        XCTAssertEqual(setup.successDraws[movement, default: 0], 0, "a refusal draws nothing")

        setup.didOpenSettings()
        host.motionActivityPermission = .authorized
        host.movementResult = .enabled(.full)
        try await bounded { await setup.refreshLiveState() }
        let finished = await eventually { setup.busyStepId == nil }
        XCTAssertTrue(finished)

        XCTAssertEqual(setup.flow.outcomes[movement], .on)
        XCTAssertEqual(setup.successDraws[movement, default: 0], 1, "the mark takes a new identity and draws in")

        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.successDraws[movement, default: 0], 1, "a success that stays one draws nothing new")
    }
}
