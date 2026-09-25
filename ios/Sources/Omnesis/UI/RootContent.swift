// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The root's content as `RootScreen` chooses it. Closing first-run setup
/// mounts home, whose appearance asks for anything that waited meanwhile.
@available(iOS 17.0, *)
struct RootContent: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let screen = RootScreen.choose(isPaired: store.pairing != nil, setupPresentation: store.phoneSetup.presentation)
        Group {
            switch screen {
            case .onboarding:
                OnboardingView()
            case .setup:
                PhoneSetupView(coordinator: store.phoneSetup)
                    .omnesisColorScheme()
                    .transition(.opacity)
            case .home:
                HomeView()
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: screen)
    }
}
#endif
