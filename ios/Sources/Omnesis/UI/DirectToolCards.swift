// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// Static twin of the agent's ephemeral tool cards, for the after-the-fact
// Direct transcript. The portal renders these calls through the same shared
// `StaticToolCard`; here the content model (`DirectCardContent`, built in the
// Transport layer) drives native rows: result titles with source icons, SQL
// rowblocks, trail/people/loop rows — and every row that names a document,
// person or loop carries its link target. Rows stay the same grey as their
// neighbours; tappable rows push without a chevron — the card header's raw
// affordance is the only trailing icon.

// MARK: - Card

/// One settled tool call, rendered flat: the header names the call, the body
/// carries its rows, and the full payload sits one tap away behind the
/// trailing raw affordance. Mirrors the portal's `StaticToolCard` with its
/// `ToolCardTrailing`: no wrapper, no success chip — only failures speak,
/// through the shared error card.
@available(iOS 17.0, *)
struct DirectToolCardView: View {
    let tool: String
    let content: DirectCardContent
    var timeText: String?
    var rawPayload: JSONValue?

    @State private var showingRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            header
            if let sections = content.sections {
                ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
                    DirectCardSectionView(section: section)
                }
            } else {
                DirectCardSectionView(section: DirectCardSection(
                    heading: nil,
                    rows: content.rows,
                    sql: content.sql,
                    error: content.error,
                    showsEmpty: content.showsEmpty
                ))
            }
            if let note = content.note {
                Text(note)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .padding(.leading, 8)
        .sheet(isPresented: $showingRaw) {
            DirectRawJsonSheet(
                title: "\(content.label) — raw JSON",
                text: rawPayload.map(directAuditPayloadText) ?? "null"
            )
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: glyph)
                .font(.system(size: 11))
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            Text(content.label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            if let icon = content.argIcon {
                DirectHeaderArgIconView(icon: icon)
            }
            if !content.arg.isEmpty {
                argText
            }
            Spacer(minLength: 0)
            if let timeText, !timeText.isEmpty {
                Text(timeText)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
            if rawPayload != nil {
                Button { showingRaw = true } label: {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 11))
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.textMuted)
                .accessibilityLabel("Show raw JSON")
            }
        }
    }

    @ViewBuilder
    private var argText: some View {
        if case .external(let urlString) = content.argLink,
           let url = URL(string: urlString) {
            // The looked-up URL opens out-of-app but reads as plain argument
            // text — grey like the rest, never link-blue — per the portal's
            // `.agent-ephemeral-arg a` rule.
            Link(content.arg, destination: url)
                .font(Theme.monospace(size: 11))
                .tint(Theme.textMuted)
                .underline(false)
                .lineLimit(1)
                .truncationMode(.tail)
        } else {
            Text(content.arg)
                .font(Theme.monospace(size: 11))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private var glyph: String {
        switch tool {
        case "search_many", "search_documents": "magnifyingglass"
        case "fetch_many", "fetch_document": "doc.text"
        case "lookup_document_by_url": "link"
        case "lookup_people": "person.2"
        case "trace_connections": "point.3.connected.trianglepath.dotted"
        case "run_sql": "tablecells"
        case "search_loops", "list_loops", "fetch_loop", "open_loop_search", "open_loop_fetch":
            "arrow.triangle.2.circlepath"
        case "temporal_query": "clock"
        case "entity_context": "circle.dotted"
        default: "questionmark.circle"
        }
    }
}

// MARK: - Section

@available(iOS 17.0, *)
struct DirectCardSectionView: View {
    let section: DirectCardSection

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let heading = section.heading, !heading.isEmpty {
                Text(heading)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let error = section.error {
                AgentToolResultErrorView(code: error.code, message: error.message)
            }
            ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                DirectCardRowView(row: row)
            }
            if let sql = section.sql {
                DirectSqlBlockView(block: sql)
            }
            if section.showsEmpty {
                Text("No result")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Raw JSON sheet

/// The full payload behind a card's trailing raw affordance: scrollable
/// mono pretty-printed JSON titled "{label} — raw JSON", mirroring the
/// portal's raw overlay. The text is the complete record — never clipped.
@available(iOS 17.0, *)
struct DirectRawJsonSheet: View {
    let title: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Rows

@available(iOS 17.0, *)
struct DirectCardRowView: View {
    @Environment(AppStore.self) private var store
    let row: DirectCardRow

    @State private var pushDocumentId: String?
    @State private var pushPerson: DirectPersonPush?

    var body: some View {
        switch row.destination {
        case .document(let id, let sourceId, _):
            Button { pushDocumentId = id } label: { rowBody(sourceId: sourceId) }
                .buttonStyle(.plain)
                .navigationDestination(item: $pushDocumentId) { pushed in
                    AgentDocumentDetailView(documentId: pushed)
                }
        case .person(let canonicalId, let name):
            Button {
                pushPerson = DirectPersonPush(id: canonicalId, name: name ?? row.title)
            } label: {
                rowBody(sourceId: nil)
            }
            .buttonStyle(.plain)
            .navigationDestination(item: $pushPerson) { pushed in
                PersonDetailView(personId: pushed.id, presetName: pushed.name)
            }
        case .external(let urlString):
            if let url = URL(string: urlString) {
                Link(destination: url) { rowBody(sourceId: nil) }
            } else {
                rowBody(sourceId: nil)
            }
        case .loop, .none:
            rowBody(sourceId: nil)
        }
    }

    private func rowBody(sourceId: String?) -> some View {
        HStack(spacing: 6) {
            rowIcon(sourceId: sourceId)
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title.isEmpty ? "Untitled" : row.title)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle = row.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func rowIcon(sourceId: String?) -> some View {
        if let sourceId {
            SourceIconView(sourceId: sourceId, store: store, size: 11)
        } else if case .person = row.destination {
            Image(systemName: "person.2")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "doc.text")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
        }
    }
}

/// The icon leading a header argument: a seed document's source icon, or the
/// person/loop glyph. Same imagery as the result rows.
@available(iOS 17.0, *)
private struct DirectHeaderArgIconView: View {
    @Environment(AppStore.self) private var store

    let icon: DirectHeaderArgIcon

    var body: some View {
        switch icon {
        case .document(let sourceId):
            if let sourceId {
                SourceIconView(sourceId: sourceId, store: store, size: 10)
            } else {
                Image(systemName: "doc.text")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .accessibilityHidden(true)
            }
        case .person:
            Image(systemName: "person.2")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
        case .loop:
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
        }
    }
}

@available(iOS 17.0, *)
private struct DirectPersonPush: Hashable {
    let id: String
    let name: String
}

// MARK: - SQL block

/// The settled SQL rowblock: column headers, then the first rows of the
/// grid, then a "+M more rows" line. Mirrors the portal's static rowblock.
@available(iOS 17.0, *)
struct DirectSqlBlockView: View {
    let block: DirectSqlBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !block.columns.isEmpty {
                DirectSqlGridRow(cells: block.columns, header: true)
            }
            ForEach(Array(block.rows.enumerated()), id: \.offset) { _, cells in
                DirectSqlGridRow(cells: cells, header: false)
            }
            let extra = block.totalRows - block.rows.count
            if extra > 0 {
                Text("+\(extra) more rows")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@available(iOS 17.0, *)
private struct DirectSqlGridRow: View {
    let cells: [String]
    var header: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(cell)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(header ? Theme.textSecondary : Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Direct tool cards — search, person, SQL") {
    ScrollView {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            DirectToolCardView(
                tool: "search_many",
                content: PreviewMocks.directSearchCard,
                timeText: "9:41 AM",
                rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_01"]
            )
            DirectToolCardView(
                tool: "lookup_people",
                content: PreviewMocks.directPeopleCard,
                timeText: "9:42 AM",
                rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_02"]
            )
            DirectToolCardView(
                tool: "run_sql",
                content: PreviewMocks.directSqlCard,
                timeText: "9:43 AM",
                rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_03"]
            )
        }
        .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

@available(iOS 17.0, *)
#Preview("Direct tool cards — error, empty, unknown tool") {
    ScrollView {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            DirectToolCardView(
                tool: "run_sql",
                content: PreviewMocks.directErrorCard,
                timeText: "9:44 AM",
                rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_03"]
            )
            DirectToolCardView(
                tool: "lookup_people",
                content: PreviewMocks.directEmptyCard,
                timeText: "9:45 AM"
            )
            DirectToolCardView(
                tool: "future_tool",
                content: PreviewMocks.directUnknownToolCard,
                timeText: "9:46 AM",
                rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_01"]
            )
        }
        .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

@available(iOS 17.0, *)
#Preview("Direct tool card — raw JSON sheet") {
    DirectRawJsonSheet(
        title: "Search — raw JSON",
        text: PreviewMocks.directAuditPayloads["direct_event_preview_01"].map(directAuditPayloadText)
            ?? "null"
    )
}

@available(iOS 17.0, *)
struct DirectRawSheetPresentedPreview: View {
    @State private var open = true

    var body: some View {
        Theme.bgPrimary
            .ignoresSafeArea()
            .sheet(isPresented: $open) {
                DirectRawJsonSheet(
                    title: "Search — raw JSON",
                    text: PreviewMocks.directAuditPayloads["direct_event_preview_01"].map(directAuditPayloadText)
                        ?? "null"
                )
            }
    }
}

@available(iOS 17.0, *)
#Preview("Direct tool card — presented raw sheet") {
    DirectRawSheetPresentedPreview()
}
#endif

#endif
