// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Per-source recent-item browser. Reached from SourceDetailView and mirrors
/// the portal's `source-recent.js`.
///
/// Three render paths driven by the gateway's tagged-union response:
///   - documents: tappable rows that push DocumentDetailView.
///   - analytics: a generic, horizontally scrollable structured-data table.
///   - empty: a friendly empty state.
@available(iOS 17.0, *)
struct SourceRecentDocumentsView: View {
    @Environment(AppStore.self) private var store

    let sourceId: String

    @Environment(\.openURL) private var openURL

    @State private var response: RecentItemsResponse?
    /// The recent envelope's own internal flag. Preferred over the
    /// sources list (which may be stale or never have loaded, e.g. on a
    /// deep link) when deciding read-only treatment.
    @State private var isInternalEnvelope = false
    @State private var loading = true
    @State private var loadError: Error?
    @State private var paging = CursorPagingState()
    /// Row pending a privacy delete (drives the confirm dialog); nil = none.
    /// Only ever set for mutable sources — generated Notes documents are
    /// read-only and offer Manage notes instead.
    @State private var pendingDelete: RecentDocument?
    @State private var deleteError: Error?

    /// Envelope flag first, sources list as fallback for older gateways.
    private var isReadOnly: Bool {
        isInternalEnvelope || store.isInternalSource(sourceId)
    }

    /// Per-row Manage-notes URL seeded at that daily document's day. Nil
    /// for non-Notes sources (the link is Notes-specific) so the row menu
    /// offers nothing instead of a link to the wrong surface.
    private func manageNotesLink(for doc: RecentDocument) -> URL? {
        guard isReadOnly, doc.sourceId == notesSourceId, let pairing = store.pairing else { return nil }
        let day = notesDayForDocument(externalId: doc.externalId, sourceCreatedAt: doc.sourceCreatedAt)
        return manageNotesURL(baseURL: pairing.url, token: pairing.token, day: day)
    }

    var body: some View {
        Group {
            if loading, response == nil {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError, response == nil {
                GatewayErrorView(
                    context: "load recent items",
                    error: loadError,
                    onRetry: { Task { await load() } }
                )
            } else if let response {
                content(for: response)
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Recent")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Delete \u{201C}\(pendingDelete?.title.nilIfBlank ?? "(untitled)")\u{201D}?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { doc in
            // Only reachable for mutable sources: generated Notes documents
            // are read-only and offer Manage notes from the row menu
            // instead. The gateway refuses their deletion as a backstop.
            Button("Delete for good", role: .destructive) { Task { await performDelete(doc, keepCopy: false) } }
            Button("Delete this copy", role: .destructive) { Task { await performDelete(doc, keepCopy: true) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text(documentDeleteExplanation)
        }
        .alert(
            GatewayErrorView.classify(deleteError).title,
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
        ) {
            Button("OK", role: .cancel) { deleteError = nil }
        } message: {
            Text(GatewayErrorView.classify(deleteError).detail(for: "delete this document"))
        }
        .task { await load() }
        .refreshable { await load() }
        .omnesisColorScheme()
    }

    @ViewBuilder
    private func content(for response: RecentItemsResponse) -> some View {
        switch response {
        case .documents(let docs):
            if !shouldShowPagedContent(itemCount: docs.count, paging: paging) {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(docs.enumerated()), id: \.element.id) { idx, doc in
                            NavigationLink {
                                DocumentDetailView(
                                    documentId: doc.id,
                                    presetTitle: doc.title,
                                    onDeleted: { removeDoc(id: $0) }
                                )
                            } label: {
                                recentRow(doc)
                                    .padding(.horizontal, Theme.Spacing.md)
                                    .padding(.vertical, 10)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                if isReadOnly {
                                    if let link = manageNotesLink(for: doc) {
                                        Button {
                                            openURL(link)
                                        } label: {
                                            Label("Manage notes", systemImage: "square.and.pencil")
                                        }
                                    }
                                } else {
                                    Button(role: .destructive) {
                                        pendingDelete = doc
                                    } label: {
                                        Label("Delete document", systemImage: "trash")
                                    }
                                }
                            }
                            if idx < docs.count - 1 {
                                Divider().background(Theme.borderLight).padding(.leading, 44)
                            }
                        }
                        ListPagingFooter(
                            state: paging,
                            label: "Load more documents",
                            retry: { Task { await loadMore() } }
                        )
                    }
                    .padding(Theme.Spacing.lg)
                }
            }
        case .analytics(let table, let displayName, let columns, let rows):
            RecentAnalyticsRowsView(
                table: table,
                displayName: displayName,
                columns: columns,
                rows: rows,
                paging: paging,
                onLoadMore: { Task { await loadMore() } }
            )
        case .empty:
            if paging.hasPagingBoundary {
                ScrollView {
                    ListPagingFooter(
                        state: paging,
                        label: "Load more items",
                        retry: { Task { await loadMore() } }
                    )
                    .padding(Theme.Spacing.lg)
                }
            } else {
                emptyState
            }
        }
    }

    private func recentRow(_ doc: RecentDocument) -> some View {
        // Stripe lives in a leading-aligned overlay so different
        // intrinsic content heights across rows can't shift the icon
        // column horizontally (see comment in SearchResultRow).
        HStack(alignment: .top, spacing: 10) {
            SourceIconView(sourceId: doc.sourceId, store: store)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(doc.title.isEmpty ? "(untitled)" : doc.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                metaRow(doc: doc)
                if let preview = doc.contentPreview, !preview.isEmpty {
                    Text(preview)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.leading, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Theme.docTypeAccent(doc.documentType)
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))
        }
    }

    @ViewBuilder
    private func metaRow(doc: RecentDocument) -> some View {
        let parts = recentMetaParts(doc: doc)
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
        }
    }

