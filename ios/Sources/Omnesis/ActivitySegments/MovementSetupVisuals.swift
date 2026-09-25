// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension MovementSetupStep: PhoneSetupStepVisuals {
    func illustration() -> AnyView? {
        AnyView(MovementSetupIllustration())
    }
}

/// A day as stretches of movement, the shape Movement sends. The day is
/// invented.
struct MovementSetupIllustration: View {
    private enum Activity: CaseIterable {
        case still
        case walking
        case cycling
        case driving

        var label: String {
            switch self {
            case .still: "Still"
            case .walking: "Walking"
            case .cycling: "Cycling"
            case .driving: "Driving"
            }
        }
    }

    private struct Stretch: Identifiable {
        let id: Int
        let share: CGFloat
        let activity: Activity
    }

    private let day = [
        Stretch(id: 0, share: 0.24, activity: .still),
        Stretch(id: 1, share: 0.07, activity: .walking),
        Stretch(id: 2, share: 0.12, activity: .driving),
        Stretch(id: 3, share: 0.25, activity: .still),
        Stretch(id: 4, share: 0.1, activity: .cycling),
        Stretch(id: 5, share: 0.06, activity: .walking),
        Stretch(id: 6, share: 0.16, activity: .still),
    ]

    private let tint = PhoneSetupTint(hex: MovementSetupStep.copy.tint)
    private static let gap: CGFloat = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { proxy in
                let usable = proxy.size.width - Self.gap * CGFloat(day.count - 1)
                HStack(spacing: Self.gap) {
                    ForEach(day) { stretch in
                        Rectangle()
                            .fill(color(for: stretch.activity))
                            .frame(width: max(0, usable * stretch.share))
                    }
                }
            }
            .frame(height: 14)
            .clipShape(Capsule())
            HStack {
                Text("7 am")
                Spacer()
                Text("Noon")
                Spacer()
                Text("9 pm")
            }
            .font(.caption2)
            .foregroundStyle(PhoneSetupPalette.textMuted)
            HStack(spacing: 14) {
                ForEach(Activity.allCases, id: \.self) { activity in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(color(for: activity))
                            .frame(width: 8, height: 8)
                        Text(activity.label)
                            .font(.caption)
                            .foregroundStyle(PhoneSetupPalette.textSecondary)
                    }
                }
            }
        }
        .phoneSetupCard(padding: 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("A day split into stretches of being still, walking, cycling and driving.")
    }

    private func color(for activity: Activity) -> Color {
        switch activity {
        case .still: PhoneSetupPalette.textMuted.opacity(0.35)
        case .walking: tint.fill
        case .cycling: Color(hex: 0x64D2FF)
        case .driving: Color(hex: 0x5E5CE6)
        }
    }
}

#if DEBUG
#Preview("Movement — setup page") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [MovementSetupStep.sourceId])
}
#endif
#endif
