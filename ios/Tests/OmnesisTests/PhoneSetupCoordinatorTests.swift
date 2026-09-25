// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class PhoneSetupCoordinatorTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let otherDevice = "22222222-2222-4222-8222-222222222222"
    private let health = AppleHealthSetupStep.sourceId
    private let places = PlacesSetupStep.sourceId
    private let photos = PhotosSetupStep.sourceId
    private let movement = MovementSetupStep.sourceId
    private let notifications = NotificationsSetupStep.stepId

    /// Steps hold their host unowned, so each test keeps its host alive.
    private func makeSetup(host: FakePhoneSetupHost, defaults: DictionaryDefaults = DictionaryDefaults()) -> PhoneSetupCoordinator {
        let setup = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: defaults))
        setup.install(host: host, steps: PhoneSetupRegistry.ios(host: host))
        return setup
    }

    // MARK: - Presentation

    func testRegistryListsTheIPhoneStepsInChooseOrder() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        XCTAssertEqual(
            setup.steps.map(\.id),
            [health, places, photos, movement, BackgroundRefreshSetupStep.stepId, notifications, RelayConsentSetupStep.stepId]
        )
        XCTAssertEqual(setup.steps.map(\.group), [.source, .source, .source, .source, .automatic, .also, .automatic])
    }

    func testFreshDeviceIsOfferedSetupFromConnected() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)

        XCTAssertEqual(setup.presentation, .firstRun)
        XCTAssertTrue(setup.isGateActive)
        XCTAssertEqual(setup.flow.screen, .connected)
    }

    func testDeviceAlreadyHostingASourceIsMarkedFinishedWithoutShowing() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)

        XCTAssertNil(setup.presentation)
        XCTAssertFalse(setup.isGateActive)
        XCTAssertEqual(PhoneSetupProgressStore(defaults: defaults).completedForDeviceId, device)
    }

    func testTheGateHoldsUntilEvaluationDecidesNotToShow() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)

        setup.holdForEvaluation(deviceId: device)
        XCTAssertTrue(setup.isGateActive)
        XCTAssertNil(setup.presentation)

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)
        XCTAssertFalse(setup.isGateActive)
    }

    func testAHeldGateStaysHeldWhenSetupShowsAndUnpairReleasesAHold() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.holdForEvaluation(deviceId: device)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        XCTAssertTrue(setup.isGateActive)
        XCTAssertEqual(setup.presentation, .firstRun)

        let other = makeSetup(host: host)
        other.holdForEvaluation(deviceId: otherDevice)
        other.resetForUnpair()
        XCTAssertFalse(other.isGateActive)
    }

    func testADeviceThatFinishedSetupIsNeverHeld() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        PhoneSetupProgressStore(defaults: defaults).completedForDeviceId = device
        let setup = makeSetup(host: host, defaults: defaults)

        setup.holdForEvaluation(deviceId: device)

        XCTAssertFalse(setup.isGateActive)
    }

    func testRepairKeepsSetupFinishedAndUnpairOffersItAgain() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.complete()
        setup.presentationDidEnd()

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        XCTAssertNil(setup.presentation, "a repair keeps the device id")

        setup.evaluateAutomaticPresentation(deviceId: otherDevice, anyPhoneSourceEnabled: false)
        XCTAssertEqual(setup.presentation, .firstRun, "a different device is offered setup")
        setup.complete()
        setup.presentationDidEnd()

        setup.resetForUnpair()
        setup.evaluateAutomaticPresentation(deviceId: otherDevice, anyPhoneSourceEnabled: false)
        XCTAssertEqual(setup.presentation, .firstRun)
    }

    func testSettingsEntryOpensOnChooseAndIsNotResumed() async {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)

        setup.presentFromSettings(deviceId: device)
        XCTAssertEqual(setup.presentation, .settings)
        XCTAssertEqual(setup.flow.screen, .choose)
        setup.toggle(photos)
        setup.startSelectedSteps()
        await setup.runCurrentStep()

        XCTAssertNil(PhoneSetupProgressStore(defaults: defaults).progress(for: device))
    }

    // MARK: - Steps

    func testStepsFollowChooseOrderAndRecordEachOutcome() async {
        let host = FakePhoneSetupHost()
        host.photosResult = .enabled(.limited)
        host.notificationGrant = false
        let setup = makeSetup(host: host)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()

        setup.toggle(notifications)
        setup.toggle(photos)
        setup.toggle(health)
        XCTAssertEqual(setup.flow.selection, [health, photos, notifications])

        setup.startSelectedSteps()
        XCTAssertEqual(setup.currentStep?.id, health)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[health], .on)

        setup.next()
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[photos], .limited)

        setup.next()
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[notifications], .notAllowed)
        XCTAssertTrue(setup.flow.isOnLastStep)

        setup.next()
        XCTAssertEqual(setup.flow.screen, .finish)
        XCTAssertTrue(setup.flow.contributed)
    }

    func testRowsThatAreOnOrUnavailableCannotBeSelected() {
        let host = FakePhoneSetupHost()
        host.appleHealthEnabled = true
        host.motionActivityPermission = .unavailable
        host.notificationPermission = .denied
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)

        XCTAssertEqual(setup.step(id: health)?.rowState, .alreadyOn)
        XCTAssertEqual(setup.step(id: movement)?.rowState, .unavailable(reason: "Not available on this iPhone"))
        XCTAssertEqual(setup.step(id: notifications)?.rowState, .unavailable(reason: "Off in Settings"))
        for id in [health, movement, notifications] {
            setup.toggle(id)
        }
        setup.startSelectedSteps()

        XCTAssertTrue(setup.flow.selection.isEmpty)
        XCTAssertEqual(setup.flow.screen, .choose)
        XCTAssertEqual(setup.sourceSummary, PhoneSetupSourceSummary(enabled: 1, available: 3))
    }

    func testChoiceRequiredWaitsForAChoiceAndContinuesWithIt() async {
        let host = FakePhoneSetupHost()
        host.appleHealthResult = .choiceRequired(.replicated)
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(health)
        setup.startSelectedSteps()

        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[health], .choiceRequired(.replicated))
        XCTAssertEqual(setup.currentStep?.choices(for: .replicated).map(\.choice), [.keepOther, .useBoth, .takeOver])
        XCTAssertEqual(setup.currentStep?.choices(for: .exclusive).map(\.choice), [.keepOther, .takeOver])

        host.appleHealthResult = .enabled(.full)
        await setup.runCurrentStep(choice: .useBoth)

        XCTAssertEqual(host.appleHealthChoices, [nil, .useBoth])
        XCTAssertEqual(setup.flow.outcomes[health], .on)
    }

    func testKeepingTheOtherDeviceMovesStraightToTheNextStep() async {
        let host = FakePhoneSetupHost()
        host.photosResult = .keptOther
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(photos)
        setup.toggle(movement)
        setup.startSelectedSteps()

        await setup.runCurrentStep()

        XCTAssertEqual(setup.flow.outcomes[photos], .skipped)
        XCTAssertEqual(setup.currentStep?.id, movement)
    }

    func testAFailureSurvivesARefreshAndCanBeRetried() async {
        let host = FakePhoneSetupHost()
        host.movementResult = .failed(message: "Couldn't reach your gateway to turn this on. Nothing was changed.")
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(movement)
        setup.startSelectedSteps()

        await setup.runCurrentStep()
        await setup.refreshLiveState()
        XCTAssertEqual(
            setup.flow.outcomes[movement],
            .failed(message: "Couldn't reach your gateway to turn this on. Nothing was changed.")
        )

        host.movementResult = .enabled(.full)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[movement], .on)
    }

    func testReturningFromSettingsUpdatesWhatThePermissionDecides() async {
        let host = FakePhoneSetupHost()
        host.placesResult = .enabled(.foregroundOnly)
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(places)
        setup.startSelectedSteps()
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[places], .partial)

        host.locationVisitsPermission = .always
        await setup.refreshLiveState()

        XCTAssertEqual(setup.flow.outcomes[places], .on)
    }

    func testANotAllowedStepReturnsToItsPageOnceAccessIsAllowedInSettings() async {
        let host = FakePhoneSetupHost()
        host.movementResult = .notAllowed
        host.motionActivityPermission = .denied
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(movement)
        setup.startSelectedSteps()
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[movement], .notAllowed)

        host.motionActivityPermission = .authorized
        await setup.refreshLiveState()

        XCTAssertNil(setup.flow.outcomes[movement])
        XCTAssertEqual(host.pushDeliveryRefreshes, 1, "refreshing re-reads notification settings")
    }
}

