// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thin "ports" the tool layer depends on. Tools don't touch SearchPipeline or
 * DocumentRepository directly — they take a port and call its narrow surface.
 *
 * The gateway wires real implementations that wrap the underlying services
 * (`packages/gateway/src/agent/ports.ts` once phase 5 lands). Tests pass
 * in-memory mocks. Both honour the same contract.
 *
 * Why ports rather than direct service dependencies:
 *   - Tools are unit-testable without spinning up a SQLite DB.
 *   - The Anthropic + Replay + OpenAI-compatible backends never depend on
 *     anything heavier than `@omnesis/agent` and `@omnesis/core`.
 *   - When a port's underlying service evolves (search pipeline, link graph),
 *     the tool surface stays stable; only the gateway wiring adapter changes.
 */

import type {
  AgentTerminalFailure,
  AgentUsage,
  DocRef,
  EventTrail,
  LoopDetail,
  LoopSummary,
  PersonSummary,
  RecordReference,
  TemporalQueryInput,
  TemporalQueryResult,
} from "@omnesis/core";

import type { ToolCaller } from "../backend.js";

// ─── search_documents ─────────────────────────────────────────────────────

export interface SearchPortInput {
  query: string;
  filters?: SearchPortFilters;
  limit?: number;
  /**
   * The conversation this search is running inside, when there is one.
   *
   * Past conversations are indexed like any other document, so a turn can
   * retrieve the stored record of the conversation it is currently having and
   * read its own earlier answer back as if it were a source. The agent cannot
   * recognise that document as itself, so the implementation drops it — this
   * is enforcement, not advice, and no tool argument exposes it to the model.
   */
  currentConversationId?: string;
}

export interface SearchPortFilters {
  sourceIds?: string[];
  documentTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface SearchPortResult {
  query: string;
  durationMs: number;
  totalCandidates?: number;
  results: ReadonlyArray<DocRef>;
}

/**
 * Thrown by a {@link SearchPort} that refuses a query because a filter in it
 * cannot be honoured for the caller — a source-restricted grant, for
 * instance, cannot scope a person or tag filter to its sources. Carries the
 * tokens as the caller typed them so the tool wrapper can ship a structured
 * `kind: "error"` (code `unsupported_filter`) naming what to remove; the
 * message is composed by the port and carries no corpus data.
 */
export class UnsupportedSearchFilterError extends Error {
  readonly tokens: readonly string[];

