// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent-harness protocol. Commands and events for the demo agent that lives
 * inside the gateway, talks to the corpus via tools, and streams its output
 * to the portal (and, later, iOS).
 *
 * Two design choices worth knowing:
 *
 *   - **Backend-agnostic.** The wire shape doesn't mention Anthropic. The
 *     same protocol must serve an Anthropic Messages backend, a local
 *     OpenAI-compatible backend (vLLM/llama.cpp/Ollama for Qwen 3 etc.),
 *     and a deterministic Replay backend used for tests and demos.
 *
 *   - **Renderer-rich.** The agent emits *typed parts* (text deltas, tool
 *     calls, citations, working-set diffs, provenance trails) so the UI
 *     can paint source-shaped cards, working-set sidebars, and breadcrumb
 *     trails without parsing markdown. The model picks what to retrieve;
 *     the renderer picks how to draw the retrieval.
 *
 * The schemas land in the unified WS registry via `ws-messages.ts`. Producers
 * and consumers reach for `parseRequestPayload` / `parseEventPayload` from
 * that module — those carry full type inference plus zod validation at the
 * wire boundary. Definitions live here to keep `ws-messages.ts` small.
 */

import { z } from "zod";

/**
 * Catalog of error codes the agent can emit. Use these constants instead
 * of free-form strings so the portal / iOS can render targeted CTAs (e.g.
 * "configure Anthropic key").
 */
export const KNOWN_AGENT_ERROR_CODES = [
  "session_not_found",
  "forbidden",
  "agent_disabled",
  "remote_inference_disabled",
  "context_window_exceeded",
  "output_truncated",
  "anthropic_api_error",
  "anthropic_stream_error",
  "tool_threw",
  "unknown_tool",
  "tool_iteration_cap",
  "send_failed",
  "fixture_exhausted",
  "rate_limited",
  "session_cap_exceeded",
  "listener_cap_exceeded",
  "internal_error",
] as const;
export type KnownAgentErrorCode = (typeof KNOWN_AGENT_ERROR_CODES)[number];

// ─── Lightweight document ref ──────────────────────────────────────────────

/**
 * One 1-hop neighbour of a search hit — a single edge in the document graph,
 * pushed onto the top search hits so the agent sees adjacent context (an
 * email's attachment, a thread reply, a near-duplicate across channels)
 * *without* having to decide to walk the graph. Deliberately tiny: a title,
 * the edge label, the neighbour's id (so the agent can `fetch_document` or
 * cite it), and a deep link. No body — the re-bill multiplier punishes fat
 * inlined context, so a breadcrumb is a pointer, never a payload. Attached on
 * agent searches only (never the public /search route); absent when the hit
 * has no neighbours.
 */
export const breadcrumbSchema = z.object({
  /** The neighbour document's id — feed straight into `fetch_document` or `annotate`. */
  documentId: z.string().min(1),
  /** Neighbour title, for the agent to recognise what the edge points at. */
  title: z.string().optional(),
  /**
   * The graph edge type connecting this neighbour to the hit —
   * `attachment`, `email-thread`, `near-duplicate`, `url`, … (the
   * `GraphEdgeType` vocabulary). Tells the agent *how* the two relate.
   */
  edge: z.string().min(1),
  /** Native-app deep link for the neighbour, when the source published one. */
  appUrl: z.string().optional(),
});
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

/**
 * A compact reference to an open loop the Cognition Steward tracks that this document
 * is a source for — the "what is this document part of" connection, attached
 * inline to search / fetch results when the gateway is in experimental mode.
 * A pointer, not the loop's full state (that lives behind `fetch_loop`); absent
 * for documents no tracked loop references.
 */
export const docLoopRefSchema = z.object({
  /** The open loop's id — feed straight into `fetch_loop`. */
  loopId: z.string().min(1),
  /** The loop's title, so the reader recognises the obligation. */
  title: z.string(),
  /** Lifecycle state: `open` | `snoozed` (terminal loops are never attached). */
  state: z.string(),
  /** Importance the Cognition Steward assigned (0-1), for ordering. */
  importance: z.number().optional(),
});
export type DocLoopRef = z.infer<typeof docLoopRefSchema>;

/**
 * A compact, hint-shaped view of a durable annotation the Cognition Steward recorded
 * ABOUT a document — a prior to reground against, never a hard fact. Attached
 * inline to fetch results in experimental mode; the verbatim evidence quote is
 * deliberately omitted from the wire shape (it lives in the source document).
 */
export const docAnnotationHintSchema = z.object({
  /** Open-vocabulary claim kind (`topic`, `entity`, `commitment-status`, …). */
  claimType: z.string(),
  /** The derived observation. */
  claim: z.string(),
  /** Recorded confidence (0-1), always below certainty. */
  confidence: z.number(),
  /**
   * The document the claim is grounded in — the "reground before asserting"
   * pointer. Optional for wire compatibility with hints recorded before the
   * field existed.
   */
  evidenceDocId: z.string().optional(),
});
export type DocAnnotationHint = z.infer<typeof docAnnotationHintSchema>;

/**
 * A compact, hint-shaped view of a temporal annotation the Cognition Steward filed
 * that cites a document — the "what dated fact is this a source for" backlink.
 * A pointer into the LLM-owned temporal-annotation store; the verbatim interval
 * bounds are omitted from the wire shape. Attached inline to agent search /
 * fetch results in experimental mode.
 */
export const docTemporalAnnotationRefSchema = z.object({
  /** The annotation id — feed into `temporal_annotation_update`. */
  annotationId: z.string().min(1),
  /** One-line meaning of the time (the annotation's sentence). */
  sentence: z.string(),
  /** Display form of the time — canonical date / ISO instant / range text. */
  when: z.string().optional(),
  /** Optional classification (`deadline`, `event`, `expiry`, …). */
  kind: z.string().optional(),
});
export type DocTemporalAnnotationRef = z.infer<typeof docTemporalAnnotationRefSchema>;

/**
 * A loop summary row in a `search_loops` result — richer than the inline
 * `DocLoopRef` chip (which only pins a document's connection): enough for the
 * reader to judge the obligation without opening it.
 */
export const loopSummarySchema = z.object({
  loopId: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  state: z.string(),
  importance: z.number().optional(),
  confidence: z.number().optional(),
  /** Human/ISO deadline string the port derived from the loop, when it has one. */
  deadline: z.string().optional(),
});
export type LoopSummary = z.infer<typeof loopSummarySchema>;

/**
 * The full read-only view of one open loop from `fetch_loop`: its summary plus
 * the people it concerns, its source documents, and its recent ledger — enough
 * to answer "what is in this loop" with no mutation surface.
 */
export const loopDetailSchema = loopSummarySchema.extend({
  /** People who need to act (canonical display names). */
  actors: z.array(z.string()).optional(),
  /** People with a stake (canonical display names). */
  involved: z.array(z.string()).optional(),
  /** Source document ids the loop rests on. */
  docIds: z.array(z.string()).optional(),
  /** Recent ledger entries, oldest → newest. */
  ledger: z.array(z.object({ at: z.number(), note: z.string() })).optional(),
  /**
   * Other active loops the agent grouped onto a shared brief with this one — a
   * curated "related work" cluster (the loop→loop backlink). Attached inline so
   * a fetch surfaces sibling obligations without a second lookup; absent/empty
   * when the loop shares no brief.
   */
  relatedLoops: z.array(docLoopRefSchema).optional(),
});
export type LoopDetail = z.infer<typeof loopDetailSchema>;

/**
 * Compact reference carried in stream events. The full Document body lives
 * behind `fetch_document`; for the citation list, working set, and search
 * result cards we only need the fields a renderer paints.
 *
 * Deliberately not the same shape as `@omnesis/core` `Document` — that's a
 * storage schema that can evolve; this is a wire shape that we'd rather
 * keep stable.
 */
