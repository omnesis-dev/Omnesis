// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Cross-device source list — full parity with the portal's Sources
/// page. The hero card mirrors `OverviewBar` (indexing %, doc/chunk
/// counts, db size, embedding model). Per-source rows show count,
/// indexing %, sync state, last sync, and last activity (with title
/// of the most recent doc when available). Drill into
/// `SourceDetailView` for actions + debug.
///
/// Data flow:
///   - Initial load: `/admin/sources` + `/admin/sync/status` +
///     `/status` + `/index/stats` on appear.
///   - Live updates: WS `sync.status` events drive
///     `syncStatusesBySource` in place.
///   - Pull-to-refresh re-fetches everything.
@available(iOS 17.0, *)
struct SourcesView: View {
    @Environment(AppStore.self) private var store
    @Binding var menuOpen: Bool

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Sources")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        MenuToolbarButton(isOpen: $menuOpen)
                    }
                }
                .refreshable {
                    await store.refreshSources()
                    await store.refreshGatewayStats()
                }
                .task {
                    if store.sources.isEmpty, store.internalSources.isEmpty { await store.refreshSources() }
                    await store.refreshGatewayStats()
                }
        }
        .omnesisColorScheme()
    }

    @ViewBuilder
    private var content: some View {
        if store.sources.isEmpty, store.internalSources.isEmpty, store.pendingSourceRemovals.isEmpty, !store.sourcesLoading {
            // Two empty paths: a load error gets the full-screen
            // connection-error surface (with shared Retry / Open
            // settings affordances); an empty-with-no-error renders
            // the "No sources yet" pitch.
            if let err = store.sourcesError {
                GatewayErrorView(
                    context: "load sources",
                    error: err,
                    onRetry: {
                        Task {
                            await store.refreshSources()
                            await store.refreshGatewayStats()
                        }
                    }
                )
            } else {
                emptyState
            }
        } else {
            ScrollView {
                LazyVStack(spacing: Theme.Spacing.md) {
                    OverviewCard(store: store)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.top, Theme.Spacing.sm)

                    ForEach(store.pendingSourceRemovals) { removal in
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Label("Removing " + humanName(for: removal.type), systemImage: "trash")
                                .font(.headline)
                            Text(removal.accountId).font(.caption).foregroundStyle(Theme.textSecondary)
                            Text("Gateway cleanup is still pending. Re-add this source after cleanup finishes. Pull to refresh its status.")
                                .font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.Spacing.md)
                        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.medium))
                        .padding(.horizontal, Theme.Spacing.lg)
                    }

                    // A source whose pushes the gateway is refusing still
                    // renders a healthy row below (its last sync completed —
                    // the upload is what failed), so the warning has to live
                    // above the list rather than inside a row.
                    if !PushHealth.isHealthy(
                        blockedSourceIds: store.blockedSourceIds,
                        oldestBufferedAge: store.oldestBufferedAge,
                        quarantinedBatches: store.quarantinedBatches
                    ) {
                        PushHealthBanner(
                            blockedSourceIds: store.blockedSourceIds,
                            bufferedBatches: store.bufferedBatches,
                            oldestBufferedAge: store.oldestBufferedAge,
                            quarantinedBatches: store.quarantinedBatches,
                            labelForSourceId: pushHealthLabel(for:),
                            retryPhase: store.pushRetryPhase,
                            onRetry: { Task { await store.retryPushDelivery() } },
                            onDiscardUndelivered: { Task { await store.discardQuarantined() } }
                        )
                        .padding(.horizontal, Theme.Spacing.lg)
                    }

                    if let err = store.sourcesError {
                        // Cached rows are visible — surface a refresh
                        // failure inline instead of replacing the list
                        // with a full-screen error.
                        Label(
                            inlineRefreshErrorText(err),
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.footnote)
                        .foregroundStyle(Theme.warning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.Spacing.lg)
                    }

                    sourcesList
                        .padding(.horizontal, Theme.Spacing.lg)

                    Color.clear.frame(height: Theme.Spacing.lg)
                }
            }
        }
    }

    /// Resolve a source id to a display name for the push-health banner:
    /// the gateway's descriptor label when known, else the shared type→name
    /// map. A source blocked from its very first push has no sync-state row
    /// yet, so the descriptor label is usually absent exactly here — without
    /// the fallback the banner would show a raw `<type>:<account>` id.
    private func pushHealthLabel(for sourceId: String) -> String {
        if let label = store.sourceLabel(forSourceId: sourceId) { return label }
        return humanName(for: sourceTypeOf(sourceId))
    }

    /// Short one-liner for the inline refresh-failure banner. Routes
    /// through the same classifier the full-screen view uses so the
    /// vocabulary stays consistent across surfaces.
    private func inlineRefreshErrorText(_ error: Error) -> String {
        switch GatewayErrorView.classify(error) {
        case .gatewayUnreachable: "Couldn't reach the gateway — showing cached sources."
        case .certificate: "Couldn't verify the gateway certificate — showing cached sources."
        case .unauthorized: "Authentication failed — re-pair from Settings."
        case .forbidden: "This device lacks the scope needed to refresh sources."
        case .agentNotConfigured: "Agent isn't configured — showing cached sources."
        case .server(let status, _): "Gateway returned \(status) while refreshing."
        case .unknown(let message): message
        }
    }

    private var sourcesList: some View {
        // Sort by display label, falling back to accountId so multi-account
        // sources (Chrome Bookmarks × N, Notion workspaces × N) stay grouped
        // and order deterministically. Matches the portal's row order.
        // Gateway-internal sources join through view-layer records so the
        // shared row renders them without nullable surgery.
        let internalRecords = store.internalSources.map { store.internalSourceRecord(for: $0.id) }
        let sorted = (store.sources + internalRecords).sorted { lhs, rhs in
            // Sort by the displayed label (meta feed first), not the raw
            // type id — internal ids have no humanName case and would
            // otherwise sort (and leak) as raw ids. Matches portal/Android.
            let lhsLabel = store.sourceLabel(forSourceId: lhs.id) ?? humanName(for: lhs.type)
            let rhsLabel = store.sourceLabel(forSourceId: rhs.id) ?? humanName(for: rhs.type)
            if lhsLabel != rhsLabel {
                return lhsLabel.localizedCaseInsensitiveCompare(rhsLabel) == .orderedAscending
            }
            return lhs.accountId.localizedCaseInsensitiveCompare(rhs.accountId) == .orderedAscending
        }
        return VStack(spacing: 0) {
            ForEach(Array(sorted.enumerated()), id: \.element.id) { index, source in
                NavigationLink {
                    SourceDetailView(sourceId: source.id)
                } label: {
                    SourceRowView(source: source, store: store)
                }
                .buttonStyle(.plain)
                if index < sorted.count - 1 {
                    Divider()
                        .background(Theme.borderLight)
                        .padding(.leading, 44)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 48))
                .foregroundStyle(Theme.textMuted)
            Text("No sources yet")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Add sources from the desktop CLI with `omnesis add`.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
            Button("Refresh") {
                Task {
                    await store.refreshSources()
                    await store.refreshGatewayStats()
                }
            }
            .tint(Theme.accent)
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

// MARK: - Overview hero card

@available(iOS 17.0, *)
private struct OverviewCard: View {
    let store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            indexingPill

            statsGrid

            if let model = store.indexStats?.model?.name, !model.isEmpty {
                HStack(spacing: 8) {
                    Text("EMBEDDING MODEL")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.textMuted)
                    Text(model)
                        .font(Theme.monospace(size: 11))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }

    /// Top status pill: "INDEXING 99%" / "UP TO DATE" / "INDEXER OFF".
    /// Mirrors portal's `OverviewBar`.
    @ViewBuilder
    private var indexingPill: some View {
        // A document is "done" once the indexer has reached a terminal state
        // for it: indexed, or terminally errored (an un-embeddable/unreachable
        // doc). Folding the errored docs into completion lets the pill reach
        // 100% / UP TO DATE once the indexer has caught up, instead of stalling
        // a hair under it forever on the handful it can never embed.
        let indexed = store.indexStats?.totalIndexed ?? 0
        let errored = store.indexStats?.totalIndexErrors ?? 0
        let done = indexed + errored
        let corpusTotal = store.statusSnapshot?.documents.total ?? 0
        let denom = max(corpusTotal, 1)
        let pct = Int(Double(done) / Double(denom) * 100)
        let cappedPct = min(max(pct, 0), 100)
        let state = store.indexStats?.state ?? "running"
        let isOff = !(store.indexStats?.enabled ?? false) || state == "disabled"
        let isUpToDate = done >= corpusTotal && done > 0

        HStack(spacing: 8) {
            if isOff {
                statusDot(color: Theme.textMuted)
                Text("INDEXER OFF")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.textMuted)
            } else if isUpToDate {
                statusDot(color: Theme.success)
                Text("UP TO DATE")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.success)
            } else {
                statusDot(color: Theme.warning)
                Text("INDEXING")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.warning)
                Text("\(cappedPct)%")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.warning)
            }
            Spacer()
        }
    }

    private func statusDot(color: Color) -> some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .shadow(color: color.opacity(0.6), radius: 4)
    }

    private var statsGrid: some View {
        HStack(spacing: Theme.Spacing.lg) {
            stat(value: "\(store.sources.count + store.internalSources.count)", label: "sources")
            stat(value: formatCount(store.statusSnapshot?.documents.total ?? 0), label: "docs")
            stat(value: formatCount(store.indexStats?.totalChunks ?? 0), label: "chunks")
            if let bytes = store.statusSnapshot?.onDiskBytes, bytes > 0 {
                stat(value: formatBytes(bytes), label: "on disk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func stat(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
                .tracking(0.3)
        }
    }

    private func formatCount(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n)"
    }

    private func formatBytes(_ n: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useKB, .useMB, .useGB]
        return f.string(fromByteCount: n)
    }
}

