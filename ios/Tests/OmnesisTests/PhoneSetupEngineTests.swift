// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhoneSetupEngineTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"
    private let otherDevice = "22222222-2222-4222-8222-222222222222"

    // MARK: - When setup shows

    func testSetupShowsOncePerDeviceAndNeverForADeviceAlreadyHostingASource() {
        XCTAssertEqual(
            PhoneSetupPresentationPolicy.decide(completedForDeviceId: nil, deviceId: device, anyPhoneSourceEnabled: false),
            .present
        )
        XCTAssertEqual(
            PhoneSetupPresentationPolicy.decide(completedForDeviceId: nil, deviceId: device, anyPhoneSourceEnabled: true),
            .completeSilently
        )
        XCTAssertEqual(
            PhoneSetupPresentationPolicy.decide(completedForDeviceId: device, deviceId: device, anyPhoneSourceEnabled: false),
            .none
        )
        XCTAssertEqual(
            PhoneSetupPresentationPolicy.decide(
                completedForDeviceId: otherDevice,
                deviceId: device,
                anyPhoneSourceEnabled: false
            ),
            .present
        )
    }

    // MARK: - Flow

    func testSelectionKeepsChooseOrderWhateverOrderRowsWereTapped() {
        var flow = PhoneSetupFlow(includesConnected: true)
        let order = ["health", "places", "photos", "movement", "notifications"]

        flow.toggle("notifications", order: order)
        flow.toggle("photos", order: order)
        flow.toggle("health", order: order)

        XCTAssertEqual(flow.selection, ["health", "photos", "notifications"])
    }

    func testStepsRunFromChooseToFinishAndBackReturnsToChoose() {
        var flow = PhoneSetupFlow(includesConnected: true)
        XCTAssertEqual(flow.screen, .connected)
        flow.showChoose()
        XCTAssertFalse(flow.startSteps(), "nothing selected")
        XCTAssertEqual(flow.screen, .choose)

        flow.toggle("health", order: ["health", "photos"])
        flow.toggle("photos", order: ["health", "photos"])
        XCTAssertTrue(flow.startSteps())
        XCTAssertEqual(flow.currentStepId, "health")
        XCTAssertFalse(flow.isOnLastStep)

        flow.record(.on, for: "health")
        flow.advance()
        XCTAssertEqual(flow.currentStepId, "photos")
        XCTAssertTrue(flow.isOnLastStep)

        flow.back()
        flow.back()
        XCTAssertEqual(flow.screen, .choose)
        XCTAssertEqual(flow.outcomes["health"], .on, "going back keeps what a step already did")

        XCTAssertTrue(flow.startSteps())
        flow.advance()
        flow.advance()
        XCTAssertEqual(flow.screen, .finish)
        XCTAssertTrue(flow.contributed)
    }

    func testDeselectingAStepForgetsItsOutcomeAndUnselectedIdsRecordNothing() {
        var flow = PhoneSetupFlow(includesConnected: false)
        XCTAssertEqual(flow.screen, .choose)
        flow.toggle("photos", order: ["photos"])
        flow.record(.limited, for: "photos")
        flow.record(.on, for: "never-selected")

        flow.toggle("photos", order: ["photos"])

        XCTAssertTrue(flow.outcomes.isEmpty)
        XCTAssertFalse(flow.contributed)
    }

    // MARK: - Persistence

    func testProgressRoundTripsForTheSameDeviceOnly() {
        let store = PhoneSetupProgressStore(defaults: DictionaryDefaults())
        var flow = PhoneSetupFlow(includesConnected: true)
        flow.showChoose()
        flow.toggle("photos", order: ["photos"])
        flow.startSteps()
        flow.record(.failed(message: "Gateway unreachable"), for: "photos")

        store.saveProgress(flow, deviceId: device)

        XCTAssertEqual(store.progress(for: device), flow)
        XCTAssertNil(store.progress(for: otherDevice))
    }

    func testResetForgetsCompletionAndProgress() {
        let defaults = DictionaryDefaults()
        let store = PhoneSetupProgressStore(defaults: defaults)
        store.completedForDeviceId = device
        store.saveProgress(PhoneSetupFlow(includesConnected: true), deviceId: device)

        store.reset()

        XCTAssertNil(store.completedForDeviceId)
        XCTAssertNil(store.progress(for: device))
        XCTAssertTrue(defaults.values.isEmpty)
    }

    // MARK: - Outcomes

    func testEnableResultsMapToOutcomes() {
        XCTAssertEqual(PhoneSetupOutcome(.enabled(.full)), .on)
        XCTAssertEqual(PhoneSetupOutcome(.enabled(.limited)), .limited)
        XCTAssertEqual(PhoneSetupOutcome(.enabled(.foregroundOnly)), .partial)
        XCTAssertEqual(PhoneSetupOutcome(.notAllowed), .notAllowed)
        XCTAssertEqual(PhoneSetupOutcome(.unavailable(reason: "No sensor")), .unavailable(reason: "No sensor"))
        XCTAssertEqual(PhoneSetupOutcome(.keptOther), .skipped)
        XCTAssertEqual(PhoneSetupOutcome(.choiceRequired(.replicated)), .choiceRequired(.replicated))
        XCTAssertEqual(PhoneSetupOutcome(.failed(message: nil)), .failed(message: nil))
    }

    func testLiveOutcomeNeedsAnAnswerAndAnEnabledSourceToCountAsOn() {
        XCTAssertNil(PhoneSetupOutcome.live(enabled: true, authorization: nil))
        XCTAssertNil(PhoneSetupOutcome.live(enabled: false, authorization: .granted(.full)))
        XCTAssertEqual(PhoneSetupOutcome.live(enabled: true, authorization: .granted(.foregroundOnly)), .partial)
        XCTAssertEqual(PhoneSetupOutcome.live(enabled: false, authorization: .notAllowed), .notAllowed)
        XCTAssertEqual(
            PhoneSetupOutcome.live(enabled: false, authorization: .unavailable(reason: "No sensor")),
            .unavailable(reason: "No sensor")
        )
    }

    func testReconcilingKeepsDecisionsButFollowsDeviceState() {
        XCTAssertEqual(PhoneSetupOutcome.partial.reconciled(with: .on), .on)
        XCTAssertNil(PhoneSetupOutcome.notAllowed.reconciled(with: nil), "access granted in Settings reopens the step")
        XCTAssertNil(PhoneSetupOutcome.limited.reconciled(with: nil), "a source turned off elsewhere is no longer on")
        XCTAssertEqual(PhoneSetupOutcome.failed(message: "x").reconciled(with: nil), .failed(message: "x"))
        XCTAssertEqual(PhoneSetupOutcome.choiceRequired(.exclusive).reconciled(with: nil), .choiceRequired(.exclusive))
        XCTAssertEqual(PhoneSetupOutcome.skipped.reconciled(with: .notAllowed), .skipped)
    }

    func testOutcomeCopyFollowsTheSpecifiedWording() {
        let places = PlacesSetupStep.copy
        XCTAssertEqual(places.outcomeTitle(.on), "Places is on")
        XCTAssertEqual(places.outcomeTitle(.partial), "Places is on, with limits")
        XCTAssertEqual(places.outcomeTitle(.notAllowed), "Places is off")
        XCTAssertEqual(
            places.outcomeBody(.notAllowed),
            "You can allow location access for Omnesis in Settings any time."
        )
        XCTAssertEqual(places.outcomeTitle(.choiceRequired(.exclusive)), "Another device already sends Places")
        XCTAssertEqual(places.outcomeBody(.failed(message: nil)), "Something went wrong. Nothing was changed.")
        XCTAssertEqual(PhotosSetupStep.copy.outcomeBody(.limited), "Omnesis can read the photos you chose.")
        XCTAssertEqual(PhotosSetupStep.copy.outcomeTitle(.limited), "Photos are on")
        XCTAssertEqual(PhotosSetupStep.copy.outcomeTitle(.notAllowed), "Photos are off")
        XCTAssertEqual(
            MovementSetupStep.copy.outcomeBody(.unavailable(reason: PhoneSetupCopy.notAvailableReason)),
            "This iPhone can't report motion activity."
        )

        let notifications = NotificationsSetupStep.copy
        XCTAssertEqual(notifications.outcomeTitle(.on), "Notifications are on")
        XCTAssertEqual(notifications.outcomeTitle(.notAllowed), "Notifications are off")
        XCTAssertEqual(notifications.outcomeBody(.notAllowed), "You can turn them on in Settings any time.")
    }

    // MARK: - Notification prompting

    func testOnlyADecidedNotificationPermissionRegistersOrWarnsOnHome() {
        XCTAssertFalse(PushDeliveryHealth.notDetermined.registersPushTokenAutomatically)
        XCTAssertFalse(PushDeliveryHealth.notDetermined.raisesHomeAttention)
        for health in [PushDeliveryHealth.ok, .permissionDenied, .scheduledSummary, .alertsOff] {
            XCTAssertTrue(health.registersPushTokenAutomatically, "\(health)")
        }
        XCTAssertTrue(PushDeliveryHealth.permissionDenied.raisesHomeAttention)
        XCTAssertFalse(PushDeliveryHealth.ok.raisesHomeAttention)
        XCTAssertEqual(PushDeliveryHealth.notDetermined.setupPermission, .notDetermined)
        XCTAssertEqual(PushDeliveryHealth.permissionDenied.setupPermission, .denied)
        XCTAssertEqual(PushDeliveryHealth.alertsOff.setupPermission, .authorized)
    }

    // MARK: - Groundwork

    func testHealthCategoriesScopeTheCatalogAndMoodStartsOff() {
        let defaults = TypeCatalog.entries(in: HealthSettings.defaultEnabledCategories)
        XCTAssertFalse(defaults.isEmpty)
        XCTAssertFalse(defaults.contains { $0.category == .mood })
        XCTAssertTrue(TypeCatalog.entries(in: []).isEmpty)
        XCTAssertTrue(TypeCatalog.entries(in: [.sleep]).allSatisfy { $0.category == .sleep })
        XCTAssertTrue(HealthCategory.mood.requiresConsent)
        XCTAssertFalse(HealthCategory.sleep.requiresConsent)
    }

    func testLimitedPhotosIsInformationalInTheAppButReportedUnchanged() throws {
        let report = PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)
        let library = report.capabilities[0]
        XCTAssertEqual(library.state, .permissionDegraded)
        XCTAssertEqual(library.presentation, .informational)
        XCTAssertEqual(report.degradedCapabilities.map(\.id), ["photo-library"])
        XCTAssertTrue(report.attentionCapabilities.isEmpty)
        XCTAssertEqual(
            PhotosPermissionHealth.report(access: .denied, backgroundRefresh: .available).attentionCapabilities.map(\.id),
            ["photo-library"]
        )

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(library)) as? [String: Any]
        XCTAssertEqual(
            encoded.map { Set($0.keys) },
            ["id", "state", "requirement", "label", "impact", "remediation", "repairAction"]
        )
    }

    // MARK: - Live status

    private func localStatus(state: String, lastSyncAt: String?) -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: PhotosSetupStep.sourceId,
            deviceId: device,
            state: state,
            unitName: nil,
            progress: nil,
            startedAt: nil,
            lastSyncAt: lastSyncAt,
            errorMessage: nil,
            erroredAt: nil,
            lastUpdated: nil
        )
    }

    func testLiveStatusReadsThisDevicesSyncStatus() {
        let syncing = SourceSyncStatus(
            sourceId: PhotosSetupStep.sourceId,
            deviceId: device,
            state: "syncing",
            unitName: "photos",
            progress: .init(phase: nil, total: 400, processed: 100, percentComplete: nil, message: nil),
            startedAt: nil,
            lastSyncAt: nil,
            errorMessage: nil,
            erroredAt: nil,
            lastUpdated: nil
        )
        let live = PhoneSetupLiveStatus(syncing)
        XCTAssertEqual(live.line, "100 photos processed", "a count wins over the headline")
        XCTAssertEqual(live.kind, .syncing)
        XCTAssertEqual(live.fraction, 0.25)

        let never = PhoneSetupLiveStatus(nil)
        XCTAssertEqual(never.line, "Not synced yet")
        XCTAssertEqual(never.kind, .notSynced)
        XCTAssertNil(never.fraction)

        let synced = localStatus(state: "synced", lastSyncAt: "2026-03-14T10:00:00Z")
        XCTAssertEqual(PhoneSetupLiveStatus(synced).line, "Up to date")
        XCTAssertEqual(PhoneSetupLiveStatus(synced).kind, .upToDate)
        XCTAssertEqual(PhoneSetupLiveStatus(localStatus(state: "error", lastSyncAt: nil)).kind, .attention)
        XCTAssertEqual(PhoneSetupLiveStatus(localStatus(state: "needs-auth", lastSyncAt: nil)).line, "Needs authorization")
    }
}