// MARK: - Cover, Settings runs and resets

extension PhoneSetupCoordinatorTests {
    func testSkipForNowFinishesAndReleasesTheGateAtOnce() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()
        XCTAssertTrue(setup.isGateActive)

        setup.complete()

        XCTAssertNil(setup.presentation)
        XCTAssertFalse(setup.isGateActive, "first-run setup is the root's content, so nothing is left to dismiss")
        let store = PhoneSetupProgressStore(defaults: defaults)
        XCTAssertEqual(store.completedForDeviceId, device)
        XCTAssertNil(store.progress(for: device))
    }

    func testFirstRunTakesTheScreenFromAWaitingConsentSheet() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.requestDeferredPresentation(.relayConsent)
        XCTAssertEqual(setup.nextDeferredPresentation(screenIsFree: true), .relayConsent)

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)

        XCTAssertNil(setup.deferredPresentations.current, "the root shows no consent sheet over first-run setup")
        XCTAssertNil(setup.nextDeferredPresentation(screenIsFree: true))
        setup.complete()
        XCTAssertEqual(setup.nextDeferredPresentation(screenIsFree: true), .relayConsent, "it comes back once home shows")
    }

    func testASettingsCoverTimesOutOnlyWhileTheSceneIsActive() async throws {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.settingsPresentationTimeout = .milliseconds(10)
        setup.sceneDidChange(isActive: false)
        setup.presentStep(photos, deviceId: device)

        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(setup.presentation, .settingsStep, "nothing presents in the background, so nothing times out")

        setup.sceneDidChange(isActive: true)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(setup.presentation)
    }

    func testClosingACoverThatNeverAppearedReleasesTheGate() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)

        setup.complete()

        XCTAssertFalse(setup.isGateActive)
    }

    func testDeferredPresentationsWaitForTheGate() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.requestDeferredPresentation(.pushTarget)

        XCTAssertNil(setup.nextDeferredPresentation(screenIsFree: true))
        setup.complete()

        XCTAssertEqual(setup.nextDeferredPresentation(screenIsFree: true), .pushTarget)
    }

    // MARK: - Settings runs

    func testASettingsRunNeverWritesTheFirstRunRecord() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let store = PhoneSetupProgressStore(defaults: defaults)
        var saved = PhoneSetupFlow(includesConnected: true)
        saved.showChoose()
        store.saveProgress(saved, deviceId: device)
        let setup = makeSetup(host: host, defaults: defaults)

        setup.presentFromSettings(deviceId: device)
        setup.complete()

        XCTAssertNil(store.completedForDeviceId)
        XCTAssertEqual(store.progress(for: device), saved, "a settings run leaves the first-run progress alone")
    }

    func testASingleStepFromSettingsRunsThatStepAndCloses() async {
        let host = FakePhoneSetupHost()
        host.placesResult = .enabled(.foregroundOnly)
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)

        setup.presentStep(places, deviceId: device)
        XCTAssertEqual(setup.presentation, .settingsStep)
        XCTAssertEqual(setup.currentStep?.id, places)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[places], .partial)
        XCTAssertTrue(setup.flow.isOnLastStep)

        setup.next()

        XCTAssertNil(setup.presentation)
        XCTAssertNil(PhoneSetupProgressStore(defaults: defaults).completedForDeviceId)
    }

    func testASingleStepClosesWhenBackIsTappedOrTheOtherDeviceKeepsTheSource() async {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.presentStep(photos, deviceId: device)
        setup.back()
        XCTAssertNil(setup.presentation)

        host.photosResult = .keptOther
        setup.presentStep(photos, deviceId: device)
        await setup.runCurrentStep()
        XCTAssertNil(setup.presentation)
    }

    func testASourceThatIsAlreadyOnCannotBeOpenedAsASingleStep() {
        let host = FakePhoneSetupHost()
        host.appleHealthEnabled = true
        let setup = makeSetup(host: host)

        setup.presentStep(health, deviceId: device)

        XCTAssertNil(setup.presentation)
    }

    func testEvaluatingWhileSettingsShowsSetupChangesNothing() {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)

        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)

        XCTAssertEqual(setup.presentation, .settings)
        XCTAssertTrue(setup.isGateActive)
    }

    // MARK: - Pairing loss

    func testUnpairingDuringPresentationEndsItAndReleasesTheGate() async {
        let host = FakePhoneSetupHost()
        host.holdsPhotosEnable = true
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()
        setup.toggle(photos)
        setup.startSelectedSteps()
        let run = Task { await setup.runCurrentStep() }
        while !host.isHoldingEnable {
            await Task.yield()
        }

        setup.resetForUnpair()
        host.releaseHeldEnable()
        await run.value

        XCTAssertNil(setup.presentation)
        XCTAssertFalse(setup.isGateActive)
        XCTAssertNil(setup.busyStepId)
        XCTAssertEqual(setup.flow, PhoneSetupFlow(includesConnected: true))
        XCTAssertNil(PhoneSetupProgressStore(defaults: defaults).progress(for: device))
    }

    // MARK: - Busy steps

    func testBackWhileAStepWaitsOnIOSAbandonsItAndDiscardsItsLateResult() async {
        let host = FakePhoneSetupHost()
        host.holdsPhotosEnable = true
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(photos)
        setup.startSelectedSteps()
        let run = Task { await setup.runCurrentStep() }
        while !host.isHoldingEnable {
            await Task.yield()
        }
        XCTAssertEqual(setup.busyStepId, photos)

        setup.back()
        XCTAssertNil(setup.busyStepId)
        XCTAssertEqual(setup.flow.screen, .choose)

        host.releaseHeldEnable()
        await run.value
        XCTAssertNil(setup.flow.outcomes[photos], "a result for an abandoned step is discarded")
        XCTAssertEqual(setup.flow.screen, .choose)
    }

    func testALateResultAfterTheFlowClosedIsDiscarded() async {
        let host = FakePhoneSetupHost()
        host.holdsPhotosEnable = true
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(photos)
        setup.startSelectedSteps()
        let run = Task { await setup.runCurrentStep() }
        while !host.isHoldingEnable {
            await Task.yield()
        }

        setup.complete()
        host.releaseHeldEnable()
        await run.value

        XCTAssertNil(setup.presentation)
        XCTAssertNil(setup.flow.outcomes[photos])
    }

    func testRefreshingWhileAStepWaitsOnIOSLeavesThatStepAlone() async {
        let host = FakePhoneSetupHost()
        host.holdsPhotosEnable = true
        let setup = makeSetup(host: host)
        setup.presentFromSettings(deviceId: device)
        setup.toggle(photos)
        setup.startSelectedSteps()
        let run = Task { await setup.runCurrentStep() }
        while !host.isHoldingEnable {
            await Task.yield()
        }

        host.photosAccess = .denied
        await setup.refreshLiveState()
        XCTAssertNil(setup.flow.outcomes[photos], "the busy step is not reconciled underneath iOS")

        host.releaseHeldEnable()
        await run.value
        XCTAssertEqual(setup.flow.outcomes[photos], .on)
    }

    // MARK: - Resume

    func testAResumedStepThatNeverRecordedAnOutcomeUsesWhatTheDeviceSays() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        var saved = PhoneSetupFlow(includesConnected: true)
        saved.showChoose()
        saved.toggle(health, order: [health])
        saved.startSteps()
        PhoneSetupProgressStore(defaults: defaults).saveProgress(saved, deviceId: device)
        host.appleHealthEnabled = true

        let setup = makeSetup(host: host, defaults: defaults)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)

        XCTAssertEqual(setup.presentation, .firstRun)
        XCTAssertEqual(setup.flow.outcomes[health], .on, "an already-on source is not activated again")
    }

    func testASavedRunNamingAnUnknownStepIsDiscarded() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        var saved = PhoneSetupFlow(includesConnected: true)
        saved.showChoose()
        saved.toggle("retired-source:local", order: ["retired-source:local"])
        saved.startSteps()
        let store = PhoneSetupProgressStore(defaults: defaults)
        store.saveProgress(saved, deviceId: device)

        let withSources = makeSetup(host: host, defaults: defaults)
        withSources.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)
        XCTAssertNil(withSources.presentation, "without a usable run, a device with sources completes silently")
        XCTAssertEqual(store.completedForDeviceId, device)

        store.reset()
        store.saveProgress(saved, deviceId: device)
        let withoutSources = makeSetup(host: host, defaults: defaults)
        withoutSources.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        XCTAssertEqual(withoutSources.presentation, .firstRun)
        XCTAssertEqual(withoutSources.flow.screen, .connected)
    }

    func testAKilledAppResumesAtTheSameStepEvenThoughASourceIsNowOn() async {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let first = makeSetup(host: host, defaults: defaults)
        first.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        first.continueFromConnected()
        first.toggle(health)
        first.toggle(photos)
        first.startSelectedSteps()
        await first.runCurrentStep()
        first.next()

        let relaunched = makeSetup(host: host, defaults: defaults)
        relaunched.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: host.appleHealthEnabled)

        XCTAssertEqual(relaunched.presentation, .firstRun)
        XCTAssertEqual(relaunched.flow.screen, .step(index: 1))
        XCTAssertEqual(relaunched.flow.selection, [health, photos])
        XCTAssertEqual(relaunched.flow.outcomes[health], .on)
    }

    func testResumeReDerivesOutcomesFromTheDevice() async {
        let host = FakePhoneSetupHost()
        host.photosResult = .enabled(.limited)
        let defaults = DictionaryDefaults()
        let first = makeSetup(host: host, defaults: defaults)
        first.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        first.continueFromConnected()
        first.toggle(photos)
        first.startSelectedSteps()
        await first.runCurrentStep()
        XCTAssertEqual(first.flow.outcomes[photos], .limited)

        host.photosAccess = .full
        let relaunched = makeSetup(host: host, defaults: defaults)
        relaunched.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: true)

        XCTAssertEqual(relaunched.flow.outcomes[photos], .on)
    }

    func testFinishingClearsTheSavedRun() {
        let host = FakePhoneSetupHost()
        let defaults = DictionaryDefaults()
        let setup = makeSetup(host: host, defaults: defaults)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()
        XCTAssertNotNil(PhoneSetupProgressStore(defaults: defaults).progress(for: device))

        setup.complete()

        XCTAssertNil(PhoneSetupProgressStore(defaults: defaults).progress(for: device))
    }
}