  constructor(tokens: readonly string[], message: string) {
    super(message);
    this.name = "UnsupportedSearchFilterError";
    this.tokens = tokens;
  }
}

export interface SearchPort {
  /**
   * Throws {@link UnsupportedSearchFilterError} when the query carries a
   * filter the implementation refuses for this caller, so the refusal names
   * the filter instead of silently dropping it.
   */
  search(input: SearchPortInput, signal?: AbortSignal): Promise<SearchPortResult>;
}

// ─── fetch_document ───────────────────────────────────────────────────────

export interface DocumentPortResult {
  ref: DocRef;
  /** Opaque full document. Renderer reads what it understands. */
  document: unknown;
  /** Documents linked from or to this one. */
  neighbors?: ReadonlyArray<DocRef>;
  /**
   * True when `neighbors` is a capped, recency-ordered sample — the document
   * has more 1-hop neighbours than were returned. Signals the agent to run
   * `trace_connections` for the full neighbourhood rather than treating the sample
   * as exhaustive.
   */
  neighborsTruncated?: boolean;
}

export interface DocumentPort {
  fetch(
    documentId: string,
    opts?: { includeNeighbors?: boolean },
  ): Promise<DocumentPortResult | null>;
}

// ─── lookup_document_by_url ───────────────────────────────────────────────

export interface DocumentByUrlPortResult {
  url: string;
  durationMs: number;
  /** Absent when no document matched the (canonicalised) URL. */
  ref?: DocRef;
}

/**
 * Reverse-lookup a document by its source URL. The implementation runs
 * the same URL canonicalisation chain ingest uses, so the agent can
 * pass user-supplied URLs verbatim (tracking parameters, mobile-app
 * redirects, etc. — all normalised the same way as at ingest time).
 *
 * Returns at most one ref: when the same canonical URL legitimately
 * fans out to several docs (an email and its attachments share a
 * `source_url`), the impl picks the canonical parent.
 */
export interface DocumentByUrlPort {
  lookup(url: string, signal?: AbortSignal): Promise<DocumentByUrlPortResult>;
}

// ─── lookup_people ────────────────────────────────────────────────────────

export interface PersonPortInput {
  query: string;
  /** Cap candidates returned. Implementations clamp to [1, 20]; default 5. */
  limit?: number;
}

export interface PersonPortResult {
  query: string;
  durationMs: number;
  results: ReadonlyArray<PersonSummary>;
}

/**
 * Fuzzy person-lookup across canonical name + every alias type (email,
 * phone, handle, name). Returns 0..N candidates ordered by recency-decayed
 * interaction score — the agent picks which one to act on, typically
 * by inspecting `lastInteraction` + the alias list to disambiguate two
 * people who share a name.
 */
export interface PersonPort {
  lookup(input: PersonPortInput, signal?: AbortSignal): Promise<PersonPortResult>;
}

// ─── trace_connections ──────────────────────────────────────────────────────────

export interface TrailPortOptions {
  /** Max BFS depth. Clamped by the impl to [1, 10]; default 4. */
  depth?: number;
  /** Per-vertex per-category fanout cap. Clamped to [1, 100]; default 25. */
  fanoutCap?: number;
}

export interface TrailPort {
  /**
   * Build a chronologically-ordered event trail around one or more seed
   * documents. Each top-level event carries its people (by role), its
   * related cross-document links, and its attachments nested inside
   * `attachments[]`. The result is the same `EventTrail` shape the
   * portal renders on `/portal/graph`, validated at the wire boundary
   * by `eventTrailSchema` in `@omnesis/core`.
   *
   * Throws if any seed id is unresolved — the tool wrapper translates
   * that into a clean `kind: "error"` ToolResult so the agent can retry.
   */
  build(seedIds: ReadonlyArray<string>, opts?: TrailPortOptions): Promise<EventTrail>;
}

// ─── run_sql ──────────────────────────────────────────────────────────────

export interface SqlPortSource {
  sourceId: string;
  sourceType: string;
  displayName: string;
}

export interface SqlPortResult {
  sql: string;
  columns: string[];
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  rowCount: number;
  /**
   * Always `false`. A `run_sql` result is never a silent partial: when a
   * query would exceed the row cap the port throws {@link SqlPortOverCapError}
   * instead of returning a truncated set, so the agent narrows the
   * query rather than reasoning over a clipped table. Retained on the wire
   * shape for compatibility with the ephemeral SQL tool-call card.
   */
  truncated: boolean;
  durationMs: number;
  /**
   * Per-row record identity, positionally aligned with `rows` (same length).
   * Entry `i` is the {@link RecordReference} for `rows[i]` when the result
   * exposes a single known table's full primary key, or `null` when the row
   * has no addressable identity — an aggregate, a join that surfaces several
   * tables' keys, or a projection that drops a primary-key column.
   * Absent entirely when the query touches no known table. Identity is never
   * fabricated: a `RecordReference` means the row round-trips back to its
   * source row.
   */
  rowIdentities?: ReadonlyArray<RecordReference | null>;
  /**
   * Source attribution for the tables this query touched. Populated by
   * the port impl (which has analytics-catalog access) so the agent tool
   * stays source-agnostic.
   */
  sources?: ReadonlyArray<SqlPortSource>;
  /** Display names of the tables touched. */
  subjects?: ReadonlyArray<string>;
}

/**
 * Thrown by a {@link SqlPort} when the query result would exceed the row
 * cap. Carries the cap so the tool wrapper can ship a structured,
 * actionable `kind: "error"` (code `sql_over_cap`) telling the agent to add
 * a `LIMIT`, aggregate, or filter — never a silently-clipped result.
 */
export class SqlPortOverCapError extends Error {
  readonly maxRows: number;