// MARK: - One source row

@available(iOS 17.0, *)
private struct SourceRowView: View {
    let source: SourceRecord
    let store: AppStore
    @State private var noticesPresentation: SourceNoticesPresentation?

    var body: some View {
        let status = store.syncStatusesBySource[source.id]
        let activity = store.statusSnapshot?.latestActivityBySource?[source.id]
        let docCount = store.statusSnapshot?.documents.bySource[source.id] ?? 0
        let pctIndexed = store.indexStats?.bySource?[source.id]?.percentIndexed
        let hostName = store.sourceRowHostLabel(for: source, status: status)
        let noticeSections = status.map { store.noticeSections(for: $0, source: source) } ?? []

        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            SourceIconView(sourceId: source.id, store: store, size: 28)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(store.sourceLabel(forSourceId: source.id) ?? humanName(for: source.type))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    statePill(status: status, paused: !source.enabled)
                }

                Text(source.accountId)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)

                metadataRow(
                    docCount: docCount,
                    pctIndexed: pctIndexed,
                    hostName: hostName,
                    noticeSections: noticeSections
                )

                if status?.state == "syncing",
                   let prog = status?.progress,
                   let pct = progressPercent(prog: prog) {
                    progressBar(pct: pct, message: prog.message ?? progressLabel(prog: prog))
                }

                if let activity, let title = activityTitle(activity) {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.textMuted)
                        Text(title)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                        Text("·")
                            .foregroundStyle(Theme.textMuted)
                        Text(formatTimeAgo(activity.latestActivityAt) ?? "")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .sourceNoticesAccessibilityAction(sections: noticeSections, presentation: $noticesPresentation)
    }

    /// Counts, index progress and host, with one notice icon standing for
    /// every device's notices — the row has no room for one per device; the
    /// detail screen places them beside each device.
    private func metadataRow(
        docCount: Int,
        pctIndexed: Double?,
        hostName: String?,
        noticeSections: [SourceNoticeSection]
    )
        -> some View {
        HStack(spacing: 8) {
            if docCount > 0 {
                Text("\(docCount)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .monospacedDigit()
                    + Text(" \(unitName(for: source))")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
            if let pct = pctIndexed {
                let isFull = pct >= 100
                let color: Color = isFull ? Theme.success : Theme.warning
                HStack(spacing: 3) {
                    Circle().fill(color).frame(width: 5, height: 5)
                    Text("\(Int(pct))% indexed")
                        .font(.system(size: 11))
                        .foregroundStyle(color)
                        .monospacedDigit()
                }
            }
            if let hostName, !hostName.isEmpty {
                Text("·")
                    .foregroundStyle(Theme.textMuted)
                Text(hostName)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
            SourceNoticeSummaryIcon(sections: noticeSections, presentation: $noticesPresentation)
        }
    }

    @ViewBuilder
    private func statePill(status: SourceSyncStatus?, paused: Bool) -> some View {
        let raw = paused ? "paused" : (status?.state ?? "idle")
        let label = pillLabel(state: raw)
        OmnesisPill(text: label, colors: Theme.pillColor(forState: raw, paused: paused))
    }

    private func pillLabel(state: String) -> String {
        switch state {
        case "syncing": "syncing"
        case "synced", "completed": "synced"
        case "error": "error"
        case "needs-auth": "auth"
        case "auth-expiring": "expiring"
        case "stale": "stale"
        case "rate-limited": "limited"
        case "paused": "paused"
        case "idle": "idle"
        case "disabled": "disabled"
        default: state
        }
    }

    private func progressBar(pct: Double, message: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Theme.bgTertiary)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Theme.accent)
                        .frame(width: geo.size.width * (pct / 100.0))
                }
            }
            .frame(height: 4)
            if let message {
                Text(message)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
        }
    }

    private func progressLabel(prog: SourceSyncStatus.Progress) -> String? {
        if let total = prog.total, let done = prog.processed {
            return "\(done) / \(total)"
        }
        if let done = prog.processed {
            return "\(done) processed"
        }
        return nil
    }

    /// Mirrors the portal: render the bar whenever we have either a server
    /// percentage or enough info to derive one (processed + total). Falls
    /// back to 0 when only `processed` is known so the bar still appears
    /// during early bootstrap before `total` is known.
    private func progressPercent(prog: SourceSyncStatus.Progress) -> Double? {
        if let pct = prog.percentComplete {
            return min(100, max(0, pct))
        }
        if let total = prog.total, total > 0, let done = prog.processed {
            return min(100, max(0, Double(done) / Double(total) * 100))
        }
        if prog.processed != nil {
            return 0
        }
        return nil
    }

    private func activityTitle(_ a: StatusSnapshot.LatestActivity) -> String? {
        if a.kind == "document" {
            let title = a.title ?? ""
            return title.isEmpty ? "(untitled)" : title
        }
        if a.kind == "analytics" {
            return a.tableDisplayName ?? a.tableName
        }
        return nil
    }

    private func unitName(for source: SourceRecord) -> String {
        switch source.type {
        case "gmail", "outlook-email": "emails"
        case "google-calendar": "events"
        case "apple-notes", "obsidian", "notion-pages": "notes"
        case "apple-reminders", "things": "tasks"
        case "apple-contacts", "google-contacts": "contacts"
        case "browser-history": "visits"
        case "chrome-bookmarks": "bookmarks"
        case "google-drive": "files"
        case "apple-imessage", "whatsapp-messages": "messages"
        case "strava-activities": "activities"
        case "screen-time": "sessions"
        case "notion-databases": "rows"
        default: "docs"
        }
    }
}

