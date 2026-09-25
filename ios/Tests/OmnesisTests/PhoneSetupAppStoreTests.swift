// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

#if canImport(UIKit)
/// Phone setup as the running app sees it: offered once a pairing's gateway
/// client exists, skipped for a device that already hosts a source, and never
/// preceded by an automatic notification prompt.
@MainActor
final class PhoneSetupAppStoreTests: XCTestCase {
    private let deviceId = "11111111-1111-4111-8111-111111111111"
    /// Nothing listens here, so a request the runtime makes fails at once.
    private let gatewayURL = "https://127.0.0.1:9"
    /// Movement and Places keep their switches in the shared defaults.
    private let sharedKeys = [ActivitySegmentsSettings.Keys.enabled, CoreLocationVisitsSettings.Keys.enabled]
    private var savedSharedValues: [String: Any] = [:]

    override func setUp() {
        super.setUp()
        savedSharedValues = [:]
        for key in sharedKeys {
            if let value = UserDefaults.standard.object(forKey: key) {
                savedSharedValues[key] = value
            }
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    override func tearDown() {
        for key in sharedKeys {
            if let value = savedSharedValues[key] {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        super.tearDown()
    }

    func testFreshPairingOffersPhoneSetupOnceTheGatewayClientExists() async throws {
        let progress = DictionaryDefaults()
        let store = try makeStore(progress: progress)

        await store.awaitPairingRuntimeForTesting()

        XCTAssertNotNil(store.admin)
        XCTAssertEqual(store.phoneSetup.presentation, .firstRun)
        XCTAssertTrue(store.phoneSetup.isGateActive)
        XCTAssertEqual(store.phoneSetup.flow.screen, .connected)
        XCTAssertNil(PhoneSetupProgressStore(defaults: progress).completedForDeviceId)
    }

    func testDeviceAlreadyHostingASourceIsMarkedSetUpWithoutShowing() async throws {
        let progress = DictionaryDefaults()
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        let store = try makeStore(health: health, progress: progress)
        XCTAssertTrue(store.phoneSetup.isGateActive, "the gate holds while setup may still appear")

        await store.awaitPairingRuntimeForTesting()

        XCTAssertNil(store.phoneSetup.presentation)
        XCTAssertFalse(store.phoneSetup.isGateActive)
        XCTAssertEqual(PhoneSetupProgressStore(defaults: progress).completedForDeviceId, deviceId)
    }

    func testForegroundAndLaunchNeverShowTheNotificationPrompt() async throws {
        let center = RecordingNotificationPermissionCenter(health: .notDetermined)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)

        store.bindAppDelegate(OmnesisAppDelegate())
        await store.onActive()

        let requests = await center.requests
        XCTAssertEqual(requests, 0)
    }

    func testRegistrationProceedsOnceNotificationsAreAllowed() async throws {
        let center = RecordingNotificationPermissionCenter(health: .ok)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)

        await store.requestPushAndRegister()

        let requests = await center.requests
        XCTAssertEqual(requests, 0)
        XCTAssertTrue(store.acceptPushTokenCallback(), "a token callback is expected after registering")
    }

    func testUnpairForgetsSetupProgressAndSourceIssues() async throws {
        let progress = DictionaryDefaults()
        let progressStore = PhoneSetupProgressStore(defaults: progress)
        progressStore.completedForDeviceId = deviceId
        progressStore.saveProgress(savedRun(), deviceId: deviceId)
        let store = try makeStore(progress: progress)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)
        store.localSourceActivator.installPreviewIssues([PhotosSetupStep.sourceId: "Something went wrong."])

        await store.unpair()

        XCTAssertNil(progressStore.completedForDeviceId)
        XCTAssertNil(progressStore.progress(for: deviceId))
        XCTAssertTrue(store.localSourceEnableIssues.isEmpty)
        XCTAssertNil(store.phoneSetup.presentation)
        XCTAssertFalse(store.phoneSetup.isGateActive)
    }

    func testPairingTheSameDeviceAgainAfterSetupNeitherHoldsNorPresents() async throws {
        let progress = DictionaryDefaults()
        PhoneSetupProgressStore(defaults: progress).completedForDeviceId = deviceId
        let exchange = StubExchange()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: deviceId, name: "Fictional iPhone", kind: "ios"),
            tokenId: "generation_fictional",
            token: "omn_fictional",
            scopes: ["admin"]
        ))
        let store = try makeStore(progress: progress, exchange: exchange)
        await store.awaitPairingRuntimeForTesting()
        XCTAssertFalse(store.phoneSetup.isGateActive)

        await store.pairAsync(raw: "{\"v\":2,\"gatewayUrl\":\"\(gatewayURL)\",\"pairingCode\":\"AA-BB\"}")
        XCTAssertFalse(store.phoneSetup.isGateActive, "a device that has been through setup is never held")
        await store.awaitPairingRuntimeForTesting()

        XCTAssertEqual(store.pairing?.deviceId, deviceId)
        XCTAssertNil(store.phoneSetup.presentation)
        XCTAssertFalse(store.phoneSetup.isGateActive)
    }

    func testASavedRunResumesEvenThoughItTurnedASourceOn() async throws {
        let progress = DictionaryDefaults()
        PhoneSetupProgressStore(defaults: progress).saveProgress(savedRun(), deviceId: deviceId)
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        let store = try makeStore(health: health, progress: progress)

        await store.awaitPairingRuntimeForTesting()

        XCTAssertEqual(store.phoneSetup.presentation, .firstRun)
        XCTAssertEqual(store.phoneSetup.flow.selection, [AppleHealthSetupStep.sourceId])
        XCTAssertNil(PhoneSetupProgressStore(defaults: progress).completedForDeviceId)
    }

    // MARK: - A new pairing starts clean

    private var otherDeviceId: String {
        "22222222-2222-4222-8222-222222222222"
    }

    private func exchangeIssuing(_ id: String) -> StubExchange {
        let exchange = StubExchange()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: id, name: "Fictional iPhone", kind: "ios"),
            tokenId: "generation_fictional",
            token: "omn_fictional",
            scopes: ["admin"]
        ))
        return exchange
    }

    private var pairingPayload: String {
        "{\"v\":2,\"gatewayUrl\":\"\(gatewayURL)\",\"pairingCode\":\"AA-BB\"}"
    }

    func testPairingANewDeviceClearsSwitchesLeftFromAnotherPairing() async throws {
        let progress = DictionaryDefaults()
        PhoneSetupProgressStore(defaults: progress).completedForDeviceId = otherDeviceId
        let owner = DictionaryDefaults(values: [LocalSourceOwnerRecord.key: otherDeviceId])
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        UserDefaults.standard.set(true, forKey: ActivitySegmentsSettings.Keys.enabled)
        let store = try makeStore(
            health: health,
            progress: progress,
            exchange: exchangeIssuing(deviceId),
            owner: owner,
            paired: false
        )
        await store.awaitPairingRuntimeForTesting()
        XCTAssertTrue(store.appleHealthEnabled, "nothing changes while unpaired")

        await store.pairAsync(raw: pairingPayload)

        XCTAssertFalse(store.appleHealthEnabled)
        XCTAssertFalse(store.activitySegmentsEnabled)
        XCTAssertTrue(store.enabledLocalSourceIds().isEmpty)
        XCTAssertTrue(store.localSourceActivator.pendingRegistrations.isEmpty, "nothing is registered")
        XCTAssertEqual(LocalSourceOwnerRecord(defaults: owner).deviceId, deviceId)
        XCTAssertNil(PhoneSetupProgressStore(defaults: progress).completedForDeviceId)
        XCTAssertEqual(store.phoneSetup.presentation, .firstRun, "setup shows as on a fresh app")
    }

    func testUnpairingThenPairingTheSameDeviceAgainShowsSetupInPlaceOfHome() async throws {
        let progress = DictionaryDefaults()
        let store = try makeStore(progress: progress, exchange: exchangeIssuing(deviceId))
        try await bounded(.seconds(20)) { await store.awaitPairingRuntimeForTesting() }
        XCTAssertEqual(store.phoneSetup.presentation, .firstRun)
        store.phoneSetup.complete()
        XCTAssertEqual(PhoneSetupProgressStore(defaults: progress).completedForDeviceId, deviceId)
        installStubAdmin(on: store)

        try await bounded(.seconds(20)) { await store.unpair() }
        try await bounded(.seconds(20)) { await store.pairAsync(raw: self.pairingPayload) }
        try await bounded(.seconds(20)) { await store.awaitPairingRuntimeForTesting() }

        XCTAssertEqual(store.pairing?.deviceId, deviceId, "the gateway gives this install its device back")
        XCTAssertEqual(store.phoneSetup.presentation, .firstRun, "unpairing forgot that the device finished setup")
        XCTAssertEqual(
            RootScreen.choose(isPaired: store.pairing != nil, setupPresentation: store.phoneSetup.presentation),
            .setup
        )
    }

    func testRepairingTheSameDeviceKeepsSetupFinished() async throws {
        let progress = DictionaryDefaults()
        let store = try makeStore(progress: progress, exchange: exchangeIssuing(deviceId))
        try await bounded(.seconds(20)) { await store.awaitPairingRuntimeForTesting() }
        store.phoneSetup.complete()
        installStubAdmin(on: store)

        try await bounded(.seconds(20)) { await store.beginRepair() }
        try await bounded(.seconds(20)) { await store.pairAsync(raw: self.pairingPayload) }
        try await bounded(.seconds(20)) { await store.awaitPairingRuntimeForTesting() }

        XCTAssertEqual(store.pairing?.deviceId, deviceId)
        XCTAssertNil(store.phoneSetup.presentation)
        XCTAssertEqual(PhoneSetupProgressStore(defaults: progress).completedForDeviceId, deviceId)
        XCTAssertEqual(
            RootScreen.choose(isPaired: store.pairing != nil, setupPresentation: store.phoneSetup.presentation),
            .home
        )
    }

    func testSwitchesWithNoRecordedPairingAreClearedWhenPairing() async throws {
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        let owner = DictionaryDefaults()
        let store = try makeStore(
            health: health,
            progress: DictionaryDefaults(),
            exchange: exchangeIssuing(deviceId),
            owner: owner,
            paired: false
        )
        await store.awaitPairingRuntimeForTesting()

        await store.pairAsync(raw: pairingPayload)

        XCTAssertFalse(store.appleHealthEnabled)
        XCTAssertEqual(LocalSourceOwnerRecord(defaults: owner).deviceId, deviceId)
    }

    func testPairingTheSameDeviceAgainKeepsItsSwitches() async throws {
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        let owner = DictionaryDefaults(values: [LocalSourceOwnerRecord.key: deviceId])
        let store = try makeStore(
            health: health,
            progress: DictionaryDefaults(),
            exchange: exchangeIssuing(deviceId),
            owner: owner,
            paired: false
        )
        await store.awaitPairingRuntimeForTesting()

        await store.pairAsync(raw: pairingPayload)

        XCTAssertTrue(store.appleHealthEnabled)
        XCTAssertEqual(LocalSourceOwnerRecord(defaults: owner).deviceId, deviceId)
    }

    func testALaunchWithAPairingKeepsItsSwitchesAndRecordsTheirOwner() async throws {
        let health = HealthSettings(defaults: DictionaryDefaults(values: [HealthSettings.Keys.appleHealthEnabled: true]))
        let owner = DictionaryDefaults()
        let store = try makeStore(health: health, progress: DictionaryDefaults(), owner: owner)

        await store.awaitPairingRuntimeForTesting()

        XCTAssertTrue(store.appleHealthEnabled)
        XCTAssertEqual(LocalSourceOwnerRecord(defaults: owner).deviceId, deviceId)
    }

    // MARK: - Decided permissions show no prompt

    func testTurningOnNotificationsThatAreAlreadyAllowedShowsNoPrompt() async throws {
        let center = RecordingNotificationPermissionCenter(health: .ok)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)
        let step = try XCTUnwrap(store.phoneSetup.step(id: NotificationsSetupStep.stepId))
        let promptsBefore = SystemPromptActivity.shared.promptsShown

        let outcome = await step.enable(choice: nil)

        XCTAssertEqual(outcome, .on)
        XCTAssertEqual(SystemPromptActivity.shared.promptsShown, promptsBefore, "a decided permission never waits on a prompt")
    }

    func testGrantingNotificationsInSetupStartsPushRegistrationStraightAway() async throws {
        let center = RecordingNotificationPermissionCenter(health: .notDetermined, afterRequest: .ok)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)
        let step = try XCTUnwrap(store.phoneSetup.step(id: NotificationsSetupStep.stepId))

        _ = await step.enable(choice: nil)

        XCTAssertTrue(
            store.acceptPushTokenCallback(),
            "registration starts with the grant, so a relay request can arrive before Finish"
        )
    }

    func testTurningOnUndecidedNotificationsCountsItsPrompt() async throws {
        let center = RecordingNotificationPermissionCenter(health: .notDetermined, afterRequest: .ok)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()
        installStubAdmin(on: store)
        let step = try XCTUnwrap(store.phoneSetup.step(id: NotificationsSetupStep.stepId))
        let promptsBefore = SystemPromptActivity.shared.promptsShown

        let outcome = await step.enable(choice: nil)

        XCTAssertEqual(outcome, .on)
        XCTAssertEqual(SystemPromptActivity.shared.promptsShown, promptsBefore + 1)
    }

    func testRegisteringForPushesNeverShowsTheNotificationPrompt() async throws {
        let center = RecordingNotificationPermissionCenter(health: .notDetermined)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()

        await store.requestPushAndRegister()

        let requests = await center.requests
        XCTAssertEqual(requests, 0)
        XCTAssertEqual(store.pushDeliveryHealth, .notDetermined)
        XCTAssertEqual(store.notificationPermission, .notDetermined)
    }

    func testAskingForNotificationsShowsThePromptOnceAndReadsTheAnswer() async throws {
        let center = RecordingNotificationPermissionCenter(health: .notDetermined, afterRequest: .ok)
        let store = try makeStore(progress: DictionaryDefaults(), notifications: center)
        await store.awaitPairingRuntimeForTesting()

        let allowed = await store.requestNotificationPermission()

        let requests = await center.requests
        XCTAssertTrue(allowed)
        XCTAssertEqual(requests, 1)
        XCTAssertEqual(store.notificationPermission, .authorized)
    }

    /// A run that chose Apple Health and turned it on.
    private func savedRun() -> PhoneSetupFlow {
        var flow = PhoneSetupFlow(includesConnected: true)
        flow.showChoose()
        flow.toggle(AppleHealthSetupStep.sourceId, order: [AppleHealthSetupStep.sourceId])
        flow.startSteps()
        flow.record(.on, for: AppleHealthSetupStep.sourceId)
        return flow
    }

    private func installStubAdmin(on store: AppStore) {
        guard let url = URL(string: gatewayURL) else { return }
        store.injectAdminClientForTesting(AdminClient(baseURL: url, token: "omn_fictional", session: UnavailableGateway()))
    }

    private func makeStore(
        health: HealthSettings = HealthSettings(defaults: DictionaryDefaults()),
        progress: DictionaryDefaults,
        notifications: RecordingNotificationPermissionCenter = RecordingNotificationPermissionCenter(),
        exchange: StubExchange = StubExchange(),
        owner: DictionaryDefaults = DictionaryDefaults(),
        paired: Bool = true
    ) throws
        -> AppStore {
        let keychain = InMemoryStore()
        let credential = PairingCredentialBundle(
            url: gatewayURL,
            token: "omn_fictional",
            accountId: "local",
            deviceId: deviceId,
            name: "Fictional Gateway",
            scopes: ["admin"],
            tlsMode: PairingTlsMode.system.rawValue,
            fingerprint: nil
        )
        if paired {
            try keychain.set(credential.encoded(), forKey: PairingCredentialBundle.key)
        }
        return AppStore(
            service: PairingService(store: keychain, exchange: exchange, pinnedExchangeBuilder: { _ in nil }),
            healthSettings: health,
            photosSettings: PhotosSettings(defaults: DictionaryDefaults()),
            foregroundConversationStore: ForegroundConversationStore(),
            phoneSetupProgress: PhoneSetupProgressStore(defaults: progress),
            notificationPermissions: notifications,
            localSourceActivator: LocalSourceActivator(defaults: DictionaryDefaults()),
            localSourceOwner: LocalSourceOwnerRecord(defaults: owner)
        )
    }
}

/// A gateway that answers every request as unavailable.
private final class UnavailableGateway: URLSessionLike, @unchecked Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let response = try XCTUnwrap(
            HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 503, httpVersion: nil, headerFields: nil)
        )
        return (Data(), response)
    }
}

/// Answers notification settings from a script and counts prompt requests.
private actor RecordingNotificationPermissionCenter: NotificationPermissionCenter {
    private var health: PushDeliveryHealth
    private let afterRequest: PushDeliveryHealth
    private(set) var requests = 0

    init(health: PushDeliveryHealth = .notDetermined, afterRequest: PushDeliveryHealth = .ok) {
        self.health = health
        self.afterRequest = afterRequest
    }

    func deliveryHealth() async -> PushDeliveryHealth {
        health
    }

    func requestAuthorization() async throws -> Bool {
        requests += 1
        health = afterRequest
        return afterRequest.setupPermission == .authorized
    }
}
#endif
