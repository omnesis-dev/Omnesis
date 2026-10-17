// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How each agent tool call reads in a conversation transcript — the one table
 * the portal, iOS and Android renderers all follow.
 *
 * Each client draws its own cards natively, so each keeps its own copy of
 * this table in its own language. The copies cannot drift silently: the table
 * is written to `wire-fixtures/agent-tool-cards.json` and every client's test
 * suite checks its copy against those bytes. Changing how a tool reads means
 * editing this table, regenerating the fixtures, and updating all three
 * clients in the same change.
 *
 * Every tool the conversational agent can call has an entry; the gateway's
 * tests fail when a registered tool has none, so a new tool cannot ship
 * without someone deciding how it reads.
 */

/**
 * - `ephemeral`: a card that shows the call while it runs, rolls its result,
 *   then dismisses itself — the default for anything the agent does on its way
 *   to an answer.
 * - `persistent`: a card that stays in the transcript, for a change the user
 *   should be able to see after the answer (their tasks, their watches).
 * - `citation`: nothing inline once settled; the Timeline and citation panel
 *   own the result, and a pending call shows a "Citing…" pill.
 * - `subagent`: replaced by the researcher row when the worker starts.
 * - `silent`: never drawn — plumbing, or a lookup the answer itself reports.
 */
export type AgentToolPresentation = "ephemeral" | "persistent" | "citation" | "subagent" | "silent";

/** The card's leading glyph, by meaning; each client maps it to its own symbol. */
export type AgentToolIcon =
  | "search"
  | "document"
  | "wiki"
  | "sql"
  | "trail"
  | "people"
  | "link"
  | "loop"
  | "observation"
  | "date"
  | "schedule"
  | "memory"
  | "notes"
  | "task"
  | "watch";

export interface AgentToolCard {
  presentation: AgentToolPresentation;
  /** What the card's header says the agent is doing. Absent when nothing is drawn. */
  label?: string;
  icon?: AgentToolIcon;
  /**
   * The tool reads a body of text (a document, a wiki page): its card scrolls
   * the body's lines under the title before dismissing.
   */
  scrollsContent?: true;
}

const ephemeral = (label: string, icon: AgentToolIcon, scrollsContent?: true): AgentToolCard => ({
  presentation: "ephemeral",
  label,
  icon,
  ...(scrollsContent ? { scrollsContent } : {}),
});
const persistent = (label: string, icon: AgentToolIcon): AgentToolCard => ({
  presentation: "persistent",
  label,
  icon,
});

export const AGENT_TOOL_CARDS: Readonly<Record<string, AgentToolCard>> = Object.freeze({
  // Retrieval. The batch tools draw one card per child, as the singular tool.
  search_many: ephemeral("Search", "search"),
  search_documents: ephemeral("Search", "search"),
  fetch_many: ephemeral("Open document", "document", true),
  fetch_document: ephemeral("Open document", "document", true),
  knowledge_fetch: ephemeral("Read wiki page", "wiki", true),
  run_sql: ephemeral("Run SQL", "sql"),
  trace_connections: ephemeral("Trace connections", "trail"),
  entity_context: ephemeral("Gather context", "trail"),
  lookup_people: ephemeral("Find people", "people"),
  lookup_document_by_url: ephemeral("Look up URL", "link"),
  search_loops: ephemeral("Search loops", "loop"),
  fetch_loop: ephemeral("Open loop", "loop"),
  list_loops: ephemeral("List loops", "loop"),
  temporal_query: ephemeral("Check dates", "date"),

  // Citations and plumbing.
  annotate: { presentation: "citation" },
  annotate_many: { presentation: "citation" },
  cite_record: { presentation: "citation" },
  spawn_subagent: { presentation: "subagent" },
  join_subagents: { presentation: "silent" },
  plan: { presentation: "silent" },

  // Watches: reading one is a lookup; changing one is the user's to see.
  watches_list: { presentation: "silent" },
  watch_get: { presentation: "silent" },
  watch_probe: ephemeral("Test watch", "watch"),
  // The watch card names the change itself ("Created …", "Updated …").
  watch_create: { presentation: "persistent", icon: "watch" },
  watch_update: { presentation: "persistent", icon: "watch" },
  watch_delete: persistent("Delete watch", "watch"),

  // Tasks: a change to the user's journal stays visible; reading them does not.
  task_list: ephemeral("Check tasks", "task"),
  task_create: persistent("Add a task", "task"),
  task_update: persistent("Update a task", "task"),
  task_undo: persistent("Undo a task change", "task"),

  // Memory.
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

  // The Brain's own records.
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

  // The wiki.
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
});
