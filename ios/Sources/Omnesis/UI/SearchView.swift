// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Full-corpus hybrid search. Mirrors the portal's search view: a single
/// query field, results below, tap-through to detail.
///
/// The query box uses iOS 17's `.searchable` modifier so the system
/// renders a native search bar in the navigation chrome — pulls down on
/// scroll, gets the keyboard suggestion bar, etc. Submission triggers a
/// fresh `POST /search` call against the gateway via the SearchClient
/// the AppStore exposes after pairing.
@available(iOS 17.0, *)
struct SearchView: View {
    @Environment(AppStore.self) private var store
    @Binding var menuOpen: Bool
    @State private var query: String = ""
    @State private var results: [SearchResultItem] = []
    @State private var lastResponse: SearchResponse?
    @State private var loading = false
    @State private var loadError: Error?
    /// Track whether the user has run at least one search this session
    /// — drives the "type a query to start" empty state vs. the
    /// "no results found" empty state.
    @State private var hasSearched = false
    @State private var lastQuery: String = ""

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    @FocusState private var queryFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                logoHeader
                searchField
                content
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MenuToolbarButton(isOpen: $menuOpen)
                }
            }
        }
        .omnesisColorScheme()
        #if DEBUG
            .task {
                guard !hasSearched,
                      let demoQuery = ProcessInfo.processInfo.environment["DEMO_SEARCH_QUERY"],
                      !demoQuery.isEmpty else { return }
                query = demoQuery
                await runSearch()
            }
        #endif
    }

    /// Omnesis logo above the "Search" heading — Google-homepage feel.
    /// Placed in content (not the nav bar) so it has room to breathe.
    private var logoHeader: some View {
        VStack(spacing: 6) {
            Image("OmnesisLogo")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(height: 64)
                .foregroundStyle(AppBuild.isDemo ? Theme.brandLogoDemo : Theme.brandLogo)
            Text("Search")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.sm)
        .background(Theme.bgPrimary)
    }

    /// In-content search field. We don't use `.searchable` because that
    /// pins the input to the nav-bar drawer, which sits ABOVE the logo.
    /// Putting the field in the content area gets the logo → title →
    /// input order the user asked for.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.textMuted)
            TextField("Search your data", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.search)
                .focused($queryFocused)
                .onSubmit { Task { await runSearch() } }
                .foregroundStyle(Theme.textPrimary)
                .accessibilityIdentifier("search.field")
            if !query.isEmpty {
                Button {
                    query = ""
                    queryFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            VStack(spacing: 12) {
                ProgressView()
                Text("Searching…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            GatewayErrorView(
                context: "run the search",
                error: loadError,
                onRetry: { Task { await runSearch() } }
            )
        } else if !hasSearched {
            tipsState
        } else if results.isEmpty {
            emptyResultsState
        } else {
            resultsList
        }
    }

    // MARK: - States

    private var tipsState: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Search across everything", systemImage: "magnifyingglass")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Try queries like:")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
            VStack(alignment: .leading, spacing: 8) {
                tipRow("dinner with Alex")
                tipRow("flight confirmation")
                tipRow("type:email Stripe")
                tipRow("source:gmail invoice")
                tipRow("after:2025-01-01 meeting notes")
            }
            Spacer()
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tipRow(_ text: String) -> some View {
        Button {
            query = text
            Task { await runSearch() }
        } label: {
            HStack {
                Image(systemName: "sparkle.magnifyingglass")
                    .foregroundStyle(Theme.accent)
                Text(text)
                    .font(Theme.monospace(size: 13))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
            }
            .padding(.vertical, 10)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
        }
        .buttonStyle(.plain)
    }

    private var emptyResultsState: some View {
        VStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("No results")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Nothing matched “\(lastQuery)”.")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var resultsList: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(results.enumerated()), id: \.element.id) { idx, item in
                        SearchResultLink(item: item, store: store) {
                            SearchResultRow(item: item, store: store)
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, 10)
                        }
                        .accessibilityIdentifier("search.result")
                        if idx < results.count - 1 {
                            Divider().background(Theme.borderLight).padding(.leading, 44)
                        }
                    }
                }
                if let response = lastResponse {
                    SearchPipelineFooter(response: response)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
    }

    // MARK: - Network

    private func runSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            results = []
            hasSearched = false
            loadError = nil
            return
        }
        guard let client = store.search else {
            loadError = URLError(.cannotConnectToHost)
            return
        }
        loading = true
        loadError = nil
        lastQuery = trimmed
        hasSearched = true
        defer { loading = false }
        do {
            let response = try await client.search(text: trimmed, limit: 30)
            results = response.results
            lastResponse = response
        } catch {
            loadError = error
        }
    }
}

