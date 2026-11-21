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
    @Binding var choice: AccessConnectionChoice
    let request: AccessAuthorizationRequest
    let overview: AccessOverview
    /// Whether the gateway refused the access level name, which is said under
    /// the field until that name is edited.
    let levelNameRefused: Bool

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
        Text("Going back leaves this request pending until it expires. You can enter the code again.")
            .accessText(.rowSecondary, color: AccessUI.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 16)
    }

    @ViewBuilder
    private var newConnectionSections: some View {
        AccessSectionHeading(AccessConnectionCopy.nameLabel, first: true)
        // The heading above already names the field, so the empty field shows no placeholder.
        TextField(AccessConnectionCopy.nameLabel, text: clampedName, prompt: Text(verbatim: ""))
            .autocorrectionDisabled()
            .accessibilityIdentifier("access-connection-name")
            .modifier(AccessFieldChrome())
        AccessProblemText(text: choice.nameError)
        AccessSectionHeading(AccessConnectionCopy.levelSection)
        helperText(AccessConnectionCopy.levelHelper)
        let levels = choice.orderedLevels(overview: overview)
        VStack(alignment: .leading, spacing: AccessUI.cardGap) {
            ForEach(levels) { level in levelRow(level) }
            radioRow(selected: choice.levelId == nil, unavailable: nil) {
                choice.levelId = nil
            } content: {
                rowTitle(AccessConnectionCopy.newLevel)
            }
            .accessibilityIdentifier("access-level-new")
            // The new level's name, asked for under its option once it is picked.
            if choice.levelId == nil {
                AccessLevelNameField(
                    name: $choice.levelName,
                    problem: choice.levelNameError(overview: overview) ?? (levelNameRefused ? accessLevelNameTakenMessage : nil)
                )
            }
        }
        // Nothing to replace means there is no way into replace mode.
        if !connections.isEmpty {
            modeSwitch(AccessConnectionCopy.replaceEntry, replacing: true)
        }
    }

    @ViewBuilder
    private var replaceSections: some View {
        let listed = connections
        AccessSectionHeading(AccessConnectionCopy.replaceTitle, first: true)
        helperText(AccessConnectionCopy.replaceHelper)
        VStack(alignment: .leading, spacing: AccessUI.cardGap) {
            ForEach(listed, id: \.id) { connection in connectionRow(connection) }
        }
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
            AccessCapabilityPills(holdings: accessCapabilityHoldings(rules: level.rules)).padding(.vertical, 2)
            detailText(AccessConnectionCopy.connectionCount(level.connectionCount))
            if let suggestion = choice.suggestion(for: level) {
                suggestionText(suggestion)
            }
        }
        .accessibilityIdentifier("access-level-\(level.id)")
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
                detailText(AccessConnectionCopy.connectionLevel(level.name))
            }
            detailText(AccessConnectionCopy.lastUsed(connection.lastUsedAt))
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
                HStack(spacing: 8) {
                    rowTitle(title)
                    AccessPill(text: AccessConnectionCopy.suggestedTag, tone: .accent)
                }
                VStack(alignment: .leading, spacing: 4) {
                    rowTitle(title)
                    AccessPill(text: AccessConnectionCopy.suggestedTag, tone: .accent)
                }
            }
        } else {
            rowTitle(title)
        }
    }

    private func rowTitle(_ title: String) -> some View {
        Text(title).accessText(.cardTitle).frame(minHeight: AccessUI.controlSize)
    }

    private func detailText(_ text: String) -> some View {
        Text(text).accessText(.rowSecondary, color: AccessUI.secondary)
    }

    private func suggestionText(_ text: String) -> some View {
        Text(text).accessText(.rowSecondary, color: Theme.accent)
    }

    /// One pickable option, on its own card with an accent outline when picked. An unavailable one stays listed, faint, with its
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
            HStack(alignment: .top, spacing: AccessUI.iconGap) {
                AccessControlMark(kind: .radio, selected: selected, tint: unavailable == nil ? Theme.accent : AccessUI.muted)
                VStack(alignment: .leading, spacing: 4) {
                    content()
                    if let unavailable {
                        Text(unavailable).accessText(.rowSecondary, color: Theme.warning).accessibilityHidden(true)
                    }
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 0)
            }
            .padding(AccessUI.cardPadding)
            .opacity(unavailable == nil ? 1 : 0.55)
            .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
            .overlay {
                if selected { RoundedRectangle(cornerRadius: AccessUI.cardRadius).strokeBorder(Theme.accent, lineWidth: 1.5) }
            }
            .contentShape(.rect(cornerRadius: AccessUI.cardRadius))
        }
        .buttonStyle(.plain)
        .disabled(unavailable != nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(unavailable ?? "")
    }

    private func modeSwitch(_ title: String, replacing: Bool) -> some View {
        Button { choice.replacing = replacing } label: {
            Text(title).accessText(.label, color: Theme.accent).frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .padding(.top, 12)
        .accessibilityIdentifier(replacing ? "access-replace-mode" : "access-new-connection-mode")
    }

    private func helperText(_ text: String) -> some View {
        Text(text).accessText(.subtitle, color: AccessUI.secondary).fixedSize(horizontal: false, vertical: true).padding(.bottom, 12)
    }

    /// The connection's name, never holding more than the gateway accepts.
    private var clampedName: Binding<String> {
        Binding(get: { choice.name }, set: { choice.name = accessConnectionClampedName($0) })
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
