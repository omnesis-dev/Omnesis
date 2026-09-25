// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Everything the iPhone's setup steps need from the app.
public typealias PhoneSetupHosting = AppleHealthSetupHost
    & BackgroundRefreshSetupHost
    & MovementSetupHost
    & NotificationsSetupHost
    & PhoneSetupHost
    & PhotosSetupHost
    & PlacesSetupHost

/// The only central list of setup steps. Each entry's copy and behaviour is
/// declared beside its source.
public enum PhoneSetupRegistry {
    /// Every step the iPhone offers, in the order a run shows them. Choose
    /// lists all but the automatic ones, which the flow adds in this order
    /// when a run calls for them.
    @MainActor
    public static func ios(host: any PhoneSetupHosting) -> [any PhoneSetupStep] {
        [
            AppleHealthSetupStep(host: host),
            PlacesSetupStep(host: host),
            PhotosSetupStep(host: host),
            MovementSetupStep(host: host),
            BackgroundRefreshSetupStep(host: host),
            NotificationsSetupStep(host: host),
            RelayConsentSetupStep(host: host),
        ]
    }
}