/// One search result row — title, source/type/date meta, and a chunk-text
/// snippet. Mirrors the portal's `result-card.js`.
@available(iOS 17.0, *)
struct SearchResultRow: View {
    let item: SearchResultItem
    let store: AppStore

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            SourceIconView(sourceId: item.sourceId, store: store)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(displayTitle)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                metaRow
                if !item.chunkText.isEmpty {
                    Text(snippet)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(3)
                }
                if let breakdown = item.scoreBreakdown, Self.showsScoreBreakdown {
                    ScoreBreakdownStrip(breakdown: breakdown)
                        .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var displayTitle: String {
        item.title.isEmpty ? "(untitled)" : item.title
    }

    /// "Gmail · Email · 3h ago · Alex Smith" — drop pieces that aren't
    /// available so we never show an empty separator. For file-like
    /// document types ("attachment" / "file") the doc-type label is
    /// replaced by a coloured file-type pill ("PDF", "DOCX", "ICS", …)
    /// to match the portal's `result-card.js`.
    @ViewBuilder
    private var metaRow: some View {
        if isFileLike {
            HStack(spacing: 6) {
                FileTypePill(mimeType: nil, filename: item.title)
                let parts = metaPartsExcludingDocLabel
                if !parts.isEmpty {
                    Text(parts.joined(separator: " · "))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
            }
        } else {
            let parts = metaParts
            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
        }
    }

    private var isFileLike: Bool {
        item.documentType == "attachment" || item.documentType == "file"
    }

    private var metaParts: [String] {
        var parts: [String] = []
        let type = sourceTypeFromId(item.sourceId)
        parts.append(humanName(for: type))
        if let label = docTypeLabel(item.documentType) { parts.append(label) }
        if let when = formatTimeAgo(item.sourceCreatedAt) { parts.append(when) }
        if let author = item.author, !author.isEmpty { parts.append(author) }
        return parts
    }

    /// Same as `metaParts`, minus the doc-type label — used when the
    /// file-type pill already carries the format.
    private var metaPartsExcludingDocLabel: [String] {
        var parts: [String] = []
        let type = sourceTypeFromId(item.sourceId)
        parts.append(humanName(for: type))
        if let when = formatTimeAgo(item.sourceCreatedAt) { parts.append(when) }
        if let author = item.author, !author.isEmpty { parts.append(author) }
        return parts
    }

    /// Trim runs of whitespace and cap length — chunk text is the raw
    /// indexed content with newlines, not pre-formatted prose.
    private var snippet: String {
        let collapsed = item.chunkText
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if collapsed.count <= 240 { return collapsed }
        return String(collapsed.prefix(240)) + "…"
    }

    private static var showsScoreBreakdown: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["DEMO_HIDE_SEARCH_DIAGNOSTICS"] != "1"
        #else
        true
        #endif
    }
}

/// Compact score-component strip rendered below each result row when the
/// gateway returns a `scoreBreakdown`. Mirrors the portal's
/// `ScoreDetails` component — monospace pairs of key=value, separated
/// by hairline spacing, so a glance tells you which dimension lifted
/// this result.
@available(iOS 17.0, *)
struct ScoreBreakdownStrip: View {
    let breakdown: SearchScoreBreakdown

