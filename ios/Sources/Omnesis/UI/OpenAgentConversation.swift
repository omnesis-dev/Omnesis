// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Environment handler that jumps the user into an agent conversation:
/// flips the main-menu section to Agent and resumes the given conversation
/// id. Injected by the app shell (`HomeView`), which owns the section
/// selection; the default nil is only hit by previews and snapshots (the
/// control still renders, the jump simply doesn't happen outside the shell).
/// Mirrors `openModelSettings` in `GatewayErrorView`.
private struct OpenAgentConversationKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    var openAgentConversation: ((String) -> Void)? {
        get { self[OpenAgentConversationKey.self] }
        set { self[OpenAgentConversationKey.self] = newValue }
    }
}
#endif
