// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Static content model for one Direct transcript call: the portal's
// `StaticToolCard` (`parts.js`), minus the DOM. A Direct payload's `result`
// is the same wire `ToolResult` the agent path decodes as `AgentToolResult`,
// so the typed kinds render the same rows the portal shows — search/fetch
// rows with titles, SQL rowblocks, trail/people/loop rows — and every row
// that names a document, person or loop carries its link target.
//
// Deliberately free of SwiftUI so the mapping is unit testable in the
// sim-less logic lane. Views map `DirectCardDestination` onto pushes; nothing
// here knows what a push is.

// MARK: - Content model

/// Where a card row leads. In-app targets push the document/person viewer;
/// loops have no native screen, so a loop row carries its id for a future
/// destination and renders plain until one exists. External URLs are
/// validated by the view — only http(s) becomes a link.
enum DirectCardDestination: Equatable, Sendable {
    case document(id: String, sourceId: String?, title: String?)
    case person(canonicalId: String, name: String?)
    case loop(id: String)
    case external(url: String)
}

struct DirectCardRow: Equatable, Sendable {
    let title: String
    let subtitle: String?
    let destination: DirectCardDestination?
}

struct DirectCardError: Equatable, Sendable {
    let code: String
    let message: String
}

struct DirectSqlBlock: Equatable, Sendable {
    let columns: [String]
    let rows: [[String]]
    let totalRows: Int
}

/// One child card of a batch call (`search_many` / `fetch_many`): the portal
/// projects one static singular card per settled item, index-aligned to the
/// call's args, so a failed child never discards its siblings.
struct DirectCardSection: Equatable, Sendable {
    let heading: String?
    let rows: [DirectCardRow]
    let sql: DirectSqlBlock?
    let error: DirectCardError?
    let showsEmpty: Bool
}

/// The icon leading a header argument: a seed document's source icon, or the
/// person/loop glyph for those seed kinds. Mirrors the row icons.
enum DirectHeaderArgIcon: Equatable, Sendable {
    case document(sourceId: String?)
    case person
    case loop
}

/// A header seed: resolved title plus icon, or the raw id when the result
/// names nothing for it.
struct DirectSeedDisplay: Equatable, Sendable {
    let icon: DirectHeaderArgIcon?
    let text: String
}

struct DirectCardContent: Equatable, Sendable {
    let label: String
    let arg: String
    /// Icon leading the header argument, when the argument names entities
    /// the result resolves (walk seeds, the reaped entity).
    let argIcon: DirectHeaderArgIcon?
    /// When the header arg itself is a link (the looked-up URL).
    let argLink: DirectCardDestination?
    let sections: [DirectCardSection]?
    let rows: [DirectCardRow]
    let sql: DirectSqlBlock?
    let note: String?
    let error: DirectCardError?
    /// A matched-but-empty result reads "No result" instead of rendering
    /// nothing. A result whose kind this tool does not render leaves the
    /// header standing alone — the call still happened.
    let showsEmpty: Bool

    init(
        label: String,
        arg: String,
        argIcon: DirectHeaderArgIcon? = nil,
        argLink: DirectCardDestination? = nil,
        sections: [DirectCardSection]? = nil,
        rows: [DirectCardRow] = [],
        sql: DirectSqlBlock? = nil,
        note: String? = nil,
        error: DirectCardError? = nil,
        showsEmpty: Bool = false
    ) {
        self.label = label
        self.arg = arg
        self.argIcon = argIcon
        self.argLink = argLink
        self.sections = sections
        self.rows = rows
        self.sql = sql
        self.note = note
        self.error = error
        self.showsEmpty = showsEmpty
    }
}

// MARK: - Caps

/// Mirrors the portal's `EPHEMERAL_SEARCH_RESULTS_MAX`: a card is a glance,
/// not an exhaustive replay.
let directCardMaxRows = 12
/// Mirrors the portal's `EPHEMERAL_SQL_ROWS_MAX`.
let directCardMaxSqlRows = 10

// MARK: - Record decoding

