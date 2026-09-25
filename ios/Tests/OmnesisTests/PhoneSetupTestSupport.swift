// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A scriptable stand-in for the app behind every setup step. Each source's
/// enable call returns the scripted result and, when that result turns the
/// source on, updates the switch and permission the real app would.
@MainActor
final class FakePhoneSetupHost: PhoneSetupHosting {
    var pairedGatewayHost: String? = "gateway.example.com"
    var statuses: [String: PhoneSetupLiveStatus] = [:]

    var appleHealthEnabled = false
    var healthDataAvailable = true
    var enabledCategories = HealthSettings.defaultEnabledCategories
    var appleHealthResult: MobileSourceEnableResult = .enabled(.full)
    private(set) var appleHealthChoices: [MobileSourceActivationChoice?] = []

    var coreLocationVisitsEnabled = false
    var locationVisitsPermission: LocationVisitsPermissionState = .notDetermined
    var placesResult: MobileSourceEnableResult = .enabled(.full)

    var photosEnabled = false
    var photosAccess: PhotosAccessState = .notDetermined
    var photosResult: MobileSourceEnableResult = .enabled(.full)
    /// Holds `enablePhotos` until `releaseHeldEnable()`, like an iOS prompt left up.
    var holdsPhotosEnable = false
    private(set) var isHoldingEnable = false
    private var heldEnable: CheckedContinuation<Void, Never>?
    /// Whether the held Photos enable was cancelled by the time it resumed.
    private(set) var enableSawCancellation = false

    var activitySegmentsEnabled = false
    var motionActivityPermission: ActivitySegmentsPermissionState = .notDetermined
    var movementResult: MobileSourceEnableResult = .enabled(.full)

    var notificationPermission: PhoneSetupNotificationPermission = .notDetermined
    var relayPushConsentRequest: RelayPushConsentRequest?
    var backgroundRefreshStatus = BackgroundRefreshPermissionState.available
    var isLowPowerModeEnabled = false
    var notificationGrant = true
    private(set) var pushDeliveryRefreshes = 0

    func liveStatus(sourceId: String) -> PhoneSetupLiveStatus? {
        statuses[sourceId]
    }

    var enableIssues: [String: String] = [:]

    func enableIssue(sourceId: String) -> String? {
        enableIssues[sourceId]
    }

    func setCategory(_ category: HealthCategory, enabled: Bool) {
        if enabled {
            enabledCategories.insert(category)
        } else {
            enabledCategories.remove(category)
        }
    }

    func enableAppleHealth(activationChoice: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        appleHealthChoices.append(activationChoice)
        if case .enabled = appleHealthResult {
            appleHealthEnabled = true
        }
        return appleHealthResult
    }

    func enableCoreLocationVisits(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        if case .enabled(let grant) = placesResult {
            coreLocationVisitsEnabled = true
            locationVisitsPermission = grant == .foregroundOnly ? .whenInUse : .always
        }
        return placesResult
    }

    func releaseHeldEnable() {
        isHoldingEnable = false
        heldEnable?.resume()
        heldEnable = nil
    }

    func requestLocationVisitsPermission() async -> LocationVisitsPermissionState {
        locationVisitsPermission = .always
        return .always
    }

    func enablePhotos(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        if holdsPhotosEnable {
            isHoldingEnable = true
            await withCheckedContinuation { heldEnable = $0 }
            enableSawCancellation = Task.isCancelled
        }
        if case .enabled(let grant) = photosResult {
            photosEnabled = true
            photosAccess = grant == .limited ? .limited : .full
        }
        return photosResult
    }

    func enableActivitySegments(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        if case .enabled = movementResult {
            activitySegmentsEnabled = true
            motionActivityPermission = .authorized
        }
        return movementResult
    }

    func refreshPushDeliveryHealth() async {
        pushDeliveryRefreshes += 1
    }

    func requestNotificationPermission() async -> Bool {
        notificationPermission = notificationGrant ? .authorized : .denied
        return notificationGrant
    }

    func allowRelayPush(_: RelayPushConsentRequest) async throws {}

    func dismissRelayPushConsent(_: RelayPushConsentRequest) {}
}

/// Waits until `condition` holds, for at most `timeout`. Returns false on
/// timeout, so a test fails instead of hanging.
/// A wait that ran past its deadline.
@MainActor
struct BoundedWaitTimedOut: Error {}

/// Runs `operation`, throwing instead of hanging when it hasn't finished
/// within `timeout`, so a regression fails the test rather than the lane.
@MainActor
func bounded(_ timeout: Duration = .seconds(5), _ operation: @escaping @MainActor () async throws -> Void) async throws {
    final class Once {
        var resumed = false
    }
    let once = Once()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let work = Task { @MainActor in
            do {
                try await operation()
                guard !once.resumed else { return }
                once.resumed = true
                continuation.resume()
            } catch {
                guard !once.resumed else { return }
                once.resumed = true
                continuation.resume(throwing: error)
            }
        }
        Task { @MainActor in
            try? await Task.sleep(for: timeout)
            guard !once.resumed else { return }
            once.resumed = true
            work.cancel()
            continuation.resume(throwing: BoundedWaitTimedOut())
        }
    }
}

func eventually(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        guard ContinuousClock.now < deadline else { return false }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return true
}
