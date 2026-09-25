// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The wizard's first step: what the approved sign-in becomes. Normally a
/// new connection on an existing or a new access level; for an agent signing
/// in again, an existing connection it takes over.
@available(iOS 17.0, *)
struct AccessAuthorizationConnectionStep: View {
    /// The width a name field needs beside its label. A label that leaves
    /// less than this moves above the field.
    private static let inlineFieldWidth: CGFloat = 120

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var choice: AccessConnectionChoice
    let request: AccessAuthorizationRequest
    let overview: AccessOverview
    /// The gateway's refusal of the access level name, shown under the field
    /// it is about until that name is edited.
    let levelNameRefusal: String?

    /// The connections that can be replaced as the step is drawn.
    private var connections: [AccessLiveConnection] {
        accessLiveConnections(overview, nowMillis: Int64(Date().timeIntervalSince1970 * 1000))
    }

    var body: some View {
        if choice.replacing {
            replaceSections
        } else {
            newConnectionSections
        }
    }

    @ViewBuilder
    private var newConnectionSections: some View {
        Section {
            nameField(AccessConnectionCopy.nameLabel, text: clamped(\.name), identifier: "access-connection-name")
            if let error = choice.nameError {
                errorText(error)
            }
        }
        .listRowBackground(Theme.bgSecondary)
        Section(AccessConnectionCopy.levelSection) {
            helperText(AccessConnectionCopy.levelHelper)
            ForEach(choice.orderedLevels(overview: overview)) { levelRow($0) }
            newLevelRow
        }
        .listRowBackground(Theme.bgSecondary)
        // Nothing to replace means there is no way into replace mode.
        if !connections.isEmpty {
            modeSwitch(AccessConnectionCopy.replaceEntry, replacing: true)
        }
    }

    @ViewBuilder
    private var replaceSections: some View {
        Section(AccessConnectionCopy.replaceTitle) {
            helperText(AccessConnectionCopy.replaceHelper)
            ForEach(connections) { connectionRow($0) }
        }
        .listRowBackground(Theme.bgSecondary)
        modeSwitch(AccessConnectionCopy.newConnectionEntry, replacing: false)
    }

    private func levelRow(_ level: AccessLevelSummary) -> some View {
        radioRow(
            selected: choice.levelId == level.id,
            unavailable: accessConnectionUnavailableReason(rules: level.rules, request: request)
        ) {
            choice.levelId = level.id
        } content: {
            taggedTitle(level.name, suggested: choice.suggestion(for: level) != nil)
            AccessCapabilityTriad(holdings: accessCapabilityHoldings(rules: level.rules))
            Text(AccessConnectionCopy.connectionCount(level.connectionCount))
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
            if let suggestion = choice.suggestion(for: level) {
                suggestionText(suggestion)
            }
        }
        .accessibilityIdentifier("access-level-\(level.id)")
    }

