// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How every phone-hosted source's own activation steps are put together.
/// Switching a source on only flips its local switch, so the page can show it
/// on straight away. Rebuilding the collector waits for any sync already
/// running, which can take a minute behind a large Apple Health sync, so it
/// belongs to the work that follows once the source is on.
public enum LocalSourceActivationPlan {
    public static func steps(
        authorize: @escaping @MainActor () async -> MobileSourceAuthorization,
        switchOn: @escaping @MainActor () -> Void,
        rebuildCollector: @escaping @MainActor () async -> Void,
        afterRebuild: @escaping @MainActor () async -> Void = {}
    )
        -> MobileSourceActivationSteps {
        MobileSourceActivationSteps(
            authorize: authorize,
            activate: { switchOn() },
            afterActivation: {
                await rebuildCollector()
                await afterRebuild()
            }
        )
    }
}
