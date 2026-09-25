// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Any tool this client does not render — a future tool, or a result kind
/// the tool does not expect — keeps its header. The view owns the raw-JSON
/// affordance underneath.
func directGenericCard(tool: String, args: JSONValue?, decoded: DirectDecodedResult) -> DirectCardContent {
    if case .typed(.error(let code, let message)) = decoded {
        return DirectCardContent(
            label: directToolLabel(tool),
            arg: directGenericArg(tool: tool, args: args),
            argLink: nil,
            sections: nil,
            rows: [],
            sql: nil,
            note: nil,
            error: DirectCardError(code: code, message: message),
            showsEmpty: false
        )
    }
    return DirectCardContent(
        label: directToolLabel(tool),
        arg: directGenericArg(tool: tool, args: args),
        argLink: nil,
        sections: nil,
        rows: [],
        sql: nil,
        note: nil,
        error: nil,
        showsEmpty: false
    )
}

private func directToolLabel(_ tool: String) -> String {
    switch tool {
    case "search_many", "search_documents": "Search"
    case "fetch_many": "Open documents"
    case "fetch_document": "Open document"
    case "lookup_document_by_url": "Look up URL"
    case "lookup_people": "Look up people"
    case "trace_connections": "Trace connections"
    case "run_sql": "Run SQL"
    case "search_loops", "open_loop_search": "Search loops"
    case "list_loops": "List loops"
    case "fetch_loop", "open_loop_fetch": "Open loop"
    case "entity_context": "Entity context"
    case "temporal_query": "Temporal query"
    default: tool
    }
}

private func directGenericArg(tool: String, args: JSONValue?) -> String {
    switch tool {
    case "lookup_document_by_url": args?["url"]?.stringValue ?? ""
    case "lookup_people": args?["name"]?.stringValue ?? args?["query"]?.stringValue ?? ""
    case "run_sql":
        (args?["sql"]?.stringValue ?? "").split { $0.isWhitespace }.joined(separator: " ")
    case "trace_connections": directTraceSeedsArg(args)
    case "search_loops", "open_loop_search": args?["query"]?.stringValue ?? ""
    case "temporal_query": directTemporalRange(args)
    default: ""
    }
}

func directStructuredLabel(tool: String) -> String {
    switch tool {
    case "list_loops": "List loops"
    case "open_loop_search": "Search loops"
    case "open_loop_fetch": "Open loop"
    case "entity_context": "Entity context"
    case "temporal_query": "Temporal query"
    default: tool
    }
}

func directStructuredArg(tool: String, args: JSONValue?) -> String {
    switch tool {
    case "open_loop_search": args?["query"]?.stringValue ?? ""
    case "entity_context": directEntityContextArg(args)
    case "temporal_query": directTemporalRange(args)
    default: ""
    }
}

/// The walked seed ids, comma-joined, read on the card's header line —
/// mirroring the portal.
private func directTraceSeedsArg(_ args: JSONValue?) -> String {
    let seeds = args?["seedIds"]?.arrayValue ?? []
    return seeds.compactMap { $0.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: ", ")
}

/// The reaped entity's kind and id read on the card's header line, where
/// every other tool's argument reads — mirroring the portal.
private func directEntityContextArg(_ args: JSONValue?) -> String {
    let kind = args?["kind"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let id = args?["id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return [kind, id].filter { !$0.isEmpty }.joined(separator: " ")
}

/// The reaped entity as a header seed: `data.seed` carries kind, id and
/// label, so the header reads the source icon plus title — never a bare id.
/// A document seed resolves its source icon from the reaped documents.
/// Without a seed the call's own kind/id stand in, as before.
func directEntitySeedDisplay(args: JSONValue?, data: JSONValue) -> DirectSeedDisplay {
    let kind = args?["kind"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let id = args?["id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let fallback = [kind, id].filter { !$0.isEmpty }.joined(separator: " ")
    let seed = data["seed"]
    let seedKind = seed?["kind"]?.stringValue ?? kind
    let seedId = seed?["id"]?.stringValue ?? id
    guard let label = seed?["label"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
          !label.isEmpty
    else { return DirectSeedDisplay(icon: nil, text: fallback) }
    switch seedKind {
    case "document":
        let sourceId = data["documents"]?.arrayValue?.first {
            $0["documentId"]?.stringValue == seedId
        }?["sourceId"]?.stringValue
        return DirectSeedDisplay(icon: .document(sourceId: sourceId), text: label)
    case "loop":
        return DirectSeedDisplay(icon: .loop, text: label)
    case "person":
        return DirectSeedDisplay(icon: .person, text: label)
    default:
        return DirectSeedDisplay(icon: nil, text: label)
    }
}

/// Walk seeds as a header seed: each seed id resolves to its trail event's
/// document title with the first resolved seed's source icon; unresolved
/// seeds keep their ids.
func directTrailSeedsDisplay(args: JSONValue?, decoded: DirectDecodedResult) -> DirectSeedDisplay {
    var ids: [String] = []
    var events: [AgentTrailEvent] = []
    if case .typed(.eventTrailBuilt(let seeds, let evts, _, _)) = decoded {
        ids = seeds
        events = evts
    }
    if ids.isEmpty {
        ids = args?["seedIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
    if ids.isEmpty { return DirectSeedDisplay(icon: nil, text: "") }
    var icon: DirectHeaderArgIcon?
    let titles = ids.map { id -> String in
        guard let doc = events.lazy.compactMap(\.doc).first(where: { $0.documentId == id }) else {
            return id
        }
        if icon == nil { icon = .document(sourceId: doc.sourceId) }
        return doc.title.isEmpty ? id : doc.title
    }
    return DirectSeedDisplay(icon: icon, text: titles.joined(separator: ", "))
}

func directTemporalRange(_ args: JSONValue?) -> String {
    let from = args?["from"]?.stringValue
    let to = args?["to"]?.stringValue
    guard from != nil || to != nil else { return "" }
    return "\(from ?? "now") … \(to ?? from ?? "now")"
}
