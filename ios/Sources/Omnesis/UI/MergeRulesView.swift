// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Read-only merge-rules audit — mirrors the portal's Merge rules tab
/// (`packages/gateway/portal/js/views/merge-rules.js`).
///
/// Each row is a *merged identity* (the surviving canonical person); expanding
/// it reveals the source aliases that were merged into it — the aliases that
/// triggered each merge. A `User` / `System` segmented filter sits at the top
/// (the per-row trigger badge is gone), and the same alias-nesting and search
/// the portal uses keep the list scannable.
///
/// iOS surfaces these read-only — delete / undo stay in the portal.
@available(iOS 17.0, *)
struct MergeRulesView: View {
    @Environment(AppStore.self) private var store

    @State private var identities: [MergeIdentity] = []
    @State private var query = ""
    @State private var filter: MergeTriggerFilter = .all
    @State private var loading = true
    @State private var loadError: Error?
    @State private var paging = CursorPagingState()

    var body: some View {
        content
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge rules")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load() }
            .task(id: "\(filter.rawValue):\(query)") {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await load()
            }
            .omnesisColorScheme()
    }

    @ViewBuilder
    private var content: some View {
        if loading, identities.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, identities.isEmpty {
            GatewayErrorView(
                context: "load merge rules",
                error: loadError,
                onRetry: { Task { await load() } }
            )
        } else {
            MergeRulesList(
                identities: identities,
                query: $query,
                filter: $filter,
                paging: paging,
                onLoadMore: { Task { await loadMore() } }
            )
        }
    }

    private func load() async {
        let request = paging.beginRefresh()
        guard let client = store.search else {
            loadError = URLError(.cannotConnectToHost)
            loading = false
            paging.failRefresh(request)
            return
        }
        loading = true
        do {
            let page = try await client.listMergeRuleGroups(
                limit: 25,
                query: query,
                kind: filter == .all ? nil : filter.rawValue
            )
            guard paging.owns(request) else { return }
            identities = page.items.map(MergeIdentity.init)
            loadError = nil
            loading = false
            paging.finishRefresh(request, nextCursor: page.pageInfo.nextCursor)
        } catch GatewayClient.Error.notFound {
            // Older gateways only expose a flat unpaged endpoint. Keep that
            // compatibility path functional; new gateways use whole-group
            // pages so cards can never be split at a cursor boundary.
            do {
                let rules = try await client.listMergeRules()
                    .sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
                guard paging.owns(request) else { return }
                identities = MergeIdentity.build(from: rules, filter: filter, query: query)
                loadError = nil
                loading = false
                paging.finishRefresh(request, nextCursor: nil)
            } catch {
                guard paging.owns(request) else { return }
                loadError = error
                loading = false
                paging.failRefresh(request)
            }
        } catch {
            guard paging.owns(request) else { return }
            loadError = error
            loading = false
            paging.failRefresh(request)
        }
    }

    private func loadMore() async {
        guard let client = store.search else { return }
        guard let request = paging.beginLoadMore() else { return }
        do {
            let page = try await client.listMergeRuleGroups(
                limit: 25,
                cursor: request.cursor,
                query: query,
                kind: filter == .all ? nil : filter.rawValue
            )
            guard paging.owns(request) else { return }
            let fresh = appendUnique(
                page.items.map(MergeIdentity.init),
                to: &identities,
                id: \.id
            )
            paging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }
}

// MARK: - Trigger filter

@available(iOS 17.0, *)
enum MergeTriggerFilter: String, CaseIterable, Identifiable {
    case all, user, system
    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .all: "All"
        case .user: "User"
        case .system: "System"
        }
    }
}

// MARK: - List (shared with the preview wrapper)

/// Pure layout over a fixed `rules` array so the snapshot test exercises the
/// same view tree the live screen renders. Owns the search + trigger-filter
/// state and the per-identity expand/collapse set locally.
@available(iOS 17.0, *)
struct MergeRulesList: View {
    let identities: [MergeIdentity]
    @Binding var query: String
    @Binding var filter: MergeTriggerFilter
    var paging = CursorPagingState()
    var onLoadMore: () -> Void = {}
    @State private var collapsed: Set<String> = []

