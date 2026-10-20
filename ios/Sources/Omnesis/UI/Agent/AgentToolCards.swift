// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How a tool call reads in a transcript: whether its card dismisses itself,
/// stays, is a "Citing…" pill, is replaced by the researcher row, or is never
/// drawn.
enum AgentToolPresentation: String, Equatable {
    case ephemeral, persistent, citation, subagent, silent
}

/// One tool's card: presentation, header label, glyph (by meaning) and
/// whether it scrolls a body of text under its title.
struct AgentToolCard: Equatable {
    let presentation: AgentToolPresentation
    var label: String?
    var icon: String?
    var scrollsContent = false
}

/// The iOS copy of the table every client follows. `AgentToolCardsTests`
/// checks it against `wire-fixtures/agent-tool-cards.json`, which the gateway
/// generates from `@omnesis/core`'s `AGENT_TOOL_CARDS`.
enum AgentToolCards {
    private static func ephemeral(_ label: String, _ icon: String, scrolls: Bool = false) -> AgentToolCard {
        AgentToolCard(presentation: .ephemeral, label: label, icon: icon, scrollsContent: scrolls)
    }

    private static func persistent(_ label: String?, _ icon: String) -> AgentToolCard {
        AgentToolCard(presentation: .persistent, label: label, icon: icon)
    }

    static let table: [String: AgentToolCard] = [
        "search_many": ephemeral("Search", "search"),
        "search_documents": ephemeral("Search", "search"),
        "fetch_many": ephemeral("Open document", "document", scrolls: true),
        "fetch_document": ephemeral("Open document", "document", scrolls: true),
        "knowledge_fetch": ephemeral("Read wiki page", "wiki", scrolls: true),
        "run_sql": ephemeral("Run SQL", "sql"),
        "trace_connections": ephemeral("Trace connections", "trail"),
        "entity_context": ephemeral("Gather context", "trail"),
        "lookup_people": ephemeral("Find people", "people"),
        "lookup_document_by_url": ephemeral("Look up URL", "link"),
        "search_loops": ephemeral("Search loops", "loop"),
        "fetch_loop": ephemeral("Open loop", "loop"),
        "list_loops": ephemeral("List loops", "loop"),
        "temporal_query": ephemeral("Check dates", "date"),
        "annotate": AgentToolCard(presentation: .citation),
        "annotate_many": AgentToolCard(presentation: .citation),
        "cite_record": AgentToolCard(presentation: .citation),
        "spawn_subagent": AgentToolCard(presentation: .subagent),
        "join_subagents": AgentToolCard(presentation: .silent),
        "plan": AgentToolCard(presentation: .silent),
        "watches_list": AgentToolCard(presentation: .silent),
        "watch_get": AgentToolCard(presentation: .silent),
        "watch_probe": ephemeral("Test watch", "watch"),
        "watch_create": persistent(nil, "watch"),
        "watch_update": persistent(nil, "watch"),
        "watch_delete": persistent("Delete watch", "watch"),
        "task_list": ephemeral("Check tasks", "task"),
        "task_create": persistent("Add a task", "task"),
        "task_update": persistent("Update a task", "task"),
        "task_undo": persistent("Undo a task change", "task"),
        "conversation_memory_evidence": ephemeral("Prepare memory", "memory"),
        "annotation_search": ephemeral("Search memory", "memory"),
        "annotate_durable": ephemeral("Remember document", "memory"),
        "annotation_revise": ephemeral("Update document memory", "memory"),
        "annotation_retract": ephemeral("Forget document memory", "memory"),
        "annotation_supersede": ephemeral("Replace document memory", "memory"),
        "annotate_person": ephemeral("Remember person", "memory"),
        "person_annotation_revise": ephemeral("Update person memory", "memory"),
        "person_annotation_retract": ephemeral("Forget person memory", "memory"),
        "person_annotation_supersede": ephemeral("Replace person memory", "memory"),
        "open_loop_search": ephemeral("Search loops", "loop"),
        "open_loop_fetch": ephemeral("Open loop", "loop"),
        "open_loop_create": ephemeral("Create loop", "loop"),
        "open_loop_update": ephemeral("Update loop", "loop"),
        "open_loop_delete": ephemeral("Delete loop", "loop"),
        "open_loop_ledger_append": ephemeral("Note on loop", "loop"),
        "observation_list": ephemeral("List brief items", "observation"),
        "observation_note": ephemeral("Note brief item", "observation"),
        "observation_withdraw": ephemeral("Withdraw brief item", "observation"),
        "observation_suppress": ephemeral("Mute brief item", "observation"),
        "temporal_annotation_add": ephemeral("Add date note", "date"),
        "temporal_annotation_update": ephemeral("Update date note", "date"),
        "temporal_annotation_delete": ephemeral("Remove date note", "date"),
        "notes_append": ephemeral("Append notes", "notes"),
        "notes_edit": ephemeral("Edit notes", "notes"),
        "notes_rewrite": ephemeral("Rewrite notes", "notes"),
        "schedule_agent_run": ephemeral("Schedule follow-up", "schedule"),
        "knowledge_list": ephemeral("List wiki pages", "wiki"),
        "knowledge_links": ephemeral("Read wiki links", "wiki"),
        "knowledge_link": ephemeral("Link wiki pages", "wiki"),
        "knowledge_history": ephemeral("Read wiki history", "wiki"),
        "knowledge_reference": ephemeral("Check references", "wiki"),
        "knowledge_evidence": ephemeral("Record evidence", "wiki"),
        "knowledge_candidates": ephemeral("Review page ideas", "wiki"),
        "knowledge_candidate_decide": ephemeral("Decide on a page idea", "wiki"),
        "knowledge_propose_page": ephemeral("Propose wiki page", "wiki"),
        "knowledge_save": ephemeral("Save wiki page", "wiki"),
        "knowledge_edit": ephemeral("Edit wiki page", "wiki"),
        "knowledge_retire": ephemeral("Retire wiki page", "wiki"),
    ]

