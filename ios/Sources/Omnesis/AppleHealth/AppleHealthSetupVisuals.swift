// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension AppleHealthSetupStep: PhoneSetupStepVisuals {
    func extraLedgerSection() -> AnyView? {
        AnyView(AppleHealthCategoryChips(host: host))
    }
}

/// Apple Health's categories as switchable chips inside its ledger. They edit
/// the same category settings as Settings, so a category turned off here is
/// never requested from HealthKit or synced.
struct AppleHealthCategoryChips: View {
    let host: any AppleHealthSetupHost

    @State private var consentCategory: HealthCategory?

    private let tint = PhoneSetupTint(hex: AppleHealthSetupStep.copy.tint)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PhoneSetupSectionLabel(text: "Categories", symbol: "square.grid.2x2.fill")
            // Each chip's tap target is a full 44pt tall, so rows need no gap.
            PhoneSetupFlowLayout(rowSpacing: 0) {
                ForEach(HealthCategory.allCases, id: \.self) { category in
                    let isOn = host.enabledCategories.contains(category)
                    Button {
                        toggle(category, isOn: isOn)
                    } label: {
                        PhoneSetupChip(text: category.displayName, style: .option(isOn: isOn), tint: tint)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isToggle)
                    .accessibilityValue(isOn ? "On" : "Off")
                }
            }
        }
        .alert(
            AppleHealthSetupStep.consentTitle,
            isPresented: Binding(
                get: { consentCategory != nil },
                set: { if !$0 { consentCategory = nil } }
            ),
            presenting: consentCategory
        ) { category in
            Button("Enable", role: .destructive) { host.setCategory(category, enabled: true) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text(AppleHealthSetupStep.consentMessage)
        }
    }

    private func toggle(_ category: HealthCategory, isOn: Bool) {
        if !isOn, category.requiresConsent {
            consentCategory = category
        } else {
            host.setCategory(category, enabled: !isOn)
        }
    }
}

#if DEBUG
#Preview("Apple Health — category chips") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [AppleHealthSetupStep.sourceId])
}
#endif
#endif