    /// The last row: a new access level, whose name is asked for inside the
    /// row once it is picked.
    private var newLevelRow: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            radioRow(selected: choice.levelId == nil, unavailable: nil) {
                choice.levelId = nil
            } content: {
                rowTitle(AccessConnectionCopy.newLevel)
            }
            .accessibilityIdentifier("access-level-new")
            if choice.levelId == nil {
                VStack(alignment: .leading, spacing: 3) {
                    nameField(AccessConnectionCopy.levelNameLabel, text: clamped(\.levelName), identifier: "access-level-name")
                    if let error = choice.levelNameError(overview: overview) ?? levelNameRefusal {
                        errorText(error)
                    }
                }
                .padding(.leading, Theme.Spacing.xl)
            }
        }
    }

    private func connectionRow(_ connection: AccessLiveConnection) -> some View {
        radioRow(
            selected: choice.connectionId == connection.id,
            unavailable: accessConnectionUnavailableReason(rules: connection.grant.rules, request: request)
        ) {
            choice.connectionId = connection.id
        } content: {
            taggedTitle(connection.name, suggested: choice.suggestion(for: connection) != nil)
            if let level = connection.level(in: overview) {
                Text(AccessConnectionCopy.connectionLevel(level.name))
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            Text(AccessConnectionCopy.lastUsed(connection.lastUsedAt))
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
            if let suggestion = choice.suggestion(for: connection) {
                suggestionText(suggestion)
            }
        }
        .accessibilityIdentifier("access-connection-\(connection.id)")
    }

    /// A row's name, with the Suggested tag beside it while both fit on one
    /// line and under it once they do not.
    @ViewBuilder
    private func taggedTitle(_ title: String, suggested: Bool) -> some View {
        if suggested {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Spacing.xs) {
                    rowTitle(title)
                    suggestedTag
                }
                VStack(alignment: .leading, spacing: 3) {
                    rowTitle(title)
                    suggestedTag
                }
            }
        } else {
            rowTitle(title)
        }
    }

    private var suggestedTag: some View {
        Text(AccessConnectionCopy.suggestedTag)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(Capsule().strokeBorder(Theme.accent.opacity(0.45), lineWidth: 1))
    }

    private func rowTitle(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
    }

    private func suggestionText(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Theme.accent)
    }

    /// A name field with its label leading on the same line. At accessibility
    /// sizes, and whenever the label leaves the field too little room, the
    /// label sits above the field instead.
    @ViewBuilder
    private func nameField(_ label: String, text: Binding<String>, identifier: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            stackedNameField(label, text: text, identifier: identifier)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    fieldLabel(label)
                        .fixedSize(horizontal: true, vertical: false)
                    nameInput(label, text: text, identifier: identifier)
                        .frame(minWidth: Self.inlineFieldWidth, idealWidth: Self.inlineFieldWidth, maxWidth: .infinity)
                }
                stackedNameField(label, text: text, identifier: identifier)
            }
        }
    }

    private func stackedNameField(_ label: String, text: Binding<String>, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            fieldLabel(label)
            nameInput(label, text: text, identifier: identifier)
        }
    }

    /// The visible label. VoiceOver reads the same name from the field.
    private func fieldLabel(_ label: String) -> some View {
        Text(label)
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .accessibilityHidden(true)
    }

    /// The field, named by `label` for VoiceOver. The label drawn beside it
    /// already names it, so the empty field shows no placeholder.
    private func nameInput(_ label: String, text: Binding<String>, identifier: String) -> some View {
        TextField(label, text: text, prompt: Text(verbatim: ""))
            .autocorrectionDisabled()
            .accessibilityIdentifier(identifier)
    }

    /// One pickable row. An unavailable one stays listed, faint, with its
    /// reason, so the owner sees why it cannot be chosen; VoiceOver reads the
    /// row as one element and gives that reason as its hint.
    private func radioRow(
        selected: Bool,
        unavailable: String?,
        select: @escaping () -> Void,
        @ViewBuilder content: () -> some View
    )
        -> some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(unavailable == nil ? Theme.accent : Theme.textMuted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    content()
                    if let unavailable {
                        Text(unavailable)
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 0)
            }
            .opacity(unavailable == nil ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(unavailable != nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(unavailable ?? "")
    }

    private func modeSwitch(_ title: String, replacing: Bool) -> some View {
        Section {
            Button(title) { choice.replacing = replacing }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
                .accessibilityIdentifier(replacing ? "access-replace-mode" : "access-new-connection-mode")
        }
        .listRowBackground(Color.clear)
    }

    private func helperText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
    }

    private func errorText(_ message: String) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(Theme.danger)
    }

    /// A name field that never holds more than the gateway accepts.
    private func clamped(_ keyPath: WritableKeyPath<AccessConnectionChoice, String>) -> Binding<String> {
        Binding(
            get: { choice[keyPath: keyPath] },
            set: { choice[keyPath: keyPath] = accessConnectionClampedName($0) }
        )
    }
}

#if DEBUG
#Preview("Connection · new access level") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionNewLevel
    )
    .environment(AppStore.preview())
}

#Preview("Connection · new access level, large type") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionNewLevel
    )
    .environment(AppStore.preview())
    .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Connection · existing level suggested") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionExistingLevel
    )
    .environment(AppStore.preview())
}

#Preview("Connection · replace suggested") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionReplaceSuggested
    )
    .environment(AppStore.preview())
}

#Preview("Connection · replace suggested, another connection picked") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionReplaceOtherPicked
    )
    .environment(AppStore.preview())
}

#Preview("Connection · replace suggested, large type") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionReplaceSuggested
    )
    .environment(AppStore.preview())
    .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Connection · replace picker") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionReplacePicker
    )
    .environment(AppStore.preview())
}

#Preview("Connection · existing level, large type") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .connectionExistingLevel
    )
    .environment(AppStore.preview())
    .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Connection · replace, agent needs Answer") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequestRequiringAnswer,
        overview: PreviewMocks.accessOverviewWithNotesConnection,
        mode: .connectionReplacePicker
    )
    .environment(AppStore.preview())
}

#Preview("Connection · 120-character names") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverviewWithLongNames,
        mode: .connectionLongNames
    )
    .environment(AppStore.preview())
}

#Preview("Connection · replace, 120-character names") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverviewWithLongNames,
        mode: .connectionLongNamesReplace
    )
    .environment(AppStore.preview())
}

#Preview("Connection · agent needs Answer") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequestRequiringAnswer,
        overview: PreviewMocks.accessOverview,
        mode: .connectionExistingLevel
    )
    .environment(AppStore.preview())
}

#Preview("Connection · no levels or connections") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverviewWithoutConnections,
        mode: .connectionNewLevel
    )
    .environment(AppStore.preview())
}

#Preview("Connection · level name already in use") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .levelNameClash
    )
    .environment(AppStore.preview())
}

#Preview("Connection · level name refused by the gateway") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .levelNameTaken
    )
    .environment(AppStore.preview())
}

#Preview("Review · shared access level") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .existingLevelReview
    )
    .environment(AppStore.preview())
}

#Preview("Review · level nobody else uses") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .existingLevelAloneReview
    )
    .environment(AppStore.preview())
}

#Preview("Review · 120-character names") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverviewWithLongNames,
        mode: .longNamesReview
    )
    .environment(AppStore.preview())
}

#Preview("Review · replace") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .replaceReview
    )
    .environment(AppStore.preview())
}

#Preview("Old gateway · no Connection step") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .oldGateway
    )
    .environment(AppStore.preview())
}
#endif

#endif
