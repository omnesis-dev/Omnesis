// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Half-sheet "i" inspector reachable from the document detail toolbar.
/// Hosts two tabs: a Metadata pane (the original right-rail dump of IDs,
/// timestamps, tags, source URL, raw extras) and an Omnesis-graph pane
/// that frames the people / attachments / references surrounding this
/// document as vertices and edges of one graph.
///
/// The graph pane reuses the portal's Omnesis-graph card vocabulary:
/// rows are grouped by edge type (Contains, References, Referenced by,
/// External links) so the type label lives in the section header
/// rather than as a per-row pill, leaving titles the full row width.
@available(iOS 17.0, *)
struct DocumentInspectorSheet: View {
    @Environment(\.dismiss) private var dismiss

    let doc: DocumentDetail
    let people: [PersonMention]
    let refs: DocumentRefs?
    let attachments: [DocumentAttachment]
    let nearDupes: DocumentNearDupes?
    /// Cross-store `same-entity` doc↔row neighbours — the
    /// bound DuckDB analytics rows from the graph walker.
    let boundRows: [GraphVertex]
    let outboundPaging: CursorPagingState
    let inboundPaging: CursorPagingState
    let nearDupesPaging: CursorPagingState
    let onLoadMoreOutbound: () -> Void
    let onLoadMoreInbound: () -> Void
    let onLoadMoreNearDupes: () -> Void

    enum Tab: Hashable { case metadata, graph, timeline }
    @State private var tab: Tab

    init(
        doc: DocumentDetail,
        people: [PersonMention],
        refs: DocumentRefs?,
        attachments: [DocumentAttachment],
        nearDupes: DocumentNearDupes? = nil,
        boundRows: [GraphVertex] = [],
        outboundPaging: CursorPagingState = CursorPagingState(),
        inboundPaging: CursorPagingState = CursorPagingState(),
        nearDupesPaging: CursorPagingState = CursorPagingState(),
        onLoadMoreOutbound: @escaping () -> Void = {},
        onLoadMoreInbound: @escaping () -> Void = {},
        onLoadMoreNearDupes: @escaping () -> Void = {},
        initialTab: Tab = .metadata
    ) {
        self.doc = doc
        self.people = people
        self.refs = refs
        self.attachments = attachments
        self.nearDupes = nearDupes
        self.boundRows = boundRows
        self.outboundPaging = outboundPaging
        self.inboundPaging = inboundPaging
        self.nearDupesPaging = nearDupesPaging
        self.onLoadMoreOutbound = onLoadMoreOutbound
        self.onLoadMoreInbound = onLoadMoreInbound
        self.onLoadMoreNearDupes = onLoadMoreNearDupes
        self._tab = State(initialValue: initialTab)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("View", selection: $tab) {
                    Text("Metadata").tag(Tab.metadata)
                    Text("Omnesis graph").tag(Tab.graph)
                    Text("Timeline").tag(Tab.timeline)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.top, Theme.Spacing.sm)
                .padding(.bottom, Theme.Spacing.sm)

                // The Timeline pane owns its own ScrollView (it can render
                // a tall trail), so only the metadata / graph panes share
                // the wrapping ScrollView below.
                switch tab {
                case .timeline:
                    TimelinePane(documentId: doc.id)
                case .metadata, .graph:
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            switch tab {
                            case .metadata:
                                MetadataPane(doc: doc)
                            case .graph:
                                GraphPane(
                                    doc: doc,
                                    people: people,
                                    refs: refs,
                                    attachments: attachments,
                                    nearDupes: nearDupes,
                                    boundRows: boundRows,
                                    outboundPaging: outboundPaging,
                                    inboundPaging: inboundPaging,
                                    nearDupesPaging: nearDupesPaging,
                                    onLoadMoreOutbound: onLoadMoreOutbound,
                                    onLoadMoreInbound: onLoadMoreInbound,
                                    onLoadMoreNearDupes: onLoadMoreNearDupes
                                )
                            case .timeline:
                                EmptyView()
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.bottom, Theme.Spacing.lg)
                    }
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
        }
        .omnesisColorScheme()
        .presentationDetents([.medium, .large])
    }

    private var navigationTitle: String {
        switch tab {
        case .metadata: "Metadata"
        case .graph: "Omnesis graph"
        case .timeline: "Timeline"
        }
    }
}

// MARK: - Timeline tab