export const docRefSchema = z.object({
  documentId: z.string().min(1),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  documentType: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  /**
   * Source-side creation time in epoch **milliseconds**.
   * iOS Swift `Codable`: `Date(timeIntervalSince1970: ts / 1000)`.
   */
  ts: z.number().optional(),
  /** Deep link from `metadata.sourceUrl` (e.g. `https://mail.google.com/…`). */
  url: z.string().optional(),
  /** Native-app deep link preferred on mobile clients (e.g. `googlecalendar://…`). */
  appUrl: z.string().optional(),
  /**
   * MIME type as recorded by the source at ingest time (read from
   * `metadata.extra.mimeType`). Primary input to file-type iconography
   * on renderers (portal / iOS) — mirrors `trailEventDocSchema.mimeType`
   * so a doc synthesised from a DocRef shows the same icon as the same
   * doc reached via an event trail. Absent for sources that don't
   * publish one.
   */
  mimeType: z.string().optional(),
  /** Canonical display names for people on the document. */
  people: z.array(z.string()).optional(),
  /**
   * Provider-declared unit noun ("emails", "events", "files", …) read
   * from `SourceDescriptor.unitName`. Baked into every DocRef the
   * gateway emits so renderers (portal / iOS) can pluralise search-
   * result group counts ("3 emails", "1 event") without doing their
   * own descriptor-cache lookup. Source-encapsulation rule: this
   * stays a generic field, populated for every source whose provider
   * package declared a unitName.
   */
  unitName: z.string().optional(),
  /**
   * Inbound-reference count: how many other documents point at this one in
   * the link graph. A **connectedness** prior, NOT a relevance score — a
   * 40-message thread head and a 40-citation contract both read high, and a
   * stray bookmark reads 0 or absent. The agent uses it to decide *which*
   * hit is worth expanding (a high-`refCount` hit with a thin snippet is the
   * one to `trace_connections` or `fetch_document(includeNeighbors)`), never to
   * rank relevance or to narrate "importance" to the user. Computed for free
   * on every search by the ref-count stage; surfaced on agent searches (not on
   * the public /search route). Absent ⇒ treat as 0.
   */
  refCount: z.number().int().nonnegative().optional(),
  /**
   * Up to a few 1-hop graph neighbours, auto-attached to the top search hits
   * so the most valuable adjacent document arrives whether or not the agent
   * chooses to walk the graph. Ordered most-structural-first (attachments,
   * thread replies, near-duplicates before bare URL references). Populated
   * only on the highest-ranked hits of an agent search.
   */
  breadcrumb: z.array(breadcrumbSchema).optional(),
  /**
   * Open loops this document is a source for — the "what is this part of"
   * connection the Cognition Steward tracks, attached inline in experimental mode
   * (loops exist only then). Surfaced on both agent searches and fetch
   * results; absent/empty when no tracked loop references the document.
   */
  openLoops: z.array(docLoopRefSchema).optional(),
  /**
   * Durable annotations the Cognition Steward recorded ABOUT this document — grounded
   * priors to reground against, never facts. Attached inline on fetch results
   * in experimental mode; absent/empty when none exist.
   */
  annotations: z.array(docAnnotationHintSchema).optional(),
  /**
   * Temporal annotations the Cognition Steward filed that cite this document —
   * deadlines/events/expiries grounded in it. Attached inline in experimental
   * mode on BOTH agent search and fetch results; absent/empty when none.
   */
  temporalAnnotations: z.array(docTemporalAnnotationRefSchema).optional(),
});
export type DocRef = z.infer<typeof docRefSchema>;

// ─── Person summary (lookup_people result) ────────────────────────────────

/**
 * One candidate from a `lookup_people` call. The lookup is fuzzy across
 * canonical name + every alias type (email, phone, lid, name) so a
 * single query can return several plausible matches — the agent picks
 * which one to act on (typically using `lastInteraction` /
 * interaction counts to break ties).
 *
 * `aliases` is the deduped union of every alias the person row owns,
 * including any merged-into-losers — this is the column the agent
 * needs to construct a follow-up `from:` / `to:` search filter once it
 * has chosen a candidate.
 */
export const personSummarySchema = z.object({
  canonicalId: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  emailCount: z.number().optional(),
  meetingCount: z.number().optional(),
  chatCount: z.number().optional(),
  lastInteraction: z.number().optional(),
  avatarHash: z.string().optional(),
  /**
   * `[0, 1]` recency-decayed interaction score. Lets the agent rank
   * candidates by "how much does the user actually deal with this
   * person *lately*" — better than raw doc counts for "what did Maria
   * say last week" / "the Maria I actually talk to" disambiguation.
   */
  interactionScore: z.number().optional(),
  /**
   * Durable annotations the Cognition Steward recorded ABOUT this person — grounded
   * priors to reground against, never facts. Attached inline on lookup_people
   * results in experimental mode; absent/empty when none exist.
   */
  annotations: z.array(docAnnotationHintSchema).optional(),
  /**
   * Temporal annotations this person is linked to — deadlines/events/reminders
   * that concern them (the person→time backlink). Attached inline on
   * lookup_people in experimental mode; absent/empty when none exist.
   */
  temporalAnnotations: z.array(docTemporalAnnotationRefSchema).optional(),
  /**
   * Active open loops this person is an actor in or involved with — the
   * tracked obligations that concern them (the person→loop backlink, via the
   * sparse curated `open_loop_people` join). Attached inline on lookup_people
   * in experimental mode; absent/empty when none exist.
   */
  openLoops: z.array(docLoopRefSchema).optional(),
});
export type PersonSummary = z.infer<typeof personSummarySchema>;

// ─── Event trail (event_trail.built result) ─────────────────────────────────────

/**
 * One document on a trail event — either the primary doc the event is
 * about, or one of its nested attachments. Source-agnostic: the source
 * accent + icon are derived from `sourceId` via `defineSource()`; the
 * `documentType` enum (file/email/event/message/attachment/note/task/…)
 * tells generic renderers how to label the doc.
 */
export const trailEventDocSchema = z.object({
  documentId: z.string().min(1),
  title: z.string(),
  sourceId: z.string().min(1),
  sourceUrl: z.string().optional(),
  appUrl: z.string().optional(),
  documentType: z.string().optional(),
  mimeType: z.string().optional(),
});
export type TrailEventDoc = z.infer<typeof trailEventDocSchema>;

/**
 * One person incident on a trail event, grouped by role-bucket. `role`
 * stays a free string at the protocol level — the closed set lives in
 * `@omnesis/types/document.PersonRole`; new roles added there light up
 * here without a schema change.
 */
export const trailEventPersonSchema = z.object({
  personId: z.string().min(1),
  name: z.string(),
  role: z.string().min(1),
  isSelf: z.boolean(),
});
export type TrailEventPerson = z.infer<typeof trailEventPersonSchema>;

/**
 * A reference to another document the trail surfaced. `linkType` carries
 * the underlying `document_links.link_type` (or `"near-duplicate"`),
 * `direction` records edge orientation relative to the host event.
 * Open enum on `linkType` for the same reason as `role`.
 */
export const trailEventRelatedSchema = z.object({
  documentId: z.string().min(1),
  title: z.string(),
  sourceId: z.string().min(1),
  linkType: z.string().min(1),
  direction: z.enum(["in", "out", "peer"]),
});
export type TrailEventRelated = z.infer<typeof trailEventRelatedSchema>;

/** One derived key field on a trail record — a label + (possibly redacted) value. */
export const trailRecordKeyFieldSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type TrailRecordKeyField = z.infer<typeof trailRecordKeyFieldSchema>;

/**
 * A DuckDB analytics row surfaced on the trail as a point-in-time record.
 *Reached via a `same-entity` edge from a seed document (or attached as
 * its own entity when the row binds no document). The gateway derives every
 * field from the table's declared record-display contract — clients render
 * these strings directly and never learn the column names or branch on the
 * source. Mirrors the cite-record payload so a record reads the same whether it
 * arrives through `cite_record` or `trace_connections`.
 *
 * `recordKey` (= `analyticsRowKey(table, pk)`) is the stable identity used to
 * dedup a row against its co-described document: a document plus its
 * `same-entity` row collapse to ONE timeline entity (the document event carries
 * the `record`), so the same row never appears twice.
 */
