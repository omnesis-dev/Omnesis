// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What the flow shows once a source's state changes after its step ran: a
/// refusal that arrives in the background, a source that is no longer on, and
/// a step the user leaves while iOS is still asking.
@MainActor
final class PhoneSetupLiveOutcomeTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let photos = PhotosSetupStep.sourceId

    private func openOnStep(_ id: String, host: FakePhoneSetupHost) -> PhoneSetupCoordinator {
        let setup = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: DictionaryDefaults()))
        setup.install(host: host, steps: PhoneSetupRegistry.ios(host: host))
        setup.presentFromSettings(deviceId: device)
        setup.toggle(id)
        setup.startSelectedSteps()
        return setup
    }

    func testASourceRefusedAfterItWasOnShowsTheRefusal() async {
        let host = FakePhoneSetupHost()
        let setup = openOnStep(photos, host: host)
        await setup.runCurrentStep()
        XCTAssertEqual(setup.flow.outcomes[photos], .on)

        host.photosEnabled = false
        host.enableIssues[photos] = "Another device already syncs that source."
        setup.reconcileRecordedOutcomes()

        XCTAssertEqual(setup.flow.outcomes[photos], .failed(message: "Another device already syncs that source."))
    }

    func testASourceTurnedOffWithoutAReasonNoLongerShowsOn() async {
        let host = FakePhoneSetupHost()
        let setup = openOnStep(photos, host: host)
        await setup.runCurrentStep()

        host.photosEnabled = false
        setup.reconcileRecordedOutcomes()

        XCTAssertNotEqual(setup.flow.outcomes[photos], .on)
    }

    func testFinishReflectsWhatIsOnNow() async {
        let host = FakePhoneSetupHost()
        let setup = openOnStep(photos, host: host)
        await setup.runCurrentStep()
        XCTAssertTrue(setup.isContributing)
        XCTAssertEqual(setup.suggestedQuestion, PhotosSetupStep.copy.ask)

        host.photosEnabled = false
        XCTAssertFalse(setup.isContributing, "a recorded on no longer counts once the source is off")
        XCTAssertNil(setup.suggestedQuestion)

        host.appleHealthEnabled = true
        XCTAssertTrue(setup.isContributing, "a source on from elsewhere counts")
        XCTAssertEqual(setup.suggestedQuestion, AppleHealthSetupStep.copy.ask)
    }

    func testLeavingAStepCancelsItsEnable() async {
        let host = FakePhoneSetupHost()
        host.holdsPhotosEnable = true
        let setup = openOnStep(photos, host: host)
        let running = Task { await setup.runCurrentStep() }
        let asking = await eventually { host.isHoldingEnable }
        XCTAssertTrue(asking)

        setup.back()
        host.releaseHeldEnable()
        await running.value

        XCTAssertTrue(host.enableSawCancellation)
        XCTAssertNil(setup.busyStepId)
    }
}