    var body: some View {
        FlowLayout(spacing: 8) {
            if let rank = breakdown.bm25Rank {
                chip(label: "bm25", value: "#\(rank)")
            }
            if let rank = breakdown.vectorRank {
                chip(label: "vec", value: "#\(rank)")
            }
            if let rrf = breakdown.rrfScore {
                chip(label: "rrf", value: format(rrf, places: 4))
            }
            if let bonus = breakdown.rankBonus, bonus != 0 {
                chip(label: "rankBonus", value: format(bonus, places: 3, signed: true))
            }
            if let boost = breakdown.typeBoost, boost != 0 {
                chip(label: "typeBoost", value: format(boost, places: 3, signed: true))
            }
            if let boost = breakdown.relevanceBoost, boost != 0 {
                chip(label: "relBoost", value: format(boost, places: 3, signed: true))
            }
            if let prior = breakdown.sourcePrior, prior != 0 {
                chip(label: "srcPrior", value: format(prior, places: 3, signed: true))
            }
            if let final = breakdown.finalScore {
                chip(label: "final", value: format(final, places: 4), emphasised: true)
            }
        }
    }

    private func chip(label: String, value: String, emphasised: Bool = false) -> some View {
        HStack(spacing: 3) {
            Text(label)
                .foregroundStyle(Theme.textMuted)
            Text(value)
                .foregroundStyle(emphasised ? Theme.accent : Theme.textSecondary)
        }
        .font(Theme.monospace(size: 10))
    }