export const trailRecordSchema = z.object({
  /** `analyticsRowKey(table, joinedPk)` — stable id; the doc/row dedup key. */
  recordKey: z.string().min(1),
  table: z.string().min(1),
  tableDisplayName: z.string(),
  /** Derived row title (never empty — falls back to the table display name). */
  title: z.string(),
  keyFields: z.array(trailRecordKeyFieldSchema),
  /**
   * ISO-8601 value of the declared `semanticTimeColumn` on this row. Always
   * present here — a timeless row (null/empty semantic time) is never surfaced
   * as a trail record (frozen rule).
   */
  semanticTime: z.string().min(1),
  sourceId: z.string().min(1),
  /** For the client to look up the source icon/colour in the registry. */
  sourceType: z.string().min(1),
  /** Co-described document id when the row binds one, else `null`. */
  boundDocumentId: z.string().nullable(),
  /** Immutable redacted row snapshot exactly as the walk projected it. */
  snapshot: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type TrailRecord = z.infer<typeof trailRecordSchema>;

/**
 * One event on the trail. Attachments nest inside `attachments[]` (an
 * email + its PDF attachments = one event whose `attachments` array
 * carries the PDFs). Empty arrays — not omitted — for events with no
 * attachments / people / related links so consumers don't have to
 * branch on `undefined`.
 *
 * `eventId` is stable within the tool_result so renderers can project
 * annotations onto the matching row. Equal to `doc.documentId` for a
 * document event, and to the `record.recordKey` for a record-only event
 * (a bound row with no co-described document) — recomputable from any
 * reference, but the field is kept distinct so the format can evolve.
 *
 * An event carries a `doc`, a `record`, or BOTH:
 *   - `doc` only — an ordinary document event.
 *   - `doc` + `record` — a document and its `same-entity` analytics row
 *     collapsed into ONE timeline entity (dedup on `record.recordKey`);
 *     `at` is the row's semantic time so the record places chronologically.
 *   - `record` only — a bound row reached from the seed that binds no
 *     document; it stands as its own point-in-time entity.
 */
export const trailEventSchema: z.ZodType<TrailEvent> = z.lazy(() =>
  z
    .object({
      eventId: z.string().min(1),
      at: z.string().nullable(),
      kind: z.enum(["seed", "duplicate", "similar", "document", "record"]),
      doc: trailEventDocSchema.optional(),
      record: trailRecordSchema.optional(),
      attachments: z.array(trailEventSchema),
      people: z.array(trailEventPersonSchema),
      related: z.array(trailEventRelatedSchema),
    })
    .refine((e) => e.doc !== undefined || e.record !== undefined, {
      message: "a trail event must carry a doc, a record, or both",
    }),
);

/**
 * Recursive TS type for one trail event (lifted out of the lazy schema
 * above so consumers can refer to `TrailEvent` directly). `doc` and
 * `record` are both optional but at least one is always present (the
 * schema enforces it); a record-only event omits `doc`, a deduped
 * doc+row event carries both.
 */
export interface TrailEvent {
  eventId: string;
  at: string | null;
  kind: "seed" | "duplicate" | "similar" | "document" | "record";
  doc?: TrailEventDoc;
  record?: TrailRecord;
  attachments: TrailEvent[];
  people: TrailEventPerson[];
  related: TrailEventRelated[];
}

/**
 * A complete trail — chronologically-ordered top-level events plus
 * the seeds the walk started from and the standard stats block. The
 * payload shape future `trace_connections` tool calls will return.
 */
export const eventTrailSchema = z.object({
  seeds: z.array(z.string().min(1)),
  events: z.array(trailEventSchema),
  truncated: z.boolean(),
  stats: z.object({
    visited: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    maxDepthReached: z.number().nonnegative(),
  }),
});
export type EventTrail = z.infer<typeof eventTrailSchema>;

// ─── Tool-result discriminated union ───────────────────────────────────────

const searchResultsResult = z.object({
  kind: z.literal("search.results"),
  query: z.string(),
  durationMs: z.number().nonnegative(),
  candidates: z.number().nonnegative().optional(),
  results: z.array(docRefSchema),
});

/**
 * Full document body. The wire kept this loose for v1 because the storage
 * `Document` schema may grow — but every gateway impl is expected to emit
 * AT LEAST the fields below. iOS clients can rely on them; renderers can
 * ignore additional keys (`passthrough()` semantics).
 */
export const docBodySchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sourceCreatedAt: z.string().optional(),
    sourceUpdatedAt: z.string().optional(),
  })
  .passthrough();
export type DocBody = z.infer<typeof docBodySchema>;

const documentResult = z.object({
  kind: z.literal("document"),
  ref: docRefSchema,
  document: docBodySchema,
  neighbors: z.array(docRefSchema).optional(),
  /**
   * True when `neighbors` is a capped, recency-ordered sample — the document
   * has more 1-hop neighbours than were returned. The agent should run
   * `trace_connections` for the full neighbourhood rather than treat the sample as
   * exhaustive.
   */
  neighborsTruncated: z.boolean().optional(),
});

const sqlRowsResult = z.object({
  kind: z.literal("sql.rows"),
  sql: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().nonnegative(),
  truncated: z.boolean().optional(),
  /**
   * Per-row record identity, positionally aligned with `rows`. Entry
   * `i` references `rows[i]` when the result exposes exactly one known table's
   * full primary key, else `null` (aggregate, multi-table join, or a
   * projection that drops a primary-key column). Absent when the query touches
   * no known table. A non-null entry round-trips back to its source row, so a
   * client (the timeline drawer, the `cite_record` flow) can cite the row as a
   * point-in-time record without re-parsing the SQL.
   */
  rowIdentities: z
    .array(
      z
        .object({
          table: z.string(),
          recordKey: z.string(),
          primaryKeyColumns: z.array(
            z.object({
              name: z.string(),
              value: z.string(),
              // The column's declared DuckDB type (informational — lets a
              // consumer rebuilding the WHERE clause know whether to quote the
              // literal). Validated as a free string at the wire boundary; the
              // closed `ColumnType` enum lives in the source SDK.
              castType: z.string().optional(),
            }),
          ),
        })
        .nullable(),
    )
    .optional(),
  durationMs: z.number().nonnegative(),
  /**
   * Source attribution for the tables this query touched, computed by
   * the gateway from the analytics catalog. Clients render this directly
   * (icon + label) rather than introspecting the SQL themselves —
   * keeping source-specific knowledge inside the provider packages.
   */
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        sourceType: z.string(),
        displayName: z.string(),
      }),
    )
    .optional(),
  /** Display names of the tables touched (catalog `displayName`). */
  subjects: z.array(z.string()).optional(),
});

/**
 * Tool result of a successful `lookup_people` call. Mirrors
 * `search.results` shape — a query echo, a duration, and an ordered
 * array of candidates — so the renderer can present it as the same
 * "rolling slot of candidate rows" ephemeral card. Empty `results`
 * (no person matched the query) is a successful call, not an error.
 */
const personResultsResult = z.object({
  kind: z.literal("person.results"),
  query: z.string(),
  durationMs: z.number().nonnegative(),
  results: z.array(personSummarySchema),
});

/**
 * Tool result of a successful `lookup_document_by_url` call. Maps an
 * input URL (canonicalised server-side) to at most one DocRef in the
 * user's corpus — metadata only, never the document body. `ref` is
 * omitted when nothing matched — a clean "no match" outcome, not an
 * error. When a URL fans out to multiple docs (an email + its
 * attachments share a source_url), the resolver orders by
 * `source_created_at ASC` and returns the earliest — which is the
 * parent for every source that ingests an email before its
 * attachments (i.e. every source today).
 *
 * Shape mirrors a `search.results` row containing one entry so the
 * renderer can reuse the same ephemeral rolling-slot card. To read
 * the body, the agent follows up with `fetch_document(documentId)`.
 */
const documentByUrlResult = z.object({
  kind: z.literal("document.byUrl"),
  url: z.string(),
  durationMs: z.number().nonnegative(),
  ref: docRefSchema.optional(),
});

/**
 * Tool result of a successful `trace_connections` call. Carries the full
 * chronologically-ordered `EventTrail` payload — top-level events with
 * nested attachments, plus seeds + truncation flag + stats. This is the
 * agent's working memory for the turn: renderers show a one-line
 * "trace_connections · N events" summary card so the user sees the tool
 * fired, but the events do NOT populate the Timeline (only `annotate`
 * puts a document there). The result kind stays `event_trail.built` as a
 * stable wire tag retained across the tool's rename.
 */
const eventTrailBuiltResult = z.object({
  kind: z.literal("event_trail.built"),
  seeds: z.array(z.string().min(1)),
  events: z.array(trailEventSchema),
  truncated: z.boolean(),
  stats: z.object({
    visited: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    maxDepthReached: z.number().nonnegative(),
  }),
});