/// A fetched payload record: `{tool,args,result,outcome}` or a truncation
/// sentinel. The view checks the sentinel first; only real records reach the
/// card mapping below.
enum DirectDecodedResult: Equatable, Sendable {
    case typed(AgentToolResult)
    /// `{kind:"structured", resultType, data}` — the steward loop/memory
    /// tools, which have no bespoke iOS result type. Parsed from raw JSON.
    case structured(resultType: String, data: JSONValue)
    case missing
    case undecodable
}

func directDecodeResult(_ value: JSONValue?) -> DirectDecodedResult {
    guard let value, case .object(let fields) = value else { return .missing }
    guard let result = fields["result"], result != .null else { return .missing }
    if case .object(let resultFields) = result,
       case .string(let kind) = resultFields["kind"],
       kind == "structured" {
        let resultType: String = if case .string(let raw) = resultFields["resultType"] { raw } else { "" }
        return .structured(resultType: resultType, data: resultFields["data"] ?? .null)
    }
    guard let data = try? JSONEncoder().encode(result),
          let typed = try? JSONDecoder().decode(AgentToolResult.self, from: data)
    else { return .undecodable }
    return .typed(typed)
}

// MARK: - Card mapping

/// The static card for one transcript record. Unknown tools and unknown
/// result kinds render a generic header card — never a dropped row — and a
/// result whose kind this tool does not render leaves the header standing
/// alone, mirroring the portal.
func directCardContent(tool: String, record: JSONValue?) -> DirectCardContent {
    let fields: [String: JSONValue] = if case .object(let object) = record { object } else { [:] }
    let args = fields["args"]
    let decoded = directDecodeResult(record)
    switch tool {
    case "search_many":
        return directSearchBatchCard(args: args, decoded: decoded)
    case "fetch_many":
        return directFetchBatchCard(args: args, decoded: decoded)
    case "search_documents":
        return directSingularSearchCard(args: args, decoded: decoded)
    case "fetch_document":
        return directSingularFetchCard(decoded: decoded)
    case "lookup_document_by_url":
        return directUrlLookupCard(args: args, decoded: decoded)
    case "lookup_people":
        return directPeopleCard(args: args, decoded: decoded)
    case "trace_connections":
        return directTrailCard(args: args, decoded: decoded)
    case "run_sql":
        return directSqlCard(args: args, decoded: decoded)
    case "search_loops":
        return directLoopsSearchedCard(args: args, decoded: decoded)
    case "fetch_loop":
        return directLoopFetchedCard(decoded: decoded)
    case "list_loops", "open_loop_search", "open_loop_fetch", "entity_context", "temporal_query":
        return directStructuredCard(tool: tool, args: args, decoded: decoded)
    default:
        return directGenericCard(tool: tool, args: args, decoded: decoded)
    }
}

// MARK: - Per-child split

/// One rendered card: the singular tool name the portal's batch splitter
/// projects plus its content.
struct DirectTranscriptCard: Equatable, Sendable {
    let tool: String
    let content: DirectCardContent
}

/// One card per transcript record — except `search_many` / `fetch_many`,
/// which the portal's `deriveBatchChildren` projects into one singular card
/// per settled item ("Search <query>", "Open document"), index-aligned to
/// the call's args. A batch that never decoded to items keeps its single
/// generic header card, exactly as `directCardContent` renders it.
func directTranscriptCards(tool: String, record: JSONValue?) -> [DirectTranscriptCard] {
    let fields: [String: JSONValue] = if case .object(let object) = record { object } else { [:] }
    let args = fields["args"]
    let decoded = directDecodeResult(record)
    switch (tool, decoded) {
    case ("search_many", .typed(.searchBatch(let items))):
        let queries = directArgQueries(args)
        return items.enumerated().map { index, item in
            let query = index < queries.count ? queries[index] : ""
            let childArgs: JSONValue = .object(["query": .string(query)])
            return DirectTranscriptCard(
                tool: "search_documents",
                content: directSingularSearchCard(args: childArgs, decoded: .typed(item))
            )
        }
    case ("fetch_many", .typed(.documentBatch(let items))):
        let ids = directArgDocumentIds(args)
        return items.enumerated().map { index, item in
            let fallback = index < ids.count ? ids[index] : nil
            return DirectTranscriptCard(
                tool: "fetch_document",
                content: directSingularFetchCard(decoded: .typed(item), fallbackTitle: fallback)
            )
        }
    default:
        return [DirectTranscriptCard(tool: tool, content: directCardContent(tool: tool, record: record))]
    }
}