/// Fetches `GET /documents/:id/trail` on appear and renders the decoded
/// `EventTrail` with the shared `TrailTimelineView` — the same renderer
/// the agent's Citations drawer uses. Loading / empty / error /
/// populated states; gateway-fetch failures route through the shared
/// `GatewayErrorView` classifier.
@available(iOS 17.0, *)
private struct TimelinePane: View {
    @Environment(AppStore.self) private var store

    let documentId: String

    @State private var trail: DocumentEventTrail?
    @State private var loading = true
    @State private var loadError: Error?
    /// Document tapped on the Timeline. The inspector hosts its own
    /// `NavigationStack`, so tapped documents push onto it.
    @State private var pushDocId: String?

    init(documentId: String) {
        self.documentId = documentId
    }

    #if DEBUG
    /// Preview/snapshot seam: inject a decoded trail so the populated
    /// Timeline renders synchronously without a live gateway fetch.
    init(documentId: String, previewTrail: DocumentEventTrail) {
        self.documentId = documentId
        self._trail = State(initialValue: previewTrail)
        self._loading = State(initialValue: false)
    }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if loading, trail == nil {
                    loadingState
                } else if let loadError, trail == nil {
                    GatewayErrorView(
                        context: "load this timeline",
                        error: loadError,
                        onRetry: { Task { await load() } }
                    )
                    .frame(minHeight: GatewayErrorView.minScrollHeight)
                } else if let trail, trail.events.isEmpty {
                    emptyState
                } else if let trail {
                    TrailTimelineView(
                        events: trail.events,
                        annotations: .empty
                    )
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .environment(\.openTrailDocument) { pushDocId = $0 }
        .navigationDestination(item: $pushDocId) { id in
            DocumentDetailView(documentId: id)
        }
        .task { await load() }
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView()
                .tint(Theme.accent)
            Text("Building timeline…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, Theme.Spacing.xl)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 28))
                .foregroundStyle(Theme.textMuted)
            Text("No timeline yet")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
            Text("This document isn't linked to any others, so there's nothing to thread together.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.lg)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Spacing.xl)
    }

    private func load() async {
        #if DEBUG
        // A preview-seeded trail short-circuits the fetch so the
        // populated snapshot renders deterministically.
        if !loading, trail != nil { return }
        #endif
        guard let client = store.search else {
            loading = false
            return
        }
        loading = true
        loadError = nil
        do {
            trail = try await client.documentTrail(documentId)
            loadError = nil
        } catch {
            loadError = error
        }
        loading = false
    }
}

// MARK: - Metadata tab

@available(iOS 17.0, *)
private struct MetadataPane: View {
    let doc: DocumentDetail

    var body: some View {
        coreFields
        if !tags.isEmpty {
            tagsCard
        }
        if let extras, !extras.isEmpty {
            extrasCard(extras: extras)
        }
        timestampsCard
        identifiersCard
    }

    private var coreFields: some View {
        FlatSection("Document") {
            VStack(alignment: .leading, spacing: 6) {
                kv("Type", value: docTypeLabel(doc.documentType) ?? "—")
                kv("Source", value: humanName(for: sourceTypeFromId(doc.sourceId)))
                if let url = doc.sourceUrl, !url.isEmpty {
                    kv("URL", value: url, mono: true)
                }
            }
        }
    }

    private var tagsCard: some View {
        FlatSection("Tags") {
            FlowLayout(spacing: 6) {
                ForEach(tags, id: \.self) { tag in
                    Text("#\(tag)")
                        .font(Theme.monospace(size: 11))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                }
            }
        }
    }

    private func extrasCard(extras: [(key: String, value: String)]) -> some View {
        FlatSection("Extras") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(extras, id: \.key) { entry in
                    kv(entry.key, value: entry.value, mono: true)
                }
            }
        }
    }

    private var timestampsCard: some View {
        FlatSection("Timestamps") {
            VStack(alignment: .leading, spacing: 6) {
                kv("Created", value: doc.sourceCreatedAt, mono: true)
                if let u = doc.sourceUpdatedAt {
                    kv("Updated", value: u, mono: true)
                }
                if let i = doc.ingestedAt {
                    kv("Ingested", value: i, mono: true)
                }
            }
        }
    }