  constructor(maxRows: number) {
    super(
      `query returned more than the ${maxRows}-row cap — narrow it with a tighter WHERE, ` +
        `an aggregate (GROUP BY / COUNT / AVG), or a smaller LIMIT, then re-run`,
    );
    this.name = "SqlPortOverCapError";
    this.maxRows = maxRows;
  }
}

/**
 * Thrown by a {@link SqlPort} when the statement reads tables outside the
 * caller's source grant (a source-restricted Direct grant's `run_sql`).
 * Carries the refused names as the caller typed them so the tool wrapper
 * can ship a structured, actionable `kind: "error"` (code
 * `sql_not_permitted`) telling the agent which tables to drop — the names
 * quote the caller's own SQL, never corpus text.
 */
export class SqlPortNotPermittedError extends Error {
  readonly tables: readonly string[];
  readonly tableFunctions: readonly string[];
  readonly shows: readonly string[];
  readonly macros: readonly string[];

  constructor(input: {
    tables: readonly string[];
    tableFunctions: readonly string[];
    shows: readonly string[];
    macros: readonly string[];
  }) {
    super("SQL query touches tables outside this grant");
    this.name = "SqlPortNotPermittedError";
    this.tables = [...input.tables];
    this.tableFunctions = [...input.tableFunctions];
    this.shows = [...input.shows];
    this.macros = [...input.macros];
  }
}

export interface SqlPort {
  /**
   * Runs `sql` against the analytics database read-only. Implementations MUST
   * reject any statement that is not a pure SELECT/WITH. When the result would
   * exceed `maxRows`, implementations MUST throw {@link SqlPortOverCapError}
   * rather than return a truncated set.
   */
  run(sql: string, opts?: { maxRows?: number; signal?: AbortSignal }): Promise<SqlPortResult>;
}

// ─── cite_record ────────────────────────────────────────────────────────────

/**
 * A fully resolved record citation — everything the `cite_record` tool
 * ships to clients and persists, derived gateway-side from the table's declared
 * contract. The tool layer holds no source-specific or analytics knowledge: it
 * passes the agent's `RecordReference` + the row snapshot to the port and
 * returns the port's resolved fields verbatim.
 */
export interface RecordCitationResolved {
  table: string;
  recordKey: string;
  primaryKeyColumns: { name: string; value: string; castType?: string }[];
  title: string;
  keyFields: { label: string; value: string | number | boolean | null }[];
  /** The declared semantic time on this row — never empty (the port rejects
   * a timeless row before resolving). */
  semanticTime: string;
  snapshot: Record<string, string | number | boolean | null>;
  sourceId: string;
  sourceType: string;
  tableDisplayName: string;
  /** Co-described document id when the row binds one, else `null`. */
  boundDocumentId: string | null;
}

/**
 * Why a record can't be cited. The tool maps each to a stable
 * `kind:'error'` ToolResult so the agent corrects its call rather than seeing a
 * stack trace.
 *   - `unknown_table` — the referenced table isn't in the analytics catalog.
 *   - `not_timeline_eligible` — the table is timeless (`semanticTimeColumn:
 *     null`) or this row's semantic-time value is empty, so it can't be a
 *     timeline record citation (a frozen rule).
 */
export type RecordCitationRejection =
  | { reason: "unknown_table"; table: string }
  | { reason: "not_timeline_eligible"; table: string };

export class RecordPortError extends Error {
  readonly rejection: RecordCitationRejection;

