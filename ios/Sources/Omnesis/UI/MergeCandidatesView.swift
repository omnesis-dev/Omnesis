// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Merge-candidate triage — mirrors the portal's Candidates tab
/// (`packages/gateway/portal/js/views/merge-candidates.js`).
///
/// The fuzzy detector surfaces probable-duplicate identity clusters. Every
/// member is checked by default; untick any that aren't the same person, then
/// **Merge** unifies the rest (`POST /people/merge-candidates/merge-cluster`)
/// and **Dismiss** denies the grouping (`POST /people/merge-candidates/:id/deny`).
/// A `Pending` / `Denied` segmented filter sits at the top, and each member
/// shows its identifying attributes as calm, borderless tokens (a small
/// uppercase type label + a mono value) instead of bordered pills. Applied
/// merges live in the Merge rules tab, so there is no "Accepted" filter here.
@available(iOS 17.0, *)
enum MergeCandidateStatus: String, CaseIterable, Identifiable {
    case pending, denied
    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .pending: "Pending"
        case .denied: "Denied"
        }
    }
}

@available(iOS 17.0, *)
struct MergeCandidatesView: View {
    @Environment(AppStore.self) private var store

    @State private var page: MergeCandidatesPage?
    @State private var status: MergeCandidateStatus = .pending
    @State private var query = ""
    @State private var loading = true
    @State private var loadError: Error?
    @State private var paging = CursorPagingState()

    var body: some View {
        content
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Candidates")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load() }
            .task(id: "\(status.rawValue):\(query)") {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await load()
            }
            .omnesisColorScheme()
    }

