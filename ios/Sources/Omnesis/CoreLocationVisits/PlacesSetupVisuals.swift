// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension PlacesSetupStep: PhoneSetupStepVisuals {
    func illustration() -> AnyView? {
        AnyView(PlacesSetupIllustration())
    }
}

/// A day as the places it was spent in, each with how long. Places records
/// visits, not the way between them, so no route is drawn. The day is invented.
struct PlacesSetupIllustration: View {
    private struct Visit: Identifiable {
        let symbol: String
        let place: String
        let stay: String

        var id: String {
            place
        }
    }

    private let visits = [
        Visit(symbol: "cup.and.saucer.fill", place: "Café", stay: "40 min"),
        Visit(symbol: "building.2.fill", place: "Studio", stay: "6 h"),
        Visit(symbol: "tree.fill", place: "Park", stay: "1 h"),
    ]

    private let tint = PhoneSetupTint(hex: PlacesSetupStep.copy.tint)

    var body: some View {
        HStack(spacing: 0) {
            ForEach(visits) { visit in
                VStack(spacing: 6) {
                    Image(systemName: visit.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint.ink)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(tint.fill.opacity(0.18)))
                    Text(visit.place)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PhoneSetupPalette.textPrimary)
                    Text(visit.stay)
                        .font(.caption)
                        .foregroundStyle(PhoneSetupPalette.textSecondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .phoneSetupCard(padding: 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("A day kept as visits: a café for 40 minutes, a studio for 6 hours, a park for an hour.")
    }
}

#if DEBUG
#Preview("Places — setup page") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [PlacesSetupStep.sourceId])
}
#endif
#endif
