// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct AccessAuthorizationCodeEntry: View {
    @Binding var code: String
    let loading: Bool
    let errorMessage: String?
    let onLookup: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Image(systemName: "person.badge.key")
                    .font(.system(size: 34))
                    .foregroundStyle(Theme.accent)
                Text("Enter the code shown by the app that wants to connect.")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(
                    "The notification contains no request details. " +
                        "Omnesis shows who is connecting only after your phone verifies this code."
                )
                .font(.system(size: 14))
                .foregroundStyle(Theme.textSecondary)
            }
            TextField("ABCD-EFGH", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.system(.title3, design: .monospaced, weight: .semibold))
                .padding(Theme.Spacing.md)
                .background(Theme.bgSecondary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                .accessibilityLabel("Authorization code")
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.warning)
                    .accessibilityLabel("Authorization lookup failed")
            }
            Button(action: onLookup) {
                HStack {
                    if loading { ProgressView().tint(.white) }
                    Text(loading ? "Checking…" : "Continue")
                        .font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(loading || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Spacer()
        }
        .padding(Theme.Spacing.lg)
    }
}

@available(iOS 17.0, *)
struct AccessAuthorizationOutcomeContent: View {
    let outcome: AccessAuthorizationOutcome
    let clientName: String?
    let onDone: () -> Void

    var body: some View {
        let presentation = accessAuthorizationOutcomePresentation(
            outcome: outcome,
            clientName: clientName
        )
        VStack(spacing: Theme.Spacing.lg) {
            Image(systemName: presentation.symbol)
                .font(.system(size: 56))
                .foregroundStyle(presentation.approved ? Theme.success : Theme.warning)
            Text(presentation.title)
                .font(.title2.weight(.semibold))
            Text(presentation.detail)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Done", action: onDone)
                .buttonStyle(.borderedProminent)
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

@available(iOS 17.0, *)
struct AccessAuthorizationStepIndicator: View {
    /// How much of each step's chip there is room to draw.
    private enum Density {
        /// Every step names itself in full.
        case full
        /// Every step still names itself, some of them abbreviated.
        case short
        /// Only the step being worked on names itself; the rest are numbers.
        case currentOnly
        /// Numbers alone.
        case numbers
    }

    let steps: [AccessAuthorizationStep]
    let current: AccessAuthorizationStep
    let compact: Bool
    /// Returning to a finished step.
    let onSelect: (AccessAuthorizationStep) -> Void

    /// The marker grows with the reader's type size: at accessibility sizes it
    /// is the only thing left of the chip, and it is the target you tap to go
    /// back, so it must not stay a 16pt dot beside 40pt text.
    @ScaledMetric(relativeTo: .caption2) private var markerSize: CGFloat = 16

    private var currentIndex: Int {
        steps.firstIndex(of: current) ?? 0
    }

    var body: some View {
        // At accessibility type sizes the titles cannot fit at any density, so
        // the numbers-only row is the only candidate offered.
        HStack(spacing: 0) {
            if compact {
                row(.numbers)
            } else {
                ViewThatFits(in: .horizontal) {
                    row(.full)
                    row(.short)
                    row(.currentOnly)
                    row(.numbers)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func row(_ density: Density) -> some View {
        HStack(spacing: 5) {
            ForEach(Array(steps.enumerated()), id: \.element) { index, item in
                chip(index: index, item: item, density: density)
            }
        }
    }

    @ViewBuilder
    private func chip(index: Int, item: AccessAuthorizationStep, density: Density) -> some View {
        let isCurrent = item == current
        let isComplete = index < currentIndex
        let showsTitle = density == .full
            || density == .short
            || (density == .currentOnly && isCurrent)
        let label = density == .full ? item.title : item.shortTitle
        Button {
            if isComplete { onSelect(item) }
        } label: {
            HStack(spacing: 5) {
                marker(index: index, isCurrent: isCurrent, isComplete: isComplete)
                if showsTitle {
                    Text(label)
                        .font(.caption2.weight(isCurrent ? .semibold : .regular))
                        .foregroundStyle(isCurrent ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.horizontal, showsTitle ? 7 : 5)
            .padding(.vertical, 5)
            .background(isCurrent ? Theme.bgSecondary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            // The chip is small by design; the target you press is not.
            .frame(minHeight: Theme.tapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isComplete && !isCurrent)
        .accessibilityLabel(item.title)
        .accessibilityValue(isComplete ? "Completed" : isCurrent ? "Current step" : "Not started")
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    /// The numbered disk: filled on the step being worked on, a checked ring
    /// once it is behind you, an outline while it is still ahead.
    private func marker(index: Int, isCurrent: Bool, isComplete: Bool) -> some View {
        ZStack {
            Circle()
                .fill(isCurrent ? Theme.accent : Color.clear)
            Circle()
                .strokeBorder(
                    isComplete ? Theme.success : isCurrent ? Color.clear : Theme.border,
                    lineWidth: 1
                )
            if isComplete {
                Image(systemName: "checkmark")
                    .font(.system(size: markerSize * 0.5, weight: .bold))
                    .foregroundStyle(Theme.success)
            } else {
                Text("\(index + 1)")
                    .font(.system(size: markerSize * 0.56, weight: .semibold))
                    .foregroundStyle(isCurrent ? Color.white : Theme.textMuted)
            }
        }
        .frame(width: markerSize, height: markerSize)
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension PreviewMocks {
    static let expiredAccessAuthorizationRequest = AccessAuthorizationRequest(
        id: "authorization-expired-preview",
        approvalId: "approval-expired-preview",
        status: "pending",
        clientId: "client-studio",
        clientName: "Studio assistant",
        clientUri: "https://studio-assistant.example.com",
        redirectOrigin: "http://127.0.0.1:49152",
        resource: "https://gateway.example.com/mcp",
        scope: "mcp answer direct",
        expiresAt: 1,
        requiresAnswer: false
    )
}

#Preview("Authorization code") {
    AccessAuthorizationSheet()
        .environment(AppStore())
}

#Preview("Scanned authorization code") {
    AccessAuthorizationSheet(initialCode: "ABCD-EFGH", automaticallyLookup: false)
        .environment(AppStore())
}

#Preview("Permissions · dark · large type") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .permissions
    )
    .environment(AppStore())
    .preferredColorScheme(.dark)
    .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Expired authorization") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.expiredAccessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .review
    )
    .environment(AppStore())
}
#endif

#endif