  constructor(rejection: RecordCitationRejection) {
    super(
      rejection.reason === "unknown_table"
        ? `no analytics table named '${rejection.table}' — cite a row from a run_sql result whose rowIdentities[i] is non-null`
        : `table '${rejection.table}' has no semantic time, so a row from it can't be cited as a timeline record`,
    );
    this.name = "RecordPortError";
    this.rejection = rejection;
  }
}

/**
 * Resolves a single analytics row into a fully-derived record citation.
 * The gateway impl (`createGatewayRecordPort`) reads the table's
 * `AnalyticsTableSchema` from the analytics catalog to derive the title, key
 * fields, semantic time, and redacted snapshot, and resolves the bound document
 * id. Throws {@link RecordPortError} for an unknown table or a timeless row.
 *
 * Optional on {@link ToolPorts}: rigs without an analytics DB omit it and the
 * registry skips registering `cite_record`.
 */
export interface RecordPort {
  resolve(input: {
    /**
     * The row identity as it arrived on the wire from `run_sql` — `castType`
     * is a free string here (the closed `ColumnType` enum lives in the source
     * SDK; the agent echoes back whatever `run_sql` sent). The gateway impl
     * re-derives the authoritative column types from the table schema, so a
     * loose `castType` here is harmless.
     */
    reference: {
      table: string;
      recordKey: string;
      primaryKeyColumns: { name: string; value: string; castType?: string }[];
    };
    /** The row's column values the agent cited — the immutable snapshot. */
    snapshot: Record<string, string | number | boolean | null>;
  }): Promise<RecordCitationResolved>;
}

// ─── Watch authoring ──────────────────────────────────────────────────────

/** The iOS notification a watch delivers when its condition becomes true. */
export interface WatchPortNotify {
  title?: string;
  body?: string;
}

/**
 * Outcome of a watch author call. `created` for a brand-new watch, `updated`
 * when an existing one was recompiled in place. `interpretation` is the
 * compiler's plain-language reading of the request — the agent relays it so
 * the user can correct a misreading in the same conversation.
 */
export interface WatchPortResult {
  action: "created" | "updated";
  watchId: string;
  name: string;
  enabled: boolean;
  interpretation: string;
  /** Advisory notes about delivery (e.g. push not configured on this gateway). */
  warnings: string[];
}

/** One watch, as a list shows it. */
export interface WatchPortEntry {
  watchId: string;
  /** The watch's own name, as every other surface shows it. */
  name: string;
  /** The request it was compiled from, when it was compiled from one. */
  request?: string;
  /** Whether the runtime is evaluating it. */
  enabled: boolean;
  /** Why it is not, when it is not — a moved ontology, or a hand pause. */
  note?: string;
  /**
   * Whether this surface may rewrite it. False for a watch installed with no
   * delivery: rewriting one here would add a notification nobody asked for.
   */
  manageable: boolean;
  firedCount: number;
  lastFiredAt?: string;
}

/** One watch in full, including what it has actually said. */
export interface WatchPortDetail extends WatchPortEntry {
  /** The condition as the compiler stated it for the judge to rule on. */
  interpretation?: string;
  createdAt: string;
  /** Most recent first. */
  firings: ReadonlyArray<{ firedAt: string; payload: unknown }>;
}

/**
 * Why a watch could not be authored. Each reason maps to a stable tool-error
 * code, so the model can tell "say it differently" apart from "this gateway
 * can't do it right now".
 */
export type WatchPortRejection =
  /** The request falls outside what the closed watch grammar can express. */
  | { reason: "uncompilable"; code: string; message: string }
  /** No background model is assigned, or the analytics catalog is unreadable. */
  | { reason: "compiler_unavailable"; message: string }
  /**
   * The compiler did not finish in the time it was given.
   *
   * Apart from a refusal because they mean opposite things to whoever asked:
   * a refusal is settled and rephrasing is the only way forward, where the
   * same request may well compile on the next attempt.
   */
  | { reason: "timed_out"; message: string }
  | { reason: "not_found"; watchId: string }
  /** The watch exists but this surface does not author its kind. */
  | { reason: "not_manageable"; watchId: string; message: string }
  /**
   * The watch was written and installed, and the record that wakes the caller
   * could not be created — so it is held rather than left evaluating into
   * nothing.
   *
   * Apart from the compiler's failures on purpose: nothing is wrong with the
   * condition, so rewriting it is the one thing that cannot help. Asking again
   * with the same request finishes the job rather than writing a second watch.
   */
  | { reason: "unarmed"; watchId: string; message: string }
  /**
   * The request collides with one already recorded, and no retry of it as
   * asked will settle differently.
   *
   * Apart from every other failure here because the fix is neither rephrasing
   * nor waiting: something about *which watch* the request names has to change.
   */
  | { reason: "conflict"; message: string };

export class WatchPortError extends Error {
  readonly rejection: WatchPortRejection;