const toolErrorResult = z.object({
  kind: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/**
 * Result of a successful `annotate` tool call. The agent records that a
 * specific document materially informed its answer, optionally with a
 * short quote from the body and/or a one-line note. The renderer groups
 * annotations by `documentId` for the Citations side-panel.
 */
const annotateRecordedResult = z.object({
  kind: z.literal("annotate.recorded"),
  documentId: z.string().min(1),
  ref: docRefSchema,
  quote: z.string().optional(),
  quoteAuthor: z.string().optional(),
  /**
   * True when the quote is the user's own words — the `isSelf` person in
   * the corpus. Resolved server-side from `quoteAuthor` via the agent's
   * "You" convention (see `isSelfQuoteAuthor`). Renderers orient a
   * self-authored chat bubble accordingly (tail on the trailing edge);
   * absent / false means it's someone else's words. Only meaningful when
   * `quote` is present.
   */
  quoteIsSelf: z.boolean().optional(),
  note: z.string().optional(),
});

/**
 * Result of a successful `cite_record` tool call. The agent records
 * that a single analytics row — a point-in-time **record** — materially
 * informed its answer, the structured twin of an `annotate` document
 * citation. The gateway has already derived everything a client needs from
 * the table's declared contract: the human `title`, the labelled `keyFields`,
 * the `semanticTime` the record sits at, and the immutable `snapshot` (with
 * sensitive columns redacted). Clients never see raw column names or source
 * identity — only these derived strings. The conversation upsert harvests
 * this into a `kind:'record'` citation edge keyed by `recordKey`.
 */
const citeRecordRecordedResult = z.object({
  kind: z.literal("cite_record.recorded"),
  /** DuckDB table the cited row lives in. */
  table: z.string().min(1),
  /**
   * `analyticsRowKey(table, pk…)` — the stable dedup id shared with
   * `run_sql` row identity and the `same-entity` bound-row vertex. Synthesises
   * the citation's `normalized_target` so a re-cite is idempotent.
   */
  recordKey: z.string().min(1),
  /** The typed primary-key columns that address the row, in declared order. */
  primaryKeyColumns: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      castType: z.string().optional(),
    }),
  ),
  /** Derived human title (never empty — falls back to the table display name). */
  title: z.string(),
  /** Key fields surfaced in the drawer, label + (redacted) value, in order. */
  keyFields: z.array(
    z.object({
      label: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
  ),
  /**
   * The row's semantic time (the declared `semanticTimeColumn`'s value). Always
   * present on a recorded record citation — a timeless row (no semantic time)
   * is refused with a `record_not_timeline_eligible` error, never recorded.
   */
  semanticTime: z.string().min(1),
  /**
   * The immutable row snapshot exactly as the agent saw it, sensitive columns
   * masked. Stored verbatim in the citation's `metadata_json`.
   */
  snapshot: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Catalog source id that owns the table (icon/colour overlay on clients). */
  sourceId: z.string(),
  /** Bare source type derived from `sourceId`. */
  sourceType: z.string(),
  /** Human table name from the analytics catalog. */
  tableDisplayName: z.string(),
  /**
   * The id of the co-described document when the row binds one
   * (`boundDocument` declared + a matching document exists), else `null`. When
   * present it becomes the citation's `target_doc_id`, so a client can deep-link
   * the record through to its source document; `null` renders without a link.
   */
  boundDocumentId: z.string().nullable(),
});

/**
 * Plan item rendered in the agent's TODO panel.
 *
 * `status` is computed server-side, not asserted by the agent. The
 * rule: the topmost non-`done` item is `in_progress`; anything later
 * is `pending`. Clients render the three states as ●(spinner) / ○ /
 * ✓ and never have to decide which one is active.
 */
export const planItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["pending", "in_progress", "done"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

/**
 * Result of a successful `plan` tool call. Carries the full current
 * plan state — every item the agent has added on this turn, with its
 * computed status. Clients diff against their local view to drive
 * slide-in / complete / auto-remove animations. The list is transient:
 * once every item is `done`, clients clear the panel after a short
 * grace period and don't render it on resume.
 */
const planUpdatedResult = z.object({
  kind: z.literal("plan.updated"),
  items: z.array(planItemSchema),
});

/**
 * LLM-token spend for one turn (or, summed, one sub-agent / one tree). The
 * single shape every cost-accounting surface reads. NOT the device-auth
 * `touchTokenUsage` beacon — that is unrelated.
 */
export const agentUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/**
 * Cumulative usage reported while a model turn is still running. Providers
 * that expose no live usage simply omit this event; `agent.message.end`
 * remains the authoritative terminal total.
 */
export const agentUsageUpdateEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  usage: agentUsageSchema,
});
export type AgentUsageUpdateEvent = z.infer<typeof agentUsageUpdateEvent>;

/**
 * What Omnesis knows about the input size of the sampling request that ended
 * a turn. Measurement and limit provenance stay explicit: an absent token
 * count must never be mistaken for zero, and a configured limit must never be
 * presented as provider-reported truth.
 */
export const agentContextAssessmentSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  peakInputTokens: z.number().int().nonnegative().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  reservedOutputTokens: z.number().int().nonnegative().optional(),
  safetyMarginTokens: z.number().int().nonnegative().optional(),
  measurement: z.enum(["provider_count", "provider_reported", "estimate", "unknown"]),
  limitSource: z.enum(["provider", "configured", "unknown"]),
  requestIteration: z.number().int().positive(),
});
export type AgentContextAssessment = z.infer<typeof agentContextAssessmentSchema>;

/**
 * What the model provider itself reported about a rejected request, reduced to
 * the fields that describe the request's disposition rather than its content.
 *
 * The upstream response body is deliberately absent and must never be added: a
 * misconfigured or hostile model server can echo the submitted prompt — which
 * carries the user's corpus — inside its own error text. Envelope fields can
 * carry the same hazard in principle, so every producer routes them through
 * `sanitizeProviderFailureField` before they reach this structure.
 */
export const agentProviderFailureDetailSchema = z.object({
  /** Upstream HTTP status, e.g. 404. */
  status: z.number().int().positive().optional(),
  /** Provider error family, e.g. `invalid_request_error`. */
  type: z.string().min(1).optional(),
  /** Provider error code, e.g. `NOT_FOUND`. */
  code: z.string().min(1).optional(),
  /** Request field the provider blamed, e.g. `model`. */
  param: z.string().min(1).optional(),
  /** Provider-side correlation id, for a support ticket upstream. */
  requestId: z.string().min(1).optional(),
});
export type AgentProviderFailureDetail = z.infer<typeof agentProviderFailureDetailSchema>;

/**
 * Longest plausible provider error code / type / param / request id. Real ones
 * are identifiers; anything longer is prose wearing an identifier's field name.
 */
const MAX_PROVIDER_FAILURE_FIELD_CHARS = 64;

/**
 * Accept a provider-supplied envelope field only if it is an identifier, and
 * drop it otherwise.
 *
 * Substituting the offending characters is not enough here. A backend that
 * echoes the submitted prompt into `error.code` would survive a substituting
 * filter as `Maya_Reeves_asked_about_her_referral` — still the user's corpus,
 * merely punctuated differently. Whitespace and excess length are what separate
 * `invalid_request_error` from a sentence, so a value carrying either is
 * discarded whole rather than laundered.
 */
export function sanitizeProviderFailureField(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROVIDER_FAILURE_FIELD_CHARS) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  const cleaned = trimmed.replace(/[^A-Za-z0-9_.:/-]/g, "_");
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Render provider metadata as one operator-facing line, e.g.
 * `HTTP 404 · NOT_FOUND · param=model`.
 *
 * The gateway uses this to build the durable `detail` on a privacy exchange.
 * The live agent stream carries the structured object instead, so the portal,
 * iOS and Android each hold a copy of this join for that path; this is the
 * reference they follow, and `agent-protocol.test.ts` pins the order.
 */