    private var identifiersCard: some View {
        FlatSection("Identifiers") {
            VStack(alignment: .leading, spacing: 6) {
                kv("Document ID", value: doc.id, mono: true)
                kv("External ID", value: doc.externalId, mono: true)
                kv("Source ID", value: doc.sourceId, mono: true)
                kv("Provider ID", value: doc.providerId, mono: true)
            }
        }
    }

    // MARK: helpers

    private func kv(_ key: String, value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(key)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(mono ? Theme.monospace(size: 11) : .system(size: 12))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }

    /// Tags pulled from `metadata.tags` (string array on the wire).
    private var tags: [String] {
        guard case .object(let obj) = doc.metadata,
              case .array(let arr)? = obj["tags"] else { return [] }
        return arr.compactMap {
            if case .string(let s) = $0 { s } else { nil }
        }
    }

    /// Flat key-value list of `metadata.extra`. Nested objects flatten
    /// with dotted keys (`mime.type`). Attachments are excluded because
    /// they appear in the Omnesis-graph tab with rich rendering.
    private var extras: [(key: String, value: String)]? {
        guard case .object(let obj) = doc.metadata,
              case .object(let extras)? = obj["extra"]
        else { return nil }
        var rows: [(String, String)] = []
        flatten(extras, prefix: "", into: &rows)
        rows = rows.filter { !$0.0.hasPrefix("attachments") }
        rows.sort { $0.0 < $1.0 }
        return rows.map { (key: $0.0, value: $0.1) }
    }

    private func flatten(_ obj: [String: JSONValue], prefix: String, into rows: inout [(String, String)]) {
        for (key, val) in obj {
            let path = prefix.isEmpty ? key : "\(prefix).\(key)"
            switch val {
            case .object(let inner): flatten(inner, prefix: path, into: &rows)
            case .array(let arr):
                rows.append((path, "[\(arr.count) items]"))
            case .string(let s): rows.append((path, s))
            case .int(let i): rows.append((path, "\(i)"))
            case .double(let d): rows.append((path, "\(d)"))
            case .bool(let b): rows.append((path, b ? "true" : "false"))
            case .null: rows.append((path, "—"))
            }
        }
    }
}

// MARK: - Omnesis-graph tab

/// Mirrors the portal's `GraphCard` layout: one card per edge type, the
/// type lives in the section header so individual rows don't carry a
/// per-row pill. Vertices that are people get rich mini-cards; vertices
/// that are documents get a title row + a small muted meta sub-line.
@available(iOS 17.0, *)
private struct GraphPane: View {
    @Environment(AppStore.self) private var store

    let doc: DocumentDetail
    let people: [PersonMention]
    let refs: DocumentRefs?
    let attachments: [DocumentAttachment]
    let nearDupes: DocumentNearDupes?
    /// Cross-store `same-entity` doc↔row neighbours.
    let boundRows: [GraphVertex]
    let outboundPaging: CursorPagingState
    let inboundPaging: CursorPagingState
    let nearDupesPaging: CursorPagingState
    let onLoadMoreOutbound: () -> Void
    let onLoadMoreInbound: () -> Void
    let onLoadMoreNearDupes: () -> Void

    var body: some View {
        let outboundDocs = refs?.outbound.filter { $0.targetDocId != nil } ?? []
        let externalLinks = refs?.outbound.filter { $0.targetDocId == nil } ?? []
        let inboundDocs = refs?.inbound ?? []
        let similarEdges = nearDupes?.edges ?? []
        let total = boundRows.count
            + people.count
            + attachments.count
            + outboundDocs.count
            + inboundDocs.count
            + externalLinks.count
            + similarEdges.count
        let hasPagingBoundary = outboundPaging.hasPagingBoundary
            || inboundPaging.hasPagingBoundary
            || nearDupesPaging.hasPagingBoundary
        if total == 0, !hasPagingBoundary {
            emptyState
        } else {
            populatedBody(
                total: total,
                outboundDocs: outboundDocs,
                inboundDocs: inboundDocs,
                externalLinks: externalLinks,
                similarEdges: similarEdges
            )
        }
    }

