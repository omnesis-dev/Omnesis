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

/// One capability, drawn the same way wherever it is named.
///
/// A review that invents its own labels makes the owner check twice that the
/// thing they are about to approve is the thing they will be shown afterwards.
@available(iOS 17.0, *)
struct AccessCapabilityBadge: View {
    let capability: AccessCapability
    let tone: AccessCapabilityTone

    private var color: Color {
        switch tone {
        case .granted: Theme.success
        case .raw: Theme.danger
        case .unreviewed: Theme.warning
        case .notes: Theme.accent
        case .withheld: Theme.textMuted
        }
    }

    var body: some View {
        Text(capability.label.uppercased())
            .font(.caption2.weight(.semibold))
            .kerning(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .overlay(
                Capsule().strokeBorder(
                    tone == .withheld ? Color.clear : color.opacity(0.45),
                    lineWidth: 1
                )
            )
            .opacity(tone == .withheld ? 0.35 : 1)
            .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        switch tone {
        case .withheld: "\(capability.label) not granted"
        case .unreviewed: "\(capability.label) granted, released without privacy review"
        default: "\(capability.label) granted"
        }
    }
}

/// Three fixed slots in a stable order, so a capability's position never moves
/// and "which of these has raw access" is answerable at a glance. A withheld
/// capability keeps its slot and goes faint rather than disappearing. The
/// badges sit in a row when it fits and stack when the text is too large for
/// one, so a label is never truncated or broken mid-word.
@available(iOS 17.0, *)
struct AccessCapabilityTriad: View {
    let holdings: AccessCapabilityHoldings

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 5) {
                badges
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 4) {
                badges
            }
        }
    }

    private var badges: some View {
        ForEach(AccessCapability.allCases, id: \.self) { capability in
            AccessCapabilityBadge(capability: capability, tone: holdings.tone(capability))
                .fixedSize(horizontal: true, vertical: false)
        }
    }
}

/// The one source list a scope runs under: which connected sources it may
/// read, and whether a source connected later joins them.
@available(iOS 17.0, *)
struct AccessSourceRuleEditor: View {
    let scope: AccessSourceScope
    @Binding var value: AccessSourceSelectionState
    let sources: [AccessSourceInstance]
    let store: AppStore
    @State private var query = ""

    private var availableSourceIds: Set<String> {
        Set(sources.filter(\.available).map(\.id))
    }

    private var allowedCount: Int {
        value.allowedSourceIds.intersection(availableSourceIds).count
    }

    /// No refusal while there is nothing to choose from: "select at least one
    /// source" in front of an empty list asks for something that is not there,
    /// and the empty state already says what to do instead.
    private var boundaryError: String? {
        guard !availableSourceIds.isEmpty else { return nil }
        return accessSourceBoundaryError(
            scope: scope,
            permitsAnyKnownSource: value.permitsAnyKnownSource(availableSourceIds),
            recordedSelectionCount: value.boundary(
                knownSourceIds: availableSourceIds
            ).sourceIds.count
        )
    }

    private var shownSources: [AccessSourceInstance] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return sources }
        return sources.filter {
            $0.name.localizedCaseInsensitiveContains(needle)
                || $0.id.localizedCaseInsensitiveContains(needle)
        }
    }

    var body: some View {
        Section {
            if availableSourceIds.isEmpty {
                Text("No sources are connected. Connect a source before approving this access.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                HStack {
                    Text("Checked sources are allowed.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: Theme.Spacing.sm)
                    Text("\(allowedCount) of \(availableSourceIds.count) allowed")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                TextField("Search sources", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                HStack {
                    Button("Allow all") { value.allowAll(availableSourceIds) }
                    Spacer()
                    Button("Block all") { value.blockAll(availableSourceIds) }
                }
                // Buttons in the same Form row otherwise inherit List's row-wide
                // tap behavior, which can invoke both actions from one tap.
                .buttonStyle(.borderless)
                // A checkbox rather than a switch: these are many rows of one
                // list being picked from, not a handful of independent
                // settings, and the whole row is the target. Android draws the
                // same row the same way.
                ForEach(shownSources) { source in
                    let allowed = value.allowedSourceIds.contains(source.id)
                    Button {
                        value.setAllowed(!allowed, sourceId: source.id)
                    } label: {
                        HStack(spacing: Theme.Spacing.sm) {
                            Image(systemName: allowed ? "checkmark.square.fill" : "square")
                                .font(.system(size: 16))
                                .foregroundStyle(allowed ? Theme.accent : Theme.textMuted)
                            SourceIconView(sourceId: source.id, store: store, size: 20)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(source.name)
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textPrimary)
                                Text(source.id)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if !source.available {
                                    Text("Unavailable — decision retained")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(
                        top: 5,
                        leading: Theme.Spacing.md,
                        bottom: 5,
                        trailing: Theme.Spacing.md
                    ))
                    .accessibilityIdentifier("access-source-\(source.id)")
                    .accessibilityLabel(source.name)
                    .accessibilityValue(allowed ? "Allowed" : "Blocked")
                    .accessibilityAddTraits(allowed ? .isSelected : [])
                    .disabled(!source.available)
                }
                if shownSources.isEmpty {
                    Text("No sources match that search.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            // The refusal belongs inside the list that earns it, naming every
            // capability this one list governs.
            if let boundaryError {
                Text(boundaryError)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
            // The future-source choice stays inside the list it governs: two
            // lists on one screen would otherwise carry two identical section
            // headers with nothing saying which is whose.
            Text("When you connect a new source")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            futureSourceChoice(allowed: false, title: "Keep it blocked until I allow it")
            futureSourceChoice(allowed: true, title: "Allow it automatically")
        } header: {
            Text(scope.editorTitle)
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private func futureSourceChoice(allowed: Bool, title: String) -> some View {
        Button {
            value.setFutureSourcesAllowed(allowed, knownSourceIds: availableSourceIds)
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Image(
                    systemName: value.allowsFutureSources == allowed
                        ? "largecircle.fill.circle"
                        : "circle"
                )
                .foregroundStyle(Theme.accent)
                Text(title)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(value.allowsFutureSources == allowed ? .isSelected : [])
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
