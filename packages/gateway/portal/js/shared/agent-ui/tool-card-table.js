// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How each agent tool call reads in a transcript: whether its card dismisses
 * itself, stays, or is never drawn, what its header says, its glyph, and
 * whether it scrolls a body of text. The portal's copy of the table every
 * client follows; `tool-cards.test.ts` checks it against
 * `wire-fixtures/agent-tool-cards.json`, which the gateway generates. Plain
 * data, so the reducer can read it without the renderer.
 */

const ephemeral = (label, icon, scrollsContent) => ({
  presentation: "ephemeral",
  label,
  icon,
  ...(scrollsContent ? { scrollsContent: true } : {}),
});
const persistent = (label, icon) => ({ presentation: "persistent", label, icon });

export const AGENT_TOOL_CARDS = Object.freeze({
  search_many: ephemeral("Search", "search"),
  search_documents: ephemeral("Search", "search"),
  fetch_many: ephemeral("Open document", "document", true),
  fetch_document: ephemeral("Open document", "document", true),
  knowledge_fetch: ephemeral("Read wiki page", "wiki", true),
  run_sql: ephemeral("Run SQL", "sql"),
  trace_connections: ephemeral("Trace connections", "trail"),
  entity_context: ephemeral("Gather context", "trail"),
  lookup_people: ephemeral("Find people", "people"),
  count_messages: ephemeral("Count messages", "people"),
  lookup_document_by_url: ephemeral("Look up URL", "link"),
  search_loops: ephemeral("Search loops", "loop"),
  fetch_loop: ephemeral("Open loop", "loop"),
  list_loops: ephemeral("List loops", "loop"),
  temporal_query: ephemeral("Check dates", "date"),
  annotate: { presentation: "citation" },
  annotate_many: { presentation: "citation" },
  cite_record: { presentation: "citation" },
  spawn_subagent: { presentation: "subagent" },
  join_subagents: { presentation: "silent" },
  plan: { presentation: "silent" },
  watches_list: { presentation: "silent" },
  watch_get: { presentation: "silent" },
  watch_probe: ephemeral("Test watch", "watch"),
  watch_create: { presentation: "persistent", icon: "watch" },
  watch_update: { presentation: "persistent", icon: "watch" },
  watch_delete: persistent("Delete watch", "watch"),
  task_list: ephemeral("Check tasks", "task"),
  task_create: ephemeral("Add a task", "task"),
  task_update: ephemeral("Update a task", "task"),
  task_undo: ephemeral("Undo a task change", "task"),
  conversation_memory_evidence: ephemeral("Prepare memory", "memory"),
  annotation_search: ephemeral("Search memory", "memory"),
  annotate_durable: ephemeral("Remember document", "memory"),
  annotation_revise: ephemeral("Update document memory", "memory"),
  annotation_retract: ephemeral("Forget document memory", "memory"),
  annotation_supersede: ephemeral("Replace document memory", "memory"),
  annotate_person: ephemeral("Remember person", "memory"),
  person_annotation_revise: ephemeral("Update person memory", "memory"),
  person_annotation_retract: ephemeral("Forget person memory", "memory"),
  person_annotation_supersede: ephemeral("Replace person memory", "memory"),
  open_loop_search: ephemeral("Search loops", "loop"),
  open_loop_fetch: ephemeral("Open loop", "loop"),
  open_loop_create: ephemeral("Create loop", "loop"),
  open_loop_update: ephemeral("Update loop", "loop"),
  open_loop_delete: ephemeral("Delete loop", "loop"),
  open_loop_ledger_append: ephemeral("Note on loop", "loop"),
  observation_list: ephemeral("List brief items", "observation"),
  observation_note: ephemeral("Note brief item", "observation"),
  observation_withdraw: ephemeral("Withdraw brief item", "observation"),
  observation_suppress: ephemeral("Mute brief item", "observation"),
  temporal_annotation_add: ephemeral("Add date note", "date"),
  temporal_annotation_update: ephemeral("Update date note", "date"),
  temporal_annotation_delete: ephemeral("Remove date note", "date"),
  notes_append: ephemeral("Append notes", "notes"),
  notes_edit: ephemeral("Edit notes", "notes"),
  notes_rewrite: ephemeral("Rewrite notes", "notes"),
  schedule_agent_run: ephemeral("Schedule follow-up", "schedule"),
  knowledge_list: ephemeral("List wiki pages", "wiki"),
  knowledge_links: ephemeral("Read wiki links", "wiki"),
  knowledge_link: ephemeral("Link wiki pages", "wiki"),
  knowledge_history: ephemeral("Read wiki history", "wiki"),
  knowledge_reference: ephemeral("Check references", "wiki"),
  knowledge_evidence: ephemeral("Record evidence", "wiki"),
  knowledge_candidates: ephemeral("Review page ideas", "wiki"),
  knowledge_candidate_decide: ephemeral("Decide on a page idea", "wiki"),
  knowledge_propose_page: ephemeral("Propose wiki page", "wiki"),
  knowledge_save: ephemeral("Save wiki page", "wiki"),
  knowledge_edit: ephemeral("Edit wiki page", "wiki"),
  knowledge_retire: ephemeral("Retire wiki page", "wiki"),
});

/**
 * Names older conversations still carry for a tool that was renamed; they
 * read as the tool they became.
 */
export const RENAMED_TOOLS = Object.freeze({
  time_index_query: "temporal_query",
  time_index_add: "temporal_annotation_add",
  time_index_update: "temporal_annotation_update",
  time_index_delete: "temporal_annotation_delete",
});

/** The card a tool call reads as, or undefined for a tool this build does not know. */
export function toolCard(tool) {
  return AGENT_TOOL_CARDS[RENAMED_TOOLS[tool] ?? tool];
}

/** The card header's words; an unknown tool reads as its own name. */
export function toolCardLabel(tool) {
  return toolCard(tool)?.label ?? tool;
}

/** Tools whose live card dismisses itself, renamed names included. */
export const EPHEMERAL_CARD_TOOLS = new Set(
  [...Object.keys(AGENT_TOOL_CARDS), ...Object.keys(RENAMED_TOOLS)].filter(
    (tool) => toolCard(tool)?.presentation === "ephemeral",
  ),
);

/** Tools never drawn in a transcript. */
export const SILENT_CARD_TOOLS = new Set(
  Object.keys(AGENT_TOOL_CARDS).filter((tool) => AGENT_TOOL_CARDS[tool].presentation === "silent"),
);