// MARK: - Per-source detail view

@available(iOS 17.0, *)
struct SourceDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let sourceId: String
    @State private var showRemoveConfirm = false
    @State private var showResyncConfirm = false
    @State private var showDebugSheet = false
    @State private var actionError: String?
    @State private var actionInFlight = false

    var body: some View {
        ScrollView {
            if let source = store.sources.first(where: { $0.id == sourceId })
                ?? (store.isInternalSource(sourceId) ? store.internalSourceRecord(for: sourceId) : nil) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    header(source: source)
                    statusCard(source: source)
                    actionsCard(source: source)

                    if !store.isInternalSource(source.id) {
                        Text(
                            "Pause stops ingestion for the whole source and keeps its data and cursors. "
                                + "Remove purges the entire source for all devices."
                        )
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    aboutCard(source: source)

                    if let err = actionError {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(Theme.Spacing.lg)
            } else {
                Text("Source no longer exists")
                    .foregroundStyle(Theme.textMuted)
                    .padding()
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(sourceTitle())
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showRemoveConfirm) {
            SourceDepartureConfirmation(sourceName: sourceTitle(), wholeSource: true) {
                Task {
                    await run { try await store.removeSource(sourceId: sourceId) }
                    if actionError == nil { dismiss() }
                }
            }
        }
        .alert("Resync this source?", isPresented: $showResyncConfirm) {
            Button("Resync", role: .destructive) {
                Task { await run { try await store.resync(sourceId: sourceId) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("All ingested documents for this source will be deleted and re-fetched from scratch. Large sources can take a while.")
        }
        .sheet(isPresented: $showDebugSheet) {
            SourceDebugSheet(sourceId: sourceId)
        }
        .omnesisColorScheme()
    }

    private func header(source: SourceRecord) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            SourceIconView(sourceId: source.id, store: store, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.sourceLabel(forSourceId: source.id) ?? humanName(for: source.type))
                    .font(.title3.bold())
                    .foregroundStyle(Theme.textPrimary)
                Text(source.accountId)
                    .font(Theme.monospace(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
        }
    }

    private func statusCard(source: SourceRecord) -> some View {
        let status = store.syncStatusesBySource[source.id]
        let raw = !source.enabled ? "paused" : (status?.state ?? "idle")
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: 8) {
                Text("STATUS")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.textSecondary)
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 1)
                    .frame(maxWidth: .infinity)
                OmnesisPill(
                    text: stateLabel(state: raw),
                    colors: Theme.pillColor(forState: raw, paused: !source.enabled)
                )
            }
            .padding(.top, Theme.Spacing.md)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if let status {
                    if let ago = formatTimeAgo(status.lastSyncAt) {
                        keyValueRow("Last sync", value: ago)
                    }
                    if let unit = status.unitName {
                        keyValueRow("Unit", value: unit)
                    }
                    if status.state == "syncing", let prog = status.progress {
                        if let total = prog.total, let done = prog.processed {
                            keyValueRow("Progress", value: "\(done) / \(total)")
                        } else if let done = prog.processed {
                            keyValueRow("Progress", value: "\(done) processed")
                        }
                        if let pct = detailProgressPercent(prog: prog) {
                            ProgressView(value: pct / 100.0)
                                .tint(Theme.accent)
                        }
                        if let msg = prog.message {
                            Text(msg)
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                        }
                    }
                }
                if let pct = store.indexStats?.bySource?[source.id]?.percentIndexed {
                    HStack {
                        Text("Indexed")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Text("\(Int(pct))%")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(pct >= 100 ? Theme.success : Theme.warning)
                            .monospacedDigit()
                    }
                }
            }
        }
    }

    private func actionsCard(source: SourceRecord) -> some View {
        // Gateway-internal sources have no sync engine, registration or
        // host device to act on — Recent items is the whole card.
        // Document deletion lives on that page.
        VStack(spacing: 0) {
            if !store.isInternalSource(source.id) {
                actionButton(
                    label: actionInFlight ? "Working…" : "Sync now",
                    systemImage: "arrow.triangle.2.circlepath",
                    color: Theme.accent
                ) {
                    Task { await run { try await store.triggerSync(sourceId: source.id) } }
                }
                Divider().background(Theme.borderLight)
                actionButton(
                    label: source.enabled ? "Pause sync — keep data" : "Resume sync",
                    systemImage: source.enabled ? "pause.circle" : "play.circle",
                    color: Theme.textPrimary
                ) {
                    Task {
                        await run {
                            try await store.setEnabled(sourceId: source.id, enabled: !source.enabled)
                        }
                    }
                }
                Divider().background(Theme.borderLight)
                actionButton(
                    label: "Debug",
                    systemImage: "ant",
                    color: Theme.textPrimary
                ) {
                    showDebugSheet = true
                }
                Divider().background(Theme.borderLight)
                actionButton(
                    label: "Resync",
                    systemImage: "arrow.counterclockwise.circle",
                    color: Theme.danger
                ) {
                    showResyncConfirm = true
                }
                Divider().background(Theme.borderLight)
                actionButton(
                    label: "Remove entire source",
                    systemImage: "trash",
                    color: Theme.danger
                ) {
                    showRemoveConfirm = true
                }
                Divider().background(Theme.borderLight)
            }
            NavigationLink {
                SourceRecentDocumentsView(sourceId: source.id)
            } label: {
                recentDocsRow
            }
            .buttonStyle(.plain)
        }
    }

    private func actionButton(
        label: String,
        systemImage: String,
        color: Color,
        action: @escaping () -> Void
    )
        -> some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: systemImage)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
                    .frame(width: 20)
                Text(label)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
                Spacer()
                if !actionInFlight {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(actionInFlight)
    }

    private var recentDocsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(Theme.accent)
                .frame(width: 20)
            Text("Recent items")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textPrimary)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 12)
    }

    private func aboutCard(source: SourceRecord) -> some View {
        FlatSection("About") {
            VStack(alignment: .leading, spacing: 8) {
                keyValueRow("Type", value: source.type, mono: true)
                keyValueRow("Account", value: source.accountId, mono: true)
                hostDevicesRow(source)
                keyValueRow("Source ID", value: source.id, mono: true)
            }
        }
    }

    /// Every device hosting the source, each with the icons for its own
    /// notices beside its name. A status member the registration does not
    /// list still gets its line, so no device's notices go unshown.
    /// Every device hosting the source, each with the icons for its own
    /// notices beside its name.
    private func hostDevicesRow(_ source: SourceRecord) -> some View {
        let entries = store.hostNoticeEntries(for: source)
        return HStack(alignment: .top) {
            Text(store.isInternalSource(source.id) ? "Host" : entries.count == 1 ? "Host device" : "Host devices")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 4) {
                ForEach(entries) { entry in
                    HStack(spacing: 4) {
                        SourceNoticeIcons(notices: entry.notices, deviceName: entry.name)
                        Text(entry.name)
                            .font(entry.isResolved ? .system(size: 12) : Theme.monospace(size: 12))
                            .foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.trailing)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    private func keyValueRow(_ key: String, value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(key)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(mono ? Theme.monospace(size: 12) : .system(size: 12))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }

    /// Same logic as `SourceRowView.progressPercent` — kept here too so
    /// the detail view can render the bar even when `total` isn't known
    /// yet (early bootstrap), matching the portal's behaviour.
    private func detailProgressPercent(prog: SourceSyncStatus.Progress) -> Double? {
        if let pct = prog.percentComplete {
            return min(100, max(0, pct))
        }
        if let total = prog.total, total > 0, let done = prog.processed {
            return min(100, max(0, Double(done) / Double(total) * 100))
        }
        if prog.processed != nil {
            return 0
        }
        return nil
    }

    private func stateLabel(state: String) -> String {
        switch state {
        case "syncing": "syncing"
        case "synced", "completed": "synced"
        case "error": "error"
        case "needs-auth": "needs auth"
        case "auth-expiring": "expiring"
        case "stale": "stale"
        case "rate-limited": "rate limited"
        case "paused": "paused"
        case "idle": "idle"
        default: state
        }
    }

    private func sourceTitle() -> String {
        if let label = store.sourceLabel(forSourceId: sourceId) {
            return label
        }
        guard let source = store.sources.first(where: { $0.id == sourceId }) else {
            return sourceId
        }
        return humanName(for: source.type)
    }

    private func run(_ action: @escaping () async throws -> Void) async {
        actionInFlight = true
        defer { actionInFlight = false }
        do {
            try await action()
            actionError = nil
        } catch let e {
            actionError = describeError(e)
        }
    }

    private func describeError(_ error: Error) -> String {
        switch error {
        case GatewayClient.Error.forbidden:
            "Forbidden — this token lacks the required scope."
        case GatewayClient.Error.unauthorized:
            "Unauthorized — re-pair from Settings."
        case GatewayClient.Error.serverError(let status, let body):
            // The thrown body is the gateway's `{error, code}` envelope; the
            // JSON is not what a reader needs, so it is unwrapped here as
            // every other render site does.
            "Gateway \(status): \(GatewayClient.errorMessage(from: body))"
        default:
            String(describing: error)
        }
    }
}

// MARK: - Debug sheet

/// Bottom sheet that fetches `/admin/sources/:id/debug` and renders the
/// raw JSON response. The collector returns whatever per-source debug
/// info it has — pretty-printing is sufficient for an iOS surface
/// (anyone who needs to slice it goes to the portal).
@available(iOS 17.0, *)
struct SourceDebugSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let sourceId: String
    @State private var output: String?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if loading {
                        HStack { ProgressView()
                            Text("Fetching debug info…")
                        }
                        .foregroundStyle(Theme.textSecondary)
                    } else if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                    } else if let output {
                        Text(output)
                            .font(Theme.monospace(size: 11))
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Debug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
            .task { await load() }
        }
        .omnesisColorScheme()
    }

    private func load() async {
        guard !store.isInternalSource(sourceId) else {
            error = "Internal sources have nothing to debug."
            loading = false
            return
        }
        guard let admin = store.admin else {
            error = "Not paired"
            loading = false
            return
        }
        loading = true
        do {
            let value = try await admin.sourceDebug(sourceId: sourceId)
            output = prettyPrint(value)
        } catch let e {
            error = String(describing: e)
        }
        loading = false
    }

    /// Recursive pretty-printer for JSONValue. Two-space indent.
    private func prettyPrint(_ v: JSONValue, indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent)
        switch v {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return "\(i)"
        case .double(let d): return "\(d)"
        case .string(let s): return "\"\(s)\""
        case .array(let arr):
            if arr.isEmpty { return "[]" }
            let inner = arr.map { prettyPrint($0, indent: indent + 1) }
            return "[\n" + inner.map { pad + "  " + $0 }.joined(separator: ",\n") + "\n" + pad + "]"
        case .object(let obj):
            if obj.isEmpty { return "{}" }
            let keys = obj.keys.sorted()
            let inner = keys.map { key in
                "\"\(key)\": " + prettyPrint(obj[key] ?? .null, indent: indent + 1)
            }
            return "{\n" + inner.map { pad + "  " + $0 }.joined(separator: ",\n") + "\n" + pad + "}"
        }
    }
}