// MARK: - Batch tools

private func directSearchBatchCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    guard case .typed(.searchBatch(let items)) = decoded else {
        return directGenericCard(tool: "search_many", args: args, decoded: decoded)
    }
    let queries = directArgQueries(args)
    let sections = items.enumerated().map { index, item -> DirectCardSection in
        let heading = index < queries.count ? queries[index] : nil
        switch item {
        case .searchResults(_, _, _, let refs):
            let rows = refs.prefix(directCardMaxRows).map { directDocumentRow($0) }
            return DirectCardSection(
                heading: heading,
                rows: rows,
                sql: nil,
                error: nil,
                showsEmpty: rows.isEmpty
            )
        case .error(let code, let message):
            return DirectCardSection(
                heading: heading,
                rows: [],
                sql: nil,
                error: DirectCardError(code: code, message: message),
                showsEmpty: false
            )
        default:
            return DirectCardSection(
                heading: heading,
                rows: [],
                sql: nil,
                error: nil,
                showsEmpty: false
            )
        }
    }
    return DirectCardContent(
        label: "Search",
        arg: "",
        argLink: nil,
        sections: sections,
        rows: [],
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: false
    )
}

private func directFetchBatchCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    guard case .typed(.documentBatch(let items)) = decoded else {
        return directGenericCard(tool: "fetch_many", args: args, decoded: decoded)
    }
    let ids = directArgDocumentIds(args)
    let sections = items.enumerated().map { index, item -> DirectCardSection in
        let heading = index < ids.count ? ids[index] : nil
        switch item {
        case .document(let ref, _, _):
            return DirectCardSection(
                heading: nil,
                rows: [directDocumentRow(ref, fallbackTitle: heading)],
                sql: nil,
                error: nil,
                showsEmpty: false
            )
        case .error(let code, let message):
            return DirectCardSection(
                heading: heading,
                rows: [],
                sql: nil,
                error: DirectCardError(code: code, message: message),
                showsEmpty: false
            )
        default:
            return DirectCardSection(
                heading: heading,
                rows: [],
                sql: nil,
                error: nil,
                showsEmpty: false
            )
        }
    }
    return DirectCardContent(
        label: "Open documents",
        arg: "",
        argLink: nil,
        sections: sections,
        rows: [],
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: false
    )
}

// MARK: - Singular tools

/// The Answer agent's own retrieval verbs (`search_documents`,
/// `fetch_document`): the same rows as their Direct batch twins, read from
/// the singular args/result shapes the portal's `StaticToolCard` reads. Only
/// the stored Answer transcripts use these arms — no Direct payload does.
private func directSingularSearchCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let query = args?["query"]?.stringValue ?? ""
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Search",
            arg: query,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.searchResults(_, _, _, let refs)) = decoded else {
        return directGenericCard(tool: "search_documents", args: args, decoded: decoded)
    }
    let rows = refs.prefix(directCardMaxRows).map { directDocumentRow($0) }
    return DirectCardContent(
        label: "Search",
        arg: query,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directSingularFetchCard(decoded: DirectDecodedResult, fallbackTitle: String? = nil) -> DirectCardContent {
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Open document",
            arg: "",
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.document(let ref, _, _)) = decoded else {
        return directGenericCard(tool: "fetch_document", args: nil, decoded: decoded)
    }
    return DirectCardContent(
        label: "Open document",
        arg: "",
        argLink: nil,
        sections: nil,
        rows: [directDocumentRow(ref, fallbackTitle: fallbackTitle)],
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: false
    )
}

