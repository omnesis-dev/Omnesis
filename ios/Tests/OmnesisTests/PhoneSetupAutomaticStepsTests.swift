// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Background refresh, which the flow adds when a source the run turned on, or
/// one already on, relies on it and it is off.
@MainActor
final class PhoneSetupAutomaticStepsTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let health = AppleHealthSetupStep.sourceId
    private let places = PlacesSetupStep.sourceId
    private let photos = PhotosSetupStep.sourceId
    private let movement = MovementSetupStep.sourceId
    private let notifications = NotificationsSetupStep.stepId
    private let backgroundRefresh = BackgroundRefreshSetupStep.stepId

    private func makeSetup(host: FakePhoneSetupHost, progress: DictionaryDefaults = DictionaryDefaults())
        -> PhoneSetupCoordinator {
        let setup = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: progress))
        setup.install(host: host, steps: PhoneSetupRegistry.ios(host: host))
        return setup
    }

    private func startFromSettings(_ ids: [String], host: FakePhoneSetupHost) -> PhoneSetupCoordinator {
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        for id in ids {
            setup.toggle(id)
        }
        setup.startSelectedSteps()
        return setup
    }

    private func moveTo(_ id: String, in setup: PhoneSetupCoordinator) {
        for _ in setup.flow.selection where setup.flow.currentStepId.map({ $0 != id }) == true {
            setup.next()
        }
        XCTAssertEqual(setup.flow.currentStepId, id)
    }

    // MARK: - Background refresh

    func testBackgroundRefreshAppearsOnceAChosenSourceThatNeedsItIsOn() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        let setup = startFromSettings([photos, notifications], host: host)
        XCTAssertEqual(setup.flow.selection, [photos, notifications], "nothing is on yet")

        try await bounded { await setup.runCurrentStep() }

        XCTAssertEqual(setup.flow.selection, [photos, backgroundRefresh, notifications])
        XCTAssertEqual(setup.flow.currentStepId, photos)
    }

    func testAChosenSourceThatEndsOffDoesNotCount() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosResult = .notAllowed
        let setup = startFromSettings([photos, notifications], host: host)

        try await bounded { await setup.runCurrentStep() }

        XCTAssertEqual(setup.flow.selection, [photos, notifications])
    }

    func testBackgroundRefreshStaysOutWhileItIsOn() {
        let host = FakePhoneSetupHost()
        host.photosEnabled = true

        let setup = startFromSettings([places, notifications], host: host)

        XCTAssertEqual(setup.flow.selection, [places, notifications])
    }

    func testARestrictedSettingIsLeftToTheSettingsWarning() {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .restricted
        host.photosEnabled = true

        let setup = startFromSettings([places, notifications], host: host)

        XCTAssertEqual(setup.flow.selection, [places, notifications])
    }

    func testASourceAlreadyOnThatNeedsItCounts() {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true

        let setup = startFromSettings([places], host: host)

        XCTAssertEqual(setup.flow.selection, [places, backgroundRefresh])
    }

    func testTheFirstRunFollowsTheSameRule() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        let setup = makeSetup(host: host)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()
        setup.toggle(movement)
        setup.startSelectedSteps()

        try await bounded { await setup.runCurrentStep() }

        XCTAssertEqual(setup.flow.selection, [movement, backgroundRefresh])
    }

    func testARunOpenedFromASettingsSwitchHasNoAddedSteps() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        let setup = makeSetup(host: host)
        setup.presentStep(photos, deviceId: device)

        try await bounded { await setup.runCurrentStep() }

        XCTAssertEqual(setup.flow.selection, [photos])
    }

    func testGoingBackToChooseDropsTheAddedStep() {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places], host: host)

        setup.back()

        XCTAssertEqual(setup.flow.screen, .choose)
        XCTAssertEqual(setup.flow.selection, [places])
    }

    func testThePageListsTheSourcesThatNeedItInChooseOrder() throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.appleHealthEnabled = true
        host.activitySegmentsEnabled = true
        host.photosEnabled = true
        let setup = startFromSettings([places], host: host)
        let step = try XCTUnwrap(setup.step(id: backgroundRefresh))

        XCTAssertEqual(
            setup.value(for: step),
            "Apple Health, Photos and Movement keep syncing while Omnesis is closed only when Background App Refresh is on."
        )

        let single = FakePhoneSetupHost()
        single.backgroundRefreshStatus = .denied
        single.photosEnabled = true
        let singleSetup = startFromSettings([places], host: single)
        let singleStep = try XCTUnwrap(singleSetup.step(id: backgroundRefresh))
        XCTAssertEqual(
            singleSetup.value(for: singleStep),
            "Photos keeps syncing while Omnesis is closed only when Background App Refresh is on."
        )
    }

    func testTheInstructionNamesTheSettingAndLowPowerMode() throws {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        let step = try XCTUnwrap(setup.step(id: backgroundRefresh))
        let turnOn = "In Settings, turn on Background App Refresh for Omnesis. "
            + "If it's off for the whole iPhone, tap General, then Background App Refresh."

        host.backgroundRefreshStatus = .denied
        XCTAssertEqual(step.settingsInstruction(for: nil), turnOn)
        XCTAssertEqual(step.settingsInstruction(for: .notAllowed), turnOn)
        host.isLowPowerModeEnabled = true
        XCTAssertEqual(step.settingsInstruction(for: nil), turnOn + "\nLow Power Mode also pauses background refresh.")
        XCTAssertNil(step.settingsInstruction(for: .on))
        host.backgroundRefreshStatus = .restricted
        XCTAssertNil(step.settingsInstruction(for: nil))
        host.backgroundRefreshStatus = .available
        XCTAssertNil(step.settingsInstruction(for: nil))
    }

    func testTheOutcomesSayWhetherItIsOn() {
        let copy = BackgroundRefreshSetupStep.copy

        XCTAssertEqual(copy.outcomeTitle(.on), "Background refresh is on")
        XCTAssertEqual(copy.outcomeBody(.on), "Your sources keep syncing while Omnesis is closed.")
        XCTAssertEqual(copy.outcomeTitle(.notAllowed), "Background refresh is still off")
        XCTAssertEqual(copy.outcomeBody(.notAllowed), "You can turn it on in Settings any time.")
    }

    func testComingBackFromSettingsWithItOnShowsItOn() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places, notifications], host: host)
        moveTo(backgroundRefresh, in: setup)

        setup.didOpenSettings()
        host.backgroundRefreshStatus = .available
        try await bounded { await setup.refreshLiveState() }

        XCTAssertEqual(setup.flow.currentStepId, backgroundRefresh)
        XCTAssertEqual(setup.flow.outcomes[backgroundRefresh], .on)
    }

    func testComingBackWithItStillOffShowsStillOffAndKeepsIt() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places], host: host)
        moveTo(backgroundRefresh, in: setup)

        setup.didOpenSettings()
        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.flow.outcomes[backgroundRefresh], .notAllowed)

        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.flow.outcomes[backgroundRefresh], .notAllowed, "a later refresh keeps it")

        setup.didOpenSettings()
        host.backgroundRefreshStatus = .available
        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.flow.outcomes[backgroundRefresh], .on)
    }

    func testNotNowMovesOn() {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places, notifications], host: host)
        moveTo(backgroundRefresh, in: setup)

        setup.next()

        XCTAssertEqual(setup.flow.currentStepId, notifications)
        XCTAssertNil(setup.flow.outcomes[backgroundRefresh])
    }

    func testAnUnreachedStepNoLongerNeededLeavesEvenWithAnOutcome() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places, notifications], host: host)
        moveTo(backgroundRefresh, in: setup)
        setup.didOpenSettings()
        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.flow.outcomes[backgroundRefresh], .notAllowed)
        setup.back()
        XCTAssertEqual(setup.flow.currentStepId, places)

        host.backgroundRefreshStatus = .available
        try await bounded { await setup.refreshLiveState() }

        XCTAssertEqual(setup.flow.selection, [places, notifications])
        XCTAssertEqual(setup.flow.currentStepId, places)
    }

    func testAPassedStepNoLongerNeededStays() async throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places, notifications], host: host)
        moveTo(notifications, in: setup)

        host.backgroundRefreshStatus = .available
        try await bounded { await setup.refreshLiveState() }

        XCTAssertEqual(setup.flow.selection, [places, backgroundRefresh, notifications])
        XCTAssertEqual(setup.flow.currentStepId, notifications)
    }

    func testAChangeInTheSettingRefreshesThePagesAndTheSteps() {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.photosEnabled = true
        let setup = startFromSettings([places], host: host)
        let revision = setup.revision

        host.backgroundRefreshStatus = .available
        setup.hostStateDidChange()

        XCTAssertGreaterThan(setup.revision, revision)
        XCTAssertEqual(setup.flow.selection, [places])
    }

    /// The steps that say they need Background App Refresh are exactly those
    /// whose permission-health report checks it.
    func testStepsThatNeedBackgroundRefreshMatchThePermissionHealthReports() throws {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        let checkedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let reports: [String: SourcePermissionHealthReport] = [
            health: AppleHealthPermissionHealth.report(backgroundRefresh: .denied, checkedAt: checkedAt),
            places: CoreLocationVisitsPermissionHealth.report(state: .always, precise: true, checkedAt: checkedAt),
            photos: PhotosPermissionHealth.report(access: .full, backgroundRefresh: .denied, checkedAt: checkedAt),
            movement: ActivitySegmentsPermissionHealth.report(state: .authorized, backgroundRefresh: .denied, checkedAt: checkedAt),
        ]

        for step in setup.steps where step.group == .source {
            let report = try XCTUnwrap(reports[step.id], step.id)
            XCTAssertEqual(
                report.capabilities.contains { $0.id == "background-refresh" },
                step.needsBackgroundRefresh,
                step.id
            )
        }
    }
}