    var body: some View {
        if identities.isEmpty, query.isEmpty, filter == .all,
           !paging.hasPagingBoundary {
            emptyState
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    statsBar
                    MergeSearchField(text: $query, placeholder: "Search people or emails")
                    Picker("Trigger", selection: $filter) {
                        ForEach(MergeTriggerFilter.allCases) { trigger in
                            Text(trigger.label).tag(trigger)
                        }
                    }
                    .pickerStyle(.segmented)
                    if identities.isEmpty, !paging.hasPagingBoundary {
                        noMatchState
                    } else {
                        ForEach(identities) { identity in
                            MergeIdentityCard(
                                identity: identity,
                                expanded: !collapsed.contains(identity.id),
                                onToggle: { toggleCollapse(identity.id) }
                            )
                        }
                    }
                    ListPagingFooter(
                        state: paging,
                        label: "Load more merge rules",
                        retry: onLoadMore
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
            }
        }
    }

    private func toggleCollapse(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.merge")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("No merge rules")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Your people graph has no applied merges yet. Auto-detected duplicates and operator-issued merges show up here.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var noMatchState: some View {
        Text("No merge rules match the current search or filter.")
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Theme.Spacing.xl)
    }

    private var statsBar: some View {
        let ruleCount = identities.reduce(0) { $0 + $1.sources.count }
        let userCount = identities.filter { $0.kinds.contains("user") }.count
        let systemCount = identities.filter { $0.kinds.contains("system") }.count
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if paging.countIsPartial {
                Text("LOADED RESULTS")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.textMuted)
            }
            HStack(spacing: Theme.Spacing.md) {
                statChip(value: identities.count, label: identities.count == 1 ? "group" : "groups")
                statChip(value: ruleCount, label: ruleCount == 1 ? "rule" : "rules")
                statChip(value: userCount, label: "user")
                statChip(value: systemCount, label: "system")
                Spacer(minLength: 0)
            }
        }
    }

    private func statChip(value: Int, label: String) -> some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
        }
    }
}

// MARK: - Merged-identity model

/// A surviving canonical identity and the source aliases merged into it. Built
/// from the flat rule list (filtered by trigger + search), grouping every rule
/// by its winner person — mirrors the portal's `buildIdentities`.
@available(iOS 17.0, *)
struct MergeIdentity: Identifiable {
    let id: String
    let person: MergeRulePerson?
    let name: String
    let canonicalEmail: String?
    let latest: String?
    let kinds: Set<String>
    let sources: [Source]

    struct Source: Identifiable {
        let id: String
        let alias: String
        let aliasType: String
        let name: String?
        let sourceIds: [String]
        /// Why the rule exists — user-entered, or the system tier's
        /// (auto-approval / background-agent adjudication) rationale.
        let reason: String?
    }

    init(_ group: MergeRuleGroup) {
        id = group.key
        person = group.person
        name = group.name
        canonicalEmail = group.canonicalEmail
        latest = group.latest
        kinds = Set(group.kinds)
        sources = group.sources.map {
            Source(
                id: $0.ruleId,
                alias: $0.alias,
                aliasType: $0.aliasType,
                name: $0.name,
                sourceIds: $0.sourceIds,
                reason: $0.reason
            )
        }
    }

    init(
        id: String,
        person: MergeRulePerson?,
        name: String,
        canonicalEmail: String?,
        latest: String?,
        kinds: Set<String>,
        sources: [Source]
    ) {
        self.id = id
        self.person = person
        self.name = name
        self.canonicalEmail = canonicalEmail
        self.latest = latest
        self.kinds = kinds
        self.sources = sources
    }

    static func bestEmail(_ person: MergeRulePerson?) -> String? {
        (person?.aliases ?? []).first { $0.aliasType == "email" }?.alias
    }

    static func build(from rules: [MergeRule], filter: MergeTriggerFilter, query: String) -> [MergeIdentity] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()

        struct Acc {
            var person: MergeRulePerson?
            var name: String
            var canonicalEmail: String?
            var latest: String?
            var kinds: Set<String>
            var sources: [Source]
        }
        var order: [String] = []
        var byKey: [String: Acc] = [:]