    private func populatedBody(
        total: Int,
        outboundDocs: [OutboundRef],
        inboundDocs: [InboundRef],
        externalLinks: [OutboundRef],
        similarEdges: [NearDupEdge]
    )
        -> some View {
        let hasPartialEdges = outboundPaging.countIsPartial
            || inboundPaging.countIsPartial
            || nearDupesPaging.countIsPartial
        return VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            summaryHeader(total: total, hasPartialEdges: hasPartialEdges)
            // "Same entity" leads — it's the cross-store join (this doc ↔
            // its analytics row), the most direct relationship. Mirrors
            // the portal graph tab's section order.
            if !boundRows.isEmpty {
                sameEntitySection
            }
            if !people.isEmpty {
                peopleSection
            }
            if !attachments.isEmpty {
                containsSection
            }
            if !outboundDocs.isEmpty {
                referencesSection(outboundDocs)
            }
            if !inboundDocs.isEmpty || inboundPaging.hasPagingBoundary {
                referencedBySection(inboundDocs)
            }
            if !similarEdges.isEmpty || nearDupesPaging.hasPagingBoundary {
                similarSection(similarEdges)
            }
            if !externalLinks.isEmpty {
                externalLinksSection(externalLinks)
            }
            ListPagingFooter(
                state: outboundPaging,
                label: "Load more references",
                retry: onLoadMoreOutbound
            )
        }
    }

    private var emptyState: some View {
        HStack(spacing: 10) {
            Image(systemName: "circle.dotted")
                .foregroundStyle(Theme.textMuted)
            Text("No graph neighbors yet. People, attachments, and references will appear here as they're indexed.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.vertical, Theme.Spacing.md)
    }

    private func summaryHeader(total: Int, hasPartialEdges: Bool) -> some View {
        HStack {
            Text("Vertices & edges connected to this document")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            Spacer()
            Text(hasPartialEdges ? "\(total) loaded" : "\(total) edge\(total == 1 ? "" : "s")")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
        }
    }

    // MARK: - Sections

    private var sameEntitySection: some View {
        SectionCard(label: "Same entity", count: boundRows.count, hint: "bound analytics row") {
            VStack(spacing: 0) {
                ForEach(boundRows) { vertex in
                    BoundRowGraphRow(vertex: vertex)
                }
            }
        }
    }

    private var peopleSection: some View {
        SectionCard(label: "People", count: people.count, hint: "connected by role") {
            VStack(spacing: 0) {
                ForEach(people, id: \.self) { person in
                    PersonGraphRow(person: person)
                }
            }
        }
    }

    private var containsSection: some View {
        SectionCard(label: "Contains", count: attachments.count, hint: "attachments") {
            VStack(spacing: 0) {
                ForEach(attachments) { att in
                    AttachmentGraphRow(att: att)
                }
            }
        }
    }

    private func referencesSection(_ outboundRefs: [OutboundRef]) -> some View {
        SectionCard(
            label: "References",
            count: outboundRefs.count,
            countIsPartial: outboundPaging.countIsPartial,
            hint: "this doc → others"
        ) {
            VStack(spacing: 0) {
                ForEach(outboundRefs) { ref in
                    OutboundDocGraphRow(ref: ref)
                }
            }
        }
    }

    private func referencedBySection(_ inboundRefs: [InboundRef]) -> some View {
        SectionCard(
            label: "Referenced by",
            count: inboundRefs.count,
            countIsPartial: inboundPaging.countIsPartial,
            hint: "others → this doc"
        ) {
            VStack(spacing: 0) {
                ForEach(inboundRefs) { ref in
                    InboundDocGraphRow(ref: ref)
                }
                ListPagingFooter(
                    state: inboundPaging,
                    label: "Load more referring documents",
                    retry: onLoadMoreInbound
                )
            }
        }
    }

    private func similarSection(_ edges: [NearDupEdge]) -> some View {
        SectionCard(
            label: "Similar",
            count: edges.count,
            countIsPartial: nearDupesPaging.countIsPartial,
            hint: "near-duplicates"
        ) {
            VStack(spacing: 0) {
                ForEach(edges) { edge in
                    NearDupGraphRow(edge: edge)
                }
                ListPagingFooter(
                    state: nearDupesPaging,
                    label: "Load more similar documents",
                    retry: onLoadMoreNearDupes
                )
            }
        }
    }

    private func externalLinksSection(_ outboundRefs: [OutboundRef]) -> some View {
        SectionCard(
            label: "External links",
            count: outboundRefs.count,
            countIsPartial: outboundPaging.countIsPartial,
            hint: "targets not in your index"
        ) {
            VStack(spacing: 0) {
                ForEach(outboundRefs) { ref in
                    ExternalLinkGraphRow(ref: ref)
                }
            }
        }
    }
}

// MARK: - Section + row primitives

@available(iOS 17.0, *)
private struct SectionCard<Content: View>: View {
    let label: String
    let count: Int
    var countIsPartial = false
    let hint: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: 8) {
                Text(label.uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.textSecondary)
                Text(countIsPartial ? "\(count) loaded" : "\(count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                    .monospacedDigit()
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 1)
                    .frame(maxWidth: .infinity)
                if let hint {
                    Text(hint)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.top, Theme.Spacing.md)
            content
        }
    }
}