  constructor(rejection: WatchPortRejection) {
    super(formatWatchRejection(rejection));
    this.rejection = rejection;
    this.name = "WatchPortError";
  }
}

function formatWatchRejection(r: WatchPortRejection): string {
  switch (r.reason) {
    case "uncompilable":
      return r.message;
    case "compiler_unavailable":
      return r.message;
    case "timed_out":
      return r.message;
    case "not_found":
      return `no watch with id ${r.watchId}`;
    case "not_manageable":
      return r.message;
    case "unarmed":
      return r.message;
    case "conflict":
      return r.message;
  }
}

/**
 * Standing conditions — reading them, and writing them.
 *
 * Every call routes the request through the compiler that turns natural
 * language into an executable watch, validated against the live ontology. The
 * only reaction this surface expresses is a push to the operator's own
 * devices, which is what makes it approval-free: the request came from the
 * user and the notification goes back to the user, so nothing crosses a
 * boundary anyone has to agree to. A watch is live the moment `create`
 * returns.
 *
 * The identity is the watch's own, and a rewrite keeps it — an id the agent
 * mentioned earlier in a conversation still resolves after an update.
 *
 * **Every method takes the caller, because reading and managing are different
 * questions with different answers.** A watch that wakes an off-host
 * integration must never be rewritten from anywhere but the surface that
 * approved it — repointing it would aim another integration's delivery at
 * something its owner never asked for. But refusing to *describe* it protects
 * nobody: it is the operator's own gateway, and their agent asked whether a
 * watch they commissioned is working. So the operator reads every watch and
 * manages only their own, while an integration sees only its own at all and
 * cannot learn that another's exists.
 *
 * Throws {@link WatchPortError} for every caller-visible failure.
 */
export interface WatchPort {
  create(
    caller: ToolCaller,
    input: { request: string; notify?: WatchPortNotify },
  ): Promise<WatchPortResult>;
  update(
    caller: ToolCaller,
    input: {
      watchId: string;
      request: string;
      notify?: WatchPortNotify;
    },
  ): Promise<WatchPortResult>;
  /** Stop watching, and forget what this watch has said. */
  remove(caller: ToolCaller, watchId: string): Promise<void>;
  list(caller: ToolCaller): Promise<ReadonlyArray<WatchPortEntry>>;
  get(caller: ToolCaller, watchId: string): Promise<WatchPortDetail | null>;
  /**
   * Try a watch against the recent past and report what it would have decided.
   *
   * The thing that lets this surface check its own work. A watch that catches
   * nothing and a watch that is right about a quiet week produce the same
   * silence, and until it has been tried there is nothing to tell them apart —
   * so "your watch is set up" is a claim this could not previously support.
   *
   * Nothing is stored and no model is asked, so it costs a query and no
   * tokens. That is why it follows the reading rule rather than the managing
   * one: a caller who may be told a watch exists may also be told what it does.
   */
  probe(caller: ToolCaller, watchId: string): Promise<WatchPortProbe>;
}

/** What trying a watch against the recent past came to. */
export interface WatchPortProbe {
  /** How many journal events it was replayed over — the denominator. */
  events: number;
  /** The window's ends, so a zero can be read against the span it is zero of. */
  from: string | null;
  to: string | null;
  nodes: ReadonlyArray<{
    nodeId: string;
    /** Events this node was offered. */
    evaluated: number;
    /** Events it took up. */
    matched: number;
    /** Times a model would have been asked — a probe never asks one. */
    wouldAsk: number;
    /** What a reader has to know in order not to misread the numbers. */
    diagnostics: ReadonlyArray<string>;
    /** A bounded quotation of what it decided, in the runtime's own words. */
    samples: ReadonlyArray<{ seq: number; transition: string; detail?: string }>;
  }>;
  /**
   * Sink firings over the window — zero whenever a judged node sits on the
   * path, because a probe's judge never says yes.
   */
  firings: number;
  judgeGated: boolean;
}

// ─── spawn_subagent ──────────────────────────────────────────────────────────

export interface SubagentPortInput {
  /** The parent session id — the conversation the user is watching. */
  parentSessionId: string;
  /**
   * INTERNAL orchestration profile. Ordinary model-facing spawns omit this and
   * run the host-defined generic worker; owned workflows such as Deep Research
   * may select a registered specialist privately.
   */
  specialist?: string;
  /** Short, parent-authored label for human-facing progress. */
  title: string;
  /** Natural-language brief — becomes the child session's first user message. */
  task: string;
  /** The parent tool-call id that requested this spawn (for event wiring). */
  parentToolCallId?: string;
  /** Forwarded so the child run honours parent-turn cancellation. */
  signal?: AbortSignal;
  /**
   * Caller's IANA zone, carried down from the spawning turn's tool context so a
   * delegated sweep over "this week" reads the same calendar the user is
   * looking at. Passing it along the spawn rather than looking it up by parent
   * id is what keeps it correct for a grandchild, whose parent is itself a
   * sub-agent and so has no entry among the user's live sessions.
   */
  timeZone?: string;
  /**
   * Mark an INTERNAL pipeline stage (the Deep Research planner and synthesis
   * sub-agents) so the host suppresses its client-facing
   * `agent.subagent.spawned` / `.event` / `.result` events. The child still
   * runs and its result + usage are returned normally — it just doesn't
   * surface as a researcher card/panel (the planner's raw JSON and the
   * synthesis prompt are internals, not "researchers"; the report reaches the
   * bubble on its own). Reader sub-agents leave this unset.
   */
  internal?: boolean;
  /**
   * Token-spend mechanism label for the child's usage, read by hosts that
   * do cost accounting. Orchestration pipelines that own their spawns stamp
   * it (Deep Research labels every stage "deep-research"); plain
   * `spawn_subagent` spawns leave it unset and the host applies its default
   * label.
   */
  spendMechanism?: string;
}

/**
 * The launch handle `spawn_subagent` returns IMMEDIATELY. Fan-out is
 * asynchronous: the child runs in the background (or waits in the concurrency
 * queue), and the parent collects its finding later via `join_subagents`. So
 * the handle carries only identity + a transient status — no summary/citations
 * yet.
 */
export interface SubagentSpawnHandle {
  subagentId: string;
  specialist: string;
  status: "queued" | "running";
}

/** A single child's distilled finding, returned by `join_subagents`. */
export interface SubagentPortResult {
  subagentId: string;
  specialist: string;
  status: "complete" | "failed" | "budget_exhausted";
  /** Distilled finding the child returned. */
  summary: string;
  /** Documents the child cited — merged into the parent's single set. */
  citations: ReadonlyArray<DocRef>;
  /** This child's own token spend, summed across its turns. */
  usage?: AgentUsage;
  /** Authoritative model failure when `status` is `failed`. */
  failure?: AgentTerminalFailure;
}

export interface SubagentJoinInput {
  /** The parent session awaiting its children. */
  parentSessionId: string;
  /**
   * Sub-agent ids to await. Each must be a child the parent launched (a
   * `SubagentSpawnHandle.subagentId`). A mixed set is fine — already-finished
   * children resolve immediately; in-flight ones are awaited.
   */
  subagentIds: ReadonlyArray<string>;
  /** Forwarded so the join honours parent-turn cancellation. */
  signal?: AbortSignal;
}

export interface SubagentJoinResult {
  results: ReadonlyArray<SubagentPortResult>;
  /** Whole-tree token aggregate at the moment the join resolved. */
  treeUsage?: AgentUsage;
  /**
   * Set when the tree-wide token budget tripped during this fan-out — the
   * honest, named reason some children stopped or never started. Absent on a
   * clean join.
   */
  stoppedReason?: string;
}

/**
 * Thrown by a {@link SubagentPort} when a spawn can't proceed for a
 * caller-correctable reason (e.g. the depth cap is reached). The
 * `spawn_subagent` tool maps it to a stable `kind: "error"` ToolResult so the
 * parent model adapts rather than seeing a stack trace.
 */
export class SubagentPortError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubagentPortError";
    this.code = code;
  }
}

