// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The relay consent decision, which the flow adds whenever the gateway asks
/// for it while setup is open and notifications are allowed, and the steps the
/// flow adds by itself in saved progress.
@MainActor
final class PhoneSetupRelayConsentStepTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let health = AppleHealthSetupStep.sourceId
    private let places = PlacesSetupStep.sourceId
    private let photos = PhotosSetupStep.sourceId
    private let notifications = NotificationsSetupStep.stepId
    private let backgroundRefresh = BackgroundRefreshSetupStep.stepId
    private let relay = RelayConsentSetupStep.stepId

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

    private func relayRequest() throws -> RelayPushConsentRequest {
        try RelayPushConsentRequest(
            pairing: Pairing(
                url: XCTUnwrap(URL(string: "https://gateway.example.com")),
                token: "omn_fictional",
                accountId: "fictional-account",
                deviceId: device,
                gatewayName: "Fictional Gateway"
            ),
            appId: "com.example.omnesis"
        )
    }

    private func moveTo(_ id: String, in setup: PhoneSetupCoordinator) {
        for _ in setup.flow.selection where setup.flow.currentStepId.map({ $0 != id }) == true {
            setup.next()
        }
        XCTAssertEqual(setup.flow.currentStepId, id)
    }

    func testARelayRequestWaitsForNotificationsToBeAllowed() throws {
        for permission in [PhoneSetupNotificationPermission.denied, .notDetermined] {
            let host = FakePhoneSetupHost()
            host.notificationPermission = permission
            host.relayPushConsentRequest = try relayRequest()

            let setup = startFromSettings([health], host: host)
            setup.syncAutomaticSteps()

            XCTAssertEqual(setup.flow.selection, [health], "\(permission)")
        }
    }

    func testNotificationsAllowedMidRunAddTheStep() async throws {
        let host = FakePhoneSetupHost()
        host.relayPushConsentRequest = try relayRequest()
        let setup = startFromSettings([health, notifications], host: host)
        XCTAssertEqual(setup.flow.selection, [health, notifications])

        host.notificationPermission = .authorized
        try await bounded { await setup.refreshLiveState() }

        XCTAssertEqual(setup.flow.selection, [health, notifications, relay])
    }

    func testNotificationsTurnedOffMidRunRemoveTheStep() async throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = try relayRequest()
        let setup = startFromSettings([health], host: host)
        XCTAssertEqual(setup.flow.selection, [health, relay])

        host.notificationPermission = .denied
        try await bounded { await setup.refreshLiveState() }

        XCTAssertEqual(setup.flow.selection, [health])
    }

    func testARequestArrivingDuringASourceStepIsAskedJustBeforeFinish() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        let setup = startFromSettings([health], host: host)

        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()

        XCTAssertEqual(setup.flow.selection, [health, relay])
        XCTAssertEqual(setup.flow.currentStepId, health, "the page on screen stays")
    }

    func testAnAnsweredPageKeepsItsAnswerThroughARefresh() async throws {
        for answer in [PhoneSetupOutcome.on, .notAllowed] {
            let host = FakePhoneSetupHost()
            host.notificationPermission = .authorized
            host.relayPushConsentRequest = try relayRequest()
            let setup = startFromSettings([health], host: host)
            moveTo(relay, in: setup)

            try await bounded { try await setup.answerCurrentStep(outcome: answer) { host.relayPushConsentRequest = nil } }
            XCTAssertEqual(setup.flow.currentStepId, relay, "the page shows the answer")
            XCTAssertEqual(setup.flow.outcomes[relay], answer, "\(answer)")

            try await bounded { await setup.refreshLiveState() }

            XCTAssertEqual(setup.flow.selection, [health, relay], "\(answer)")
            XCTAssertEqual(setup.flow.currentStepId, relay, "a refresh keeps the answered page")
            XCTAssertEqual(setup.flow.outcomes[relay], answer, "the page shows the answer, not a blank page")

            setup.next()
            XCTAssertEqual(setup.flow.screen, .finish)
        }
    }

    func testTheAnswersHaveTheirOwnOutcomeCopy() {
        let copy = RelayConsentSetupStep.copy

        XCTAssertEqual(copy.outcomeTitle(.on), "Relay notifications are on")
        XCTAssertEqual(copy.outcomeBody(.on), "Your gateway can now wake this iPhone privately.")
        XCTAssertEqual(copy.outcomeTitle(.notAllowed), "Relay notifications are off")
        XCTAssertEqual(copy.outcomeBody(.notAllowed), "Omnesis will ask again later. You can also allow them from Settings.")
    }

    /// After an answer in setup, the app's next registration can set the
    /// request again straight away. Closing setup must not put the sheet up
    /// during the same visit; a later visit may ask again.
    func testARequestSetAgainAfterAnAnswerWaitsForTheNextVisit() async throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = try relayRequest()
        let setup = startFromSettings([health], host: host)
        // The request was queued for the standalone sheet when it arrived.
        setup.requestDeferredPresentation(.relayConsent)
        moveTo(relay, in: setup)
        try await bounded { try await setup.answerCurrentStep(outcome: .on) { host.relayPushConsentRequest = nil } }

        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()
        setup.requestDeferredPresentation(.relayConsent)
        setup.complete()
        setup.presentationDidEnd()
        XCTAssertNil(setup.nextDeferredPresentation(screenIsFree: true), "no sheet on close in the same visit")

        setup.appDidEnterBackground()
        setup.requestDeferredPresentation(.relayConsent)
        XCTAssertEqual(setup.nextDeferredPresentation(screenIsFree: true), .relayConsent, "a later visit asks again")
    }

    func testNotNowIsNotAskedAgainInTheSameRun() async throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = try relayRequest()
        let setup = startFromSettings([health], host: host)
        moveTo(relay, in: setup)
        try await bounded { try await setup.answerCurrentStep(outcome: .notAllowed) { host.relayPushConsentRequest = nil } }

        host.relayPushConsentRequest = try relayRequest()
        try await bounded { await setup.refreshLiveState() }
        XCTAssertEqual(setup.declinedStepIds, [relay])
        XCTAssertEqual(setup.flow.selection, [health, relay], "only the answered page, not a new one")

        for _ in setup.flow.selection where setup.flow.screen != .choose {
            setup.back()
        }
        XCTAssertEqual(setup.flow.screen, .choose)
        setup.startSelectedSteps()
        XCTAssertEqual(setup.flow.selection, [health], "starting again from Choose doesn't ask again")

        setup.complete()
        setup.presentFromSettings(deviceId: device)
        XCTAssertTrue(setup.declinedStepIds.isEmpty, "a new run may ask again")
    }

    func testARequestAfterTheFlowClosesGoesToTheStandaloneSheet() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        let setup = startFromSettings([health], host: host)
        setup.complete()
        setup.presentationDidEnd()

        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()
        setup.requestDeferredPresentation(.relayConsent)

        XCTAssertFalse(setup.flow.selection.contains(relay))
        XCTAssertEqual(setup.nextDeferredPresentation(screenIsFree: true), .relayConsent)
    }

    func testARequestArrivingOnFinishLeavesItToTheStandaloneSheet() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        let setup = startFromSettings([health], host: host)
        setup.next()
        XCTAssertEqual(setup.flow.screen, .finish)

        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()

        XCTAssertEqual(setup.flow.selection, [health])
        XCTAssertEqual(setup.flow.screen, .finish)
    }

    func testAWithdrawnRequestDropsTheStep() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        let setup = startFromSettings([health, places], host: host)
        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()

        host.relayPushConsentRequest = nil
        setup.syncAutomaticSteps()

        XCTAssertEqual(setup.flow.selection, [health, places])
    }

    func testARequestWithdrawnWhileItsPageShowsMovesOnToFinish() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = try relayRequest()
        let setup = startFromSettings([health], host: host)
        moveTo(relay, in: setup)

        host.relayPushConsentRequest = nil
        setup.syncAutomaticSteps()

        XCTAssertEqual(setup.flow.screen, .finish)
    }

    func testNoRequestAddsNoRelayStep() {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized

        let setup = startFromSettings([health], host: host)

        XCTAssertEqual(setup.flow.selection, [health])
    }

    func testTheProgressBarCountsTheAddedSteps() throws {
        let host = FakePhoneSetupHost()
        host.backgroundRefreshStatus = .denied
        host.appleHealthEnabled = true
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = try relayRequest()

        let setup = startFromSettings([photos, places], host: host)

        XCTAssertEqual(setup.flow.selection, [places, photos, backgroundRefresh, relay])
    }

    // MARK: - Saved progress

    func testSavedProgressLeavesOutAddedStepsAndResumesOnFinishFromOne() throws {
        let host = FakePhoneSetupHost()
        host.notificationPermission = .authorized
        let progress = DictionaryDefaults()
        let setup = makeSetup(host: host, progress: progress)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        setup.continueFromConnected()
        setup.toggle(health)
        setup.startSelectedSteps()
        host.relayPushConsentRequest = try relayRequest()
        setup.syncAutomaticSteps()
        XCTAssertEqual(setup.flow.selection, [health, relay])

        moveTo(relay, in: setup)

        let saved = try XCTUnwrap(PhoneSetupProgressStore(defaults: progress).progress(for: device))
        XCTAssertEqual(saved.selection, [health])
        XCTAssertEqual(saved.screen, .finish)
    }
}
