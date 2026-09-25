// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The ground behind every setup page: the landing surface's base and
/// vignette, with a halo falling from the top of the screen in the current
/// step's tint. The halo is the only place a page is coloured by its step.
struct PhoneSetupBackdrop: View {
    let tint: PhoneSetupTint

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { proxy in
            let reach = max(proxy.size.width, proxy.size.height)
            let strength = colorScheme == .dark ? 1.0 : 0.6
            ZStack {
                LandingPalette.base
                RadialGradient(
                    stops: [
                        .init(color: tint.fill.opacity(0.34 * strength), location: 0.0),
                        .init(color: tint.fill.opacity(0.13 * strength), location: 0.42),
                        .init(color: tint.fill.opacity(0.03 * strength), location: 0.72),
                        .init(color: tint.fill.opacity(0), location: 1.0),
                    ],
                    center: UnitPoint(x: 0.5, y: -0.06),
                    startRadius: 0,
                    endRadius: reach * 0.64
                )
                RadialGradient(
                    stops: [
                        .init(color: LandingPalette.vignette.opacity(0), location: 0.0),
                        .init(color: LandingPalette.vignette.opacity(0), location: 0.55),
                        .init(color: LandingPalette.vignette.opacity(colorScheme == .dark ? 0.5 : 0.18), location: 1.0),
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: reach * 0.78
                )
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

#if DEBUG
#Preview("Phone setup backdrop — Apple Health") {
    PhoneSetupBackdrop(tint: PhoneSetupTint(hex: 0xFF2D55))
        .omnesisColorScheme()
}

#Preview("Phone setup backdrop — brand, light") {
    PhoneSetupBackdrop(tint: .brand)
        .preferredColorScheme(.light)
}
#endif
#endif