    private func recentMetaParts(doc: RecentDocument) -> [String] {
        var parts: [String] = []
        if let label = docTypeLabel(doc.documentType) { parts.append(label) }
        if let when = formatTimeAgo(doc.sourceCreatedAt) { parts.append(when) }
        return parts
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("No recent items yet")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Once this source syncs, recent items will show up here.")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Network

    private func load() async {
        let request = paging.beginRefresh()
        guard let client = store.search else {
            paging.failRefresh(request)
            loadError = URLError(.cannotConnectToHost)
            loading = false
            return
        }
        loading = true
        loadError = nil
        do {
            let page = try await client.recentItems(sourceId: sourceId, limit: 30)
            guard paging.owns(request) else { return }
            response = page.content
            isInternalEnvelope = page.isInternal
            loading = false
            paging.finishRefresh(request, nextCursor: page.pageInfo.nextCursor)
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
            let page = try await client.recentItems(
                sourceId: sourceId,
                limit: 30,
                cursor: request.cursor
            )
            guard paging.owns(request) else { return }
            let madeProgress = merge(page.content)
            paging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: madeProgress
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }

    private func merge(_ incoming: RecentItemsResponse) -> Bool {
        switch (response, incoming) {
        case (.documents(var current)?, .documents(let next)):
            let fresh = appendUnique(next, to: &current, id: \.id)
            response = .documents(current)
            return !fresh.isEmpty
        case (
            .analytics(let table, let displayName, let columns, let currentRows)?,
            .analytics(let nextTable, _, let nextColumns, let nextRows)
        ) where table == nextTable && columns == nextColumns:
            // Equal-valued analytics rows may be legitimate observations, so
            // preserve the server's cursor order without value-based dedupe.
            var rows = currentRows
            rows.append(contentsOf: nextRows)
            response = .analytics(
                table: table,
                displayName: displayName,
                columns: columns,
                rows: rows
            )
            return !nextRows.isEmpty
        default:
            // A source changing projection while this screen is open is rare
            // but valid (for example, its first documents just arrived).
            // Prefer the canonical new shape over mixing incompatible arms.
            response = incoming
            switch incoming {
            case .documents(let documents):
                return !documents.isEmpty
            case .analytics(_, _, _, let rows):
                return !rows.isEmpty
            case .empty:
                return false
            }
        }
    }

    private func performDelete(_ doc: RecentDocument, keepCopy: Bool) async {
        guard let client = store.search else { return }
        do {
            try await client.deleteDocument(id: doc.id, keepCopy: keepCopy)
            removeDoc(id: doc.id)
        } catch {
            deleteError = error
        }
    }

    /// Drop a now-deleted row from the loaded list in place — no refetch.
    private func removeDoc(id: String) {
        guard case .documents(let docs)? = response else { return }
        response = .documents(docs.filter { $0.id != id })
    }
}

/// Generic structured-data table for the analytics arm of the recent-items
/// endpoint. Columns and values come directly from the gateway descriptor;
/// no source-specific display rules live in the app.
@available(iOS 17.0, *)
struct RecentAnalyticsRowsView: View {
    let table: String
    let displayName: String
    let columns: [String]
    let rows: [[JSONValue]]
    var paging = CursorPagingState()
    var onLoadMore: () -> Void = {}

    private let columnWidth: CGFloat = 144

    var body: some View {
        ScrollView {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            heading
            if columns.isEmpty {
                Text("No columns were returned.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .center)
            } else if !shouldShowPagedContent(itemCount: rows.count, paging: paging) {
                Text("No recent rows returned.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .center)
            } else {
                tableGrid
            }
            ListPagingFooter(
                state: paging,
                label: "Load more rows",
                retry: onLoadMore
            )
        }
        .padding(Theme.Spacing.lg)
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayName.isEmpty ? table : displayName)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(
                "\(table) · \(pagingCountLabel(rows.count, countIsPartial: paging.countIsPartial)) "
                    + "\(rows.count == 1 ? "row" : "rows")"
            )
            .font(Theme.monospace(size: 11))
            .foregroundStyle(Theme.textMuted)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tableGrid: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                RecentAnalyticsTableRow(
                    values: columns,
                    columnLabels: nil,
                    header: true,
                    columnWidth: columnWidth
                )
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    RecentAnalyticsTableRow(
                        values: normalised(row).map(\.displayString),
                        columnLabels: columns,
                        header: false,
                        columnWidth: columnWidth
                    )
                    .background(index.isMultiple(of: 2) ? Theme.bgSecondary : Theme.bgPrimary)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.small)
                    .stroke(Theme.borderLight, lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
        }
        .menuRevealExcluded()
    }

    private func normalised(_ row: [JSONValue]) -> [JSONValue] {
        if row.count == columns.count { return row }
        if row.count > columns.count { return Array(row.prefix(columns.count)) }
        return row + Array(repeating: .null, count: columns.count - row.count)
    }
}

@available(iOS 17.0, *)
private struct RecentAnalyticsTableRow: View {
    let values: [String]
    let columnLabels: [String]?
    let header: Bool
    let columnWidth: CGFloat

    private var font: Font {
        Theme.monospace(size: header ? 11 : 12, weight: header ? .semibold : .regular)
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(values.indices, id: \.self) { index in
                cell(value: values[index], index: index)
            }
        }
        .background(header ? Theme.bgTertiary : Color.clear)
        .overlay(alignment: .bottom) {
            Divider().background(Theme.borderLight)
        }
    }

    private func cell(value: String, index: Int) -> some View {
        Text(value)
            .font(font)
            .foregroundStyle(header ? Theme.textSecondary : Theme.textPrimary)
            .lineLimit(header ? 1 : 2)
            .truncationMode(.tail)
            .frame(width: columnWidth, alignment: .leading)
            .frame(minHeight: header ? 36 : 44, alignment: .leading)
            .padding(.horizontal, 8)
            .accessibilityLabel(accessibilityLabel(for: value, index: index))
            .overlay(alignment: .trailing) {
                if index < values.count - 1 {
                    Rectangle()
                        .fill(Theme.borderLight)
                        .frame(width: 1)
                }
            }
    }

    private func accessibilityLabel(for value: String, index: Int) -> Text {
        guard let columnLabels, index < columnLabels.count else {
            return Text(value)
        }
        return Text("\(columnLabels[index]): \(value)")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Source recent — documents") {
    NavigationStack {
        SourceRecentPreviewWrapper(arm: .documents(PreviewMocks.recentDocuments))
            .environment(AppStore.preview(
                sources: PreviewMocks.sources,
                statusesBySource: PreviewMocks.syncStatuses,
                deviceNames: PreviewMocks.deviceNames
            ))
    }
}

@available(iOS 17.0, *)
#Preview("Source recent — empty") {
    NavigationStack {
        SourceRecentPreviewWrapper(arm: .empty)
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Source recent — empty page loading continuation") {
    NavigationStack {
        SourceRecentPreviewWrapper(
            arm: .documents([]),
            paging: CursorPagingState(nextCursor: "preview-next", isLoadingMore: true)
        )
        .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Source recent — analytics fallback") {
    NavigationStack {
        SourceRecentPreviewWrapper(arm: PreviewMocks.recentAnalytics)
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Source recent — notes day") {
    NavigationStack {
        SourceRecentPreviewWrapper(arm: .documents(PreviewMocks.recentNotesDocuments))
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Source recent — load error") {
    NavigationStack {
        GatewayErrorView(
            context: "load recent items",
            error: URLError(.cannotConnectToHost),
            onRetry: {}
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
struct SourceRecentPreviewWrapper: View {
    @Environment(AppStore.self) private var store
    let arm: RecentItemsResponse
    var paging = CursorPagingState(nextCursor: "preview-next")

    var body: some View {
        Group {
            switch arm {
            case .documents(let docs):
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(docs.enumerated()), id: \.element.id) { idx, doc in
                            HStack(alignment: .top, spacing: 10) {
                                SourceIconView(sourceId: doc.sourceId, store: store)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(doc.title)
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Theme.textPrimary)
                                    if let preview = doc.contentPreview {
                                        Text(preview)
                                            .font(.system(size: 12))
                                            .foregroundStyle(Theme.textSecondary)
                                            .lineLimit(2)
                                    }
                                }
                                Spacer()
                            }
                            .padding(.leading, Theme.Spacing.md + 13)
                            .padding(.trailing, Theme.Spacing.md)
                            .padding(.vertical, 10)
                            .overlay(alignment: .leading) {
                                Theme.docTypeAccent(doc.documentType)
                                    .frame(width: 3)
                                    .clipShape(RoundedRectangle(cornerRadius: 1.5))
                                    .padding(.vertical, 10)
                                    .padding(.leading, Theme.Spacing.md)
                            }
                            if idx < docs.count - 1 {
                                Divider().background(Theme.borderLight).padding(.leading, 44)
                            }
                        }
                    }
                    .padding(Theme.Spacing.lg)
                    ListPagingFooter(
                        state: paging,
                        label: "Load more documents",
                        retry: {}
                    )
                    .padding(.horizontal, Theme.Spacing.lg)
                }
            case .empty:
                if paging.hasPagingBoundary {
                    ScrollView {
                        ListPagingFooter(
                            state: paging,
                            label: "Load more items",
                            retry: {}
                        )
                        .padding(Theme.Spacing.lg)
                    }
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "tray")
                            .font(.system(size: 36))
                            .foregroundStyle(Theme.textMuted)
                        Text("No recent items yet")
                            .font(.headline)
                            .foregroundStyle(Theme.textPrimary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .analytics(let table, let displayName, let columns, let rows):
                RecentAnalyticsRowsView(
                    table: table,
                    displayName: displayName,
                    columns: columns,
                    rows: rows,
                    paging: paging
                )
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Recent")
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
    }
}
#endif
#endif