/**
 * Orchestrates nested {@link AgentSession}s for the parent agent.
 *
 * Fan-out is asynchronous: `spawn` LAUNCHES a child (running it in the
 * background, bounded by the configured concurrency cap) and returns a handle
 * immediately, so the parent can launch several children that run concurrently;
 * `join` is the barrier that awaits a set of those children and collects their
 * distilled findings + the per-tree token aggregate. Each child's full event
 * stream reaches clients via the `agent.subagent.*` events. Depth (up to the
 * configured cap) and the tree-wide token budget are enforced here.
 */
export interface SubagentPort {
  /** Launch a child; returns a handle immediately (non-blocking). */
  spawn(input: SubagentPortInput): Promise<SubagentSpawnHandle>;
  /** Await a set of launched children and collect their findings. */
  join(input: SubagentJoinInput): Promise<SubagentJoinResult>;
}

// ─── loop read (experimental) ─────────────────────────────────────────────

export interface LoopSearchPortInput {
  query: string;
  /** Cap loops returned. Implementations clamp to a small ceiling; default ~10. */
  limit?: number;
}

export interface LoopSearchPortResult {
  query: string;
  durationMs: number;
  loops: ReadonlyArray<LoopSummary>;
}
export interface LoopListPortResult {
  durationMs: number;
  loops: ReadonlyArray<LoopSummary>;
  /** True when more active loops exist than the returned cap. */
  truncated: boolean;
}