/// External targets open out-of-app per portal convention — and only http(s)
/// becomes a link. Anything else stays plain text, never a lively href.
func directExternalDestination(_ raw: String) -> DirectCardDestination? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          url.host != nil
    else { return nil }
    return .external(url: trimmed)
}

private func directUrlLookupCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let url = args?["url"]?.stringValue ?? ""
    let argLink = directExternalDestination(url)
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Look up URL",
            arg: url,
            argLink: argLink,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.documentByUrl(_, _, let ref)) = decoded else {
        return directGenericCard(tool: "lookup_document_by_url", args: args, decoded: decoded)
    }
    // A nil ref is a successful "no match", not an error — the portal reads
    // "No result" here rather than rendering nothing.
    return DirectCardContent(
        label: "Look up URL",
        arg: url,
        argLink: argLink,
        sections: nil,
        rows: ref.map { [directDocumentRow($0)] } ?? [],
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: ref == nil
    )
}

private func directPeopleCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let query = args?["name"]?.stringValue ?? args?["query"]?.stringValue ?? ""
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Look up people",
            arg: query,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.personResults(_, _, let people)) = decoded else {
        return directGenericCard(tool: "lookup_people", args: args, decoded: decoded)
    }
    let rows = people.prefix(directCardMaxRows).map { person in
        DirectCardRow(
            title: person.displayName,
            subtitle: person.aliases.first,
            destination: .person(canonicalId: person.canonicalId, name: person.displayName)
        )
    }
    return DirectCardContent(
        label: "Look up people",
        arg: query,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directTrailCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let seeds = directTrailSeedsDisplay(args: args, decoded: decoded)
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Trace connections",
            arg: seeds.text,
            argIcon: seeds.icon,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.eventTrailBuilt(_, let events, _, _)) = decoded else {
        return directGenericCard(tool: "trace_connections", args: args, decoded: decoded)
    }
    // Chronological like the portal's `flattenTrailDocs`: each event's doc,
    // then its attachments' docs, deduplicated by document id.
    var seen = Set<String>()
    var rows: [DirectCardRow] = []
    func push(_ doc: AgentTrailEventDoc?) {
        guard let doc, !doc.documentId.isEmpty, !seen.contains(doc.documentId) else { return }
        seen.insert(doc.documentId)
        let title = doc.title.isEmpty ? "Untitled" : doc.title
        rows.append(DirectCardRow(
            title: title,
            subtitle: nil,
            destination: .document(
                id: doc.documentId,
                sourceId: doc.sourceId.isEmpty ? nil : doc.sourceId,
                title: title
            )
        ))
    }
    for event in events {
        push(event.doc)
        for attachment in event.attachments {
            push(attachment.doc)
        }
    }
    return DirectCardContent(
        label: "Trace connections",
        arg: seeds.text,
        argIcon: seeds.icon,
        argLink: nil,
        sections: nil,
        rows: Array(rows.prefix(directCardMaxRows)),
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directSqlCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let sql = (args?["sql"]?.stringValue ?? "")
        .split { $0.isWhitespace }
        .joined(separator: " ")
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Run SQL",
            arg: sql,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.sqlRows(_, let columns, let rows, let rowCount, _, _, _, _)) = decoded else {
        return directGenericCard(tool: "run_sql", args: args, decoded: decoded)
    }
    let normalised = rows.map { directNormaliseSqlRow($0, columns: columns.count) }
    return DirectCardContent(
        label: "Run SQL",
        arg: sql,
        argLink: nil,
        sections: nil,
        rows: [],
        sql: DirectSqlBlock(
            columns: columns,
            rows: Array(normalised.prefix(directCardMaxSqlRows)),
            totalRows: rowCount > 0 ? rowCount : rows.count
        ),
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directLoopsSearchedCard(args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let query = args?["query"]?.stringValue ?? ""
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Search loops",
            arg: query,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.loopsSearched(_, _, let loops)) = decoded else {
        return directGenericCard(tool: "search_loops", args: args, decoded: decoded)
    }
    let rows = loops.prefix(directCardMaxRows).map { directLoopRow(loopId: $0.loopId, state: $0.state, title: $0.title) }
    return DirectCardContent(
        label: "Search loops",
        arg: query,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directLoopFetchedCard(decoded: DirectDecodedResult) -> DirectCardContent {
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: "Open loop",
            arg: "",
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .typed(.loopFetched(let loop)) = decoded else {
        return directGenericCard(tool: "fetch_loop", args: nil, decoded: decoded)
    }
    // A nil loop is a clean no-match, not an error.
    let rows: [DirectCardRow] = if let loop {
        [directLoopRow(loopId: loop.loopId, state: loop.state, title: loop.title)]
    } else {
        []
    }
    return DirectCardContent(
        label: "Open loop",
        arg: "",
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

// MARK: - Structured steward tools

private func directStructuredCard(tool: String, args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    let label = directStructuredLabel(tool: tool)
    let arg = directStructuredArg(tool: tool, args: args)
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: label,
            arg: arg,
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    guard case .structured(let resultType, let data) = decoded else {
        return directGenericCard(tool: tool, args: args, decoded: decoded)
    }
    switch (tool, resultType) {
    case ("list_loops", "loops.listed"):
        return directListedLoopsCard(label: label, arg: arg, data: data)
    case ("open_loop_search", "open_loop.search_results"):
        return directSearchedLoopsCard(label: label, arg: arg, data: data)
    case ("open_loop_fetch", "open_loop.fetched"):
        return directFetchedLoopCard(label: label, arg: arg, data: data)
    case ("entity_context", "entity_context.reaped"):
        return directEntityContextCard(label: label, args: args, data: data)
    case ("temporal_query", "temporal.results"):
        return directTemporalResultsCard(label: label, arg: arg, data: data)
    default:
        return directGenericCard(tool: tool, args: args, decoded: decoded)
    }
}

private func directListedLoopsCard(label: String, arg: String, data: JSONValue) -> DirectCardContent {
    let rows = directLoopList(data["loops"]).prefix(directCardMaxRows).map {
        directLoopRow(loopId: $0.id, state: $0.state, title: $0.title)
    }
    return DirectCardContent(
        label: label,
        arg: arg,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directSearchedLoopsCard(label: String, arg: String, data: JSONValue) -> DirectCardContent {
    let rows = directLoopList(data["loops"]).prefix(directCardMaxRows).map {
        directLoopRow(loopId: $0.id, state: $0.state, title: $0.title)
    }
    let retired = directRetiredCount(data["retired"])
    return DirectCardContent(
        label: label,
        arg: arg,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: retired > 0 ? "\(retired) retired" : nil,
        error: nil,
        showsEmpty: rows.isEmpty && retired == 0
    )
}

private func directFetchedLoopCard(label: String, arg: String, data: JSONValue) -> DirectCardContent {
    let rows: [DirectCardRow] = if let loop = directSingleLoop(data) {
        [directLoopRow(loopId: loop.id, state: loop.state, title: loop.title)]
    } else {
        []
    }
    return DirectCardContent(
        label: label,
        arg: arg,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directEntityContextCard(label: String, args: JSONValue?, data: JSONValue) -> DirectCardContent {
    let seed = directEntitySeedDisplay(args: args, data: data)
    let rows = directNeighborhoodRows(data)
    return DirectCardContent(
        label: label,
        arg: seed.text,
        argIcon: seed.icon,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}

private func directTemporalResultsCard(label: String, arg: String, data: JSONValue) -> DirectCardContent {
    let items = data["items"]?.arrayValue ?? []
    let rows = items.prefix(directCardMaxRows).map { entry in
        DirectCardRow(
            title: entry["label"]?.stringValue ?? "Untitled moment",
            subtitle: nil,
            destination: nil
        )
    }
    return DirectCardContent(
        label: label,
        arg: arg,
        argLink: nil,
        sections: nil,
        rows: rows,
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: rows.isEmpty
    )
}
