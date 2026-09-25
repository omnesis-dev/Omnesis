// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// People list — mirrors the portal's `/people` view. Self pinned to
/// the top, followed by everyone else in interaction-score-recent
/// order. Search box filters server-side. Tap a row to push
/// `PersonDetailView`. Two count buttons at the top of the list open the
/// merge-candidate review queue and the read-only merge-rules viewer,
/// labelled with live counts from `GET /people/stats`.
@available(iOS 17.0, *)
struct PeopleView: View {
    @Environment(AppStore.self) private var store

    @State private var query: String = ""
    @State private var debouncedQuery: String = ""
    @State private var people: [PersonSummary] = []
    @State private var stats: PeopleStats?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var paging = CursorPagingState()
    @State private var showCandidates = false
    @State private var showRules = false
    @Binding var menuOpen: Bool

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("People")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        MenuToolbarButton(isOpen: $menuOpen)
                    }
                }
                .navigationDestination(isPresented: $showCandidates) {
                    MergeCandidatesView()
                }
                .navigationDestination(isPresented: $showRules) {
                    MergeRulesView()
                }
                .searchable(
                    text: $query,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search people"
                )
                .onChange(of: query) { _, newValue in
                    Task { await debounce(query: newValue) }
                }
                .refreshable {
                    await load(query: debouncedQuery)
                    await loadStats()
                }
                .task {
                    await load(query: "")
                    await loadStats()
                }
        }
        .omnesisColorScheme()
    }

    @ViewBuilder
    private var content: some View {
        if loading, people.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, people.isEmpty {
            GatewayErrorView(
                context: "load people",
                error: loadError,
                onRetry: { Task { await load(query: debouncedQuery) } }
            )
        } else if !shouldShowPagedContent(itemCount: people.count, paging: paging) {
            emptyState
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    if debouncedQuery.isEmpty, let stats {
                        mergeShortcuts(stats)
                    }
                    let groups = grouped(people)
                    if let selfPerson = groups.selfPerson {
                        sectionHeader("YOU")
                        NavigationLink {
                            PersonDetailView(personId: selfPerson.id, presetName: selfPerson.canonicalName)
                        } label: {
                            personRow(selfPerson)
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.bottom, Theme.Spacing.md)
                    }

                    if !groups.top.isEmpty, debouncedQuery.isEmpty {
                        sectionHeader("TOP CONTACTS")
                        VStack(spacing: 0) {
                            ForEach(groups.top, content: rowWithLink)
                        }
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.bottom, Theme.Spacing.md)
                    }

                    if !Self.storeArtworkTopContactsOnly {
                        sectionHeader(debouncedQuery.isEmpty ? "EVERYONE" : "RESULTS")
                        VStack(spacing: 0) {
                            ForEach(groups.rest, content: rowWithLink)
                        }
                        .padding(.horizontal, Theme.Spacing.lg)

                        ListPagingFooter(
                            state: paging,
                            label: "Load more people",
                            retry: { Task { await loadMore() } }
                        )
                        .padding(.horizontal, Theme.Spacing.lg)
                    }

                    Color.clear.frame(height: Theme.Spacing.lg)
                }
            }
        }
    }

    private static var storeArtworkTopContactsOnly: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["DEMO_PEOPLE_TOP_CONTACTS_ONLY"] == "1"
        #else
        false
        #endif
    }

    private func sectionHeader(_ text: String) -> some View {
        FlatSectionHeader(title: text)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.sm)
    }

    /// Two side-by-side count buttons that jump to the merge-candidate
    /// review queue and the read-only merge-rules viewer. Counts come from
    /// `GET /people/stats`; the buttons scroll with the list above "YOU".
    private func mergeShortcuts(_ stats: PeopleStats) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            MergeShortcutPill(
                count: stats.pendingMergeCandidates,
                noun: "merge candidate",
                systemImage: "person.2.badge.gearshape",
                action: { showCandidates = true }
            )
            MergeShortcutPill(
                count: stats.mergeRules,
                noun: "merge rule",
                systemImage: "arrow.triangle.merge",
                action: { showRules = true }
            )
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
    }

    @ViewBuilder
    private func rowWithLink(_ person: PersonSummary) -> some View {
        NavigationLink {
            PersonDetailView(personId: person.id, presetName: person.canonicalName)
        } label: {
            personRow(person)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        Divider()
            .background(Theme.borderLight)
            .padding(.leading, 56)
    }

    private func personRow(_ person: PersonSummary) -> some View {
        PersonRow(person: person)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.2")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text(debouncedQuery.isEmpty ? "No people yet" : "No matches")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(debouncedQuery.isEmpty
                ? "People are extracted automatically as your sources sync."
                : "Try a different name, email, or phone.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Helpers

    /// Pull self to a featured slot, top-9 contacts to a "TOP CONTACTS"
    /// section (only when there's no search), and rest below. Mirrors
    /// the portal's three-section layout.
    private func grouped(_ people: [PersonSummary]) -> (selfPerson: PersonSummary?, top: [PersonSummary], rest: [PersonSummary]) {
        let selfPerson = people.first(where: { $0.isSelf })
        let nonSelf = people.filter { !$0.isSelf }
        if debouncedQuery.isEmpty {
            let top = Array(nonSelf.prefix(9))
            let rest = Array(nonSelf.dropFirst(top.count))
            return (selfPerson, top, rest)
        }
        return (selfPerson, [], nonSelf)
    }

    /// 250ms debounce so a fast typist doesn't hammer the gateway.
    private func debounce(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        try? await Task.sleep(nanoseconds: 250_000_000)
        if trimmed == query.trimmingCharacters(in: .whitespacesAndNewlines) {
            debouncedQuery = trimmed
            await load(query: trimmed)
        }
    }

    private func load(query: String) async {
        let request = paging.beginRefresh()
        guard let client = store.search else {
            paging.failRefresh(request)
            loadError = URLError(.cannotConnectToHost)
            loading = false
            return
        }
        loading = true
        do {
            let page = try await client.listPeoplePage(
                query: query.isEmpty ? nil : query,
                limit: 50
            )
            guard paging.owns(request) else { return }
            people = page.items
            loading = false
            paging.finishRefresh(request, nextCursor: page.pageInfo.nextCursor)
            loadError = nil
        } catch {
            guard paging.owns(request) else { return }
            loading = false
            paging.failRefresh(request)
            loadError = error
        }
    }

    private func loadMore() async {
        guard let client = store.search else { return }
        guard let request = paging.beginLoadMore() else { return }
        do {
            let page = try await client.listPeoplePage(
                query: debouncedQuery.isEmpty ? nil : debouncedQuery,
                limit: 50,
                cursor: request.cursor
            )
            guard paging.owns(request) else { return }
            let fresh = appendUnique(page.items, to: &people, id: \.id)
            paging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }

    /// Refresh the merge-shortcut counts. Independent of the people query —
    /// only fetched on first appear and pull-to-refresh, never per keystroke.
    /// A failure here leaves the buttons hidden rather than blocking the list.
    private func loadStats() async {
        guard let client = store.search else { return }
        stats = try? await client.peopleStats()
    }
}

// MARK: - Row

/// One row in the People list. Renders the avatar, name (truncates
/// first when space is tight), source-icon provenance strip, and the
/// trailing doc-count column. Shared between `PeopleView` and the
/// preview wrapper so the snapshot test exercises the real layout.
@available(iOS 17.0, *)
struct PersonRow: View {
    @Environment(AppStore.self) private var store
    let person: PersonSummary

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            PersonAvatar(name: person.canonicalName, isSelf: person.isSelf)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(person.canonicalName.isEmpty ? "(no name)" : person.canonicalName)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if person.isSelf {
                        Text("(self)")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.success)
                            .fixedSize()
                    }
                }
                PersonRow.metaRow(person: person)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(0)
            if let ids = person.sourceIds, !ids.isEmpty {
                PersonSourceStrip(sourceIds: ids, store: store)
                    .layoutPriority(1)
            }
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(person.documentCount)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .monospacedDigit()
                Text("docs")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
            .layoutPriority(1)
        }
    }

    static func metaRow(person: PersonSummary) -> some View {
        HStack(spacing: 6) {
            if person.aliasCount > 0 {
                Text("\(person.aliasCount) aliases")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
            if let lastSeen = formatTimeAgo(person.lastSeen) {
                if person.aliasCount > 0 {
                    Text("·").foregroundStyle(Theme.textMuted)
                }
                Text("seen \(lastSeen)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .lineLimit(1)
    }
}

/// Compact source-icon strip — mirrors the portal's
/// `renderSourceStripFromIds()`. Dedupes by full sourceId (so two
/// distinct gmail accounts render two gmail icons), preserves the
/// first-occurrence order, and caps to `max` to keep a long-tail
/// person from blowing past the doc-count column on narrow phones.
@available(iOS 17.0, *)
struct PersonSourceStrip: View {
    let sourceIds: [String]
    let store: AppStore
    var max: Int = 5
    var size: CGFloat = 14

    var body: some View {
        let visible = Self.dedupePreservingOrder(sourceIds).prefix(max)
        HStack(spacing: 3) {
            ForEach(Array(visible), id: \.self) { id in
                SourceIconView(sourceId: id, store: store, size: size)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    static func dedupePreservingOrder(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

// MARK: - Avatar

/// Initials avatar with a stable hash-derived background. Self gets a
/// green ring + (self) label.
@available(iOS 17.0, *)
struct PersonAvatar: View {
    let name: String
    let isSelf: Bool
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            Circle()
                .fill(backgroundColor)
                .frame(width: size, height: size)
            if isSelf {
                Circle()
                    .stroke(Theme.success, lineWidth: 2)
                    .frame(width: size, height: size)
            }
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(Color.white)
        }
    }

    private var initials: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "?" }
        let parts = trimmed.split(separator: " ", maxSplits: 1)
        if parts.count == 2 {
            return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
        }
        return String(trimmed.prefix(2)).uppercased()
    }

    /// Deterministic colour from the name hash — same person always
    /// gets the same swatch.
    private var backgroundColor: Color {
        let palette: [UInt32] = [
            0x5B8DEF, 0x7B4EE0, 0xD24FE0, 0xE0556E,
            0xE08855, 0xD2A455, 0x6DC257, 0x4DBFAE,
            0x4F9FD2, 0x9B6DD2, 0xC25777,
        ]
        let hash = name.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return Color(hex: palette[abs(hash) % palette.count])
    }
}

// MARK: - Merge shortcut pill

/// One of the two count buttons at the top of the People list. Shows the
/// count large with the unit noun beneath (e.g. "133" / "merge candidates")
/// and a trailing chevron; the whole card is tappable. Pluralizes the noun
/// on the count.
@available(iOS 17.0, *)
struct MergeShortcutPill: View {
    let count: Int
    let noun: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    Text("\(count)")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.bgSecondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Theme.borderLight, lineWidth: 1)
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) \(label)")
    }

    private var label: String {
        "\(noun)\(count == 1 ? "" : "s")"
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("People — list") {
    // Inject mock people directly via a wrapper so we don't need to
    // hit the network in preview.
    PeoplePreviewWrapper()
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("People — empty") {
    @Previewable @State var menuOpen = false
    return PeopleView(menuOpen: $menuOpen)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("People — load error") {
    // PeopleView's loadError is private state, so render the
    // GatewayErrorView directly with the same `context` string the
    // view uses at runtime. Locks in the per-page error copy.
    GatewayErrorView(
        context: "load people",
        error: URLError(.cannotConnectToHost),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("People — long-name row") {
    // Isolated row preview so the name-truncation behaviour is easy
    // to inspect without scrolling the full list.
    let long = PreviewMocks.peopleSummaries.first { $0.id == "p-long" }!
    return VStack(spacing: 0) {
        PersonRow(person: long)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
        Divider().background(Theme.borderLight).padding(.leading, 56)
        PersonRow(person: PreviewMocks.peopleSummaries.first { $0.isSelf }!)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
    }
    .frame(maxWidth: .infinity)
    .background(Theme.bgSecondary)
    .padding()
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Merge shortcut pills") {
    /// Cover the count edge cases that change layout/copy: typical large
    /// count, singular (no "s"), zero, and a very large count that must
    /// scale down rather than overflow the chevron.
    func row(candidates: Int, rules: Int) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            MergeShortcutPill(
                count: candidates,
                noun: "merge candidate",
                systemImage: "person.2.badge.gearshape",
                action: {}
            )
            MergeShortcutPill(
                count: rules,
                noun: "merge rule",
                systemImage: "arrow.triangle.merge",
                action: {}
            )
        }
    }
    return VStack(spacing: Theme.Spacing.md) {
        row(candidates: 133, rules: 415)
        row(candidates: 1, rules: 0)
        row(candidates: 0, rules: 1)
        row(candidates: 12048, rules: 9999)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

/// Tiny wrapper that hands `PeopleView` an already-populated state so
/// the preview shows the full layout instead of the loading spinner.
@available(iOS 17.0, *)
struct PeoplePreviewWrapper: View {
    @State private var people: [PersonSummary] = PreviewMocks.peopleSummaries
    var body: some View {
        // Render a static composition that mirrors PeopleView's layout
        // without the network task — keeps the preview deterministic
        // and works in Xcode without a paired gateway.
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 0) {
                    HStack(spacing: Theme.Spacing.md) {
                        MergeShortcutPill(
                            count: 133,
                            noun: "merge candidate",
                            systemImage: "person.2.badge.gearshape",
                            action: {}
                        )
                        MergeShortcutPill(
                            count: 415,
                            noun: "merge rule",
                            systemImage: "arrow.triangle.merge",
                            action: {}
                        )
                    }
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.top, Theme.Spacing.sm)
                    .padding(.bottom, Theme.Spacing.md)
                    FlatSectionHeader(title: "YOU")
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.bottom, Theme.Spacing.sm)
                    if let me = people.first(where: { $0.isSelf }) {
                        peopleRowPreview(me)
                            .padding(.horizontal, Theme.Spacing.lg)
                    }
                    FlatSectionHeader(title: "EVERYONE")
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.bottom, Theme.Spacing.sm)
                    VStack(spacing: 0) {
                        ForEach(people.filter { !$0.isSelf }) { p in
                            peopleRowPreview(p)
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, 10)
                            Divider().background(Theme.borderLight).padding(.leading, 56)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.lg)
                    ListPagingFooter(
                        state: CursorPagingState(nextCursor: "preview-next"),
                        label: "Load more people",
                        retry: {}
                    )
                    .padding(.horizontal, Theme.Spacing.lg)
                    Spacer().frame(height: Theme.Spacing.lg)
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("People")
        }
        .preferredColorScheme(.dark)
    }

    private func peopleRowPreview(_ person: PersonSummary) -> some View {
        PersonRow(person: person)
    }
}
#endif
#endif