export function formatProviderFailureDetail(
  detail: AgentProviderFailureDetail | undefined,
): string | undefined {
  if (!detail) return undefined;
  const parts: string[] = [];
  if (detail.status !== undefined) parts.push(`HTTP ${detail.status}`);
  if (detail.code) parts.push(detail.code);
  else if (detail.type) parts.push(detail.type);
  if (detail.param) parts.push(`param=${detail.param}`);
  if (detail.requestId) parts.push(`request ${detail.requestId}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Authoritative machine-readable failure for a completed agent turn. Providers
 * may still emit `agent.error` for live presentation, but durable consumers
 * decide success, retryability, and settlement from this structure only.
 */
export const agentTerminalFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  backend: z.string().min(1),
  model: z.string().min(1),
  provider: agentProviderFailureDetailSchema.optional(),
});
export type AgentTerminalFailure = z.infer<typeof agentTerminalFailureSchema>;

/**
 * A conversation-level terminal state persisted outside model-visible chat
 * history. V1 uses this for context exhaustion so reopening a conversation
 * cannot silently submit more turns to an already-full context.
 */
export const agentConversationTerminalFailureSchema = agentTerminalFailureSchema.extend({
  failedAt: z.string().datetime(),
  context: agentContextAssessmentSchema.optional(),
});
export type AgentConversationTerminalFailure = z.infer<
  typeof agentConversationTerminalFailureSchema
>;

/**
 * Lifecycle status of a sub-agent. `queued`/`running` are transient
 * (a `spawn_subagent` launch handle); `complete`/`failed`/`budget_exhausted`
 * are terminal (an `agent.subagent.result` event or a `join_subagents`
 * collected entry). `budget_exhausted` is the honest, named reason the
 * tree-wide token budget tripped — never a silent stop.
 */
export const subagentStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "budget_exhausted",
]);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

/**
 * Honest terminal reason a Deep Research run stopped. Every value is a
 * real terminal state the orchestrator can reach — never a euphemism for a
 * silent stop:
 *   - `answer_complete` — the loop planned, fanned out, verified, and
 *     synthesised a cited answer over the verified findings (the happy path);
 *   - `no_results` — the readers ran and surfaced nothing to ground an answer
 *     (every reader returned no citations), so the loop reports the gap rather
 *     than synthesising an ungrounded answer;
 *   - `plan_unusable` — the planner finished but never produced a
 *     decomposition the loop could execute, so no reader ever ran. Distinct
 *     from `no_results` on purpose: nothing was searched, so the run says
 *     nothing about whether the corpus holds an answer;
 *   - `evidence_unavailable` — readers cited documents the store could not hand
 *     back for verification, leaving nothing the run can stand behind. Also
 *     distinct from `no_results`: the evidence may well exist and be
 *     unreadable, which is a fault in the install rather than in the corpus;
 *   - `budget_exhausted` — the tree-wide sub-agent token budget tripped during
 *     fan-out (the iter-5 fail-loud trip), so synthesis ran (or was skipped)
 *     over whatever verified findings landed before the budget ran out;
 *   - `depth_or_concurrency_capped` — a structural cap (depth / concurrency)
 *     blocked the planned fan-out from running as decomposed;
 *   - `context_window_exceeded` / `output_truncated` — one model stage hit a
 *     deterministic input or output limit;
 *   - `agent_failed` — a model stage failed for another reason.
 */
export const deepResearchStoppedReasonSchema = z.enum([
  "answer_complete",
  "no_results",
  "plan_unusable",
  "evidence_unavailable",
  "budget_exhausted",
  "depth_or_concurrency_capped",
  "context_window_exceeded",
  "output_truncated",
  "agent_failed",
]);
export type DeepResearchStoppedReason = z.infer<typeof deepResearchStoppedReasonSchema>;

/**
 * Result of a `spawn_subagent` tool call. Fan-out is asynchronous: the
 * tool LAUNCHES a child (`status: "queued"` while the concurrency cap holds it,
 * `"running"` once it starts) and returns a handle IMMEDIATELY so the parent
 * can launch several children that run concurrently, then await them with
 * `join_subagents`. The distilled finding + citations arrive on the matching
 * `join_subagents` entry (or the `agent.subagent.result` event), not here —
 * `summary`/`citations` are absent on a fresh launch handle.
 */
const subagentSpawnedResult = z.object({
  kind: z.literal("subagent.spawned"),
  subagentId: z.string(),
  specialist: z.string(),
  status: subagentStatusSchema,
  summary: z.string().optional(),
  citations: z.array(docRefSchema).optional(),
});

/** One collected sub-agent finding inside a `join_subagents` result. */
const subagentJoinedEntry = z.object({
  subagentId: z.string(),
  specialist: z.string(),
  status: subagentStatusSchema,
  summary: z.string(),
  citations: z.array(docRefSchema),
  /** This child's own token spend, summed across its turns. */
  usage: agentUsageSchema.optional(),
  /** Authoritative model failure when the worker did not complete. */
  failure: agentTerminalFailureSchema.optional(),
});
export type SubagentJoinedEntry = z.infer<typeof subagentJoinedEntry>;

/**
 * Result of a `join_subagents` tool call — the barrier the parent uses
 * to await a set of in-flight (or already-finished) sub-agents and collect
 * their distilled findings. Carries the per-tree token aggregate so the parent
 * (and the report footer) can reason about total research cost. No per-citation
 * sub-agent attribution — citations merge into the parent's single set.
 */
const subagentJoinedResult = z.object({
  kind: z.literal("subagent.joined"),
  results: z.array(subagentJoinedEntry),
  /** Whole-tree token total at the moment the join resolved. */
  treeUsage: agentUsageSchema.optional(),
  /**
   * Present when the tree-wide token budget tripped during this fan-out — the
   * honest, named reason some children were stopped or never started.
   */
  stoppedReason: z.string().optional(),
});

// ─── Retired automation tool results ──────────────────────────────────
//
// **Decode-only, all of it.** These shapes belonged to the automation feature
// and nothing emits them any more — but `toolResultSchema` is what parses
// stored transcripts, so a conversation that contains one of these cards must
// still open. Dropping a member does not remove a card; it makes the whole
// conversation unreadable.
//
// The enums below are restated rather than imported for the same reason: the
// vocabulary they describe no longer exists anywhere else in the tree.

const TRIGGER_KIND_ENUM = ["match", "poll", "combined", "change"] as const;
const TRIGGER_ACTION_KIND_ENUM = ["exec", "notify-ios"] as const;
const TRIGGER_FIRING_STATUS_ENUM = [
  "ok",
  "exit-non-zero",
  "timeout",
  "spawn-error",
  "skipped",
] as const;

const triggerSummaryEntry = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(TRIGGER_KIND_ENUM),
  enabled: z.boolean(),
  expired: z.boolean(),
  lastFiredAt: z.number().nullable(),
  fireCount: z.number(),
  actionKinds: z.array(z.enum(TRIGGER_ACTION_KIND_ENUM)),
  agentManageable: z.boolean(),
});
const triggersListedResult = z.object({
  kind: z.literal("triggers.listed"),
  triggers: z.array(triggerSummaryEntry),
});

const triggerRecordEntry = triggerSummaryEntry.extend({
  spec: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const triggerFetchedResult = z.object({
  kind: z.literal("trigger.fetched"),
  trigger: triggerRecordEntry,
});

const triggerFiringEntry = z.object({
  id: z.string(),
  triggerId: z.string(),
  firedAt: z.number(),
  kind: z.enum(TRIGGER_KIND_ENUM),
  status: z.enum(TRIGGER_FIRING_STATUS_ENUM),
  batchSize: z.number(),
  durationMs: z.number(),
  error: z.string().nullable(),
});
const triggerFiringsResult = z.object({
  kind: z.literal("trigger.firings"),
  triggerId: z.string(),
  firings: z.array(triggerFiringEntry),
});

// Preview / test-backfill of a candidate spec — runs against a recent
// corpus slice without firing or persisting. Mirrors the gateway's
// `PreviewResult` so the agent can explain what an existing automation
// matches (does it match anything? does it reference a dead field?).
const triggerPreviewSampleEntry = z.object({
  id: z.string(),
  title: z.string().optional(),
  table: z.string().optional(),
  /** Short reason this item matched (or, for change, was in scope). */
  why: z.string(),
});

const triggerPreviewFieldDiagnosticEntry = z.object({
  /** A leaf field path referenced by the predicate. */
  path: z.string(),
  /** "K/N": of N evaluated items, K resolved this path to a non-null value. */
  resolvedNonNull: z.string(),
});

const triggerPreviewedResult = z.object({
  kind: z.literal("trigger.previewed"),
  /** False only when the spec failed structural validation. */
  ok: z.boolean(),
  /** Structural validation errors (present only when !ok). */
  errors: z.array(z.string()).optional(),
  /** Non-blocking warnings (dead field paths, truncated scan, …). */
  warnings: z.array(z.string()).optional(),
  triggerKind: z.enum(TRIGGER_KIND_ENUM),
  /** How many docs/rows the engine evaluated. */
  evaluated: z.number(),
  /** How many of those matched (would have fired / passed the guard). */
  matched: z.number(),
  samples: z.array(triggerPreviewSampleEntry),
  fieldDiagnostics: z.array(triggerPreviewFieldDiagnosticEntry),
  /** Free-form notes describing scope, skipped phases, truncation, etc. */
  notes: z.array(z.string()),
});
/**
 * Results from the retired automation feature.
 *
 * **Decode-only.** Nothing emits these any more, and the tools that did are
 * gone — but `toolResultSchema` is what parses stored transcripts, and a
 * conversation containing one of these cards must still open. Dropping a
 * member does not remove a card; it makes the whole conversation unreadable.
 *
 * `watch.upserted` is the successor for the one of these that had a live
 * counterpart.
 */
const triggerUpsertedResult = z.object({
  kind: z.literal("trigger.upserted"),
  triggerId: z.string(),
  name: z.string(),
  /** `created` when the trigger is brand new, `updated` for in-place edits. */
  action: z.enum(["created", "updated"]),
  enabled: z.boolean(),
  /** Short one-line summary so renderers can show what the trigger does. */
  summary: z.string().optional(),
  /**
   * The compiler's plain-language reading of the natural-language request the
   * automation was built from. The agent relays it so the user can correct a
   * misreading in the same conversation.
   */
  interpretation: z.string().optional(),
  /**
   * Non-blocking advisory notes from the gateway — e.g. push delivery is not
   * configured, so the automation will match but never reach a device. The
   * automation was still created/updated; the agent should relay these.
   */
  warnings: z.array(z.string()).optional(),
});

/**
 * One of the user's own watches, as the agent's read tools show it.
 *
 * The identity is the watch's own and survives a rewrite, so an id the agent
 * mentioned earlier in a conversation still resolves afterwards. `manageable`
 * is false for a watch that records its firings without notifying anyone —
 * visible, because it is the user's, but not rewritable from here, since a
 * rewrite would attach a notification nobody asked for.
 */
const watchSummaryEntry = z.object({
  watchId: z.string(),
  name: z.string(),
  /** The request it was compiled from, when it was compiled from one. */
  request: z.string().optional(),
  enabled: z.boolean(),
  /** Why it is not evaluating, when it is not. */
  note: z.string().optional(),
  manageable: z.boolean(),
  firedCount: z.number(),
  lastFiredAt: z.string().optional(),
});
export type WatchSummaryEntry = z.infer<typeof watchSummaryEntry>;

const watchesListedResult = z.object({
  kind: z.literal("watches.listed"),
  watches: z.array(watchSummaryEntry),
});

const watchRecordEntry = watchSummaryEntry.extend({
  /** The condition as the compiler stated it for the judge to rule on. */
  interpretation: z.string().optional(),
  createdAt: z.string(),
  /** What it has actually said, most recent first. */
  firings: z.array(z.object({ firedAt: z.string(), payload: z.unknown() })),
});
export type WatchRecordEntry = z.infer<typeof watchRecordEntry>;

const watchFetchedResult = z.object({
  kind: z.literal("watch.fetched"),
  watch: watchRecordEntry,
});

/**
 * What trying a watch against the recent past came to.
 *
 * The numbers are per node and the samples are the runtime's own words about
 * documents in this corpus — which is why the tool that produces this is one
 * the operator's own conversation holds and nothing else does.
 */
const watchProbedResult = z.object({
  kind: z.literal("watch.probed"),
  watchId: z.string(),
  events: z.number(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  firings: z.number(),
  /** True when a judged node sits on the path, so a probe cannot reach a firing. */
  judgeGated: z.boolean(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      evaluated: z.number(),
      matched: z.number(),
      wouldAsk: z.number(),
      diagnostics: z.array(z.string()),
      samples: z.array(
        z.object({ seq: z.number(), transition: z.string(), detail: z.string().optional() }),
      ),
    }),
  ),
});

/**
 * A historical result kind: nothing emits it, because the agent no longer has a
 * tool that flips an automation on or off. It stays in the union because
 * transcripts recorded before watches still carry one, and `toolResultSchema`
 * is what decodes a stored transcript — drop the member and every conversation
 * containing a toggle fails to parse on reopen, losing the whole transcript,
 * not just that one card.
 */
const triggerToggledResult = z.object({
  kind: z.literal("trigger.toggled"),
  triggerId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});

/**
 * Generic structured payload for feature-scoped tools with no bespoke
 * renderer — currently the background Cognition Steward's loop/brief/notes tools,
 * whose sessions are headless and never broadcast, so only the model reads
 * the result. `resultType` namespaces the payload shape (e.g.
 * `open_loop.created`); a renderer that does encounter one shows the raw
 * JSON rather than a dedicated card.
 */
const structuredResult = z.object({
  kind: z.literal("structured"),
  resultType: z.string(),
  data: z.unknown(),
});
export type StructuredToolResult = z.infer<typeof structuredResult>;

/**
 * Result of a successful interactive `search_loops` call (experimental) — the
 * chat agent reading the Cognition Steward's tracked obligations. Read-only; mirrors
 * the `search.results` / `person.results` shape so a renderer can present the
 * same rolling-slot card. Empty `loops` is a successful "nothing matched".
 */
const loopsSearchedResult = z.object({
  kind: z.literal("loops.searched"),
  query: z.string(),
  durationMs: z.number().nonnegative(),
  loops: z.array(loopSummarySchema),
});

/**
 * Result of a successful interactive `fetch_loop` call (experimental) — one
 * loop's full read-only detail. `loop` is omitted when the id matched nothing
 * (a clean no-match, not an error).
 */
const loopFetchedResult = z.object({
  kind: z.literal("loop.fetched"),
  loop: loopDetailSchema.optional(),
});

// ─── Batch tool results (search_many / fetch_many / annotate_many) ─────────
//
// A batch tool call maps to exactly one `tool_result` whose `items` are the
// ordered per-child outcomes — one model round-trip, N operations. Each child
// reuses the SINGULAR result shape so every renderer projects it into the same
// per-item card (search / document) or citation (annotate) it already shows for
// a singular call; a failed child is a `toolErrorResult` in its slot, so one
// failure never discards the batch. Output order follows input order even when
// execution finishes out of order. Live per-child progress streams separately
// via `agent.tool.child.*` events (below); this durable result is what the
// transcript persists and what a resumed conversation re-projects from.
const searchBatchItem = z.discriminatedUnion("kind", [searchResultsResult, toolErrorResult]);
const documentBatchItem = z.discriminatedUnion("kind", [documentResult, toolErrorResult]);
const annotateBatchItem = z.discriminatedUnion("kind", [annotateRecordedResult, toolErrorResult]);

const searchBatchResult = z.object({
  kind: z.literal("search.batch"),
  items: z.array(searchBatchItem),
});
const documentBatchResult = z.object({
  kind: z.literal("document.batch"),
  items: z.array(documentBatchItem),
});
const annotateBatchResult = z.object({
  kind: z.literal("annotate.batch"),
  items: z.array(annotateBatchItem),
});
export type SearchBatchResult = z.infer<typeof searchBatchResult>;
export type DocumentBatchResult = z.infer<typeof documentBatchResult>;
export type AnnotateBatchResult = z.infer<typeof annotateBatchResult>;

const watchUpsertedResult = z.object({
  kind: z.literal("watch.upserted"),
  watchId: z.string(),
  name: z.string(),
  /** `created` for a brand-new watch, `updated` when one is rewritten. */
  action: z.enum(["created", "updated"]),
  enabled: z.boolean(),
  /** One line describing what the watch does, for the card. */
  summary: z.string().optional(),
  /**
   * The compiler's plain-language reading of the request the watch was written
   * from. The agent relays it so the user can correct a misreading in the same
   * conversation.
   */
  interpretation: z.string().optional(),
  /**
   * Non-blocking advisory notes from the gateway — push delivery unconfigured,
   * for instance, so the watch will match but reach no device. The watch was
   * still installed; the agent should relay these.
   */
  warnings: z.array(z.string()).optional(),
});
export type WatchUpsertedResult = z.infer<typeof watchUpsertedResult>;

export const toolResultSchema = z.discriminatedUnion("kind", [
  searchResultsResult,
  documentResult,
  documentByUrlResult,
  sqlRowsResult,
  personResultsResult,
  eventTrailBuiltResult,
  annotateRecordedResult,
  citeRecordRecordedResult,
  planUpdatedResult,
  subagentSpawnedResult,
  subagentJoinedResult,
  triggersListedResult,
  triggerFetchedResult,
  triggerFiringsResult,
  triggerPreviewedResult,
  triggerUpsertedResult,
  triggerToggledResult,
  watchUpsertedResult,
  watchesListedResult,
  watchFetchedResult,
  watchProbedResult,
  loopsSearchedResult,
  loopFetchedResult,
  structuredResult,
  toolErrorResult,
  searchBatchResult,
  documentBatchResult,
  annotateBatchResult,
]);
export type ToolResult = z.infer<typeof toolResultSchema>;

// ─── Canonical chat-message shape (history snapshots) ─────────────────────

/**
 * Wire shape for one turn of the canonical conversation history. Mirrors
 * the in-memory `ChatMessage` produced by `@omnesis/agent` so the
 * session-create response can include the prior transcript when a
 * conversation is resumed. Renderers paint these as user / assistant
 * bubbles with inline tool-use chips and tool-result cards.
 */
const userPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("tool_result"),
    toolCallId: z.string(),
    result: toolResultSchema,
  }),
]);

const assistantPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    toolCallId: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
]);

export const chatMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), parts: z.array(userPartSchema) }),
  z.object({ role: z.literal("assistant"), parts: z.array(assistantPartSchema) }),
]);
export type ChatMessageWire = z.infer<typeof chatMessageSchema>;

// ─── Commands (client → server) ────────────────────────────────────────────

export const agentSessionCreateRequest = z.object({});
export const agentSessionCreateResponse = z.object({
  sessionId: z.string(),
  model: z.string(),
  backend: z.string(),
  messageCount: z.number().int().nonnegative(),
  title: z.string(),
  // True when a turn is genuinely in flight for this session right now (only a
  // live in-memory session can be busy). Defaulted so a client talking to an
  // older gateway that omits the field treats the session as idle. Clients use
  // this on foreground/reconnect to choose between trusting the persisted
  // transcript (idle) and preferring the live SSE resume (busy).
  busy: z.boolean().default(false),
  messages: z.array(chatMessageSchema),
  terminalFailure: agentConversationTerminalFailureSchema.optional(),
  // Durable presentation metadata for the most recent partial answer. Kept
  // outside `messages` so it is never sent back to the model as history.
  lastTurnFailure: agentTerminalFailureSchema.optional(),
});

export const agentMessageSendRequest = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  /**
   * Explicit opt-in to the Deep Research loop for THIS message only —
   * plan → parallel fan-out → citation-verify → cited synthesis. Off/absent =
   * an ordinary single agent turn. There is no implicit auto-gating: the loop
   * runs only when a client sets this (the `/`→"Deep Research" pill flips it),
   * and it clears afterward — the next message is a normal turn again.
   */
  deepResearch: z.boolean().optional(),
});
export const agentMessageSendResponse = z.object({
  messageId: z.string(),
  /**
   * Stable id for the user message itself (distinct from the assistant
   * turn's `messageId`). Echoed on the `agent.user.message` event so
   * the originator's client can dedupe its own optimistic bubble.
   */
  userMessageId: z.string(),
});

export const agentSessionCancelRequest = z.object({
  sessionId: z.string().min(1),
});
export const agentSessionCancelResponse = z.object({
  ok: z.literal(true),
});

// ─── Events (server → client, broadcast on the session channel) ────────────

/**
 * Fired the moment a user message lands on the gateway, before the
 * agent's turn begins. Carries the verbatim text so every device with
 * the conversation open can render the user bubble in real time —
 * including devices that did NOT originate the send. The originator
 * dedupes by matching `userMessageId` against the value returned from
 * `POST /agent/sessions/:id/messages`.
 */
export const agentUserMessageEvent = z.object({
  sessionId: z.string(),
  userMessageId: z.string(),
  text: z.string(),
});

export const agentMessageStartEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  role: z.literal("assistant"),
});

export const agentTextDeltaEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  delta: z.string(),
});

export const agentThinkingDeltaEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  delta: z.string(),
});

/**
 * Fires the moment the model opens a tool-use content block — BEFORE
 * any of the JSON args have streamed back. Carries just the tool id +
 * name so the UI can render a "Tool X · running…" stub card
 * immediately, instead of waiting for `tool.start` (which only fires
 * once the args have fully streamed in, often seconds later).
 *
 * Renderers should add a tool part with empty args / no result; the
 * later `tool.start` event updates the same slot (matched by
 * `toolCallId`) with the finalized args; `tool.result` then fills in
 * the result.
 */
export const agentToolInputStartEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  tool: z.string(),
});

export const agentToolStartEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  /**
   * Tool name, exactly as the registry (`buildBuiltinTools` in
   * `@omnesis/agent`) declared it. Open-string on purpose: a new tool ships
   * without bumping the wire version, and a transcript recorded before a tool
   * was retired still carries its name. Renderers own the set they draw cards
   * for and fall back to a generic card for anything else.
   */
  tool: z.string(),
  /**
   * Tool arguments as the model emitted them — opaque shape (per tool).
   * Renderers that want a short summary should pattern-match on `tool`
   * for built-ins (see `summarizeArgs` in the portal reference impl).
   */
  args: z.unknown(),
  /** One-sentence "why I'm running this" for the demo audience. */
  intent: z.string().optional(),
  /**
   * Optional server-rendered short summary of `args` (single line). When
   * present, renderers should prefer it over recomputing locally —
   * keeps the iOS / portal / CLI rendering consistent.
   */
  argsSummary: z.string().optional(),
  /**
   * Opaque provider metadata attached to the tool call, echoed back to the
   * model verbatim on later turns. Some providers (e.g. Gemini) return an
   * encrypted reasoning `thought_signature` here that must be replayed with
   * the tool call to keep a multi-turn reasoning conversation valid. The
   * session records it on the `tool_use` history part so it survives across
   * turns. Renderers ignore it.
   */
  extraContent: z.unknown().optional(),
  /** Opaque assistant reasoning blocks echoed on later turns with this tool call. */
  reasoningDetails: z.array(z.unknown()).optional(),
});

export const agentToolResultEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  result: toolResultSchema,
  durationMs: z.number().nonnegative(),
});

/**
 * Per-child progress for a batch tool call (`search_many` / `fetch_many` /
 * `annotate_many`). `toolCallId` is the PARENT batch call; `(toolCallId,
 * childIndex)` keys one live ephemeral card per child so a client animates N
 * cards with concurrent lifecycles. `tool` is the SINGULAR tool name
 * (`search_documents` / `fetch_document` / `annotate`) so renderers reuse the
 * existing per-tool card. These are live-only signals — the durable record is
 * the single `agent.tool.result` (a `*.batch` result) the cards re-project from
 * on reload, so a client that ignores them still reconstructs the same UI.
 */
export const agentToolChildStartEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  childIndex: z.number().int().nonnegative(),
  tool: z.string(),
  argsSummary: z.string().optional(),
});

export const agentToolChildResultEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  childIndex: z.number().int().nonnegative(),
  result: toolResultSchema,
});

/**
 * Live signal that the agent has cited a document. Emitted by the
 * session as a side-effect of a successful `annotate.recorded` tool
 * result; carries the optional verbatim `quote` or one-line `note` so
 * the UI can render them inline under the cited document.
 */
export const agentCitationEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  documentId: z.string(),
  ref: docRefSchema,
  quote: z.string().optional(),
  quoteAuthor: z.string().optional(),
  /**
   * True when the quote is the user's own words (the `isSelf` person).
   * Mirrors `annotate.recorded.quoteIsSelf` so the live citation event
   * carries the same orientation hint the terminal snapshot does.
   */
  quoteIsSelf: z.boolean().optional(),
  note: z.string().optional(),
});

/**
 * Per-turn diff of the citations panel. The panel surfaces only
 * documents the agent explicitly cited via the `annotate` tool —
 * search hits and fetched docs never auto-populate.
 */
export const agentCitationsUpdateEvent = z.object({
  sessionId: z.string(),
  added: z.array(docRefSchema),
  /** IDs to remove from the citations panel. */
  removed: z.array(z.string()),
});

// ─── Sub-agent events ───────────────────────────────────────────────
//
// A sub-agent is a nested `AgentSession` the parent spawns via the
// `spawn_subagent` tool. Its lifecycle is surfaced to clients through three
// event kinds, defined once here and re-rendered one level of recursion on
// each client. `agent.subagent.event` wraps the child's own AgentEvent so a
// client re-invokes its part renderer on the inner event; the wrapped event is
// carried opaquely on the wire (the child validates it as it emits it).

export const agentSubagentSpawnedEvent = z.object({
  /** Parent session id (the conversation the user is watching). */
  sessionId: z.string(),
  /** Child session id — `<parent>.sub.<short>`. */
  subagentId: z.string(),
  /** Registry name of the specialist driving the child. */
  specialist: z.string(),
  /** Short, parent-authored label for human-facing progress. */
  title: z.string().optional(),
  /** The natural-language brief — the child's first user message. */
  task: z.string(),
  /** The tool call on the parent that spawned this child, when known. */
  parentToolCallId: z.string().optional(),
});
export type AgentSubagentSpawnedEvent = z.infer<typeof agentSubagentSpawnedEvent>;

export const agentSubagentEventEvent = z.object({
  sessionId: z.string(),
  subagentId: z.string(),
  specialist: z.string(),
  /**
   * The child's own AgentEvent, wrapped. Carried opaquely (one level of
   * recursion) — clients re-invoke their renderer on `event`. The child
   * session validated it as a real AgentEvent at emit time.
   */
  event: z.object({ type: z.string(), payload: z.unknown() }).passthrough(),
});
export type AgentSubagentEventEvent = z.infer<typeof agentSubagentEventEvent>;

export const agentSubagentResultEvent = z.object({
  sessionId: z.string(),
  subagentId: z.string(),
  specialist: z.string(),
  status: z.enum(["complete", "failed", "budget_exhausted"]),
  /** Short distilled finding the child returned to the parent. */
  summary: z.string(),
  /** Documents the child cited; merged into the parent's single citation set. */
  citations: z.array(docRefSchema),
  /** Token spend for this child's run, summed across its turns. */
  usage: agentUsageSchema.optional(),
  /** Authoritative model failure when `status` is `failed`. */
  failure: agentTerminalFailureSchema.optional(),
  /**
   * Whole-tree token aggregate (this child + every other sub-agent sharing the
   * same root parent) at the moment this child finished. Clients render it as
   * the research-total in the report footer; the backend uses it to enforce the
   * tree-wide token budget. Cumulative and monotonic across a fan-out.
   */
  treeUsage: agentUsageSchema.optional(),
});
export type AgentSubagentResultEvent = z.infer<typeof agentSubagentResultEvent>;

/**
 * One planned reader sub-task the Deep Research planner produced: which
 * specialist chased which slice of the question. Surfaced on the summary event
 * and retained in persisted compatibility metadata; never carries a
 * backend/model (a specialist names a model ROLE only — frozen).
 */
export const deepResearchPlanItemSchema = z.object({
  specialist: z.string(),
  title: z.string(),
  task: z.string(),
});
export type DeepResearchPlanItem = z.infer<typeof deepResearchPlanItemSchema>;

/**
 * Quote-verification tally for a Deep Research run. The citation-verify
 * pass re-fetches each cited document and string-matches the verbatim quotes a
 * reader embedded against the fetched body (the `verifyQuotes` trust check).
 * `quotesChecked` is how many quotes were tested; `quotesVerified` how many
 * matched. Persisted for transcript compatibility and diagnostics even though
 * clients no longer render a separate verification card. A run that quoted
 * nothing reports `0/0`.
 */
export const deepResearchVerificationSchema = z.object({
  quotesChecked: z.number(),
  quotesVerified: z.number(),
});
export type DeepResearchVerification = z.infer<typeof deepResearchVerificationSchema>;

/**
 * Additive end-of-run summary for an explicit Deep Research run. Emitted
 * ONCE by the `DeepResearchService` just before the parent turn's
 * `agent.message.end`, after the report has streamed as `agent.text.delta` and
 * the single merged citation set landed via `agent.citations.update`.
 *
 * It carries the structured facts a client needs to render the verified-report
 * artifact — the honest terminal `stoppedReason`, the planner's decomposition,
 * the whole-tree token total, and the quote-verification tally — WITHOUT the
 * client having to parse the rendered report footer. It is strictly ADDITIVE:
 * the report still streams (and writes back) as ordinary text, so a client that
 * doesn't render the artifact, or a run/resume that never carries this event,
 * degrades gracefully to the plain chat bubble.
 *
 * No per-sub-agent citation attribution is surfaced here (a frozen constraint)
 * — citations remain a single merged set on `agent.citations.update`.
 */
export const agentDeepResearchSummaryEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  /** Honest terminal reason the run stopped. */
  stoppedReason: deepResearchStoppedReasonSchema,
  /** The planner's decomposition (the readers fanned out), in plan order. */
  plan: z.array(deepResearchPlanItemSchema).optional(),
  /** Whole-tree token total at the end of the run — the report-footer figure. */
  treeUsage: agentUsageSchema.optional(),
  /** Quote-verification tally driving the "N/N quotes verified" badge. */
  verification: deepResearchVerificationSchema,
});
export type AgentDeepResearchSummaryEvent = z.infer<typeof agentDeepResearchSummaryEvent>;

export const agentMessageEndEvent = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  stopReason: z.enum(["end_turn", "max_tokens", "tool_use", "canceled", "error"]),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheCreationTokens: z.number().optional(),
    })
    .optional(),
  context: agentContextAssessmentSchema.optional(),
  failure: agentTerminalFailureSchema.optional(),
});

export const agentErrorEvent = z.object({
  sessionId: z.string(),
  messageId: z.string().optional(),
  /**
   * Stable error code. See `KNOWN_AGENT_ERROR_CODES` for the catalog —
   * renderers branch off this to decide what action to surface (retry,
   * configure key, contact support). Open string so future codes can ship
   * without bumping the wire version; consumers should treat unknown
   * codes as `internal_error`.
   */
  code: z.string(),
  /** Operator-friendly message, suitable for surfacing to the end user. */
  message: z.string(),
  /**
   * What the model provider reported, when this error came from one. Present
   * so a renderer can show the disposition (`HTTP 429`, `NOT_FOUND`) beside the
   * sentence without parsing it back out of the prose.
   */
  provider: agentProviderFailureDetailSchema.optional(),
});

/**
 * Out-of-band control event telling a reconnecting client that it can't be
 * caught up incrementally — the gap predates the gateway's bounded replay
 * buffer — so it must reconcile by reloading the persisted transcript
 * (`POST /agent/sessions { resumeFromId }`). Carries no payload and no
 * sequence id (the SSE frame omits `id:`); it's connection-scoped, emitted
 * only to the client that reconnected past the buffer's window.
 */
export const agentResyncEvent = z.object({});

// ─── Inferred TS types ─────────────────────────────────────────────────────

export type AgentSessionCreateRequest = z.infer<typeof agentSessionCreateRequest>;
export type AgentSessionCreateResponse = z.infer<typeof agentSessionCreateResponse>;
export type AgentMessageSendRequest = z.infer<typeof agentMessageSendRequest>;
export type AgentMessageSendResponse = z.infer<typeof agentMessageSendResponse>;
export type AgentSessionCancelRequest = z.infer<typeof agentSessionCancelRequest>;
export type AgentSessionCancelResponse = z.infer<typeof agentSessionCancelResponse>;

export type AgentUserMessageEvent = z.infer<typeof agentUserMessageEvent>;
export type AgentMessageStartEvent = z.infer<typeof agentMessageStartEvent>;
export type AgentTextDeltaEvent = z.infer<typeof agentTextDeltaEvent>;
export type AgentThinkingDeltaEvent = z.infer<typeof agentThinkingDeltaEvent>;
export type AgentToolInputStartEvent = z.infer<typeof agentToolInputStartEvent>;
export type AgentToolStartEvent = z.infer<typeof agentToolStartEvent>;
export type AgentToolResultEvent = z.infer<typeof agentToolResultEvent>;
export type AgentToolChildStartEvent = z.infer<typeof agentToolChildStartEvent>;
export type AgentToolChildResultEvent = z.infer<typeof agentToolChildResultEvent>;
export type AgentCitationEvent = z.infer<typeof agentCitationEvent>;
export type AgentCitationsUpdateEvent = z.infer<typeof agentCitationsUpdateEvent>;

/**
 * UI-facing aggregate of one document's citations within a session.
 * Built by clients (portal reducer, iOS coordinator) by walking the
 * stream of `agent.citation` events and grouping entries by
 * `documentId`. Lives here so portal and iOS render identical shapes.
 *
 * Routing convention (applied client-side when ingesting annotate events):
 *   - annotate with `quote` (with or without `note`) → append an entry
 *     under `entries[]`. Per-entry `note` is the "why this matters" caption.
 *   - annotate with `note` only (no `quote`) → set the card's `docNote`.
 *     The last note-only call wins; renderers show this once at the top
 *     of the citation card, NOT under any specific quote entry.
 *   - annotate with neither → still creates the card via `ref`, just empty.
 */
export interface Citation {
  documentId: string;
  ref: DocRef;
  docNote?: string;
  entries: Array<{
    toolCallId: string;
    messageId: string;
    quote?: string;
    quoteAuthor?: string;
    /** See `isSelfQuoteAuthor` — orients a self-authored chat bubble. */
    quoteIsSelf?: boolean;
    note?: string;
  }>;
}

/**
 * Self-author tokens. The agent is instructed (annotate tool + system
 * prompt) to pass `quoteAuthor: "You"` when a quote is the user's own
 * words — the `isSelf` person in the corpus. We resolve that convention
 * to a boolean on the wire (`quoteIsSelf`) so renderers — the portal and
 * iOS chat bubbles — can orient a self-authored quote without
 * re-deriving identity from the people graph. Deliberately small and
 * English-centric: it mirrors the exact words the prompt tells the agent
 * to use for itself.
 */
const SELF_QUOTE_AUTHOR_TOKENS = new Set(["you", "me", "myself", "i", "self"]);

/**
 * True when `author` denotes the user themself. Resolves the agent's
 * "You" convention; whitespace- and case-insensitive. Empty / absent
 * author → false.
 */
export function isSelfQuoteAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  return SELF_QUOTE_AUTHOR_TOKENS.has(author.trim().toLowerCase());
}

export type AgentMessageEndEvent = z.infer<typeof agentMessageEndEvent>;
// (subagent event types are exported next to their schemas above)
export type AgentErrorEvent = z.infer<typeof agentErrorEvent>;
export type AgentResyncEvent = z.infer<typeof agentResyncEvent>;

/**
 * Discriminated union of every agent stream event. Handlers (the portal
 * reducer, the iOS view-model, the replay-fixture writer) can `switch`
 * exhaustively on `type`.
 */
export type AgentEvent =
  | { type: "agent.user.message"; payload: AgentUserMessageEvent }
  | { type: "agent.message.start"; payload: AgentMessageStartEvent }
  | { type: "agent.text.delta"; payload: AgentTextDeltaEvent }
  | { type: "agent.thinking.delta"; payload: AgentThinkingDeltaEvent }
  | { type: "agent.usage.update"; payload: AgentUsageUpdateEvent }
  | { type: "agent.tool.input_start"; payload: AgentToolInputStartEvent }
  | { type: "agent.tool.start"; payload: AgentToolStartEvent }
  | { type: "agent.tool.result"; payload: AgentToolResultEvent }
  | { type: "agent.tool.child.start"; payload: AgentToolChildStartEvent }
  | { type: "agent.tool.child.result"; payload: AgentToolChildResultEvent }
  | { type: "agent.citation"; payload: AgentCitationEvent }
  | { type: "agent.citations.update"; payload: AgentCitationsUpdateEvent }
  | { type: "agent.subagent.spawned"; payload: AgentSubagentSpawnedEvent }
  | { type: "agent.subagent.event"; payload: AgentSubagentEventEvent }
  | { type: "agent.subagent.result"; payload: AgentSubagentResultEvent }
  | { type: "agent.deep_research.summary"; payload: AgentDeepResearchSummaryEvent }
  | { type: "agent.message.end"; payload: AgentMessageEndEvent }
  | { type: "agent.error"; payload: AgentErrorEvent }
  | { type: "agent.resync"; payload: AgentResyncEvent };

export type AgentEventType = AgentEvent["type"];