/// Format an ISO timestamp as a compact relative phrase. Returns nil
/// if the input is missing or unparseable so callers can omit the row.
func timeAgo(_ iso: String?) -> String? {
    formatTimeAgo(iso)
}

/// Turn a source type id into a user-facing label.
func humanName(for type: String) -> String {
    switch type {
    case "gmail": "Gmail"
    case "google-calendar": "Google Calendar"
    case "google-drive": "Google Drive"
    case "google-contacts": "Google Contacts"
    case "apple-notes": "Apple Notes"
    case "apple-reminders": "Apple Reminders"
    case "apple-imessage", "apple-messages": "Apple iMessage"
    case "apple-contacts": "Apple Contacts"
    case "apple-health": "Apple Health"
    case "whatsapp-messages": "WhatsApp"
    case "obsidian": "Obsidian"
    case "chrome-bookmarks": "Chrome Bookmarks"
    case "browser-history": "Browser History"
    case "things": "Things 3"
    case "notion-pages": "Notion Pages"
    case "notion-databases": "Notion Databases"
    case "outlook-email": "Outlook"
    case "strava-activities": "Strava"
    case "screen-time": "Screen Time"
    default: type
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Sources — whole-source cleanup pending") {
    SourcesView(menuOpen: .constant(false))
        .environment(AppStore.preview(pendingSourceRemovals: [PreviewMocks.pendingSourceRemoval]))
}

@available(iOS 17.0, *)
#Preview("Sources — populated") {
    @Previewable @State var menuOpen = false
    return SourcesView(menuOpen: $menuOpen)
        .environment(AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        ))
}

