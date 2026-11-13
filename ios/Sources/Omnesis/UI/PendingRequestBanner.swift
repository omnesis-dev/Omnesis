// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The row above the home section for something waiting on the owner: an access request,
/// or a device that signed in and waits to pair. Tapping the row opens the review; the
/// cross hides it for what is waiting right now. Every such request uses this one row, so
/// two of them stack as equals and neither covers the section below.
@available(iOS 17.0, *)
struct PendingRequestBanner: View {
    let symbol: String
    let title: String
    /// A second line that is cut rather than wrapped, such as who is asking.
    var detail: String?
    let actionTitle: String
    let reviewLabel: String
    let reviewHint: String
    let dismissLabel: String
    let onReview: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onReview) {
                HStack(spacing: 10) {
                    Image(systemName: symbol).foregroundStyle(Theme.accent)
                    // The action stays in words at every size: beside the
                    // title while both fit on one line, under it once they
                    // do not.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Theme.Spacing.sm) {
                            titleAndDetail(wraps: false)
                            actionText
                                .fixedSize()
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            titleAndDetail(wraps: true)
                            actionText
                        }
                    }
                }
                .padding(.leading, Theme.Spacing.lg)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(reviewLabel)
            .accessibilityHint(reviewHint)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(dismissLabel)
            .padding(.trailing, Theme.Spacing.xs)
        }
        .background(Theme.bgSecondary)
        .overlay(alignment: .bottom) { Divider().background(Theme.borderLight) }
    }

    /// `wraps` is the stacked layout, where a title too long for one line takes the lines it needs.
    @ViewBuilder
    private func titleAndDetail(wraps: Bool) -> some View {
        if let detail {
            // The access request row, laid out exactly as it was before the pairing row shared it.
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                // Asks for no width of its own and is cut to whatever the row
                // leaves, so a long client name never decides where the action
                // goes.
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(wraps ? nil : 1)
                    .fixedSize(horizontal: !wraps, vertical: true)
            }
            // Fills the row without a second line, so the action and the cross stay at its end.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var actionText: some View {
        Text(actionTitle)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.accent)
    }
}

/// Devices that signed in and wait for approval, as one row with their count.
@available(iOS 17.0, *)
struct PairingRequestBanner: View {
    let offer: PairingRequestBannerOffer
    let onReview: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        PendingRequestBanner(
            symbol: "checkmark.shield",
            title: offer.text,
            actionTitle: PairingRequestBannerOffer.actionTitle,
            reviewLabel: offer.text,
            reviewHint: "Opens Pairing requests",
            dismissLabel: "Dismiss pairing request",
            onReview: onReview,
            onDismiss: onDismiss
        )
        .accessibilityIdentifier("home.pairingRequestBanner")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("One device waiting") {
    PairingRequestBanner(offer: PairingRequestBannerOffer(count: 1), onReview: {}, onDismiss: {})
}

@available(iOS 17.0, *)
#Preview("Several devices waiting · dark") {
    PairingRequestBanner(offer: PairingRequestBannerOffer(count: 3), onReview: {}, onDismiss: {})
        .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("With an access request") {
    VStack(spacing: 0) {
        AccessPendingRequestBanner(
            offer: AccessPendingRequestBannerOffer(newest: PreviewMocks.accessPendingRequests[0], count: 1),
            onReview: {},
            onDismiss: {}
        )
        PairingRequestBanner(offer: PairingRequestBannerOffer(count: 1), onReview: {}, onDismiss: {})
    }
}

@available(iOS 17.0, *)
#Preview("Narrow screen, large type") {
    PairingRequestBanner(offer: PairingRequestBannerOffer(count: 12), onReview: {}, onDismiss: {})
        .frame(width: 320)
        .environment(\.dynamicTypeSize, .accessibility2)
}
#endif
#endif