// MARK: - Cover timeouts, summary and copy

extension PhoneSetupCoordinatorTests {
    func testATimedOutSettingsCoverClosesSoTheNextSwitchCanOpenOne() async throws {
        let host = FakePhoneSetupHost()
        let setup = makeSetup(host: host)
        setup.settingsPresentationTimeout = .milliseconds(10)
        setup.presentStep(photos, deviceId: device)
        XCTAssertEqual(setup.presentation, .settingsStep)

        try await Task.sleep(for: .milliseconds(200))

        XCTAssertNil(setup.presentation)
        XCTAssertFalse(setup.isGateActive)
        setup.settingsPresentationTimeout = .seconds(60)
        setup.presentStep(photos, deviceId: device)
        XCTAssertEqual(setup.presentation, .settingsStep)
    }

    func testASourceThatIsOnCountsEvenWhileItsRowIsUnavailable() {
        let host = FakePhoneSetupHost()
        host.appleHealthEnabled = true
        host.healthDataAvailable = false
        host.activitySegmentsEnabled = true
        host.motionActivityPermission = .unavailable
        let setup = makeSetup(host: host)

        XCTAssertEqual(setup.sourceSummary, PhoneSetupSourceSummary(enabled: 2, available: 4))
    }

    func testAnUnavailableStepSaysWhyItCannotOpen() {
        let host = FakePhoneSetupHost()
        host.motionActivityPermission = .unavailable
        let setup = makeSetup(host: host)

        XCTAssertEqual(setup.unavailableReason(for: movement), PhoneSetupCopy.notAvailableReason)
        XCTAssertNil(setup.unavailableReason(for: photos))
        setup.presentStep(movement, deviceId: device)
        XCTAssertNil(setup.presentation)
    }

    func testAFailureMessageDoesNotAskToTryAgainTwice() {
        let copy = PhotosSetupStep.copy

        XCTAssertEqual(
            copy.outcomeBody(.failed(message: "iOS couldn't show the Health access sheet. Try again.")),
            "iOS couldn't show the Health access sheet."
        )
        XCTAssertEqual(copy.outcomeBody(.failed(message: "Try again.")), "Try again.")
        XCTAssertEqual(copy.outcomeBody(.failed(message: "Nothing was changed.")), "Nothing was changed.")
    }
}