@available(iOS 17.0, *)
#Preview("Sources — empty") {
    @Previewable @State var menuOpen = false
    return SourcesView(menuOpen: $menuOpen)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Sources — first-load error") {
    @Previewable @State var menuOpen = false
    return SourcesView(menuOpen: $menuOpen)
        .environment(AppStore.preview(sourcesError: URLError(.cannotConnectToHost)))
}

@available(iOS 17.0, *)
#Preview("Sources — inline refresh banner") {
    @Previewable @State var menuOpen = false
    return SourcesView(menuOpen: $menuOpen)
        .environment(AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            sourcesError: URLError(.notConnectedToInternet)
        ))
}

@available(iOS 17.0, *)
#Preview("Source detail — synced") {
    NavigationStack {
        SourceDetailView(sourceId: PreviewMocks.sourceAppleNotes.id)
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames,
                indexStats: PreviewMocks.indexStats
            ))
    }
}

@available(iOS 17.0, *)
#Preview("Source detail — multiple hosts, pause keeps data, removal affects every host") {
    NavigationStack {
        SourceDetailView(sourceId: PreviewMocks.sourceAppleHealth.id)
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames,
                indexStats: PreviewMocks.indexStats
            ))
    }
}

@available(iOS 17.0, *)
#Preview("Source detail — syncing") {
    NavigationStack {
        SourceDetailView(sourceId: PreviewMocks.sourceGmail.id)
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames,
                indexStats: PreviewMocks.indexStats
            ))
    }
}

@available(iOS 17.0, *)
#Preview("Source detail — notices beside each member device") {
    NavigationStack {
        SourceDetailView(sourceId: PreviewMocks.sourceSharedVault.id)
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames,
                indexStats: PreviewMocks.indexStats
            ))
    }
}

@available(iOS 17.0, *)
#Preview("Source detail — error") {
    NavigationStack {
        SourceDetailView(sourceId: PreviewMocks.sourceWhatsApp.id)
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames,
                indexStats: PreviewMocks.indexStats
            ))
    }
}
#endif
#endif
