// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

/// Presentation priority only; readiness and collection admission remain in the store.
@MainActor
enum DesktopSetupRepair: Equatable {
    case installation, background, connection, startup, power, storage, route, access, sources, devices

    static func first(in store: DesktopStore) -> Self? {
        if store.applicationOwnership?.installation == .recoveredVersionInstallNeeded { return .installation }
        if store.backgroundStartupBlock != nil { return .background }
        if !store.installationIdentityReady || !store.nativeOwnerReady { return .connection }
        if !store.automaticStartup.ready { return .startup }
        if store.state.mode == "home" {
            if !store.serverPower.ready { return .power }
            if [.blocked, .unavailable].contains(store.homeServices.storage) { return .storage }
            if [.blocked, .unavailable].contains(store.homeServices.route) { return .route }
        }
        if !store.sourceAccessReady, !store.localCollectionSources.isEmpty { return .access }
        if !store.sourceConnectionsReady { return .sources }
        if !store.localCollectionIdentityReady { return .devices }
        return nil
    }

    static func bannerTitle(in store: DesktopStore) -> String {
        guard let repair = first(in: store) else {
            return store.requiredSetupNeedsAction ? "Required settings need checking" : "Checking required settings"
        }
        switch repair {
        case .installation: return "Finish installing the recovered app"
        case .background: return "Background connection needs attention"
        case .connection: return "Checking this copy of Omnesis"
        case .startup:
            if store.automaticStartup.working { return "Checking automatic startup" }
            switch store.automaticStartup.status {
            case .needsCheck, .enabled: return "Checking automatic startup"
            case .disabled: return "Automatic startup is required"
            case .approvalRequired: return "Approve automatic startup in Settings"
            case .unavailable: return "Automatic startup needs checking"
            }
        case .power:
            switch store.serverPower.status {
            case .needed, .checking, .ready: return "Checking this Mac’s power settings"
            case .sleepEnabled: return "Keep this Mac awake for your library"
            case .onBattery: return "Connect this Mac to power"
            case .unavailable: return "Power settings need checking"
            }
        case .storage:
            return store.homeServices.storage == .blocked ? "Collection needs more storage" : "Storage needs checking"
        case .route: return "Your library’s remote connection needs checking"
        case .access:
            if store.sourceMetadataFailure != nil { return "Collection access needs checking" }
            guard store.collectionAccess.context == store.permissionContext else { return "Checking collection access" }
            let observations = store.collectionAccess.flows.values
            if observations.contains(where: { $0.memberAccessProblem || $0.unresolvedDenial || $0.state == .denied }) {
                return "Collection access needs attention"
            }
            if observations.contains(where: { [.unavailable, .unsupported].contains($0.state) }) {
                return "Collection access needs checking"
            }
            return "Checking collection access"
        case .sources:
            return store.collectionHealth.loaded && store.collectionHealth.failure == nil
                ? "Source collection needs attention" : "Collection status needs checking"
        case .devices:
            return store.sourcesLoaded ? "This computer’s collection connection needs checking" : "Checking this computer’s collection connection"
        }
    }
}
