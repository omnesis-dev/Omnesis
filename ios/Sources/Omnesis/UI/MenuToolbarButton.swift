// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Shared leading-toolbar button that toggles the global side menu
/// (`MainMenuDrawer`). Every top-level section view (Agent, Search,
/// Sources, People, Watches, Settings) plants one of these so the menu
/// is reachable from any surface without depending on the reveal
/// gesture alone.
@available(iOS 17.0, *)
struct MenuToolbarButton: View {
    @Binding var isOpen: Bool

    var body: some View {
        Button {
            withAnimation(MenuReveal.openCloseAnimation) {
                isOpen.toggle()
            }
        } label: {
            Image(systemName: "line.3.horizontal")
                .foregroundStyle(Theme.textPrimary)
        }
        .accessibilityLabel("Menu")
        .accessibilityIdentifier("menu.toggle")
    }
}
#endif