@available(iOS 17.0, *)
private struct PersonGraphRow: View {
    let person: PersonMention

    var body: some View {
        NavigationLink {
            PersonDetailView(personId: person.personId, presetName: person.displayName)
        } label: {
            HStack(spacing: 10) {
                PersonAvatar(name: person.displayName, isSelf: person.isSelf, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(person.displayName)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        if person.isSelf {
                            Text("(you)")
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                    Text(person.role.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.textMuted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct AttachmentGraphRow: View {
    let att: DocumentAttachment

    private func wrap(@ViewBuilder content: () -> some View) -> some View {
        NavigationLink {
            DocumentDetailView(documentId: att.id, presetTitle: att.title)
        } label: { content() }.buttonStyle(.plain)
    }

    var body: some View {
        wrap {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    FileTypeIcon(mimeType: att.mimeType, filename: att.title, size: 14)
                    Text(att.title.isEmpty ? att.attachmentId : att.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                let parts = metaParts
                if !parts.isEmpty {
                    Text(parts.joined(separator: " · "))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                        .padding(.leading, 22)
                }
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
    }

    private var metaParts: [String] {
        var parts: [String] = []
        if let mime = att.mimeType, !mime.isEmpty { parts.append(mime) }
        if let size = att.sizeBytes, size > 0 { parts.append(formatBytes(size)) }
        if let pages = att.pages, pages > 0 { parts.append("\(pages) pages") }
        if att.truncated == true { parts.append("truncated") }
        return parts
    }

    private func formatBytes(_ n: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: n)
    }
}

@available(iOS 17.0, *)
private struct OutboundDocGraphRow: View {
    let ref: OutboundRef

    private func wrap(@ViewBuilder content: () -> some View) -> some View {
        NavigationLink {
            DocumentDetailView(
                documentId: ref.targetDocId ?? "",
                presetTitle: ref.targetTitle
            )
        } label: { content() }.buttonStyle(.plain)
    }

    var body: some View {
        wrap {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text((ref.targetTitle?.isEmpty == false ? ref.targetTitle! : "(untitled)"))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                let parts = subParts
                if !parts.isEmpty {
                    Text(parts.joined(separator: " · "))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .disabled(ref.targetDocId == nil)
    }

    private var subParts: [String] {
        var parts: [String] = []
        if let s = ref.targetSourceId {
            parts.append(humanName(for: sourceTypeFromId(s)))
        }
        if ref.linkType != "references", ref.linkType != "url" {
            parts.append(ref.linkType)
        }
        return parts
    }
}

@available(iOS 17.0, *)
private struct InboundDocGraphRow: View {
    @Environment(AppStore.self) private var store
    let ref: InboundRef

    private func wrap(@ViewBuilder content: () -> some View) -> some View {
        NavigationLink {
            DocumentDetailView(
                documentId: ref.sourceDocId,
                presetTitle: ref.sourceTitle
            )
        } label: { content() }.buttonStyle(.plain)
    }

    var body: some View {
        wrap {
            HStack(spacing: 10) {
                SourceIconView(sourceId: ref.sourceSourceId, store: store, size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ref.sourceTitle.isEmpty ? "(untitled)" : ref.sourceTitle)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(humanName(for: sourceTypeFromId(ref.sourceSourceId)))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
    }
}

@available(iOS 17.0, *)
private struct NearDupGraphRow: View {
    @Environment(AppStore.self) private var store
    let edge: NearDupEdge

    private func wrap(@ViewBuilder content: () -> some View) -> some View {
        NavigationLink {
            DocumentDetailView(documentId: edge.otherDocId, presetTitle: edge.otherTitle)
        } label: { content() }.buttonStyle(.plain)
    }

    var body: some View {
        wrap {
            HStack(spacing: 10) {
                SourceIconView(sourceId: edge.otherSourceId, store: store, size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(edge.otherTitle.isEmpty ? "(untitled)" : edge.otherTitle)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(humanName(for: sourceTypeFromId(edge.otherSourceId)))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
                Spacer()
                Text("\(Int((edge.jaccard * 100).rounded()))%")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.borderLight).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
    }
}

/// Cross-store `same-entity` row: the document's bound
/// DuckDB analytics row. Unlike the other graph rows there's no iOS
/// destination to push (the portal links to its table browser, which has no
/// app equivalent), so this is a static, non-tappable row: a table glyph,
/// the table's display name, and up to four headline `column: value`
/// fields on a wrapped muted sub-line.
@available(iOS 17.0, *)
private struct BoundRowGraphRow: View {
    let vertex: GraphVertex

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "tablecells")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.accent)
                Text(vertex.tableLabel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
            }
            let fields = vertex.headlineFields()
            if !fields.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(fields, id: \.key) { field in
                        BoundRowFieldChip(key: field.key, value: field.value)
                    }
                }
                .padding(.leading, 21)
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.borderLight).frame(height: 1)
        }
    }
}

/// One `column: value` chip on a bound-row sub-line — keeps the column
/// name muted and the value legible, and ellipses long values so a
/// chatty field can't push the chip past the row width.
@available(iOS 17.0, *)
private struct BoundRowFieldChip: View {
    let key: String
    let value: String

    var body: some View {
        HStack(spacing: 0) {
            Text("\(key): ")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
            Text(value)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .lineLimit(1)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.bgPrimary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }
}

@available(iOS 17.0, *)
private struct ExternalLinkGraphRow: View {
    let ref: OutboundRef

    var body: some View {
        let url = URL(string: ref.rawTarget)
        let isHttp = (url?.scheme == "http") || (url?.scheme == "https")
        if isHttp, let url {
            Link(destination: url) { rowContent(isHttp: true) }
        } else {
            rowContent(isHttp: false)
        }
    }

    private func rowContent(isHttp: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(ref.rawTarget)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(isHttp ? Theme.accent : Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if isHttp {
                    Image(systemName: "arrow.up.forward.app")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            if ref.linkType != "url" {
                Text("\(ref.linkType) · not yet indexed")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.borderLight).frame(height: 1)
        }
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Document inspector — Metadata") {
    DocumentInspectorSheet(
        doc: PreviewMocks.documentDetail,
        people: PreviewMocks.documentPeople,
        refs: PreviewMocks.documentRefs,
        attachments: PreviewMocks.documentAttachments
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Document inspector — Omnesis graph") {
    DocumentInspectorSheet(
        doc: PreviewMocks.documentDetail,
        people: PreviewMocks.documentPeople,
        refs: PreviewMocks.documentRefs,
        attachments: PreviewMocks.documentAttachments,
        nearDupes: PreviewMocks.documentNearDupes,
        outboundPaging: CursorPagingState(nextCursor: "outbound-next"),
        inboundPaging: CursorPagingState(nextCursor: "inbound-next"),
        nearDupesPaging: CursorPagingState(nextCursor: "similar-next"),
        initialTab: .graph
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Document inspector — Same entity (bound row)") {
    DocumentInspectorSheet(
        doc: PreviewMocks.documentDetail,
        people: PreviewMocks.documentPeople,
        refs: PreviewMocks.documentRefs,
        attachments: PreviewMocks.documentAttachments,
        nearDupes: PreviewMocks.documentNearDupes,
        boundRows: PreviewMocks.documentGraphBoundRows,
        initialTab: .graph
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Document inspector — Timeline (sheet, opens on tab)") {
    DocumentInspectorSheet(
        doc: PreviewMocks.documentDetail,
        people: PreviewMocks.documentPeople,
        refs: PreviewMocks.documentRefs,
        attachments: PreviewMocks.documentAttachments,
        nearDupes: PreviewMocks.documentNearDupes,
        initialTab: .timeline
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("TimelinePane — populated") {
    TimelinePane(
        documentId: "doc-preview",
        previewTrail: DocumentEventTrail(
            seeds: ["evt-wa-used"],
            events: PreviewMocks.trailVoucherJourney,
            truncated: false
        )
    )
    .background(Theme.bgPrimary.ignoresSafeArea())
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TimelinePane — empty") {
    TimelinePane(
        documentId: "doc-preview-empty",
        previewTrail: DocumentEventTrail(seeds: [], events: [], truncated: false)
    )
    .background(Theme.bgPrimary.ignoresSafeArea())
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}
#endif
#endif