    private func format(_ value: Double, places: Int, signed: Bool = false) -> String {
        let sign = signed && value > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.\(places)f", value))"
    }
}

/// "Search pipeline" footer card rendered below the results list. Mirrors
/// the portal's `PipelineDebug` component — query info, model versions,
/// per-stage status + timing, and the verbose `debug` block (model
/// readiness, query length). Always visible after a search
/// returns; there's no toggle.
@available(iOS 17.0, *)
struct SearchPipelineFooter: View {
    let response: SearchResponse

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header
            if let query = response.query {
                section("QUERY") { queryBlock(query: query) }
            }
            if let stages = response.stages {
                section("STAGES") { stagesBlock(stages: stages) }
            }
            if let debug = response.debug {
                section("DEBUG") { debugBlock(debug: debug) }
            }
            footer
        }
        .padding(.top, Theme.Spacing.md)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .font(.system(size: 11))
                .foregroundStyle(Theme.accent)
            Text("SEARCH PIPELINE")
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
            if let total = response.timing?.totalMs {
                Text("\(Int(total))ms")
                    .font(Theme.monospace(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func section(_ label: String, @ViewBuilder _ body: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.textMuted)
            body()
        }
    }

    @ViewBuilder
    private func queryBlock(query: SearchResponse.SearchQueryReport) -> some View {
        if let original = query.original, !original.isEmpty {
            kv(label: "original", value: original, mono: true)
        }
        if let effective = query.effectiveText, !effective.isEmpty,
           effective != query.original {
            kv(label: "effective", value: effective, mono: true)
        }
    }

    @ViewBuilder
    private func stagesBlock(stages: SearchResponse.SearchStages) -> some View {
        if let s = stages.bm25 { stageRow(name: "bm25", report: s) }
        if let s = stages.vector { stageRow(name: "vector", report: s) }
        if let s = stages.fusion { stageRow(name: "fusion", report: s) }
        if let s = stages.boost { stageRow(name: "boost", report: s) }
        if let s = stages.refCount { stageRow(name: "refCount", report: s) }
    }

    private func stageRow(name: String, report: SearchResponse.StageReport) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(name)
                    .font(Theme.monospace(size: 11, weight: .semibold))
                    .foregroundStyle(stageColor(report))
                if let status = report.status, status != "ran" {
                    Text(status)
                        .font(Theme.monospace(size: 10))
                        .foregroundStyle(Theme.warning)
                }
                Spacer()
                if let ms = report.durationMs {
                    Text("\(Int(ms))ms")
                        .font(Theme.monospace(size: 10))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            let metrics = stageMetrics(name: name, report: report)
            if !metrics.isEmpty {
                Text(metrics.joined(separator: " · "))
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.leading, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let reason = report.reason, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.leading, 8)
            }
        }
    }

    private func stageColor(_ report: SearchResponse.StageReport) -> Color {
        switch report.status {
        case "ran": Theme.accent
        case "skipped": Theme.warning
        default: Theme.textSecondary
        }
    }

    /// Metrics for a stage rendered on the wrapped second line, not the
    /// header. `durationMs` is shown on the header instead so the
    /// at-a-glance scan tells you which stage is slow.
    private func stageMetrics(name: String, report: SearchResponse.StageReport) -> [String] {
        var pieces: [String] = []
        if let cands = report.candidates {
            pieces.append("\(cands) cand")
        }
        if name == "fusion" {
            if let method = report.method { pieces.append(method) }
            if let count = report.resultCount { pieces.append("→\(count)") }
            if let k = report.rrfK { pieces.append("k=\(k)") }
        }
        if name == "vector" {
            if let q = report.quantization { pieces.append(q) }
            if let rescore = report.rescore, rescore { pieces.append("rescore") }
            if let k = report.effectiveK { pieces.append("k=\(k)") }
            if let embed = report.embedMs { pieces.append("embed \(Int(embed))ms") }
            if let sql = report.sqlMs { pieces.append("sql \(Int(sql))ms") }
        }
        return pieces
    }

    @ViewBuilder
    private func debugBlock(debug: SearchResponse.SearchDebugInfo) -> some View {
        if let model = debug.modelState {
            if let vec = model.vector {
                kv(label: "vector", value: vec, valueColor: vec == "ready" ? Theme.success : Theme.warning, mono: true)
            }
        }
        if let q = debug.query {
            if let n = q.inputLength {
                kv(label: "inputLen", value: "\(n) chars")
            }
        }
        if let embedding = response.models?.embedding {
            kv(label: "embedding", value: embedding, mono: true)
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let timing = response.timing {
            HStack(spacing: 10) {
                if let cands = timing.bm25Candidates {
                    Text("bm25 \(cands)")
                        .font(Theme.monospace(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
                if let cands = timing.vectorCandidates {
                    Text("vec \(cands)")
                        .font(Theme.monospace(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
                Spacer()
                Text("\(response.results.count) result\(response.results.count == 1 ? "" : "s")")
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textSecondary)
            }
            .padding(.top, 2)
        }
    }

    private func kv(label: String, value: String, valueColor: Color = Theme.textPrimary, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label)
                .font(Theme.monospace(size: 10))
                .foregroundStyle(Theme.textMuted)
                .frame(minWidth: 60, alignment: .leading)
            Text(value)
                .font(mono ? Theme.monospace(size: 10) : .system(size: 10))
                .foregroundStyle(valueColor)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Search — empty (tips)") {
    @Previewable @State var menuOpen = false
    return SearchView(menuOpen: $menuOpen)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Search — load error") {
    GatewayErrorView(
        context: "run the search",
        error: URLError(.cannotConnectToHost),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search — results") {
    NavigationStack {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(PreviewMocks.searchResults.enumerated()), id: \.element.id) { idx, item in
                        SearchResultRow(item: item, store: AppStore.preview())
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, 10)
                        if idx < PreviewMocks.searchResults.count - 1 {
                            Divider().background(Theme.borderLight).padding(.leading, 44)
                        }
                    }
                }
                SearchPipelineFooter(response: PreviewMocks.searchResponseVerbose)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Search")
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Search — pipeline footer only") {
    ScrollView {
        SearchPipelineFooter(response: PreviewMocks.searchResponseVerbose)
            .padding()
    }
    .background(Theme.bgPrimary.ignoresSafeArea())
    .preferredColorScheme(.dark)
}
#endif
#endif
