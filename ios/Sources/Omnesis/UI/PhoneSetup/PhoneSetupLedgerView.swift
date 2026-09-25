// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What a source sends to the gateway and what never leaves the phone. The
/// setup page shows it as a card; Settings shows the same ledger plainly inside
/// a source's "What's sent" disclosure.
struct PhoneSetupLedgerView: View {
    enum Style {
        case card
        case plain
    }

    let ledger: PhoneSetupLedger
    var extra: AnyView?
    var style = Style.card

    var body: some View {
        switch style {
        case .card:
            sections
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous).fill(PhoneSetupPalette.card)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(PhoneSetupPalette.cardBorder, lineWidth: 1)
                )
        case .plain:
            sections
        }
    }

    private var sections: some View {
        VStack(alignment: .leading, spacing: 0) {
            section {
                PhoneSetupSectionLabel(text: "Sent to your gateway", symbol: "arrow.up.right")
                chips(ledger.sent, style: .sent)
            }
            if let extra {
                divider
                section { extra }
            }
            divider
            section {
                PhoneSetupSectionLabel(text: ledger.staysLabel, symbol: "lock.fill")
                chips(ledger.stays, style: .kept)
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(PhoneSetupPalette.cardBorder)
            .frame(height: 1)
    }

    private func section(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .padding(.horizontal, style == .card ? 14 : 0)
            .padding(.vertical, style == .card ? 14 : 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func chips(_ items: [String], style chipStyle: PhoneSetupChip.Style) -> some View {
        PhoneSetupFlowLayout {
            ForEach(items, id: \.self) { item in
                PhoneSetupChip(text: item, style: chipStyle)
            }
        }
    }
}

/// A step's examples of what it is for, in place of a ledger.
struct PhoneSetupHighlightsView: View {
    let highlights: [PhoneSetupHighlight]
    let tint: PhoneSetupTint

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(highlights.enumerated()), id: \.element.id) { index, highlight in
                if index > 0 {
                    Rectangle()
                        .fill(PhoneSetupPalette.cardBorder)
                        .frame(height: 1)
                        .padding(.leading, 62)
                }
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(tint.fill.opacity(0.16))
                        .frame(width: 34, height: 34)
                        .overlay(
                            Image(systemName: highlight.symbol)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(tint.ink)
                        )
                    Text(highlight.text)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(PhoneSetupPalette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(PhoneSetupPalette.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(PhoneSetupPalette.cardBorder, lineWidth: 1)
        )
    }
}

#if DEBUG
#Preview("Phone setup — ledger") {
    ScrollView {
        VStack(spacing: 16) {
            if let ledger = PhotosSetupStep.copy.ledger {
                PhoneSetupLedgerView(ledger: ledger)
            }
            PhoneSetupHighlightsView(
                highlights: NotificationsSetupStep.copy.highlights,
                tint: PhoneSetupTint(hex: NotificationsSetupStep.copy.tint)
            )
        }
        .padding(24)
    }
    .background(LandingPalette.base)
    .omnesisColorScheme()
}
#endif
#endif
