// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Single-document view shown when the user taps a search result or a
/// recent-document row. Loads the full doc + people + attachments via
/// the SearchClient, renders the body, and offers tap-through to the
/// child attachment docs.
///
/// Showing a `presetTitle` while the body is loading avoids the screen
/// flashing a generic "Loading…" header right after the user tapped a
/// row that already displayed the title.
@available(iOS 17.0, *)
struct DocumentDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let documentId: String
    var presetTitle: String?
    /// Called after a successful privacy delete so a parent list can drop
    /// the row in place. Optional — most call sites just pop back.
    var onDeleted: ((String) -> Void)?

    @State private var doc: DocumentDetail?
    @State private var people: [PersonMention] = []
    @State private var attachments: [DocumentAttachment] = []
    @State private var refs: DocumentRefs?
    @State private var nearDupes: DocumentNearDupes?
    @State private var outboundRefsPaging = CursorPagingState()
    @State private var inboundRefsPaging = CursorPagingState()
    @State private var nearDupesPaging = CursorPagingState()
    /// Cross-store `same-entity` doc↔row neighbours (#450, #644) — the
    /// bound DuckDB analytics rows from the graph walker. Surfaced as the
    /// inspector's "Same entity" section.
    @State private var boundRows: [GraphVertex] = []
    /// The agent's durable LLM annotations grounded on this document (the
    /// "Enriched by Omnesis" panel). Available on every gateway.
    @State private var annotations: [Annotation] = []
    @State private var annotationsPaging = CursorPagingState()
    @State private var loading = true
    @State private var loadError: Error?
    @State private var showInspector = false
    @State private var showDeleteConfirm = false
    @State private var deleting = false
    @State private var deleteError: Error?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if loading, doc == nil {
                    loadingHeader
                } else if let loadError, doc == nil {
                    GatewayErrorView(
                        context: "load this document",
                        error: loadError,
                        onRetry: { Task { await load() } }
                    )
                    .frame(minHeight: GatewayErrorView.minScrollHeight)
                } else if let doc {
                    header(doc: doc)
                    quickFacts(doc: doc)
                    if !doc.content.isEmpty {
                        bodySection(doc: doc)
                    }
                    if shouldShowPagedContent(
                        itemCount: annotations.count,
                        paging: annotationsPaging
                    ) {
                        AnnotationsSection(
                            title: "Enriched by Omnesis",
                            annotations: annotations,
                            paging: annotationsPaging,
                            onLoadMore: { Task { await loadMoreAnnotations() } }
                        )
                    }
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle(navigationTitle)
        .devTarget(.document(documentId, label: doc?.title ?? navigationTitle))
        .toolbar { toolbarContent }
        .sheet(isPresented: $showInspector) {
            if let doc {
                DocumentInspectorSheet(
                    doc: doc,
                    people: people,
                    refs: refs,
                    attachments: attachments,
                    nearDupes: nearDupes,
                    boundRows: boundRows,
                    outboundPaging: outboundRefsPaging,
                    inboundPaging: inboundRefsPaging,
                    nearDupesPaging: nearDupesPaging,
                    onLoadMoreOutbound: { Task { await loadMoreOutboundRefs() } },
                    onLoadMoreInbound: { Task { await loadMoreInboundRefs() } },
                    onLoadMoreNearDupes: { Task { await loadMoreNearDupes() } }
                )
            }
        }
        .confirmationDialog("Delete this document?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            // Only reachable for mutable sources: generated Notes documents
            // offer Manage notes from the toolbar instead.
            Button("Delete for good", role: .destructive) { Task { await performDelete(keepCopy: false) } }
            Button("Delete this copy", role: .destructive) { Task { await performDelete(keepCopy: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
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
        .omnesisColorScheme()
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        // Info button is the primary affordance for "show me everything
        // about this doc without scrolling" — opens a half-sheet with
        // metadata, all people, and the link graph. Always visible
        // (even before doc loads — it'll just be disabled).
        ToolbarItem(placement: .primaryAction) {
            Button {
                showInspector = true
            } label: {
                Image(systemName: "info.circle")
            }
            .tint(Theme.accent)
            .disabled(doc == nil)
        }
        let openURLs = docOpenURLs(appUrl: doc?.appUrl, sourceUrl: doc?.sourceUrl)
        if !openURLs.isEmpty {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    openFirst(openURLs[...])
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .tint(Theme.accent)
                .accessibilityLabel("Open in source")
            }
        }
        // Destructive single-document privacy delete (#1065) lives in an
        // overflow menu so it can't be hit by accident next to the info /
        // open-in-source icons. Generated Notes documents are read-only
        // projections — they offer Manage notes instead, and the gateway
        // refuses their deletion as a backstop.
        if doc?.isInternal == true, let link = manageNotesLink() {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    openURL(link)
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .tint(Theme.accent)
                .accessibilityLabel("Manage notes")
            }
        } else if doc?.isInternal != true {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete document", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .tint(Theme.accent)
                .disabled(doc == nil || deleting)
            }
        }
    }

    /// Open the first of `urls` the system accepts. `openURL` reports
    /// `false` when no installed app handles a scheme, so an app link for
    /// an app this phone lacks falls through to the web link.
    private func openFirst(_ urls: ArraySlice<URL>) {
        guard let url = urls.first else { return }
        openURL(url) { accepted in
            if !accepted { openFirst(urls.dropFirst()) }
        }
    }

    /// Tell Omnesis URL seeded at this daily document's day, when the
    /// device is paired. Nil keeps the caller from offering the action —
    /// including for non-Notes sources, whose day-seeded Tell Omnesis
    /// destination would be the wrong surface.
    private func manageNotesLink() -> URL? {
        guard let doc, doc.isInternal, doc.sourceId == notesSourceId, let pairing = store.pairing else { return nil }
        let day = notesDayForDocument(externalId: doc.externalId, sourceCreatedAt: doc.sourceCreatedAt)
        return manageNotesURL(baseURL: pairing.url, token: pairing.token, day: day)
    }

    private func performDelete(keepCopy: Bool) async {
        guard let doc, let client = store.search else { return }
        deleting = true
        deleteError = nil
        do {
            try await client.deleteDocument(id: doc.id, keepCopy: keepCopy)
            onDeleted?(doc.id)
            dismiss()
        } catch {
            deleteError = error
        }
        deleting = false
    }

    /// Compact strip directly under the header card showing counts the
    /// user would otherwise have to scroll to find — people, refs in,
    /// refs out, attachments. Lives between the title and body so the
    /// reader sees "this email has 4 people, 2 inbound refs" in the
    /// first viewport without needing to open the inspector.
    @ViewBuilder
    private func quickFacts(doc: DocumentDetail) -> some View {
        let attachmentCount = attachments.count
        let peopleCount = people.count
        let outboundCount = refs?.outbound.count ?? 0
        let inboundCount = refs?.inbound.count ?? 0
        let hasAny = attachmentCount > 0 || peopleCount > 0 || outboundCount > 0 || inboundCount > 0
        if hasAny {
            HStack(spacing: 8) {
                if peopleCount > 0 {
                    quickFact(icon: "person.2", count: peopleCount, label: peopleCount == 1 ? "person" : "people")
                }
                if attachmentCount > 0 {
                    quickFact(icon: "paperclip", count: attachmentCount, label: attachmentCount == 1 ? "attachment" : "attachments")
                }
                if outboundCount > 0 {
                    quickFact(icon: "arrow.up.right", count: outboundCount, label: "out")
                }
                if inboundCount > 0 {
                    quickFact(icon: "arrow.down.left", count: inboundCount, label: "in")
                }
                Spacer()
            }
        }
    }

    private func quickFact(icon: String, count: Int, label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9))
                .foregroundStyle(Theme.accent)
            Text("\(count)")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }

    private var navigationTitle: String {
        if let doc {
            return doc.title.isEmpty ? "Document" : doc.title
        }
        return presetTitle ?? "Document"
    }

    // MARK: - Sections

    private var loadingHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let presetTitle {
                Text(presetTitle)
                    .font(.title2.bold())
                    .foregroundStyle(Theme.textPrimary)
            }
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading document…")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(doc: DocumentDetail) -> some View {
        HStack(alignment: .top, spacing: 10) {
            SourceIconView(sourceId: doc.sourceId, store: store, size: 32)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(doc.title.isEmpty ? "(untitled)" : doc.title)
                    .font(.title3.bold())
                    .foregroundStyle(Theme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                metaLine(doc: doc)
            }
        }
        .padding(.leading, 13)
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            Theme.docTypeAccent(doc.documentType)
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))
        }
    }

    @ViewBuilder
    private func metaLine(doc: DocumentDetail) -> some View {
        let text = metaParts(doc: doc).joined(separator: " · ")
        if isFileLike(doc.documentType) {
            // For file-like docs (Drive PDFs / attachments shown as their
            // own document) mirror the portal: file-type pill instead of
            // a generic "Document" label, so the user reads format at a
            // glance.
            HStack(spacing: 6) {
                FileTypePill(mimeType: doc.metadataString("mimeType"), filename: doc.title)
                Text(textExcludingDocLabel(doc: doc))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
            }
        } else {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private func metaParts(doc: DocumentDetail) -> [String] {
        var parts: [String] = [humanName(for: sourceTypeFromId(doc.sourceId))]
        if let label = docTypeLabel(doc.documentType) { parts.append(label) }
        if let when = formatTimeAgo(doc.sourceCreatedAt) { parts.append(when) }
        return parts
    }

    /// Same as `metaParts`, minus the doc-type label — used when the pill
    /// already carries the format.
    private func textExcludingDocLabel(doc: DocumentDetail) -> String {
        var parts: [String] = [humanName(for: sourceTypeFromId(doc.sourceId))]
        if let when = formatTimeAgo(doc.sourceCreatedAt) { parts.append(when) }
        return parts.joined(separator: " · ")
    }

    private func isFileLike(_ documentType: String?) -> Bool {
        guard let documentType else { return false }
        return documentType == "attachment" || documentType == "file"
    }

    private func bodySection(doc: DocumentDetail) -> some View {
        FlatSection("Content") {
            // Markdown rendering matches the portal's `marked.js` —
            // headings, lists, bold/italic, inline code, fenced
            // code, and blockquotes. Text stays selectable for
            // copy-out.
            MarkdownView(text: doc.content)
        }
    }

    // MARK: - Network

    private func load() async {
        guard let client = store.search else {
            loadError = URLError(.cannotConnectToHost)
            loading = false
            return
        }
        loading = true
        loadError = nil
        do {
            // Doc body first, then secondary panels concurrently. If
            // any secondary call fails we still show the body — the
            // refs/people/attachments rows just don't render.
            let fetchedDoc = try await client.getDocument(id: documentId)
            doc = fetchedDoc
            let outboundRequest = outboundRefsPaging.beginRefresh()
            let inboundRequest = inboundRefsPaging.beginRefresh()
            let nearDupesRequest = nearDupesPaging.beginRefresh()
            let annotationsRequest = annotationsPaging.beginRefresh()
            async let peopleTask = client.getDocumentPeople(id: documentId)
            async let attachmentsTask = client.getDocumentAttachments(id: documentId)
            async let refsTask = client.getDocumentRefs(id: documentId)
            async let nearDupesTask = client.getDocumentNearDupes(id: documentId)
            // See #644 — also surface the cross-store `same-entity` doc↔row edge
            // (#450) here, as the portal graph panel does. It comes from the
            // graph walker (`GET /documents/:id/graph`, kind == "analytics-row"),
            // not these reference endpoints, so it needs a separate fetch + row.
            // One shallow hop is enough: the bound analytics row is a direct
            // neighbour. Failure degrades silently — the section just hides.
            async let graphTask = client.getDocumentGraph(id: documentId)
            people = await (try? peopleTask) ?? []
            attachments = await (try? attachmentsTask) ?? []
            if let loadedRefs = try? await refsTask {
                refs = loadedRefs
                outboundRefsPaging.finishRefresh(
                    outboundRequest,
                    nextCursor: loadedRefs.outboundPageInfo.nextCursor
                )
                inboundRefsPaging.finishRefresh(
                    inboundRequest,
                    nextCursor: loadedRefs.inboundPageInfo.nextCursor
                )
            } else {
                outboundRefsPaging.failRefresh(outboundRequest)
                inboundRefsPaging.failRefresh(inboundRequest)
            }
            if let loadedNearDupes = try? await nearDupesTask {
                nearDupes = loadedNearDupes
                nearDupesPaging.finishRefresh(
                    nearDupesRequest,
                    nextCursor: loadedNearDupes.nextCursor
                )
            } else {
                nearDupesPaging.failRefresh(nearDupesRequest)
            }
            boundRows = await (try? graphTask)?.boundRows ?? []
            if let page = try? await client.getDocumentAnnotations(id: documentId) {
                annotations = page.annotations
                annotationsPaging.finishRefresh(
                    annotationsRequest,
                    nextCursor: page.pageInfo.nextCursor
                )
            } else {
                annotationsPaging.failRefresh(annotationsRequest)
            }
            loading = false
        } catch {
            loadError = error
            loading = false
        }
    }

    private func loadMoreOutboundRefs() async {
        guard let client = store.search else { return }
        guard let request = outboundRefsPaging.beginLoadMore() else { return }
        do {
            let page = try await client.getDocumentOutboundRefs(
                id: documentId,
                cursor: request.cursor
            )
            guard outboundRefsPaging.owns(request) else { return }
            var outbound = refs?.outbound ?? []
            let fresh = appendUnique(page.items, to: &outbound, id: \.id)
            refs = DocumentRefs(
                outbound: outbound,
                inbound: refs?.inbound ?? [],
                outboundPageInfo: page.pageInfo,
                inboundPageInfo: refs?.inboundPageInfo
            )
            outboundRefsPaging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            outboundRefsPaging.failLoadMore(request, error: error)
        }
    }

    private func loadMoreInboundRefs() async {
        guard let client = store.search else { return }
        guard let request = inboundRefsPaging.beginLoadMore() else { return }
        do {
            let page = try await client.getDocumentInboundRefs(
                id: documentId,
                cursor: request.cursor
            )
            guard inboundRefsPaging.owns(request) else { return }
            var inbound = refs?.inbound ?? []
            let fresh = appendUnique(page.items, to: &inbound, id: \.id)
            refs = DocumentRefs(
                outbound: refs?.outbound ?? [],
                inbound: inbound,
                outboundPageInfo: refs?.outboundPageInfo,
                inboundPageInfo: page.pageInfo
            )
            inboundRefsPaging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            inboundRefsPaging.failLoadMore(request, error: error)
        }
    }

    private func loadMoreNearDupes() async {
        guard let client = store.search else { return }
        guard let request = nearDupesPaging.beginLoadMore() else { return }
        do {
            let page = try await client.getDocumentNearDupes(
                id: documentId,
                cursor: request.cursor
            )
            guard nearDupesPaging.owns(request) else { return }
            var edges = nearDupes?.edges ?? []
            let fresh = appendUnique(page.edges, to: &edges, id: \.id)
            nearDupes = DocumentNearDupes(edges: edges, nextCursor: page.nextCursor)
            nearDupesPaging.finishLoadMore(
                request,
                nextCursor: page.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            nearDupesPaging.failLoadMore(request, error: error)
        }
    }

    private func loadMoreAnnotations() async {
        guard let client = store.search else { return }
        guard let request = annotationsPaging.beginLoadMore() else { return }
        do {
            let page = try await client.getDocumentAnnotations(
                id: documentId,
                cursor: request.cursor
            )
            guard annotationsPaging.owns(request) else { return }
            let fresh = appendUnique(page.annotations, to: &annotations, id: \.id)
            annotationsPaging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            annotationsPaging.failLoadMore(request, error: error)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Document detail — stable gateway with annotations") {
    NavigationStack {
        DocumentDetailPreviewWrapper()
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Document detail — load error") {
    NavigationStack {
        GatewayErrorView(
            context: "load this document",
            error: URLError(.cannotConnectToHost),
            onRetry: {}
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

/// Renders the same composition as `DocumentDetailView` body but
/// against pre-loaded mock state, so the preview shows the lean
/// document surface (header + content body + quick-facts strip).
/// The right-rail data — people, attachments, refs — now lives in
/// the tabbed `DocumentInspectorSheet` reached via the toolbar (i)
/// button; that surface has its own preview.
@available(iOS 17.0, *)
struct DocumentDetailPreviewWrapper: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let doc = PreviewMocks.documentDetail
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(alignment: .top, spacing: 10) {
                    SourceIconView(sourceId: doc.sourceId, store: store, size: 32)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(doc.title)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                        Text("Gmail · Email · 3d ago")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(.leading, 13)
                .padding(.vertical, 4)
                .overlay(alignment: .leading) {
                    Theme.docTypeAccent(doc.documentType)
                        .frame(width: 3)
                        .clipShape(RoundedRectangle(cornerRadius: 1.5))
                }
                HStack(spacing: 8) {
                    PreviewQuickFact(icon: "person.2", count: PreviewMocks.documentPeople.count, label: "people")
                    PreviewQuickFact(icon: "paperclip", count: PreviewMocks.documentAttachments.count, label: "attachment")
                    PreviewQuickFact(icon: "arrow.up.right", count: PreviewMocks.documentRefs.outbound.count, label: "out")
                    PreviewQuickFact(icon: "arrow.down.left", count: PreviewMocks.documentRefs.inbound.count, label: "in")
                    Spacer()
                }
                FlatSection("Content") {
                    MarkdownView(text: doc.content)
                }
                AnnotationsSection(title: "Enriched by Omnesis", annotations: PreviewMocks.documentAnnotations)
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Re: Stripe invoice for March")
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
    }
}

@available(iOS 17.0, *)
#Preview("Document detail — notes day") {
    NavigationStack {
        NotesDayPreviewWrapper()
            .environment(AppStore.preview())
    }
}

/// Static render of a generated Notes day document: header + content plus
/// the Manage-notes toolbar action. The live view shows the same button
/// when its `manageNotesLink()` resolves (Notes source + paired device);
/// the predicate itself is unit-tested in `NotesManageLinkTests`.
@available(iOS 17.0, *)
struct NotesDayPreviewWrapper: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let doc = PreviewMocks.notesDayDocument
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(alignment: .top, spacing: 10) {
                    SourceIconView(sourceId: doc.sourceId, store: store, size: 32)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(doc.title)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                        Text("Notes · note")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(.leading, 13)
                .padding(.vertical, 4)
                .overlay(alignment: .leading) {
                    Theme.docTypeAccent(doc.documentType)
                        .frame(width: 3)
                        .clipShape(RoundedRectangle(cornerRadius: 1.5))
                }
                FlatSection("Content") {
                    MarkdownView(text: doc.content)
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(doc.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Image(systemName: "square.and.pencil")
                    .tint(Theme.accent)
                    .accessibilityLabel("Manage notes")
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct PreviewQuickFact: View {
    let icon: String
    let count: Int
    let label: String
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9))
                .foregroundStyle(Theme.accent)
            Text("\(count)")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }
}
#endif
#endif
