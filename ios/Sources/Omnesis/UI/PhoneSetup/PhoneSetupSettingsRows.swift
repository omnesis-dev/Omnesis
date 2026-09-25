// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Settings row that reopens phone setup at Choose.
struct PhoneSetupSettingsRow: View {
    let summary: PhoneSetupSourceSummary
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(PhoneSetupPalette.brandGradient)
                    .frame(width: 34, height: 34)
                    .overlay(
                        Image(systemName: "iphone")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text("Set up this iPhone")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("\(summary.enabled) of \(summary.available) sources on")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// A source's ledger in Settings, collapsed until opened. It shows the same
/// copy as the source's setup page.
struct PhoneSetupWhatsSent: View {
    let copy: PhoneSetupCopy

    @State private var isExpanded: Bool

    init(copy: PhoneSetupCopy, isExpanded: Bool = false) {
        self.copy = copy
        _isExpanded = State(initialValue: isExpanded)
    }

    var body: some View {
        if let ledger = copy.ledger {
            DisclosureGroup(isExpanded: $isExpanded) {
                PhoneSetupLedgerView(ledger: ledger, style: .plain)
            } label: {
                Text("What's sent")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
            }
            .tint(Theme.textSecondary)
        }
    }
}

#if DEBUG
#Preview("Settings — phone setup rows") {
    Form {
        Section("This iPhone") {
            PhoneSetupSettingsRow(summary: PhoneSetupSourceSummary(enabled: 1, available: 4)) {}
        }
        .listRowBackground(Theme.bgSecondary)
        Section("Photos") {
            PhoneSetupWhatsSent(copy: PhotosSetupStep.copy, isExpanded: true)
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}
#endif
#endif