/**
 * READ-ONLY access to the background Cognition Steward's tracked obligations, for the
 * interactive (chat) agent in experimental mode. No mutation surface by design:
 * the chat agent can FIND and READ loops — never create/update/delete them
 * (that stays the background Cognition Steward's job) and never touch briefs. The
 * implementation lives in the briefs subsystem; the registry gates the two
 * tools (`search_loops`, `fetch_loop`) on this port being wired AND experimental
 * mode. Absent ⇒ neither tool is registered.
 */
export interface LoopReadPort {
  search(input: LoopSearchPortInput, signal?: AbortSignal): Promise<LoopSearchPortResult>;
  /** Full read-only detail of one loop, or null when the id matches nothing. */
  fetch(loopId: string, signal?: AbortSignal): Promise<LoopDetail | null>;
  /**
   * Every active (open / snoozed) loop, most-important first, capped.
   * The exhaustive enumeration primitive — use it to answer "what am I
   * tracking / all my open loops" instead of guessing `search` terms (lexical
   * search can silently miss loops).
   */
  list(limit: number | undefined, signal?: AbortSignal): Promise<LoopListPortResult>;
}

/**
 * Read-only temporal view. Parsing, timezone arithmetic, federation, coverage,
 * and keyset pagination belong behind this port in the gateway.
 */
