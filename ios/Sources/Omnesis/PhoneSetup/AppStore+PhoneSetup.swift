// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)

/// The app store is the host every setup step talks to. Most requirements are
/// members `AppStore` already exposes to Settings; the rest read operating
/// system state the steps need.
@available(iOS 17.0, *)
extension AppStore: PhoneSetupHosting {
    public var pairedGatewayHost: String? {
        pairing?.url.host()
    }

    public func liveStatus(sourceId: String) -> PhoneSetupLiveStatus? {
        // On here, while the collector is rebuilt around the source.
        if localSourceActivator.preparing.contains(sourceId) {
            return PhoneSetupLiveStatus(headline: PhoneSetupLiveStatus.gettingReadyHeadline, kind: .syncing)
        }
        // On here, but the gateway has not accepted and registered it yet.
        if localSourceActivator.pendingRegistrations.contains(sourceId) {
            return PhoneSetupLiveStatus(headline: PhoneSetupLiveStatus.awaitingGatewayHeadline, kind: .notSynced)
        }
        return PhoneSetupLiveStatus(localSyncStatus(sourceId: sourceId))
    }

    public func enableIssue(sourceId: String) -> String? {
        localSourceEnableIssues[sourceId]
    }

    public var healthDataAvailable: Bool {
        #if canImport(HealthKit)
        HealthKitClient.isAvailable
        #else
        false
        #endif
    }

    public var locationVisitsPermission: LocationVisitsPermissionState {
        #if DEBUG
        if let preview = previewPermissions.locationVisits { return preview }
        #endif
        return LocationVisitsAuthorization.current
    }

    public var photosAccess: PhotosAccessState {
        #if DEBUG
        if let preview = previewPermissions.photos { return preview }
        #endif
        return PhotosAuthorization.current
    }

    public func requestLocationVisitsPermission() async -> LocationVisitsPermissionState {
        let permission = await LocationVisitsAuthorization.request()
        await refreshSourcePermissionHealth()
        return permission
    }

    public var backgroundRefreshStatus: BackgroundRefreshPermissionState {
        .current
    }

    public var isLowPowerModeEnabled: Bool {
        ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    public var motionActivityPermission: ActivitySegmentsPermissionState {
        MotionAuthorization.current
    }

    public var notificationPermission: PhoneSetupNotificationPermission {
        pushDeliveryHealth.setupPermission
    }
}

@available(iOS 17.0, *)
extension AppStore {
    /// Holds phone setup's presentation gate for the pairing that just became
    /// current, until `evaluatePhoneSetup(for:)` decides whether setup shows.
    /// Called synchronously, before home can render and present anything.
    func holdPhoneSetupEvaluation() {
        #if DEBUG
        guard !PhoneSetupLaunchEnvironment.suppressesAutomaticPresentation else { return }
        #endif
        guard let pairing else { return }
        phoneSetup.holdForEvaluation(deviceId: pairing.deviceId)
    }

    /// Offers phone setup for `pairing`, once its gateway client exists.
    func evaluatePhoneSetup(for pairing: Pairing) {
        #if DEBUG
        guard !PhoneSetupLaunchEnvironment.suppressesAutomaticPresentation else { return }
        #endif
        phoneSetup.evaluateAutomaticPresentation(
            deviceId: pairing.deviceId,
            anyPhoneSourceEnabled: !enabledLocalSourceIds().isEmpty
        )
    }
}

#if DEBUG
/// UI automation pairs the app from launch arguments and drives the home
/// screen directly, so setup stays out of its way unless a run asks for it
/// with `DEMO_PHONE_SETUP=1`.
enum PhoneSetupLaunchEnvironment {
    static var suppressesAutomaticPresentation: Bool {
        let process = ProcessInfo.processInfo
        guard process.environment["DEMO_PHONE_SETUP"] != "1" else { return false }
        return process.environment["DEMO_PAIRING_JSON"] != nil
            || process.arguments.contains("-pairingFile")
            || process.arguments.contains("-pairingFileName")
    }
}
#endif
#endif
