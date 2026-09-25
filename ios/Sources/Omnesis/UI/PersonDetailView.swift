// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Single-person detail view — header (avatar + name + self badge),
/// aliases panel, interaction stats panel, latest documents list.
/// Tap a doc row to push `DocumentDetailView`. Surfaces merge state
/// in two forms: a "merged into [canonical]" banner on loser rows, and
/// a concise "N people merged into this" affordance on canonicals that
/// expands a sheet with the full list when tapped.
@available(iOS 17.0, *)
struct PersonDetailView: View {
    @Environment(AppStore.self) private var store

    let personId: String
    var presetName: String?

    @State private var person: PersonDetail?
    @State private var docs: [PersonDocumentEntry] = []
    @State private var docPreviews: [String: DocumentDetail] = [:]
    /// The agent's durable, evidence-grounded annotations about this person.
    @State private var annotations: [Annotation] = []
    @State private var annotationsPaging = CursorPagingState()
    @State private var loading = true
    @State private var loadError: Error?
    @State private var docsPaging = CursorPagingState()
    @State private var loadGeneration = 0
    @State private var showMergeSheet = false
    private let pageSize = 30

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if loading, person == nil {
                    headerLoading
                } else if let loadError, person == nil {
                    GatewayErrorView(
                        context: "load this person",
                        error: loadError,
                        onRetry: { Task { await load() } }
                    )
                    .frame(minHeight: GatewayErrorView.minScrollHeight)
                } else if let person {
                    header(person: person)
                    if let target = person.mergedInto {
                        MergedIntoBanner(
                            target: target,
                            targetName: person.mergedIntoCanonicalName
                        )
                    }
                    if let merged = person.mergedFrom, !merged.isEmpty {
                        MergedFromSummary(count: merged.count) {
                            showMergeSheet = true
                        }
                    }
                    if !person.aliases.isEmpty {
                        aliasesCard(aliases: person.aliases)
                    }
                    if !person.isSelf {
                        interactionCard(person: person)
                    }
                    if shouldShowPagedContent(
                        itemCount: annotations.count,
                        paging: annotationsPaging
                    ) {
                        AnnotationsSection(
                            title: annotationsTitle(person: person),
                            annotations: annotations,
                            paging: annotationsPaging,
                            onLoadMore: { Task { await loadMoreAnnotations() } }
                        )
                    }
                    documentsSection
                }
            }
            // Force the scroll content to span the full available width.
            // Without this, narrow content (the loading state in
            // particular) lets the ScrollView size to content and the
            // `.background(...)` below it only covers that narrower
            // region — exposing the navigation-stack's system-dark
            // wrapper as a column on either side.
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: personId) { await load() }
        .sheet(isPresented: $showMergeSheet) {
            if let merged = person?.mergedFrom, !merged.isEmpty {
                MergedFromSheet(
                    merged: merged,
                    canonicalName: person?.canonicalName ?? ""
                )
                .presentationDetents([.medium, .large])
            }
        }
        .omnesisColorScheme()
    }

    private var navigationTitle: String {
        if let person { return person.canonicalName.isEmpty ? "Person" : person.canonicalName }
        return presetName ?? "Person"
    }

    /// Title for the LLM-annotations section: the self person's are the
    /// user's own "Profile"; anyone else's are framed as what Omnesis has
    /// learned about them.
    private func annotationsTitle(person: PersonDetail) -> String {
        if person.isSelf { return "Profile" }
        let name = person.canonicalName.isEmpty ? "this person" : person.canonicalName
        return "What Omnesis has learned about \(name)"
    }

    // MARK: - Header

    private var headerLoading: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.md) {
                Circle().fill(Theme.bgSecondary).frame(width: 56, height: 56)
                if let presetName {
                    Text(presetName)
                        .font(.title3.bold())
                        .foregroundStyle(Theme.textPrimary)
                }
            }
            HStack { ProgressView()
                Text("Loading person…").foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func header(person: PersonDetail) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            PersonAvatar(name: person.canonicalName, isSelf: person.isSelf, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(person.canonicalName.isEmpty ? "(no name)" : person.canonicalName)
                        .font(.title3.bold())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                    if person.isSelf {
                        Text("(self)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.success)
                    }
                }
                if let firstSeen = formatTimeAgo(person.firstSeen),
                   let lastSeen = formatTimeAgo(person.lastSeen) {
                    Text("first seen \(firstSeen) · last seen \(lastSeen)")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            Spacer()
        }
    }

    // MARK: - Aliases

    private func aliasesCard(aliases: [PersonAlias]) -> some View {
        FlatSection("Aliases") {
            FlowLayout(spacing: 6) {
                ForEach(Array(aliases.enumerated()), id: \.element.id) { _, alias in
                    aliasChip(alias)
                }
            }
        }
    }

    private func aliasChip(_ alias: PersonAlias) -> some View {
        HStack(spacing: 4) {
            Image(systemName: aliasIcon(alias.aliasType))
                .font(.system(size: 9))
                .foregroundStyle(Theme.textMuted)
            Text(alias.alias)
                .font(Theme.monospace(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private func aliasIcon(_ type: String) -> String {
        switch type {
        case "email": "envelope"
        case "phone": "phone"
        case "lid": "number"
        case "name": "person"
        default: "tag"
        }
    }

    // MARK: - Interaction stats

    private func interactionCard(person: PersonDetail) -> some View {
        FlatSection("Interaction") {
            HStack(spacing: Theme.Spacing.lg) {
                statBlock(
                    label: "Recent score",
                    value: scoreText(person.interactionScoreRecent)
                )
                statBlock(
                    label: "Lifetime score",
                    value: scoreText(person.interactionScore)
                )
                statBlock(
                    label: "Edges",
                    value: edgesText(person)
                )
            }
        }
    }

    private func statBlock(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func scoreText(_ score: Double?) -> String {
        guard let score else { return "—" }
        return String(format: "%.3f", score)
    }

    private func edgesText(_ person: PersonDetail) -> String {
        let inbound = person.inboundCount ?? 0
        let outbound = person.outboundCount ?? 0
        return "\(inbound) in / \(outbound) out"
    }

    // MARK: - Documents

    private var documentsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            FlatSectionHeader(
                title: "Latest documents",
                trailing: docs.isEmpty
                    ? nil
                    : pagingCountLabel(docs.count, countIsPartial: docsPaging.countIsPartial)
            )
            if docs.isEmpty, !loading,
               !shouldShowPagedContent(itemCount: docs.count, paging: docsPaging) {
                Text("No documents linked yet.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.vertical, Theme.Spacing.sm)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(docs.enumerated()), id: \.element.id) { idx, entry in
                        NavigationLink {
                            DocumentDetailView(
                                documentId: entry.id,
                                presetTitle: docPreviews[entry.id]?.title
                            )
                        } label: {
                            documentRow(entry: entry, doc: docPreviews[entry.id])
                        }
                        .buttonStyle(.plain)
                        if idx < docs.count - 1 {
                            Divider().background(Theme.borderLight)
                        }
                    }
                    ListPagingFooter(
                        state: docsPaging,
                        label: "Load more documents"
                    ) {
                        Task { await loadMoreDocuments() }
                    }
                }
            }
        }
    }

    private func documentRow(entry: PersonDocumentEntry, doc: DocumentDetail?) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            if let doc {
                SourceIconView(sourceId: doc.sourceId, store: store, size: 22)
                    .padding(.top, 2)
            } else {
                Image(systemName: "doc.text")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 22, height: 22)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(displayTitle(doc: doc))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                metaRow(doc: doc, roles: entry.roles)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func displayTitle(doc: DocumentDetail?) -> String {
        guard let doc else { return "Loading…" }
        return doc.title.isEmpty ? "(untitled)" : doc.title
    }

    @ViewBuilder
    private func metaRow(doc: DocumentDetail?, roles: [String]) -> some View {
        let parts = metaParts(doc: doc, roles: roles)
        Text(parts.joined(separator: " · "))
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)
            .lineLimit(1)
    }

    private func metaParts(doc: DocumentDetail?, roles: [String]) -> [String] {
        var parts: [String] = []
        if let doc {
            parts.append(humanName(for: sourceTypeFromId(doc.sourceId)))
            if let label = docTypeLabel(doc.documentType) { parts.append(label) }
            if let when = formatTimeAgo(doc.sourceCreatedAt) { parts.append(when) }
        }
        if !roles.isEmpty {
            parts.append(roles.map(\.capitalized).joined(separator: ", "))
        }
        return parts
    }

    // MARK: - Network

    private func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        loading = true
        loadError = nil
        person = nil
        docs = []
        docPreviews = [:]
        let docsRequest = docsPaging.beginRefresh()
        guard let client = store.search else {
            docsPaging.failRefresh(docsRequest)
            loadError = URLError(.cannotConnectToHost)
            loading = false
            return
        }
        defer {
            if generation == loadGeneration {
                loading = false
            }
        }
        do {
            async let pendingPerson = client.getPerson(id: personId)
            async let pendingDocuments = client.getPersonDocumentsPage(id: personId, limit: pageSize)
            let (loadedPerson, loadedPage) = try await (pendingPerson, pendingDocuments)
            guard generation == loadGeneration, docsPaging.owns(docsRequest) else { return }
            person = loadedPerson
            docs = loadedPage.items
            docsPaging.finishRefresh(
                docsRequest,
                nextCursor: loadedPage.pageInfo.nextCursor
            )
            loadError = nil
            let request = annotationsPaging.beginRefresh()
            if let page = try? await client.getPersonAnnotations(id: personId) {
                annotations = page.annotations
                annotationsPaging.finishRefresh(
                    request,
                    nextCursor: page.pageInfo.nextCursor
                )
            } else {
                annotationsPaging.failRefresh(request)
            }
            await loadDocPreviews(
                client: client,
                ids: loadedPage.items.map(\.id),
                generation: generation
            )
        } catch {
            docsPaging.failRefresh(docsRequest)
            guard generation == loadGeneration else { return }
            loadError = error
        }
    }

    private func loadMoreDocuments() async {
        guard let client = store.search else { return }
        guard let request = docsPaging.beginLoadMore() else { return }
        let generation = loadGeneration
        do {
            let page = try await client.getPersonDocumentsPage(
                id: personId,
                limit: pageSize,
                cursor: request.cursor
            )
            guard docsPaging.owns(request) else { return }
            let fresh = appendUnique(page.items, to: &docs, id: \.id)
            docsPaging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: !fresh.isEmpty
            )
            await loadDocPreviews(
                client: client,
                ids: fresh.map(\.id),
                generation: generation
            )
        } catch {
            docsPaging.failLoadMore(request, error: error)
        }
    }

    private func loadDocPreviews(
        client: SearchClient,
        ids: [String],
        generation: Int
    ) async {
        await withTaskGroup(of: (String, DocumentDetail?).self) { group in
            for id in ids {
                group.addTask {
                    let doc = try? await client.getDocument(id: id)
                    return (id, doc)
                }
            }
            for await (id, doc) in group {
                if generation == loadGeneration, let doc {
                    docPreviews[id] = doc
                }
            }
        }
    }

    private func loadMoreAnnotations() async {
        guard let client = store.search else { return }
        guard let request = annotationsPaging.beginLoadMore() else { return }
        do {
            let page = try await client.getPersonAnnotations(
                id: personId,
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

// MARK: - Tiny flow-layout for alias chips

/// Wrap chips left-to-right, top-to-bottom. Stand-in for SwiftUI's
/// `AnyLayout` so we don't pin to iOS 17 specifics.
@available(iOS 17.0, *)
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let layout = compute(maxWidth: maxWidth, subviews: subviews)
        return CGSize(width: maxWidth.isFinite ? maxWidth : layout.width, height: layout.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = compute(maxWidth: bounds.width, subviews: subviews)
        for (subview, point) in zip(subviews, layout.positions) {
            subview.place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: .unspecified
            )
        }
    }

    private func compute(maxWidth: CGFloat, subviews: Subviews) -> (width: CGFloat, height: CGFloat, positions: [CGPoint]) {
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            maxX = max(maxX, x)
        }
        return (maxX, y + lineHeight, positions)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Person — stable gateway with annotations") {
    NavigationStack {
        PersonDetailPreviewWrapper()
            .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Person — loading (preset name)") {
    NavigationStack {
        PersonDetailLoadingPreview(presetName: "Alice Liddell")
    }
}

@available(iOS 17.0, *)
#Preview("Person — loading (no preset name)") {
    NavigationStack {
        PersonDetailLoadingPreview(presetName: nil)
    }
}

@available(iOS 17.0, *)
#Preview("Person — load error") {
    NavigationStack {
        GatewayErrorView(
            context: "load this person",
            error: URLError(.cannotConnectToHost),
            onRetry: {}
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

/// Replays the exact view hierarchy `PersonDetailView` renders while
/// `loading == true && person == nil`. Lives outside the parent struct
/// so the preview / snapshot harness can mount it without driving the
/// `.task { await load() }` network fetch (which would flip the state
/// out of loading immediately when no gateway is paired).
@available(iOS 17.0, *)
struct PersonDetailLoadingPreview: View {
    let presetName: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.md) {
                    Circle().fill(Theme.bgSecondary).frame(width: 56, height: 56)
                    if let presetName {
                        Text(presetName)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                    }
                }
                HStack { ProgressView()
                    Text("Loading person…").foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(presetName ?? "Person")
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
    }
}

/// Render the static composition of `PersonDetailView` against fully
/// loaded mock data, skipping the on-appear network fetch.
@available(iOS 17.0, *)
struct PersonDetailPreviewWrapper: View {
    @Environment(AppStore.self) private var store

    private var person: PersonDetail {
        PreviewMocks.personDetail
    }

    private var docs: [PersonDocumentEntry] {
        PreviewMocks.personDocuments
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.md) {
                    PersonAvatar(name: person.canonicalName, isSelf: person.isSelf, size: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.canonicalName)
                            .font(.title3.bold())
                            .foregroundStyle(Theme.textPrimary)
                        if let firstSeen = formatTimeAgo(person.firstSeen),
                           let lastSeen = formatTimeAgo(person.lastSeen) {
                            Text("first seen \(firstSeen) · last seen \(lastSeen)")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    Spacer()
                }
                FlatSection("Aliases") {
                    FlowLayout(spacing: 6) {
                        ForEach(person.aliases, id: \.id) { alias in
                            HStack(spacing: 4) {
                                Image(systemName: aliasIcon(alias.aliasType))
                                    .font(.system(size: 9))
                                    .foregroundStyle(Theme.textMuted)
                                Text(alias.alias)
                                    .font(Theme.monospace(size: 11))
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Theme.bgTertiary)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                        }
                    }
                }
                FlatSection("Interaction") {
                    HStack(spacing: Theme.Spacing.lg) {
                        stat("0.412", "Recent")
                        stat("0.412", "Lifetime")
                        stat("200 in / 212 out", "Edges")
                    }
                }
                AnnotationsSection(
                    title: "What Omnesis has learned about \(person.canonicalName)",
                    annotations: PreviewMocks.personAnnotations
                )
                FlatSectionHeader(title: "Latest documents")
                VStack(spacing: 0) {
                    ForEach(docs, id: \.id) { entry in
                        HStack(spacing: 10) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.textMuted)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Document \(entry.id)")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Theme.textPrimary)
                                Text(entry.roles.joined(separator: ", "))
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.textMuted)
                            }
                            Spacer()
                        }
                        .padding(Theme.Spacing.md)
                        Divider().background(Theme.borderLight)
                    }
                    ListPagingFooter(
                        state: CursorPagingState(nextCursor: "preview-next"),
                        label: "Load more documents",
                        retry: {}
                    )
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Alice Liddell")
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func aliasIcon(_ type: String) -> String {
        switch type {
        case "email": "envelope"
        case "phone": "phone"
        case "lid": "number"
        case "name": "person"
        default: "tag"
        }
    }
}
#endif
#endif