    /// Names older conversations still carry for a renamed tool; they read as
    /// the tool they became.
    static let renamed: [String: String] = [
        "time_index_query": "temporal_query",
        "time_index_add": "temporal_annotation_add",
        "time_index_update": "temporal_annotation_update",
        "time_index_delete": "temporal_annotation_delete",
    ]

    /// SF Symbol for each icon the table names.
    static let symbols: [String: String] = [
        "search": "magnifyingglass",
        "document": "doc.text",
        "wiki": "book.pages",
        "sql": "tablecells",
        "trail": "point.3.connected.trianglepath.dotted",
        "people": "person.2",
        "link": "link",
        "loop": "arrow.triangle.2.circlepath",
        "observation": "sunrise",
        "date": "calendar",
        "schedule": "clock.arrow.circlepath",
        "memory": "brain.head.profile",
        "notes": "note.text",
        "task": "checklist",
        "watch": "bolt.fill",
    ]

    static func card(for tool: String) -> AgentToolCard? {
        table[renamed[tool] ?? tool]
    }

    /// The card header's words; an unknown tool reads as its own name.
    static func label(for tool: String) -> String {
        card(for: tool)?.label ?? tool
    }

    /// The card's glyph; a wrench for a tool this build does not know.
    static func symbol(for tool: String) -> String {
        card(for: tool)?.icon.flatMap { symbols[$0] } ?? "wrench.and.screwdriver"
    }

    /// Tools whose live card dismisses itself, renamed names included.
    static let ephemeralTools: Set<String> = Set(
        (Array(table.keys) + Array(renamed.keys)).filter { card(for: $0)?.presentation == .ephemeral }
    )

    /// Tools never drawn in a transcript.
    static let silentTools: Set<String> = Set(table.filter { $0.value.presentation == .silent }.keys)
}

/// The document a read returned: a `document` result, or the first document
/// of a `document.batch` (a wiki read returns the batch shape `fetch_many`
/// does).
func agentDocumentRead(_ result: AgentToolResult?) -> (ref: AgentDocRef, content: String?)? {
    switch result {
    case .document(let ref, let content, _):
        return (ref, content)
    case .documentBatch(let items):
        for item in items {
            if case .document(let ref, let content, _) = item { return (ref, content) }
        }
        return nil
    default:
        return nil
    }
}
