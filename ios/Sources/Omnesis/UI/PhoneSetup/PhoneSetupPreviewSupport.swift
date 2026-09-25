// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit) && DEBUG
import SwiftUI

/// An observable stand-in for the app behind setup, so previews and snapshots
/// render every page and outcome without HealthKit, Core Location, Photos or a
/// gateway. Turning a step on succeeds with full access.
@MainActor
@Observable
final class PhoneSetupPreviewHost: PhoneSetupHosting {
    var pairedGatewayHost: String? = "gateway.example.com"
    var statuses: [String: PhoneSetupLiveStatus] = [:]

    var appleHealthEnabled = false
    var healthDataAvailable = true
    var enabledCategories = HealthSettings.defaultEnabledCategories
    var coreLocationVisitsEnabled = false
    var locationVisitsPermission = LocationVisitsPermissionState.notDetermined
    var photosEnabled = false
    var photosAccess = PhotosAccessState.notDetermined
    var activitySegmentsEnabled = false
    var motionActivityPermission = ActivitySegmentsPermissionState.notDetermined
    var notificationPermission = PhoneSetupNotificationPermission.notDetermined
    var relayPushConsentRequest: RelayPushConsentRequest?
    var backgroundRefreshStatus = BackgroundRefreshPermissionState.available
    var isLowPowerModeEnabled = false

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

    func enableAppleHealth(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        appleHealthEnabled = true
        return .enabled(.full)
    }

    func enableCoreLocationVisits(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        coreLocationVisitsEnabled = true
        locationVisitsPermission = .always
        return .enabled(.full)
    }

    func requestLocationVisitsPermission() async -> LocationVisitsPermissionState {
        locationVisitsPermission = .always
        return .always
    }

    func enablePhotos(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        photosEnabled = true
        photosAccess = .full
        return .enabled(.full)
    }

    func enableActivitySegments(activationChoice _: MobileSourceActivationChoice?) async -> MobileSourceEnableResult {
        activitySegmentsEnabled = true
        motionActivityPermission = .authorized
        return .enabled(.full)
    }

    func refreshPushDeliveryHealth() async {}

    func requestNotificationPermission() async -> Bool {
        notificationPermission = .authorized
        return true
    }

    func allowRelayPush(_: RelayPushConsentRequest) async throws {
        relayPushConsentRequest = nil
    }

    func dismissRelayPushConsent(_: RelayPushConsentRequest) {
        relayPushConsentRequest = nil
    }
}

@MainActor
enum PhoneSetupPreview {
    /// Steps hold their host unowned, so every host a preview creates lives
    /// for the rest of the process.
    private static var hosts: [PhoneSetupPreviewHost] = []

    /// A relay-consent request for an invented gateway.
    static var relayConsentRequest: RelayPushConsentRequest? {
        guard let url = URL(string: "https://gateway.example.com") else { return nil }
        return RelayPushConsentRequest(
            pairing: Pairing(
                url: url,
                token: "omn_preview",
                accountId: "preview-account",
                deviceId: "dev_iphone",
                gatewayName: "Preview Gateway"
            ),
            appId: PreviewMocks.relayPushAppId
        )
    }

    /// A coordinator showing `screen` over `host`, with `selection` chosen and
    /// `outcomes` recorded, as if the user had navigated there.
    static func coordinator(
        host: PhoneSetupPreviewHost? = nil,
        screen: PhoneSetupScreen,
        selection: [String] = [],
        outcomes: [String: PhoneSetupOutcome] = [:],
        busyStepId: String? = nil,
        presentation: PhoneSetupCoordinator.Presentation = .firstRun
    )
        -> PhoneSetupCoordinator {
        let host = host ?? PhoneSetupPreviewHost()
        hosts.append(host)
        let coordinator = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: DictionaryDefaults()))
        coordinator.install(host: host, steps: PhoneSetupRegistry.ios(host: host))
        var flow = PhoneSetupFlow(includesConnected: true)
        if screen != .connected {
            flow.showChoose()
        }
        let order = coordinator.steps.map(\.id)
        for id in selection {
            flow.toggle(id, order: order)
        }
        for (id, outcome) in outcomes {
            flow.record(outcome, for: id)
        }
        switch screen {
        case .connected, .choose:
            break
        case .step(let index):
            flow.startSteps()
            for _ in 0 ..< index {
                flow.advance()
            }
        case .finish:
            flow.startSteps()
            for _ in flow.selection {
                flow.advance()
            }
        }
        coordinator.installPreview(flow: flow, presentation: presentation, busyStepId: busyStepId)
        return coordinator
    }

    static func view(
        host: PhoneSetupPreviewHost? = nil,
        screen: PhoneSetupScreen,
        selection: [String] = [],
        outcomes: [String: PhoneSetupOutcome] = [:]
    )
        -> some View {
        PhoneSetupView(
            coordinator: coordinator(host: host, screen: screen, selection: selection, outcomes: outcomes)
        )
        .omnesisColorScheme()
    }
}
#endif
