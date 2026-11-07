// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension AccessLevelEditorView {
    var permissionsContent: some View {
        Section {
            permission("answer", title: "Ask through Omnesis", detail: "Get answers from the data you choose.")
            permission("direct", title: "Search and read originals", detail: "Direct returns original content without privacy review.")
            permission("notes", title: "Create new notes", detail: "Create notes only. This does not read existing notes.")
            if draft.rules.isEmpty { Text("Choose at least one permission.").font(.subheadline) }
        }
    }

    func permission(_ capability: String, title: String, detail: String) -> some View {
        Toggle(isOn: Binding(get: { draft.rule(capability) != nil }, set: { draft.setEnabled(capability, $0, overview: overview) })) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                Text(detail).font(.subheadline).foregroundStyle(Theme.textSecondary)
            }.padding(.vertical, 8)
        }
    }

    @ViewBuilder var directChoiceContent: some View {
        Section {
            Button { draft.setDirectSameAsAnswer(true, authoringEnabled: overview.sourceFilters?.enabled) } label: {
                choice("Use Answer’s data", detail: overviewDataSummary("answer"), selected: draft.directSameAsAnswer)
            }.disabled(!draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled))
            Button { draft.setDirectSameAsAnswer(false, authoringEnabled: overview.sourceFilters?.enabled) } label: {
                choice("Choose separate data", detail: "Make a separate selection for Direct.", selected: !draft.directSameAsAnswer)
            }
        }
        Section {
            DisclosureGroup("View Answer’s data", isExpanded: $answerDetailsExpanded) {
                ForEach(reviewSources.filter { accountDecision(draft, "answer", $0.id).allowed }) { source in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(accessSourceDisplayName(source)).font(.headline)
                        Text(accountSummary(draft, "answer", source)).font(.subheadline).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            Text("Direct reads originals. Answer’s privacy review does not apply to Direct.")
                .font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
    }

    func choice(_ title: String, detail: String, selected: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle").accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).foregroundStyle(Color.primary)
                Text(detail).font(.subheadline).foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.vertical, 8)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    var futureContent: some View {
        ForEach(["answer", "direct"], id: \.self) { capability in
            if let rule = draft.rule(capability), !(capability == "direct" && draft.directSameAsAnswer && draft.rule("answer") != nil) {
                Section(futureSectionTitle(capability)) {
                    Toggle("Include future sources", isOn: Binding(get: { rule.boundary.mode != .allowlist }, set: { allowed in
                        var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                        selection.setFutureSourcesAllowed(allowed, knownSourceIds: overview.availableSourceIds)
                        draft.setBoundary(
                            selection.boundary(knownSourceIds: overview.availableSourceIds),
                            capability: capability,
                            authoringEnabled: overview.sourceFilters?.enabled
                        )
                    }))
                    Text("When off, sources connected later stay blocked until you choose them.").font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }

    func futureSectionTitle(_ capability: String) -> String {
        capability == "answer" && draft.directSameAsAnswer && draft.rule("direct") != nil ? "Answer and Direct" : capability.capitalized
    }

    @ViewBuilder var releaseContent: some View {
        if let rule = draft.rule("answer") {
            Section {
                Button {
                    draft
                        .setRule(rule
                            .replacing(release: .reviewed(policyFamilyId: overview.defaultPolicyFamilyId ?? overview.policyFamilies.first?
                                    .id ?? "")))
                } label: {
                    choice(
                        "Review with a privacy policy",
                        detail: "Omnesis checks each answer before releasing it.",
                        selected: { if case .reviewed = rule.release { return true }
                            return false
                        }()
                    )
                }
                Button { draft.setRule(rule.replacing(release: .unreviewed)) } label: {
                    choice(
                        "Release automatically",
                        detail: "No privacy reviewer checks these answers.",
                        selected: rule.release == .unreviewed
                    )
                }
            }
            if case .reviewed(let family) = rule.release {
                Section("Privacy policy") {
                    Picker(
                        "Policy",
                        selection: Binding(get: { family }, set: { draft.setRule(rule.replacing(release: .reviewed(policyFamilyId: $0))) })
                    ) {
                        if !overview.policyFamilies.contains(where: { $0.id == family }) { Text("Choose an available policy").tag(family) }
                        ForEach(overview.policyFamilies) { Text($0.name).tag($0.id) }
                    }
                    if !validRelease { Text("Choose an available policy before saving.").foregroundStyle(Theme.danger) }
                }
            }
        }
    }

    @ViewBuilder func dataContent(_ capability: String) -> some View {
        if let rule = draft.rule(capability) {
            sourceSection(capability: capability, rule: rule)
            if let problem = sourceProblem(capability) { Section { Text(problem).foregroundStyle(Theme.danger) } }
            if isEditing, capability == "direct", draft.rule("answer") != nil {
                Section {
                    Button("Copy Answer’s data once") { draft.copyAnswer(authoringEnabled: overview.sourceFilters?.enabled) }
                        .disabled(!draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled))
                    Text("Replaces Direct’s sources and restrictions once. Later Answer changes stay separate.").font(.subheadline)
                }
            }
        }
    }

    func sourceSection(capability: String, rule: AccessGrantRule) -> some View {
        Section {
            ForEach(sources(for: rule)) { source in
                let allowed = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                    .allowedSourceIds.contains(source.id)
                VStack(alignment: .leading, spacing: 8) {
                    Toggle(accessSourceDisplayName(source), isOn: Binding(get: { allowed }, set: { enabled in
                        var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                        selection.setAllowed(enabled, sourceId: source.id)
                        draft.setBoundary(
                            selection.boundary(knownSourceIds: overview.availableSourceIds),
                            capability: capability,
                            authoringEnabled: overview.sourceFilters?.enabled
                        )
                    })).disabled(!source.available || !canToggleSource(source.id, allowed: allowed, rule: rule))
                    Text(source
                        .available ? (allowed ? restrictionSummary(rule, source.id) : "Not shared") :
                        "Unavailable account · saved settings retained").font(.subheadline).foregroundStyle(Theme.textSecondary)
                    if accessFilterEntryVisible(
                        authoringEnabled: overview.sourceFilters?.enabled,
                        sourceAllowed: allowed,
                        hasDeclaration: source.scopes != nil,
                        hasSavedPolicy: rule.scopePolicies.contains { $0.sourceId == source.id }
                    ) {
                        Button("Change restriction") { filter = FilterRoute(source: source, capability: capability) }.frame(minHeight: 44)
                            .accessibilityLabel("Change \(capability) restriction for \(accessSourceDisplayName(source))")
                    }
                }.padding(.vertical, 8)
            }
        }
    }
}

#if DEBUG
#Preview("Guided access questions") {
    NavigationStack { AccessLevelEditorView(level: nil, overview: PreviewMocks.accessOverview) }.environment(AppStore.preview())
}
#endif
#endif