    @ViewBuilder
    private var content: some View {
        if loading, page == nil {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, page == nil {
            GatewayErrorView(
                context: "load merge candidates",
                error: loadError,
                onRetry: { Task { await load() } }
            )
        } else if let page {
            MergeCandidatesList(
                page: page,
                status: $status,
                query: $query,
                paging: paging,
                onLoadMore: { Task { await loadMore() } },
                onMerge: { personIds in try await merge(personIds) },
                onDismiss: { candidateIds in try await dismiss(candidateIds) }
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
            let loaded = try await client.listMergeCandidates(
                status: status.rawValue,
                clusterLimit: 25,
                query: query
            )
            guard paging.owns(request) else { return }
            page = loaded
            loadError = nil
            loading = false
            paging.finishRefresh(request, nextCursor: loaded.pageInfo.nextCursor)
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
            let loaded = try await client.listMergeCandidates(
                status: status.rawValue,
                clusterLimit: 25,
                cursor: request.cursor,
                query: query
            )
            guard paging.owns(request) else { return }
            let current = page?.items ?? []
            var items = current
            let fresh = appendUnique(loaded.items, to: &items, id: \.id)
            page = MergeCandidatesPage(
                items: items,
                counts: loaded.counts,
                pageInfo: loaded.pageInfo
            )
            paging.finishLoadMore(
                request,
                nextCursor: loaded.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }

    private func merge(_ personIds: [String]) async throws -> String {
        guard let client = store.search else { throw URLError(.cannotConnectToHost) }
        let result = try await client.mergeCluster(personIds: personIds)
        await load()
        return "Merged \(personIds.count) identities — \(result.rulesCreated) rule(s) created."
    }

    private func dismiss(_ candidateIds: [String]) async throws -> String {
        guard let client = store.search else { throw URLError(.cannotConnectToHost) }
        for id in candidateIds {
            try await client.denyMergeCandidate(id: id)
        }
        await load()
        return "Dismissed — won't be re-proposed."
    }
}

// MARK: - Cluster model

/// A connected-component cluster of candidate pairs: its de-duplicated member
/// people plus the candidate ids that bridge them (needed to deny the whole
/// grouping). Built from the flat candidate list, preserving API order.
@available(iOS 17.0, *)
struct MergeCandidateCluster: Identifiable {
    let id: String
    let members: [MergeRulePerson]
    let candidateIds: [String]

    static func build(from candidates: [MergeCandidate], dropSingletons: Bool = true) -> [MergeCandidateCluster] {
        struct Acc {
            var memberOrder: [String] = []
            var members: [String: MergeRulePerson] = [:]
            var candidateIds: [String] = []
        }
        var order: [String] = []
        var byCluster: [String: Acc] = [:]
        for cand in candidates {
            let cid = cand.clusterId ?? cand.id
            if byCluster[cid] == nil {
                byCluster[cid] = Acc()
                order.append(cid)
            }
            byCluster[cid]?.candidateIds.append(cand.id)
            for person in cand.resolvedSideA + cand.resolvedSideB where byCluster[cid]?.members[person.id] == nil {
                byCluster[cid]?.memberOrder.append(person.id)
                byCluster[cid]?.members[person.id] = person
            }
        }
        return order.compactMap { cid -> MergeCandidateCluster? in
            guard let acc = byCluster[cid] else { return nil }
            let members = acc.memberOrder.compactMap { acc.members[$0] }
            // In the pending queue, a single-identity cluster has nothing to
            // merge (both sides of its candidate pair resolved to the same
            // person, e.g. already merged) — drop it rather than render a dead
            // "Merge 1" button. The accepted/denied views are read-only audits,
            // so they keep the collapsed singletons.
            if dropSingletons, members.count < 2 { return nil }
            guard !members.isEmpty else { return nil }
            return MergeCandidateCluster(id: cid, members: members, candidateIds: acc.candidateIds)
        }
    }

    /// A name-like member's name for the card title; falls back to any member.
    var title: String {
        let named = members.first {
            $0.canonicalName.contains(" ") && !$0.canonicalName.contains("@")
        }
        return named?.canonicalName
            ?? members.first?.canonicalName.nilIfEmpty
            ?? "Unknown"
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

// MARK: - List (shared with the preview wrapper)

/// Pure layout over a fixed page so the snapshot test exercises the same view
/// tree the live screen renders. Owns per-cluster selection + busy + notice +
/// collapse + attribute-expand state locally; delegates the mutations to the
/// `onMerge` / `onDismiss` closures (which return the banner text or throw).
@available(iOS 17.0, *)
struct MergeCandidatesList: View {
    let page: MergeCandidatesPage
    @Binding var status: MergeCandidateStatus
    @Binding var query: String
    var paging = CursorPagingState()
    var onLoadMore: () -> Void = {}
    /// Returns the success-banner text; throws to surface a failure banner.
    var onMerge: ([String]) async throws -> String = { _ in "" }
    var onDismiss: ([String]) async throws -> String = { _ in "" }

    private static let attrLimit = 4

    /// Per-cluster set of deselected person ids (absence = checked).
    @State private var deselected: [String: Set<String>] = [:]
    @State private var busy: Set<String> = []
    /// Cluster ids merged/dismissed this session — dropped optimistically since
    /// the merge is eventually consistent and lingers until the gateway
    /// materializes it.
    @State private var resolved: Set<String> = []
    @State private var collapsed: Set<String> = []
    @State private var attrExpanded: Set<String> = []
    @State private var notice: Notice?

    private struct Notice: Equatable {
        let ok: Bool
        let text: String
    }

    private var isPending: Bool {
        status == .pending
    }

    private var clusters: [MergeCandidateCluster] {
        let all = MergeCandidateCluster.build(from: page.items, dropSingletons: isPending)
            .filter { !resolved.contains($0.id) }
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return all }
        return all.filter { cluster in
            let hay = ([cluster.title] + cluster.members.map(\.canonicalName)
                + cluster.members.flatMap { ($0.aliases ?? []).map(\.alias) })
                .joined(separator: " ").lowercased()
            return hay.contains(needle)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                statsBar
                hint
                MergeSearchField(text: $query, placeholder: "Search clusters or identifiers")
                Picker("Status", selection: $status) {
                    ForEach(MergeCandidateStatus.allCases) { candidateStatus in
                        Text(candidateStatus.label).tag(candidateStatus)
                    }
                }
                .pickerStyle(.segmented)
                if let notice {
                    noticeBanner(notice)
                }
                if clusters.isEmpty, !paging.hasPagingBoundary {
                    emptyState
                } else {
                    ForEach(clusters) { cluster in
                        clusterCard(cluster)
                    }
                }
                ListPagingFooter(
                    state: paging,
                    label: "Load more candidates",
                    retry: onLoadMore
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
        }
    }

    // MARK: Selection helpers

    private func isChecked(_ clusterId: String, _ personId: String) -> Bool {
        !(deselected[clusterId]?.contains(personId) ?? false)
    }

    private func toggle(_ clusterId: String, _ personId: String) {
        var set = deselected[clusterId] ?? []
        if set.contains(personId) { set.remove(personId) } else { set.insert(personId) }
        deselected[clusterId] = set
    }

    private func checkedMemberIds(_ cluster: MergeCandidateCluster) -> [String] {
        cluster.members.map(\.id).filter { isChecked(cluster.id, $0) }
    }

    private func toggleAll(_ cluster: MergeCandidateCluster, allChecked: Bool) {
        deselected[cluster.id] = allChecked ? Set(cluster.members.map(\.id)) : []
    }

    // MARK: Actions

    private func runMerge(_ cluster: MergeCandidateCluster) {
        let ids = checkedMemberIds(cluster)
        guard ids.count >= 2 else {
            notice = Notice(ok: false, text: "Select at least two identities to merge.")
            return
        }
        busy.insert(cluster.id)
        notice = nil
        Task {
            defer { busy.remove(cluster.id) }
            do {
                let text = try await onMerge(ids)
                deselected[cluster.id] = nil
                resolved.insert(cluster.id)
                notice = Notice(ok: true, text: text)
            } catch {
                notice = Notice(ok: false, text: "Merge failed: \(gatewayMessage(error))")
            }
        }
    }

    private func runDismiss(_ cluster: MergeCandidateCluster) {
        busy.insert(cluster.id)
        notice = nil
        Task {
            defer { busy.remove(cluster.id) }
            do {
                let text = try await onDismiss(cluster.candidateIds)
                deselected[cluster.id] = nil
                resolved.insert(cluster.id)
                notice = Notice(ok: true, text: text)
            } catch {
                notice = Notice(ok: false, text: "Dismiss failed: \(gatewayMessage(error))")
            }
        }
    }

    private func gatewayMessage(_ error: Error) -> String {
        let gatewayError = error as? GatewayClient.Error
        return switch gatewayError {
        case .unauthorized: "not authorized"
        case .forbidden: "this device lacks admin scope"
        case .internalSource: "not available for gateway-hosted sources"
        case .notFound: "candidate no longer exists"
        case .serverError(_, let body):
            gatewayError?.gatewayMessage ?? (body.isEmpty ? "server error" : body)
        case .invalidResponse, .invalidURL: "bad gateway response"
        case .decoding: "could not read the response"
        case .none: error.localizedDescription
        }
    }

    // MARK: Subviews

    private var statsBar: some View {
        HStack(spacing: Theme.Spacing.md) {
            statChip(value: page.counts.pending, label: "pending", color: Theme.warning)
            statChip(value: page.counts.denied, label: "denied", color: Theme.textPrimary)
            Spacer(minLength: 0)
        }
    }

    private func statChip(value: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(color)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
        }
    }

    private var hint: some View {
        Text(
            "Probable duplicates, grouped into clusters. Members are checked by default — "
                + "untick any that aren't the same person, then Merge to unify the rest. "
                + "Dismiss never re-proposes a grouping."
        )
        .font(.footnote)
        .foregroundStyle(Theme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func noticeBanner(_ notice: Notice) -> some View {
        Text(notice.text)
            .font(.system(size: 12))
            .foregroundStyle(notice.ok ? Theme.success : Theme.danger)
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((notice.ok ? Theme.success : Theme.danger).opacity(0.10))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke((notice.ok ? Theme.success : Theme.danger).opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    @ViewBuilder
    private func clusterCard(_ cluster: MergeCandidateCluster) -> some View {
        let isBusy = busy.contains(cluster.id)
        let isCollapsed = collapsed.contains(cluster.id)
        let checkedCount = checkedMemberIds(cluster).count
        let allChecked = checkedCount == cluster.members.count
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: Theme.Spacing.sm) {
                PersonAvatar(name: cluster.title, isSelf: false, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(cluster.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        Text("\(cluster.members.count) \(cluster.members.count == 1 ? "entity" : "entities")")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                        if isPending {
                            Text("\(checkedCount) of \(cluster.members.count) selected")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
                Spacer(minLength: 0)
                if isPending {
                    Button(allChecked ? "Uncheck all" : "Check all") {
                        toggleAll(cluster, allChecked: allChecked)
                    }
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .disabled(isBusy)
                }
                Button {
                    toggleCollapse(cluster.id)
                } label: {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(Theme.Spacing.md)

            if !isCollapsed {
                Divider().overlay(Theme.borderLight)
                VStack(spacing: 0) {
                    ForEach(Array(cluster.members.enumerated()), id: \.element.id) { index, member in
                        if index > 0 { Divider().overlay(Theme.borderLight) }
                        memberRow(cluster, member)
                    }
                }
                if isPending {
                    actionRow(cluster, checkedCount: checkedCount, isBusy: isBusy)
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
        .opacity(isBusy ? 0.6 : 1)
    }

    private func toggleCollapse(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
    }

    @ViewBuilder
    private func memberRow(_ cluster: MergeCandidateCluster, _ member: MergeRulePerson) -> some View {
        let checked = isChecked(cluster.id, member.id)
        let attrs = sortedAliases(member)
        let key = "\(cluster.id):\(member.id)"
        let expanded = attrExpanded.contains(key)
        let shown = expanded ? attrs : Array(attrs.prefix(Self.attrLimit))
        let hidden = attrs.count - shown.count
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            if isPending {
                Button {
                    toggle(cluster.id, member.id)
                } label: {
                    Image(systemName: checked ? "checkmark.square.fill" : "square")
                        .font(.system(size: 18))
                        .foregroundStyle(checked ? Theme.accent : Theme.textMuted)
                }
                .buttonStyle(.plain)
                .disabled(busy.contains(cluster.id))
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(member.canonicalName.isEmpty ? "(unnamed)" : member.canonicalName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(checked ? Theme.textPrimary : Theme.textMuted)
                    .lineLimit(1)
                FlowLayout(spacing: 10) {
                    ForEach(shown) { attr in
                        attrToken(attr)
                    }
                    if attrs.count > Self.attrLimit {
                        Button(expanded ? "show less" : "+\(hidden) more") {
                            toggleAttrs(key)
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.Spacing.md)
    }

    private func attrToken(_ attr: MergeRuleSide) -> some View {
        HStack(spacing: 5) {
            Text(attr.aliasType)
                .font(.system(size: 9, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(Theme.textMuted)
            Text(attr.alias)
                .font(Theme.monospace(size: 11))
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private func actionRow(_ cluster: MergeCandidateCluster, checkedCount: Int, isBusy: Bool) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button {
                runMerge(cluster)
            } label: {
                Text("Merge \(checkedCount)")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(isBusy || checkedCount < 2)

            Button {
                runDismiss(cluster)
            } label: {
                Text("Dismiss")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Theme.danger)
            .disabled(isBusy)
        }
        .padding(Theme.Spacing.md)
        .overlay(alignment: .center) {
            if isBusy { ProgressView() }
        }
    }

    private func toggleAttrs(_ key: String) {
        if attrExpanded.contains(key) { attrExpanded.remove(key) } else { attrExpanded.insert(key) }
    }

    /// A member's aliases, strongest first (email > phone > lid > name).
    private func sortedAliases(_ member: MergeRulePerson) -> [MergeRuleSide] {
        let rank = ["email": 0, "phone": 1, "lid": 2, "name": 3]
        return (member.aliases ?? []).sorted {
            (rank[$0.aliasType] ?? 9, $0.alias) < (rank[$1.aliasType] ?? 9, $1.alias)
        }
    }

    private struct EmptyCopy {
        let icon: String
        let title: String
        let body: String
    }

    private var emptyState: some View {
        let copy = switch status {
        case .pending: EmptyCopy(
                icon: "checkmark.circle",
                title: "No pending candidates",
                body: "The fuzzy detector hasn't found any probable duplicates you haven't already decided on."
            )
        case .denied: EmptyCopy(
                icon: "xmark.circle",
                title: "Nothing dismissed yet",
                body: "Clusters you dismiss won't be re-proposed, and are listed here."
            )
        }
        return VStack(spacing: 10) {
            Image(systemName: copy.icon)
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text(query.isEmpty ? copy.title : "No matching clusters")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(query.isEmpty ? copy.body : "No clusters match your search.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.xl)
    }
}

// `FlowLayout` (wrapping layout for the borderless attribute tokens) is shared
// from PersonDetailView.swift.

extension MergeRuleSide: Identifiable {
    public var id: String {
        "\(aliasType):\(alias)"
    }
}

// Note: `id` is intentionally public to match MergeRuleSide's public access.

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Merge candidates — clusters") {
    NavigationStack {
        MergeCandidatesList(
            page: PreviewMocks.mergeCandidates,
            status: .constant(.pending),
            query: .constant(""),
            paging: CursorPagingState(nextCursor: "next")
        )
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Candidates")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}
#endif
#endif
