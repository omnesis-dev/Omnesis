// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)

/// Which pairing the phone's local source state belongs to, and clearing it.
@available(iOS 17.0, *)
extension AppStore {
    /// Clears every phone source's local switch, its pending gateway intents
    /// and background work, and the setup record, as unpairing does.
    func resetLocalSourceOptIns() {
        healthSettings.reset()
        activitySegmentsSettings.reset()
        coreLocationVisitsSettings.reset()
        photosSettings.reset()
        phoneSetup.resetForUnpair()
        pendingLocalSourceDepartures = []
        pendingLocalSourceResumes = []
        localSourceActionIds.removeAll()
        appleHealthEnabled = false
        enabledCategories = HealthSettings.defaultEnabledCategories
        activitySegmentsEnabled = false
        coreLocationVisitsEnabled = false
        photosEnabled = false
        localSourceActivator.reset()
    }

    /// A pairing whose device id is not the one local source state was kept
    /// for starts clean before its session is built, so switches left from
    /// another gateway neither skip setup nor stay on unregistered. Pairing
    /// the same id again, as a repair does, keeps them. Permissions iOS has
    /// granted stay granted.
    func claimLocalSources(for pairing: Pairing) {
        guard localSourceOwner.belongsToAnotherDevice(than: pairing.deviceId) else { return }
        resetLocalSourceOptIns()
        permissionHealthCoordinator.reset()
        #if os(iOS) && canImport(CoreLocation)
        // Visit monitoring stops before its buffer is cleared, so no visit
        // recorded for the previous pairing lands after the reset.
        visitProvider?.stop()
        visitProvider = nil
        VisitStore().reset()
        #endif
        localSourceOwner.deviceId = pairing.deviceId
    }
}
#endif
