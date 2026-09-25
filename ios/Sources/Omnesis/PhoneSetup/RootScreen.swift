// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the app's root shows. First-run setup takes home's place instead of
/// presenting over it, so it never waits on a pairing sheet that is still
/// closing, and nothing home presents can appear behind it.
public enum RootScreen: Equatable, Sendable {
    case onboarding
    case setup
    case home

    /// Onboarding until paired, then setup while its first run is up, then
    /// home. Runs opened from Settings present over home from Settings.
    @available(iOS 17.0, *)
    public static func choose(isPaired: Bool, setupPresentation: PhoneSetupCoordinator.Presentation?) -> RootScreen {
        guard isPaired else { return .onboarding }
        return setupPresentation == .firstRun ? .setup : .home
    }
}
