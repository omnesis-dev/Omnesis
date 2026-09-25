// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - Merged-into banner (loser → canonical)

/// "Merged into [canonical]" affordance shown on a logical-merge loser.
/// Tapping pushes the canonical's detail view so the user can see the
/// absorbed identity in context.
@available(iOS 17.0, *)
struct MergedIntoBanner: View {
    let target: String
    let targetName: String?

    var body: some View {
        NavigationLink {
            PersonDetailView(personId: target, presetName: targetName)
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: "arrowshape.turn.up.right.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Merged into \(targetName ?? "another identity")")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                    Text("You're seeing this row's pre-merge state. Edge counts and interaction scores live on the canonical.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Merged-from summary (canonical → losers)

/// Concise "N people merged into this" affordance on a canonical.
/// Stays compact (one line + a Details button) and delegates the
/// "show full list" action upward so the parent can present the
/// sheet — keeps state ownership in PersonDetailView.
@available(iOS 17.0, *)
struct MergedFromSummary: View {
    let count: Int
    let onShowDetails: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.sm) {
            Image(systemName: "person.2.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(count) \(count == 1 ? "person" : "people") merged into this")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text("Aliases, documents, and edge counts have been rolled up.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button(action: onShowDetails) {
                Text("Details")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Theme.accent.opacity(0.18))
                    .foregroundStyle(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            }
            .buttonStyle(.plain)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

// MARK: - Merged-from sheet (full list)

/// Bottom sheet that lists every loser absorbed into a canonical, with
/// their source-icon strip and `merged X ago` timestamp. Mirrors the
/// portal's "N people merged into this canonical" panel.
@available(iOS 17.0, *)
struct MergedFromSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppStore.self) private var store
    let merged: [MergedFromPerson]
    let canonicalName: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    Text(rollupBlurb)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 0) {
                        ForEach(Array(merged.enumerated()), id: \.element.id) { idx, person in
                            NavigationLink {
                                PersonDetailView(personId: person.id, presetName: person.canonicalName)
                            } label: {
                                MergedFromRow(person: person, store: store)
                                    .padding(.horizontal, Theme.Spacing.md)
                                    .padding(.vertical, Theme.Spacing.sm)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if idx < merged.count - 1 {
                                Divider().background(Theme.borderLight).padding(.leading, 44)
                            }
                        }
                    }
                    .background(Theme.bgSecondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.large)
                            .stroke(Theme.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("\(merged.count) merged in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
            .omnesisColorScheme()
        }
    }

    private var rollupBlurb: String {
        let target = canonicalName.isEmpty ? "this person" : canonicalName
        return "Aliases, documents, and edge counts from each identity below were rolled up into \(target)."
    }
}

@available(iOS 17.0, *)
struct MergedFromRow: View {
    let person: MergedFromPerson
    let store: AppStore

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            PersonAvatar(name: person.canonicalName, isSelf: false, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.canonicalName.isEmpty ? "(no name)" : person.canonicalName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(mergedAtLabel)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !person.sourceIds.isEmpty {
                PersonSourceStrip(sourceIds: person.sourceIds, store: store, max: 4, size: 13)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
        }
    }

    private var mergedAtLabel: String {
        if let when = formatTimeAgo(person.appliedAt) {
            return "merged \(when)"
        }
        return "merged"
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Person — canonical with merges") {
    NavigationStack {
        PersonDetailMergePreview(person: PreviewMocks.personDetailWithMerges)
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Person — loser (mergedInto)") {
    NavigationStack {
        PersonDetailMergePreview(person: PreviewMocks.personDetailLoser)
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("MergedFromSheet — full list") {
    MergedFromSheet(
        merged: PreviewMocks.personDetailWithMerges.mergedFrom ?? [],
        canonicalName: PreviewMocks.personDetailWithMerges.canonicalName
    )
    .environment(AppStore.preview())
}

/// Renders the merge surfaces (banner + concise row) against fixture
/// PersonDetail values, without driving the on-appear network fetch.
/// Drives the preview / snapshot harness for both `mergedInto` (loser)
/// and `mergedFrom` (canonical) variants.
@available(iOS 17.0, *)
struct PersonDetailMergePreview: View {
    let person: PersonDetail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.md) {
                    PersonAvatar(name: person.canonicalName, isSelf: person.isSelf, size: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.canonicalName)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(2)
                        if let lastSeen = formatTimeAgo(person.lastSeen) {
                            Text("last seen \(lastSeen)")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    Spacer()
                }
                if let target = person.mergedInto {
                    MergedIntoBanner(target: target, targetName: person.mergedIntoCanonicalName)
                }
                if let merged = person.mergedFrom, !merged.isEmpty {
                    MergedFromSummary(count: merged.count, onShowDetails: {})
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(person.canonicalName)
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
    }
}
#endif
#endif