export interface TemporalReadPort {
  query(input: TemporalQueryInput, signal?: AbortSignal): Promise<TemporalQueryResult>;
}

/** Kinds of entity the reap tool can be seeded on. */
export type EntityContextSeedKind = "document" | "person" | "loop";

export interface EntityContextSeed {
  kind: EntityContextSeedKind;
  id: string;
}

/**
 * The cognitive neighbourhood around one seed entity — pointer-only (ids +
 * labels + light attributes), grouped by kind, per-kind capped. `notes` on a
 * person are the agent-authored claims about them. The agent follows the ids
 * with its existing fetch tools for detail; no bodies are inlined here.
 */
export interface EntityContextResult {
  seed: { kind: string; id: string; label: string } | null;
  loops: Array<{ loopId: string; title: string; state: string; importance?: number }>;
  documents: Array<{ documentId: string; title?: string; sourceId?: string }>;
  people: Array<{ personId: string; name: string; notes?: string[] }>;
  temporalAnnotations: Array<{
    annotationId: string;
    sentence: string;
    when?: string;
    kind?: string;
  }>;
  truncated: boolean;
  counts: { loops: number; documents: number; people: number; temporalAnnotations: number };
}

/**
 * Read-only reap of the cognitive graph: from one seed entity, the connected
 * loops / documents / people / temporal annotations the background agent has linked. A
 * missing / non-cognitive seed returns an empty result with `seed:null` (never
 * throws). Shared by the interactive and background agents.
 */
export interface EntityContextPort {
  reap(
    seed: EntityContextSeed,
    opts?: { depth?: number },
    signal?: AbortSignal,
  ): Promise<EntityContextResult>;
}

// ─── Bundled ports ────────────────────────────────────────────────────────

export interface ToolPorts {
  search: SearchPort;
  document: DocumentPort;
  /**
   * Reverse document lookup by source URL. Optional so test rigs that
   * don't speak to a live gateway can omit it; the matching tool is
   * skipped at registry build time when the port isn't wired.
   */
  documentByUrl?: DocumentByUrlPort;
  person?: PersonPort;
  trail?: TrailPort;
  sql?: SqlPort;
  /**
   * Optional record-citation port. When omitted, the registry does not
   * register the `cite_record` tool — used by rigs without an analytics DB.
   */
  record?: RecordPort;
  /**
   * Optional watch-authoring port (experimental). When omitted — or when the
   * gateway is not in experimental mode — the registry does not register
   * `watch_create` / `watch_update`. This is the agent's ONLY write path into
   * automations; it compiles natural language rather than accepting a spec.
   */
  watch?: WatchPort;
  /**
   * Optional sub-agent port. When omitted, the registry does not
   * register the `spawn_subagent` tool — child sessions can't spawn further
   * children once the depth cap is reached (the port is withheld), and rigs
   * without a SubagentService omit it entirely.
   */
  subagent?: SubagentPort;
  /**
   * Optional READ-ONLY loop port (experimental). When omitted — or when the
   * gateway is not in experimental mode — the registry does not register
   * `search_loops` / `fetch_loop`. Lets the interactive agent leverage the
   * background Cognition Steward's tracked obligations without any mutation surface.
   */
  loopRead?: LoopReadPort;
  /**
   * Optional READ-ONLY temporal port (experimental). When omitted — or when
   * the gateway is not in experimental mode — the registry does not register
   * `temporal_query`. Lets BOTH agents query deterministic projections and
   * LLM-owned annotations; only annotation mutation lives on the Cognition Steward.
   */
  temporal?: TemporalReadPort;
  /**
   * Optional READ-ONLY cognitive-context (reap) port (experimental). When
   * omitted — or when the gateway is not in experimental mode — the registry
   * does not register `entity_context`. Lets BOTH agents reap the neighbourhood
   * of loops / docs / people / time-entries the background agent linked around
   * one entity in a single call, instead of stitching it from many reads.
   */
  entityContext?: EntityContextPort;
}