        for rule in rules {
            if filter != .all, rule.kind != filter.rawValue { continue }

            let winnerIsA = rule.winnerSide == "a"
            let winner = (winnerIsA ? rule.resolvedSideA : rule.resolvedSideB)?.first
            let loser = (winnerIsA ? rule.resolvedSideB : rule.resolvedSideA)?.first
            let winnerSide = winnerIsA ? rule.sideA : rule.sideB
            let loserSide = winnerIsA ? rule.sideB : rule.sideA

            // A rule that already collapsed onto a single identity is dropped —
            // the eval pass auto-deletes these and a self-merge row would mislead.
            if let winnerId = winner?.id, winnerId == loser?.id { continue }

            if !needle.isEmpty {
                let hay = [
                    winner?.canonicalName, loser?.canonicalName,
                    bestEmail(winner), loserSide.alias, winnerSide.alias,
                ].compactMap { $0 }.joined(separator: " ").lowercased()
                if !hay.contains(needle) { continue }
            }

            let key = winner?.id ?? "\(winnerSide.aliasType)=\(winnerSide.alias)"
            let displayName = winner?.canonicalName.nilIfBlank
                ?? "\(winnerSide.aliasType)=\(winnerSide.alias)"
            let source = Source(
                id: rule.id,
                alias: loserSide.alias,
                aliasType: loserSide.aliasType,
                name: loser?.canonicalName.nilIfBlank,
                sourceIds: loser?.sourceIds ?? [],
                reason: rule.reason?.nilIfBlank
            )

            if byKey[key] == nil {
                order.append(key)
                byKey[key] = Acc(
                    person: winner,
                    name: displayName,
                    canonicalEmail: bestEmail(winner),
                    latest: rule.createdAt,
                    kinds: [rule.kind],
                    sources: [source]
                )
            } else {
                byKey[key]?.sources.append(source)
                byKey[key]?.kinds.insert(rule.kind)
                if let created = rule.createdAt, (byKey[key]?.latest ?? "") < created {
                    byKey[key]?.latest = created
                }
            }
            if byKey[key]?.canonicalEmail == nil, loserSide.aliasType == "email" {
                byKey[key]?.canonicalEmail = loserSide.alias
            }
        }

        return order.compactMap { key in
            guard let acc = byKey[key] else { return nil }
            return MergeIdentity(
                id: key,
                person: acc.person,
                name: acc.name,
                canonicalEmail: acc.canonicalEmail,
                latest: acc.latest,
                kinds: acc.kinds,
                sources: acc.sources
            )
        }
    }
}

// MARK: - Identity card

@available(iOS 17.0, *)
struct MergeIdentityCard: View {
    @Environment(AppStore.self) private var store
    let identity: MergeIdentity
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: 12)
                    PersonAvatar(name: identity.name, isSelf: false, size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(identity.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(identity.person == nil ? Theme.textSecondary : Theme.accent)
                                .lineLimit(1)
                            Text("\(identity.sources.count) \(identity.sources.count == 1 ? "rule" : "rules")")
                                .font(.system(size: 10.5))
                                .foregroundStyle(Theme.textMuted)
                        }
                        if let email = identity.canonicalEmail {
                            Text(email)
                                .font(Theme.monospace(size: 11))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let when = identity.latest.flatMap({ formatTimeAgo($0) }) {
                        Text(when)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                .padding(Theme.Spacing.md)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(spacing: 0) {
                    ForEach(identity.sources) { source in
                        Divider().overlay(Theme.borderLight)
                        sourceRow(source)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private func sourceRow(_ source: MergeIdentity.Source) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("↳")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
            VStack(alignment: .leading, spacing: 1) {
                Text(source.alias)
                    .font(Theme.monospace(size: 11.5))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                if let name = source.name {
                    Text(name)
                        .font(.system(size: 10.5))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                if let reason = source.reason {
                    Text(reason)
                        .font(.system(size: 10.5))
                        .italic()
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !source.sourceIds.isEmpty {
                PersonSourceStrip(sourceIds: source.sourceIds, store: store, max: 4, size: 13)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .padding(.leading, Theme.Spacing.lg)
        .background(Theme.bgPrimary.opacity(0.4))
    }
}

// MARK: - Shared search field

/// Search field styled to the portal's `.search-input` (magnifier + rounded
/// input on `bg-tertiary`). Shared by the Merge rules + Candidates lists.
@available(iOS 17.0, *)
struct MergeSearchField: View {
    @Binding var text: String
    var placeholder: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
            TextField(placeholder, text: $text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textPrimary)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(Theme.bgTertiary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Merge rules — list") {
    NavigationStack {
        MergeRulesList(
            identities: MergeIdentity.build(
                from: PreviewMocks.mergeRules,
                filter: .all,
                query: ""
            ),
            query: .constant(""),
            filter: .constant(.all),
            paging: CursorPagingState(nextCursor: "next")
        )
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Merge rules")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}
#endif
#endif
