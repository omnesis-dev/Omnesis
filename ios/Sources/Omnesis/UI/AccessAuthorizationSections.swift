// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// Self-contained sections of the access wizard. Each one reads the form it is
// handed and needs none of the sheet's own state, which keeps the sheet to the
// steps' wiring and the decision flow.

/// The Answer-privacy choice: review every answer with a policy, or release
/// answers automatically. Edits the form's release choice and policy in place.
struct AccessAnswerReleaseSection: View {
    @Binding var form: AccessAuthorizationFormState
    let overview: AccessOverview

    var body: some View {
        Section("Privacy for Answer") {
            answerReleaseChoice(
                .reviewed,
                title: "Review answers with a privacy policy",
                detail: "A privacy review checks every answer before it is released."
            )
            // The policy belongs under the choice it qualifies, so picking one
            // and reading it are part of that option rather than a separate
            // step below both.
            if form.answerRelease == .reviewed {
                Picker("Privacy policy", selection: $form.policyFamilyId) {
                    ForEach(overview.policyFamilies) { policy in
                        Text(policy.name).tag(policy.id)
                    }
                }
                if overview.policyFamilies.isEmpty {
                    Text("No published privacy policy is available. Omnesis will fail closed.")
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                }
                NavigationLink(
                    value: AccessPolicyTextRoute(
                        familyId: form.policyFamilyId,
                        name: overview.policyFamilies.first { $0.id == form.policyFamilyId }?.name
                    )
                ) {
                    Text("Read this policy's full text")
                        .font(.footnote)
                }
                .disabled(form.policyFamilyId.isEmpty)
            }
            answerReleaseChoice(
                .unreviewed,
                title: "Release answers automatically",
                // Choosing this option is the acknowledgement: its own wording
                // carries the warning, so nothing further is asked.
                detail: "High risk: source boundaries and audit still apply, "
                    + "but no reviewer checks the answer.",
                warning: true
            )
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private func answerReleaseChoice(
        _ choice: AccessAnswerReleaseChoice,
        title: String,
        detail: String,
        warning: Bool = false
    )
        -> some View {
        let selected = form.answerRelease == choice
        // Unreviewed release is the warning colour, never danger: danger
        // belongs to Direct, and two reds on one screen means neither is read
        // as one. Like Direct's warning, it is loudest once it applies.
        let loud = warning && selected
        return Button {
            form.answerRelease = choice
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(loud ? Theme.warning : Theme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.textPrimary)
                    Text(detail)
                        .font(loud ? .footnote.weight(.semibold) : .footnote)
                        .foregroundStyle(loud ? Theme.warning : Theme.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The final review of what approval connects: the connection, the access
/// level it uses, and the permissions that come with it.
struct AccessAuthorizationReviewSection: View {
    let request: AccessAuthorizationRequest
    let overview: AccessOverview
    let connection: AccessConnectionReview
    /// The permissions the connection would hold, as a form prints them.
    let form: AccessAuthorizationFormState

    var body: some View {
        Section("Review access") {
            LabeledContent("Connection", value: connection.connectionName)
            if let accessLevel = connection.accessLevel {
                LabeledContent("Access level", value: accessLevel)
            }
            if let replaces = connection.replaces {
                LabeledContent("Replaces", value: replaces)
            }
            // The same three badges the wizard chose them with, so the thing
            // being approved looks like the thing that was picked.
            LabeledContent("Permissions") {
                AccessCapabilityTriad(holdings: form.holdings(request: request))
            }
            ForEach(form.sourceScopes(request: request), id: \.self) { scope in
                LabeledContent("\(scope.name) sources", value: sourceSummary(
                    form.sources(for: scope),
                    overview: overview
                ))
            }
            if form.answerActive(request: request) {
                LabeledContent("Answer privacy", value: accessAnswerPrivacySummary(form: form, overview: overview))
                    .foregroundStyle(
                        form.answerRelease == .unreviewed ? Theme.warning : Theme.textPrimary
                    )
            }
            if form.notesEnabled {
                LabeledContent("Notes", value: "Save notes; the agent’s name is recorded")
            }
            if let footnote = connection.levelFootnote {
                Text(footnote)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }
            Text("Access can be edited or revoked later from Settings → Access in the Omnesis Portal.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private func sourceSummary(
        _ selection: AccessSourceSelectionState,
        overview: AccessOverview
    )
        -> String {
        let available = overview.availableSourceIds
        switch selection.mode {
        case .all:
            return "All sources"
        case .allowlist:
            let count = selection.allowedSourceIds.intersection(available).count
            return "\(count) selected source\(count == 1 ? "" : "s")"
        case .denylist:
            let blocked = available.subtracting(selection.allowedSourceIds).count
            return blocked == 0 ? "All sources" : "All except \(blocked) blocked"
        }
    }
}
#endif
