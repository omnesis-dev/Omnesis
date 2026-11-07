// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension AccessLevelEditorView {
    @ViewBuilder var overviewContent: some View {
        summaryRow("Permissions", value: draft.rules.map(\.capability.capitalized).joined(separator: ", "), destination: .permissions)
        if draft.rule("answer") != nil { summaryRow("Answer data", value: overviewDataSummary("answer"), destination: .answerData) }
        if draft.rule("direct") != nil { summaryRow("Direct data", value: overviewDataSummary("direct"), destination: .directData) }
        if draft.rule("answer") != nil || draft.rule("direct") != nil { summaryRow(
            "Future sources",
            value: futureSummary(draft),
            destination: .future
        ) }
        if draft.rule("answer") != nil { summaryRow("Answer release", value: releaseSummary(draft), destination: .release) }
    }

    func summaryRow(_ title: String, value: String, destination: AccessFlowStep) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    Button("Change") { edit(destination) }
                        .frame(minWidth: 60, minHeight: 44)
                        .accessibilityLabel("Change \(title)")
                }
                Text(value)
            }
        }
    }

    @ViewBuilder var reviewContent: some View {
        if let allSourceProblems { Section { Text(allSourceProblems).foregroundStyle(Theme.danger) } }
        if !isEditing {
            Section { Button("Change permissions") { edit(.permissions) }.frame(minHeight: 44) }
        }
        Section("Name") {
            TextField(
                "Access level name",
                text: $draft.name,
                prompt: Text("Access level name").foregroundStyle(Theme.textSecondary)
            ).submitLabel(.done)
            if let nameProblem { Text(nameProblem).font(.subheadline).foregroundStyle(Theme.danger) }
        }
        if isEditing {
            changeRow(
                "Permissions",
                before: original.rules.map(\.capability).sorted().joined(separator: ", "),
                after: draft.rules.map(\.capability).sorted().joined(separator: ", ")
            )
            ForEach(["answer", "direct"], id: \.self) { capability in
                ForEach(reviewSources) { source in
                    if accountDecision(original, capability, source.id) != accountDecision(draft, capability, source.id) {
                        Section("\(capability.capitalized) · \(accessSourceDisplayName(source))") {
                            Text("Before: \(accountSummary(original, capability, source))")
                            Text("After: \(accountSummary(draft, capability, source))")
                            if accountSummary(original, capability, source) == accountSummary(draft, capability, source) {
                                Text("The saved selection changed; its labels are unchanged.").font(.subheadline)
                                DisclosureGroup("Selection details", isExpanded: referenceDetailsBinding(capability, source.id)) {
                                    referenceDetails(original, capability: capability, source: source, heading: "Before")
                                    referenceDetails(draft, capability: capability, source: source, heading: "After")
                                }
                            }
                        }
                    }
                }
            }
            changeRow("Future sources", before: futureSummary(original), after: futureSummary(draft))
            changeRow(
                "Answer release",
                before: original.rule("answer") == nil ? "Not allowed" : releaseSummary(original),
                after: draft.rule("answer") == nil ? "Not allowed" : releaseSummary(draft)
            )
            if draft.name != original.name { Section("Name change") { Text("\(original.name) → \(draft.name)") } }
            Section {
                DisclosureGroup("Unchanged settings") {
                    ForEach(["answer", "direct", "notes"].filter { !draft.changedCapabilities(from: original).contains($0) }, id: \.self) {
                        Text(ruleSummary(
                            draft,
                            $0
                        ))
                    }
                }
            }
        } else {
            ForEach(draft.serializedRules, id: \.capability) { rule in
                Section(rule.capability.capitalized) {
                    if rule.capability == "notes" {
                        Text("Create new notes only. Existing notes cannot be read.")
                    } else {
                        if rule.capability == "direct", !isEditing, draft.directSameAsAnswer, draft.rule("answer") != nil {
                            Text("Direct uses the same data as Answer.")
                        } else {
                            ForEach(reviewSources.filter { accountDecision(draft, rule.capability, $0.id).allowed }) { source in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(accessSourceDisplayName(source)).font(.headline)
                                    Text(restrictionSummary(rule, source.id)).font(.subheadline).foregroundStyle(Theme.textSecondary)
                                }.padding(.vertical, 4)
                            }
                        }
                        if rule.capability == "direct" { Text("Reads originals without privacy review.").font(.subheadline) }
                        Button("Change data") { edit(rule.capability == "answer" ? .answerData : .directData) }.frame(minHeight: 44)
                            .disabled(rule.capability == "direct" && draft.directSameAsAnswer
                                && !draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled))
                    }
                }
            }
            if draft.rule("answer") != nil || draft.rule("direct") != nil {
                Section("Future sources") {
                    Text(futureSummary(draft))
                    Button("Change future sources") { edit(.future) }.frame(minHeight: 44)
                }
            }
            if draft.rule("answer") != nil {
                Section("Answer release") {
                    Text(releaseSummary(draft))
                    Button("Change Answer release") { edit(.release) }.frame(minHeight: 44)
                }
            }
        }
        Section {
            if level != nil {
                let connections = impactConnectionCount == 1 ? "connection" : "connections"
                Text("Changes apply to \(impactConnectionCount) \(connections) using this level.")
            }
            Text("Changes apply after saving. Connected apps with older access tokens must refresh before making new requests.")
                .font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
    }

    @ViewBuilder func changeRow(_ title: String, before: String, after: String) -> some View {
        if before != after { Section(title) { Text("Before: \(before)")
            Text("After: \(after)")
        } }
    }

    func referenceDetailsBinding(_ capability: String, _ sourceId: String) -> Binding<Bool> {
        let key = capability + ":" + sourceId
        return Binding(get: { referenceDetailsExpanded.contains(key) }, set: { expanded in
            if expanded { referenceDetailsExpanded.insert(key) } else { referenceDetailsExpanded.remove(key) }
        })
    }

    @ViewBuilder func referenceDetails(
        _ value: AccessLevelDraft,
        capability: String,
        source: AccessSourceInstance,
        heading: String
    )
        -> some View {
        Text(heading).font(.headline)
        let refs = value.rule(capability)?.scopePolicies.first { $0.sourceId == source.id }?.rules.flatMap(\.match) ?? []
        ForEach(Array(refs.enumerated()), id: \.offset) { _, ref in
            VStack(alignment: .leading, spacing: 4) {
                Text(scopeDisplayLabel(ref, previewItem: scopeLabelHint(for: ref, in: scopeLabels[capability + ":" + source.id] ?? [])))
                Text(source.scopes?.items.first { $0.kind == ref.kind }?.noun?.one ?? ref.kind.capitalized)
                    .font(.subheadline).foregroundStyle(Theme.textSecondary)
                if let identifiers = ref.identifiers { Text(identifiers.map(\.value).joined(separator: ", ")).font(.caption) }
                if let id = ref.id { LabeledContent("Saved identifier", value: id).font(.caption).textSelection(.enabled) }
            }
        }
    }

    func ruleSummary(_ value: AccessLevelDraft, _ capability: String) -> String {
        guard let rule = value.serializedRules.first(where: { $0.capability == capability }) else { return "Not allowed" }
        if capability == "notes" { return "Create new notes only; no reading existing notes." }
        return dataSummary(value, capability) + ". Future sources: " + (rule.boundary.mode == .allowlist ? "blocked" : "allowed") + ". " +
            (capability == "direct" ? "Originals without privacy review." : releaseSummary(value))
    }

    func overviewDataSummary(_ capability: String) -> String {
        let selected = reviewSources.filter { accountDecision(draft, capability, $0.id).allowed }
        let restricted = selected.filter { accountDecision(draft, capability, $0.id).policy != nil }.count
        if selected.count == 1, let source = selected.first { return accessSourceDisplayName(source) + " · " + accountSummary(
            draft,
            capability,
            source
        ) }
        return "\(selected.count) accounts · \(restricted) restricted"
    }

    func dataSummary(_ value: AccessLevelDraft, _ capability: String) -> String {
        guard let rule = value.serializedRules.first(where: { $0.capability == capability }) else { return "Not allowed" }
        let selected = sources(for: rule).filter { source in
            let selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
            return selection.allowedSourceIds.contains(source.id)
        }
        guard !selected.isEmpty else { return "No sources selected" }
        let descriptions = selected.map { source in
            accessSourceDisplayName(source) + " · " + restrictionSummary(rule, source.id)
        }
        return descriptions.joined(separator: "\n")
    }

    func futureSummary(_ value: AccessLevelDraft) -> String {
        if value.directSameAsAnswer, let answer = value.rule("answer"), value.rule("direct") != nil {
            return "Answer and Direct: " + (answer.boundary.mode == .allowlist ? "blocked" : "allowed")
        }
        let rules = value.serializedRules.filter { $0.capability != "notes" }.sorted { $0.capability < $1.capability }
        let descriptions = rules.map { rule in
            "\(rule.capability.capitalized): \(rule.boundary.mode == .allowlist ? "blocked" : "allowed")"
        }
        return descriptions.joined(separator: " · ")
    }

    func releaseSummary(_ value: AccessLevelDraft) -> String {
        if case .reviewed(let family) = value.rule("answer")?
            .release {
            return "Privacy review · " +
                (overview.policyFamilies.first { $0.id == family }?.name ?? "Unavailable policy — choose a replacement")
        }
        return "Automatic release · no privacy review"
    }
}

#if DEBUG
#Preview("Access level overview") {
    let overview = PreviewMocks.scopeEditorOverview
    NavigationStack { AccessLevelEditorView(level: overview.levels[0], overview: overview) }.environment(AppStore.preview())
}
#endif
#endif
