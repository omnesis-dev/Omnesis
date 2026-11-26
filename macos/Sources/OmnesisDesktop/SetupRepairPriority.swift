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
}
