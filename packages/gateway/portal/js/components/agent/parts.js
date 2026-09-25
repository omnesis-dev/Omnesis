// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent UI components — message bubble, tool-call chips, source-shaped
 * search-result cards, inline citations. The AgentView owns the
 * conversation state and feeds each turn in via props; components paint the
 * structured `turn.parts[]` the reducer in `views/agent.js` produced. Most
 * are pure functions of their props, but a few transient affordances — the
 * ephemeral tool cards and the thinking indicator — own local
 * animation/dismiss state layered on top of those props.
 */

import { html } from "htm/preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { sourceIcon, sourceLabel } from "../../lib/format.js";
import { navigate } from "../../lib/router.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { DocChip } from "../doc-chip.js";
import { Modal } from "../modal.js";
import { TimelineColumn } from "../timeline.js";
import { buildUnifiedTimeline } from "../../views/agent-reducer.js";
import { matchSlashCommands, sendOptionsForArmed } from "../../lib/slash-commands.js";

// Agent components sit inline with body text, so icons should match the
// surrounding font size rather than the portal default (16px). 12px reads
// as "alongside a word" instead of "label header".
const AGENT_ICON_PX = 12;

/**
 * Parse a `#rrggbb` hex string into an `rgba(r, g, b, a)` CSS colour.
 * Falls back to `null` on a malformed value so callers can default to
 * a CSS-token border colour. 3-digit `#rgb` shorthand also supported.
 */
function hexToRgba(hex, alpha) {
  if (typeof hex !== "string") return null;
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ─── Message bubble ──────────────────────────────────────────────────────

/**
 * The quotable half of a failed turn: the Omnesis code, then the provider's own
 * disposition when a model provider rejected the request. Set apart from the
 * sentence above it because it is meant to be copied into a bug report rather
 * than read, and because a code run into the front of a sentence reads as its
 * first word.
 */
function AgentFailureCodes({ failure, className = "agent-msg-error-codes" }) {
  const code = failure?.code ? String(failure.code) : null;
  const detail = failure?.detail ? String(failure.detail) : null;
  if (!code && !detail) return null;
  return html`<span class=${className}>
    ${code ? html`<code>${code}</code>` : null}
    ${detail ? html`<span>${detail}</span>` : null}
  </span>`;
}

export function MessageBubble({ turn, citations, dispatch }) {
  const count = turn.role === "assistant" ? (turn.citationCount ?? 0) : 0;
  // Pre-compute citation-pill coalescing: every consecutive run of
  // pending annotate tool parts collapses into ONE pill rendered at the
  // run's lead slot, with a count of "N document(s) being cited" that
  // grows as more annotate calls land in the same run. The natural
  // alternative (one pill per part) reads as a stack of identical
  // animations when the agent fires off five annotates in a row.
  const pillRuns = computeCitationPillRuns(turn.parts ?? []);
  return html`
    <div class=${`agent-msg agent-msg-${turn.role}`}>
      <div class="agent-msg-body">
        ${turn.parts.map((part, i) =>
          // A thinking part is "live" only while it is the trailing part of
          // an in-flight turn (`!turn.done`). The moment anything follows it
          // — or the turn ends — it stops being live and fades itself out.
          // `turnDone` (the same done-signal the thinking block keys off)
          // also dismisses the inline researcher cards once the answer is
          // written — the normal Timeline annotations retain its evidence.
          renderPart(
            part,
            i,
            citations,
            dispatch,
            pillRuns,
            !turn.done && i === turn.parts.length - 1,
            true,
            turn.done === true,
          ))}
      </div>
      ${turn.error
        ? html`<div class="agent-msg-error">
            <span>${turn.error}</span>
            <${AgentFailureCodes} failure=${turn.failure} />
          </div>`
        : null}
      ${turn.stopped
        ? html`<div class="agent-msg-stopped">${turn.stopped}</div>`
        : null}
      ${count > 0
        ? html`<div class="agent-msg-footer"><${CitationCountChip} count=${count} /></div>`
        : null}
    </div>
  `;
}

/**
 * Walk `parts[]` and return a map from part index → { lead, count }:
 *   lead  = true on the first pending annotate of a contiguous run,
 *           false on every subsequent pending annotate in that run.
 *   count = number of pending annotates in the run (only meaningful
 *           on the lead slot).
 *
 * "Pending annotate" = a tool part for `annotate` whose `result` has
 * not landed yet. As soon as a result lands, the part is no longer
 * pending — the pill keeps counting only the still-in-flight calls so
 * it visibly shrinks and disappears when the last annotate resolves.
 */
function computeCitationPillRuns(parts) {
  // Both citation tools coalesce into the pill while pending: `annotate` cites a
  // document, `cite_record` cites a DuckDB row (#757). Both stream sizable args
  // (a verbatim quote / a row snapshot) that stall the transcript, so the pill
  // covers the pause for either.
  const isPendingCitation = (p) =>
    p?.kind === "tool" &&
    (p.tool === "annotate" || p.tool === "cite_record") &&
    p.result == null;
  const out = new Map();
  let i = 0;
  while (i < parts.length) {
    if (!isPendingCitation(parts[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < parts.length && isPendingCitation(parts[j])) j++;
    const runLength = j - i;
    out.set(i, { lead: true, count: runLength });
    for (let k = i + 1; k < j; k++) out.set(k, { lead: false, count: runLength });
    i = j;
  }
  return out;
}

/**
 * The per-child list for a batch tool card (`search_many` / `fetch_many`), in
 * PRIORITY order — the caller dispatches each entry back through `renderPart`
 * as a singular-tool pseudo-part:
 *
 *   1. `part.children` — the reducer populates these live from
 *      `agent.tool.child.*` events. Every production backend emits these while
 *      a batch is running.
 *   2. A settled batch result (`search.batch` / `document.batch`, whose
 *      index-aligned `.items[]` mirror the call's args) → one SETTLED
 *      pseudo-child per item. This preserves reload/replay behaviour when a
 *      live child event was not retained.
 *   3. Still running, no children, no result yet → one PENDING pseudo-child per
 *      entry in `part.args` (`queries` / `documents`) so the singular ephemeral
 *      card shows its live rotating/spinner state until the result lands.
 *
 * Each entry is `{ index, tool, argsSummary, result }`, index-aligned to the
 * call's args, matching the child shape the reducer builds from child events.
 */
function deriveBatchChildren(part, childTool) {
  // The batch call's instant and full payload ride along so every child card
  // can timestamp itself and open the same raw JSON.
  const shared = { timeText: part.timeText ?? null, rawPayload: part.rawPayload };
  if (Array.isArray(part.children) && part.children.length > 0) {
    return part.children.map((c) => ({
      index: c.index,
      tool: c.tool || childTool,
      argsSummary: c.argsSummary ?? "",
      result: c.result ?? null,
      ...shared,
    }));
  }
  const entries = batchArgEntries(part);
  const items = Array.isArray(part.result?.items) ? part.result.items : null;
  if (items) {
    return items.map((item, i) => ({
      index: i,
      tool: childTool,
      argsSummary: batchChildSummary(part.tool, entries[i], item),
      result: item,
      ...shared,
    }));
  }
  return entries.map((entry, i) => ({
    index: i,
    tool: childTool,
    argsSummary: batchChildSummary(part.tool, entry, null),
    result: null,
    ...shared,
  }));
}

/** The per-child arg entries for a batch call: `queries` or `documents`. */
function batchArgEntries(part) {
  const list = part.tool === "search_many" ? part.args?.queries : part.args?.documents;
  return Array.isArray(list) ? list : [];
}

/**
 * One-line summary for a batch pseudo-child: the query text for a search, the
 * fetched document's title (falling back to its id before the result lands) for
 * a fetch.
 */
function batchChildSummary(batchTool, argEntry, item) {
  if (batchTool === "search_many") {
    return typeof argEntry?.query === "string" ? argEntry.query : "";
  }
  const title = item?.kind === "document" ? item.ref?.title : null;
  if (typeof title === "string" && title.length > 0) return title;
  return typeof argEntry?.documentId === "string" ? argEntry.documentId : "";
}

// `live` distinguishes a streaming top-level transcript (true — ephemeral tool
// cards roll in then self-dismiss) from an after-the-fact / nested render
// (false — they render as STATIC chips). The reducer drops top-level ephemeral
// tool parts on resume, so only sub-agent `childTurns` (which retain them) need
// the static path; without it the rolling cards animate-then-vanish, leaving
// bare text blobs (#890).
export function renderPart(part, key, citations, dispatch, pillRuns, thinkingActive, live = true, turnDone = false) {
  switch (part.kind) {
    case "text":
      // Assistant text is markdown — tables, bold, lists, code fences.
      // User-side text is in agent-msg-user (rendered elsewhere); the
      // markdown path is harmless either way and DOMPurify sanitises.
      return html`<div key=${key} class="agent-part-text"
        dangerouslySetInnerHTML=${{ __html: renderMarkdown(part.text) }} />`;
    case "thinking":
      return html`<${ThinkingBlock} key=${key} text=${part.text} active=${thinkingActive} />`;
    case "subagent":
      // A nested sub-agent's lifecycle (#748): a compact live row showing its
      // title, status, token usage, and reached sources.
      //
      // Once the parent turn is done (`turnDone`), its live researcher rows
      // would be stale progress plumbing. Timeline annotations retain the
      // evidence; reload does not reconstruct subagent parts.
      if (turnDone) return null;
      return html`<${SubagentCard} key=${key} card=${part} dispatch=${dispatch} />`;
    case "tool":
      // `annotate` is silent in the transcript — the unified Timeline
      // sidebar owns the visible payload. But while the model is
      // streaming the annotate tool_use args (a verbatim quote, up to
      // 1024 chars) no text deltas can arrive, so the transcript
      // visibly pauses for ~0.5–2s per annotate call. Render an inline
      // "Citing N document(s)" pill once per RUN of pending annotates
      // (coalesced by `computeCitationPillRuns`) so a burst of
      // annotates reads as one growing pill rather than a stack of
      // identical ones. The pill disappears the moment the last
      // annotate in the run resolves; the citation itself still
      // surfaces in the sidebar + footer chip.
      // `annotate` (document citation) and `cite_record` (DuckDB row citation,
      // #757) are both silent in the transcript — the unified Timeline sidebar
      // and the footer count chip own their visible payload. While pending they
      // coalesce into one inline "Citing N…" pill (see `computeCitationPillRuns`).
      if (part.tool === "annotate" || part.tool === "cite_record") {
        if (part.result != null) return null;
        const run = pillRuns?.get(key);
        if (run?.lead) {
          return html`<${CitingPill} key=${key} count=${run.count} />`;
        }
        return null;
      }
      // `annotate_many` is silent like `annotate` — the Timeline sidebar and
      // footer chip own the visible payload. While pending, show one pill sized
      // to the batch; once the result lands, nothing inline (citations persist
      // via the sidebar).
      if (part.tool === "annotate_many") {
        if (part.result != null) return null;
        const n = Array.isArray(part.args?.annotations)
          ? part.args.annotations.length
          : Array.isArray(part.children)
            ? part.children.length
            : 1;
        return html`<${CitingPill} key=${key} count=${n} />`;
      }
      // Other silent tools — they drive their own surfaces (the pinned
      // TODO panel for `plan`) and never appear inline. The retired
      // read-only automation tools belong to this group too, so a
      // transcript recorded before they were removed still reopens
      // without an empty card where a background fetch used to be.
      if (
        part.tool === "plan" ||
        part.tool === "join_subagents" ||
        part.tool === "triggers_list" ||
        part.tool === "trigger_get" ||
        part.tool === "trigger_firings"
      ) {
        return null;
      }
      // Watch writes — surface a small lightning card so the user
      // immediately sees the change without having to ask. The retired
      // `trigger_*` authoring names stay in this list so transcripts recorded
      // before watches still render their cards on reopen.
      if (
        part.tool === "watch_create" ||
        part.tool === "watch_update" ||
        part.tool === "trigger_upsert" ||
        part.tool === "trigger_toggle"
      ) {
        return html`<${WatchActionCard} key=${key} call=${part} />`;
      }
      // Ephemeral cards: search / fetch_document / run_sql render as
      // transient rolling-slot cards that stream their content in and
      // then dismiss themselves. The reducer drops these tool_use parts
      // on resume, so this path only fires for live streaming.
      //
      // In an after-the-fact / debug render (`live === false`) the rolling
      // cards would animate-then-vanish, leaving bare text. Render a static
      // chip showing the tool + its result instead.
      // temporal_query and the steward loop reads keep the generic action
      // card live, but their results deserve the same rich static card as
      // the rest once settled. This set is static-only on purpose: the
      // live stream and the reducer's resume/drop behavior are untouched.
      if (
        !live &&
        (EPHEMERAL_TOOLS.has(part.tool) || STATIC_CARD_TOOLS.has(part.tool))
      ) {
        return html`<${StaticToolCard} key=${key} call=${part} />`;
      }
      // Batch retrieval: project one ephemeral card per child, reusing the
      // singular card by dispatching a child pseudo-part back through renderPart.
      // Each child carries the SINGULAR tool name so it lands on the right card.
      // The child list is derived (`deriveBatchChildren`) from live child events
      // (codex), the settled batch result (Anthropic / DeepSeek http, which emit
      // no child events), or the pending args — so cards render on every backend.
      if (part.tool === "search_many" || part.tool === "fetch_many") {
        const childTool = part.tool === "search_many" ? "search_documents" : "fetch_document";
        return deriveBatchChildren(part, childTool).map((c) =>
          renderPart(
            {
              kind: "tool",
              toolCallId: `${part.toolCallId}#${c.index}`,
              tool: c.tool || childTool,
              args: null,
              argsSummary: c.argsSummary ?? "",
              result: c.result ?? null,
              durationMs: null,
              timeText: c.timeText ?? null,
              rawPayload: c.rawPayload,
            },
            `${key}-${c.index}`,
            citations,
            dispatch,
            pillRuns,
            thinkingActive,
            live,
            turnDone,
          ),
        );
      }
      if (part.tool === "search_documents") {
        return html`<${EphemeralSearchCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "fetch_document") {
        return html`<${EphemeralDocumentCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "run_sql") {
        return html`<${EphemeralSqlCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "trace_connections") {
        return html`<${EphemeralTrailCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "lookup_people") {
        return html`<${EphemeralPeopleCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "lookup_document_by_url") {
        return html`<${EphemeralUrlLookupCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "search_loops") {
        return html`<${EphemeralLoopSearchCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      if (part.tool === "fetch_loop") {
        return html`<${EphemeralLoopFetchCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      // Background actions are ephemeral in the live interactive stream:
      // a generic action card
      // names the action, rolls one outcome line, and dismisses. In
      // static renders (`live === false`: a sub-agent fold, and the
      // cognition page's run transcripts) they keep the persistent
      // ToolCallChip below, so the debug surface shows every call.
      if (live && (EPHEMERAL_ACTION_TOOLS.has(part.tool) || EPHEMERAL_TOOLS.has(part.tool))) {
        // A member of the ephemeral set without a bespoke card (e.g.
        // `entity_context`, `list_loops`) — render the generic self-dismissing
        // action card so it flushes the causality gate rather than persisting.
        return html`<${EphemeralActionCard} key=${key} call=${part} dispatch=${dispatch} />`;
      }
      return html`<${ToolCallChip} key=${key} call=${part} citations=${citations} />`;
    default:
      return null;
  }
}

// ─── Sub-agent card (#748) ───────────────────────────────────────────────
//
// Renders one `agent.subagent.*` lifecycle as a compact, live researcher row.
// The detailed working set remains in ResearchWorkspace; a child transcript is
// neither useful progress information nor worth a disclosure interaction here.

function SubagentCard({ card }) {
  const running = card.status == null;
  const complete = card.status === "complete";
  const unsuccessful = card.status === "failed" || card.status === "budget_exhausted";
  const tokens = card.tokens ?? 0;
  const hasPartialResult =
    card.status === "failed" &&
    card.failureCode === "output_truncated" &&
    (card.retainedCitationCount ?? 0) > 0 &&
    card.summary?.startsWith(
      "Partial evidence collected before the worker reached its output limit:",
    );
  const statusLabel =
    card.status === "complete"
      ? "Done"
      : card.status === "failed"
        ? hasPartialResult
          ? "Partial result"
          : "Couldn't finish"
        : card.status === "budget_exhausted"
          ? "Stopped"
          : "Searching";
  const sources = sourceCounts(card.docs ?? []);
  const failureDetail = !running && card.status !== "complete" && !hasPartialResult ? card.summary : null;
  return html`
    <div class=${`agent-subagent${running ? " running" : ""}${complete ? " complete" : ""}${unsuccessful ? " unsuccessful" : ""}`}>
      <div class="agent-subagent-header" role="status" aria-label=${`${card.title || card.specialist}. ${statusLabel}. ${formatTokenCount(tokens)} tokens.`}>
        <span class="agent-subagent-specialist">${card.title || card.specialist}</span>
        <span class="agent-subagent-meta">
          ${running
            ? html`<span class="agent-subagent-dots" aria-label="Working"><span></span><span></span><span></span></span>`
            : null}
          <span class="agent-subagent-status">${statusLabel}</span>
          <span class="agent-subagent-counter">${formatTokenCount(tokens)} tok</span>
        </span>
      </div>
      ${failureDetail ? html`<div class="agent-subagent-failure" title=${failureDetail}>${failureDetail}</div>` : null}
      ${unsuccessful
        ? html`<${AgentFailureCodes}
            className="agent-subagent-codes"
            failure=${{ code: card.failureCode, detail: card.failureProvider }}
          />`
        : null}
      ${sources.length > 0
        ? html`<div class="agent-subagent-sources" role="list" aria-label="Sources found">
          ${sources.map(({ sourceId, count }) => html`
            <span
              class="agent-subagent-source"
              role="listitem"
              aria-label=${`${sourceLabel(sourceId)}: ${count} document${count === 1 ? "" : "s"}`}
              title=${`${sourceLabel(sourceId)}: ${count} document${count === 1 ? "" : "s"}`}
            >
              ${sourceIcon(sourceId, { size: 16 })}<span class="agent-subagent-source-count">${formatSourceCount(count)}</span>
            </span>
          `)}
        </div>`
        : null}
    </div>
  `;
}

/** Distinct documents grouped by their registry-resolved source. */
function sourceCounts(docs) {
  const counts = new Map();
  for (const doc of docs) {
    if (!doc?.sourceId) continue;
    counts.set(doc.sourceId, (counts.get(doc.sourceId) ?? 0) + 1);
  }
  return [...counts].map(([sourceId, count]) => ({ sourceId, count }));
}

/** Compact token count: 1234 → "1.2k", below 1000 stays exact. */
function formatTokenCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1000) return String(n ?? 0);
  return `${(n / 1000).toFixed(1)}k`;
}

/** Notification badges stay compact; the exact count remains in accessible text. */
function formatSourceCount(n) {
  return n > 99 ? "99+" : String(n);
}

// Tool controls that render as rolling, self-dismissing ephemeral cards while
// streaming. Static transcript/debug renders use `StaticToolCard` instead.
const EPHEMERAL_TOOLS = new Set([
  "spawn_subagent",
  "search_documents",
  "fetch_document",
  "run_sql",
  "trace_connections",
  "lookup_people",
  "lookup_document_by_url",
  "search_loops",
  "fetch_loop",
  "list_loops",
  "entity_context",
]);

// Static renders (transcripts, run history) show these through the rich
// StaticToolCard too. Kept out of EPHEMERAL_TOOLS so live streams keep the
// generic action card and resume/drop behavior stays exactly as it was.
const STATIC_CARD_TOOLS = new Set(["temporal_query", "open_loop_search", "open_loop_fetch"]);

// Background actions without a dedicated card. Live interactive streams
// render these through the generic EphemeralActionCard;
// static renders (sub-agent folds, cognition run transcripts) deliberately
// do NOT — there they stay persistent ToolCallChips so every call is
// inspectable. The reducer's EPHEMERAL_TOOLS (agent-reducer.js) separately
// drops them from resumed interactive history.
const EPHEMERAL_ACTION_TOOLS = new Set([
  "open_loop_search",
  "open_loop_fetch",
  "open_loop_create",
  "open_loop_update",
  "open_loop_delete",
  "open_loop_ledger_append",
  "brief_list",
  "brief_fetch",
  "brief_create",
  "brief_update",
  "brief_delete",
  "temporal_annotation_add",
  "temporal_annotation_update",
  "temporal_annotation_delete",
  "temporal_query",
  // Rolling aliases preserved in stored experimental conversations.
  "time_index_add",
  "time_index_update",
  "time_index_delete",
  "time_index_query",
  "notes_append",
  "notes_rewrite",
  "annotate_durable",
  "conversation_memory_evidence",
  "annotation_search",
  "annotation_revise",
  "annotation_retract",
  "annotation_supersede",
  "annotate_person",
  "person_annotation_revise",
  "person_annotation_retract",
  "person_annotation_supersede",
  "schedule_agent_run",
]);

/** Human verb for each ephemeral action; the raw name for anything new. */
function actionToolLabel(tool) {
  return {
    open_loop_search: "Search loops",
    open_loop_fetch: "Open loop",
    open_loop_create: "Create loop",
    open_loop_update: "Update loop",
    open_loop_delete: "Delete loop",
    open_loop_ledger_append: "Note on loop",
    brief_list: "List briefs",
    brief_fetch: "Open brief",
    brief_create: "Create brief",
    brief_update: "Update brief",
    brief_delete: "Withdraw brief",
    temporal_query: "Query time",
    temporal_annotation_add: "Add temporal annotation",
    temporal_annotation_update: "Update temporal annotation",
    temporal_annotation_delete: "Remove temporal annotation",
    time_index_query: "Query time",
    time_index_add: "Add temporal annotation",
    time_index_update: "Update temporal annotation",
    time_index_delete: "Remove temporal annotation",
    notes_append: "Append notes",
    notes_rewrite: "Rewrite notes",
    conversation_memory_evidence: "Prepare memory",
    annotation_search: "Search memory",
    annotate_durable: "Remember document",
    annotation_revise: "Update document memory",
    annotation_retract: "Forget document memory",
    annotation_supersede: "Replace document memory",
    annotate_person: "Remember person",
    person_annotation_revise: "Update person memory",
    person_annotation_retract: "Forget person memory",
    person_annotation_supersede: "Replace person memory",
    schedule_agent_run: "Schedule follow-up",
    list_loops: "List loops",
    entity_context: "Gather context",
  }[tool] ?? tool;
}

function actionToolGlyph(tool) {
  if (tool.startsWith("open_loop_")) return LOOP_GLYPH;
  if (tool === "list_loops") return LOOP_GLYPH;
  if (tool.startsWith("brief_")) return BRIEF_GLYPH;
  if (
    tool === "temporal_query" ||
    tool.startsWith("temporal_annotation_") ||
    tool.startsWith("time_index_")
  ) {
    return CLOCK_GLYPH;
  }
  if (tool === "schedule_agent_run") return CLOCK_GLYPH;
  return DOC_GLYPH;
}

/**
 * Generic ephemeral card for background and memory actions: names the action
 * while it runs, rolls a single outcome line (the humanized structured
 * resultType — steward results are `{kind:"structured", resultType,
 * data}` on the wire — or the error message), then dismisses — same
 * lifecycle contract as the bespoke ephemeral cards, including the
 * causality-gate flush. Mirrors iOS's AgentEphemeralActionCard.
 */
function EphemeralActionCard({ call, dispatch }) {
  const resultArrived = ephemeralResultArrived(call);
  const isError = call.result?.kind === "error";
  let line = null;
  if (isError) {
    line = String(call.result.message ?? "failed").slice(0, 120);
  } else if (resultArrived) {
    const resultType = typeof call.result?.resultType === "string" ? call.result.resultType : null;
    // "open_loop.ledger_appended" → "Open loop ledger appended".
    line = resultType
      ? resultType.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase())
      : "Done";
  }
  const items = line == null ? [] : [{ kind: "outcome", line, isError }];
  const { currentIndex, phase } = useRollingRotation(resultArrived, items.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${actionToolGlyph(call.tool)}
        label=${actionToolLabel(call.tool)}
        monospaceArg=${call.argsSummary || ""}
        showSpinner=${!resultArrived}
      />
      ${items.length > 0
        ? html`<${RollingSlot}
            items=${items}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(item) => html`
              <div class=${`agent-ephemeral-result${item.isError ? " agent-ephemeral-error" : ""}`}>
                <span class="agent-ephemeral-result-title">${item.line}</span>
              </div>
            `}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

const BRIEF_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="10" height="7" rx="1" />
    <path d="M4.5 4h7 M6 2h4" />
  </svg>
`;
const CLOCK_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2.2 1.6" />
  </svg>
`;

// Static (non-animated, non-dismissing) twin of the ephemeral tool cards.
// Historical/debug renders use it so rolling cards cannot animate away and
// leave bare text.
function docHref(documentId) {
  return `/portal/doc/${encodeURIComponent(documentId)}`;
}

function personHref(canonicalId) {
  return `/portal/people/${encodeURIComponent(canonicalId)}`;
}

// Loop detail lives on the debug cognition surface — the same target the
// cognition view's own cross-entity links use.
function loopHref(loopId) {
  return `/portal/debug/cognition/loops/${encodeURIComponent(loopId)}`;
}

// In-SPA navigation for transcript links. Modifier/middle clicks fall
// through to the browser's open-in-new-tab, like DocChip.
function transcriptLinkNav(href) {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    navigate(href);
  };
}

/**
 * The `entity_context(kind, id, depth?)` header argument: the reaped
 * entity's kind and id read on the card's header line, where every other
 * tool's argument reads. After-the-fact calls carry no argsSummary, so
 * without this the header would stand bare.
 */
function entityContextArg(args) {
  const kind = typeof args?.kind === "string" ? args.kind.trim() : "";
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  return [kind, id].filter((part) => part.length > 0).join(" ");
}

/**
 * The `trace_connections(seedIds, depth?, fanoutCap?)` header argument: the
 * walked seed ids, comma-joined, where every other tool's argument reads.
 */
function traceSeedsArg(args) {
  const seeds = args?.seedIds;
  if (Array.isArray(seeds)) {
    return seeds.filter((seed) => typeof seed === "string" && seed.trim().length > 0).join(", ");
  }
  return typeof seeds === "string" ? seeds.trim() : "";
}

/**
 * Seed header for `trace_connections`: the walked seed ids resolved to
 * their trail-event document titles with the first resolved seed's source
 * icon — the same header the native audit cards render. Unresolved seeds
 * keep their ids; no ids at all returns null so the caller falls back to
 * the raw arg text.
 */
function traceSeedsDisplay(args, result) {
  const trailed = result?.kind === "event_trail.built" ? result : null;
  const raw =
    trailed && Array.isArray(trailed.seeds)
      ? trailed.seeds
      : Array.isArray(args?.seedIds)
        ? args.seedIds
        : [];
  const ids = raw.filter((seed) => typeof seed === "string" && seed.trim().length > 0);
  if (ids.length === 0) return null;
  const byId = new Map(
    flattenTrailDocs(trailed?.events ?? []).map((doc) => [doc.documentId, doc]),
  );
  let iconSourceId = null;
  let href = null;
  const titles = ids.map((id) => {
    const doc = byId.get(id);
    if (!doc) return id;
    if (iconSourceId == null) {
      iconSourceId = doc.sourceId || null;
      href = doc.documentId ? docHref(doc.documentId) : null;
    }
    return doc.title || id;
  });
  return { text: titles.join(", "), icon: sourceIcon(iconSourceId, { size: 11 }), href };
}

/**
 * Seed header for `entity_context`: the reaped seed's label with its
 * kind icon (a document seed resolves its source icon from the reaped
 * documents, like the trail seeds above). A labelless seed returns null
 * so the caller falls back to the `kind id` arg text.
 */
function entitySeedDisplay(args, data) {
  const kind = typeof args?.kind === "string" ? args.kind.trim() : "";
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  const seed = data?.seed;
  const seedKind =
    seed != null && typeof seed.kind === "string" && seed.kind.length > 0 ? seed.kind : kind;
  const seedId = seed != null && typeof seed.id === "string" && seed.id.length > 0 ? seed.id : id;
  const label = seed != null && typeof seed.label === "string" ? seed.label.trim() : "";
  if (label.length === 0) return null;
  if (seedKind === "document") {
    const docs = Array.isArray(data?.documents) ? data.documents : [];
    const doc = docs.find((entry) => entry?.documentId === seedId);
    return {
      text: label,
      icon: sourceIcon(doc?.sourceId, { size: 11 }),
      href: seedId ? docHref(seedId) : null,
    };
  }
  if (seedKind === "loop") {
    return { text: label, icon: LOOP_GLYPH, href: seedId ? loopHref(seedId) : null };
  }
  if (seedKind === "person") {
    return { text: label, icon: PEOPLE_GLYPH, href: seedId ? personHref(seedId) : null };
  }
  return { text: label, icon: null, href: null };
}

/**
 * The shared seed header: icon + resolved titles, linked like the opened
 * document when the seed names a single target.
 */
function seedHeaderExtra(display) {
  const opened = html`
    <span class="agent-ephemeral-result-icon">${display.icon}</span>
    <span>${display.text}</span>`;
  return display.href
    ? html`<a
        class="agent-ephemeral-doc-title agent-ephemeral-result-link"
        href=${display.href}
        onClick=${transcriptLinkNav(display.href)}
      >${opened}</a>`
    : html`<span class="agent-ephemeral-doc-title">${opened}</span>`;
}

function staticResultRow(icon, title, href) {
  const inner = html`
    <span class="agent-ephemeral-result-icon">${icon}</span>
    <span class="agent-ephemeral-result-title">${title || "Untitled"}</span>`;
  return href
    ? html`<a
        class="agent-ephemeral-result agent-ephemeral-result-link"
        href=${href}
        onClick=${transcriptLinkNav(href)}
      >${inner}</a>`
    : html`<div class="agent-ephemeral-result">${inner}</div>`;
}

function StaticToolCard({ call }) {
  const tool = call.tool;
  const row = staticResultRow;
  let glyph = SEARCH_GLYPH;
  let label = actionToolLabel(tool);
  let arg = call.argsSummary || "";
  let headerExtra = null;
  let items = [];
  // Rich result blocks that are not plain row lists (the SQL rowblock).
  let extra = null;
  // Whether the result matched the kind this tool renders — a matched but
  // empty result reads "No result" instead of rendering nothing.
  let matched = false;
  if (tool === "search_documents") {
    glyph = SEARCH_GLYPH;
    label = "Search";
    arg = call.args?.query || call.argsSummary || "";
    if (call.result?.kind === "search.results") {
      matched = true;
      items = (call.result.results || [])
        .slice(0, EPHEMERAL_SEARCH_RESULTS_MAX)
        .map((r) =>
          row(
            sourceIcon(r.sourceId, { size: 11 }),
            r.title,
            r.documentId ? docHref(r.documentId) : null,
          ),
        );
    }
  } else if (tool === "fetch_document") {
    glyph = DOC_GLYPH;
    label = "Open document";
    arg = "";
    const ref = call.result?.kind === "document" ? call.result.ref : null;
    if (call.result?.kind === "document") matched = true;
    if (ref) {
      const opened = html`
        <span class="agent-ephemeral-result-icon">${sourceIcon(ref.sourceId, { size: 11 })}</span>
        <span>${ref.title || "Untitled"}</span>`;
      headerExtra = ref.documentId
        ? html`<a
            class="agent-ephemeral-doc-title agent-ephemeral-result-link"
            href=${docHref(ref.documentId)}
            onClick=${transcriptLinkNav(docHref(ref.documentId))}
          >${opened}</a>`
        : html`<span class="agent-ephemeral-doc-title">${opened}</span>`;
    }
  } else if (tool === "run_sql") {
    glyph = SQL_GLYPH;
    label = "Run SQL";
    arg = typeof call.args?.sql === "string" ? call.args.sql.replace(/\s+/g, " ").trim() : "";
    if (call.result?.kind === "sql.rows") {
      matched = true;
      const columns = Array.isArray(call.result.columns) ? call.result.columns : [];
      const allRows = Array.isArray(call.result.rows) ? call.result.rows : [];
      const shownRows = allRows.slice(0, EPHEMERAL_SQL_ROWS_MAX);
      // The live card rotates through these rows; the static transcript
      // prints the same rowblock without animation.
      extra = html`<div class="agent-ephemeral-sql-rowblock">
        ${columns.length > 0
          ? html`<div class="agent-ephemeral-sql-cols">
              ${columns.map((c, j) => html`<span key=${j} class="agent-ephemeral-sql-col">${c}</span>`)}
            </div>`
          : null}
        ${shownRows.map((r, i) => html`<div key=${i} class="agent-ephemeral-sql-row">
          ${normaliseRow(r, columns.length).map((cell, j) => html`<span key=${j} class="agent-ephemeral-sql-cell">${formatSqlCell(cell)}</span>`)}
        </div>`)}
        ${allRows.length > shownRows.length
          ? html`<div class="agent-ephemeral-note">+${allRows.length - shownRows.length} more rows</div>`
          : null}
      </div>`;
    }
  } else if (tool === "trace_connections") {
    glyph = TRAIL_GLYPH;
    label = "Trace connections";
    const seeds = traceSeedsDisplay(call.args, call.result);
    arg = seeds ? "" : traceSeedsArg(call.args) || call.argsSummary || "";
    if (seeds) headerExtra = seedHeaderExtra(seeds);
    if (call.result?.kind === "event_trail.built") {
      matched = true;
      items = flattenTrailDocs(call.result.events ?? []).map((d) =>
        row(sourceIcon(d.sourceId, { size: 11 }), d.title, docHref(d.documentId)),
      );
    }
  } else if (tool === "lookup_people") {
    glyph = PEOPLE_GLYPH;
    label = "Look up people";
    arg = call.args?.name || call.args?.query || call.argsSummary || "";
    if (call.result?.kind === "person.results") {
      matched = true;
      items = (call.result.results || [])
        .slice(0, EPHEMERAL_SEARCH_RESULTS_MAX)
        .map((p) =>
          row(
            PEOPLE_GLYPH,
            p.displayName,
            p.canonicalId ? personHref(p.canonicalId) : null,
          ),
        );
    }
  } else if (tool === "lookup_document_by_url") {
    glyph = LINK_GLYPH;
    label = "Look up URL";
    const lookupUrl = typeof call.args?.url === "string" ? call.args.url : "";
    // External target, new tab per portal convention. Only http(s) becomes
    // a link — anything else stays plain text, never a lively href.
    arg =
      /^https?:\/\//i.test(lookupUrl)
        ? html`<a href=${lookupUrl} target="_blank" rel="noreferrer">${lookupUrl}</a>`
        : lookupUrl || call.argsSummary || "";
    const ref = call.result?.kind === "document.byUrl" ? call.result.ref : null;
    if (call.result?.kind === "document.byUrl") matched = true;
    if (ref) {
      items = [
        row(
          sourceIcon(ref.sourceId, { size: 11 }),
          ref.title,
          ref.documentId ? docHref(ref.documentId) : null,
        ),
      ];
    }
  } else if (tool === "search_loops") {
    glyph = LOOP_GLYPH;
    label = "Search loops";
    arg = call.args?.query || call.argsSummary || "";
    if (call.result?.kind === "loops.searched") {
      matched = true;
      items = loopResultRows(call.result.loops);
    }
  } else if (tool === "list_loops") {
    glyph = LOOP_GLYPH;
    label = "List loops";
    arg = call.argsSummary || "";
    if (call.result?.kind === "structured" && call.result?.resultType === "loops.listed") {
      matched = true;
      items = loopResultRows(call.result?.data?.loops);
    }
  } else if (tool === "open_loop_search") {
    glyph = LOOP_GLYPH;
    label = "Search loops";
    arg = call.args?.query || call.argsSummary || "";
    if (call.result?.kind === "structured" && call.result?.resultType === "open_loop.search_results") {
      matched = true;
      items = loopResultRows(call.result?.data?.loops);
      const retired = call.result?.data?.retired;
      const retiredCount = typeof retired === "number" ? retired : Array.isArray(retired) ? retired.length : 0;
      if (retiredCount > 0) {
        items = [...items, html`<div class="agent-ephemeral-note">${retiredCount} retired</div>`];
      }
    }
  } else if (tool === "fetch_loop") {
    glyph = LOOP_GLYPH;
    label = "Open loop";
    arg = "";
    const loop = call.result?.kind === "loop.fetched" ? call.result.loop : null;
    if (call.result?.kind === "loop.fetched") matched = true;
    if (loop) headerExtra = loopHeaderExtra(loop);
  } else if (tool === "open_loop_fetch") {
    glyph = LOOP_GLYPH;
    label = "Open loop";
    arg = "";
    const data = call.result?.kind === "structured" && call.result?.resultType === "open_loop.fetched"
      ? call.result?.data
      : null;
    if (data) matched = true;
    if (data) headerExtra = loopHeaderExtra(data);
  } else if (tool === "entity_context") {
    glyph = TRAIL_GLYPH;
    label = "Entity context";
    const seed =
      call.result?.kind === "structured" && call.result?.resultType === "entity_context.reaped"
        ? entitySeedDisplay(call.args, call.result?.data)
        : null;
    arg = seed ? "" : entityContextArg(call.args) || call.argsSummary || "";
    if (seed) headerExtra = seedHeaderExtra(seed);
    if (call.result?.kind === "structured" && call.result?.resultType === "entity_context.reaped") {
      matched = true;
      items = neighborhoodRows(call.result?.data);
    }
  } else if (tool === "temporal_query") {
    glyph = CLOCK_GLYPH;
    label = "Temporal query";
    arg = call.args?.from || call.args?.to ? `${call.args?.from ?? "now"} … ${call.args?.to ?? call.args?.from ?? "now"}` : call.argsSummary || "";
    if (call.result?.kind === "structured" && call.result?.resultType === "temporal.results") {
      matched = true;
      const found = Array.isArray(call.result?.data?.items) ? call.result.data.items : [];
      items = found
        .slice(0, EPHEMERAL_SEARCH_RESULTS_MAX)
        .map((entry) => row(null, entry?.label || "Untitled moment"));
    }
  }
  const isError = call.result?.kind === "error";
  // Citation tools stay silent by design — the Timeline and Citations
  // side-panel own their results, so a missing result here is not news.
  const silent = tool === "annotate" || tool === "cite_record" || tool === "annotate_many";
  // Nothing rendered and nothing expected to render: a missing result, or a
  // matched result kind with an empty list, reads "No result" instead of a
  // bare header.
  const showEmpty =
    !isError &&
    !silent &&
    headerExtra == null &&
    extra == null &&
    items.length === 0 &&
    (call.result == null || matched);
  // The timestamp/raw affordances own modal state, so they only enter the
  // tree when the caller sets them. Error results always use the shared
  // error card below, independent of those flags.
  const trailing =
    call.timeText != null || call.rawPayload !== undefined
      ? html`<${ToolCardTrailing}
          timeText=${call.timeText ?? null}
          rawTitle=${`${label} — raw JSON`}
          rawPayload=${call.rawPayload}
        />`
      : null;
  return html`
    <div class="agent-ephemeral agent-ephemeral-static">
      <${EphemeralHeader}
        glyph=${glyph}
        label=${label}
        monospaceArg=${arg || null}
        headerExtra=${headerExtra}
        showSpinner=${false}
        trailing=${trailing}
      />
      ${isError
        ? html`<${ToolErrorCard} code=${call.result.code} message=${call.result.message} />`
        : items.length > 0
          ? html`<div class="agent-ephemeral-static-list">${items}</div>`
          : null}
      ${extra}
      ${showEmpty ? html`<div class="agent-ephemeral-empty">No result</div>` : null}
    </div>
  `;
}

// ─── Research working-set surface (#748) ─────────────────────────────────
//
// The headline Deep Research deliverable: a bespoke, multi-panel surface —
// "N researchers side by side" — that appears WHILE a Deep Research run is in
// flight and disappears once the answer ends. Each panel
// is one sub-agent (specialist + task) whose found documents accumulate LIVE
// as source-tinted chips, reduced from the real `agent.subagent.*` stream
// (`agent-reducer.js` → `researchPanels`). This is deliberately NOT the plain
// citation drawer re-skinned: it is a dedicated horizontal workspace with a
// distinct visual language (a header strip, a status rail per researcher, a
// flat vertical list of document rows).
//
// Source encapsulation: every document carries its source's glyph via
// `sourceIcon` (label via `sourceLabel`) keyed off the DocRef's `sourceId` —
// NEVER by branching on a source name. Rows are flat — the icon + title sit
// directly on the card with no per-row fill or rail; a source the registry
// doesn't know falls back to the generic doc glyph, so the surface degrades
// gracefully for any source.

const RESEARCH_STATUS = {
  complete: { label: "done", cls: "done" },
  failed: { label: "failed", cls: "failed" },
  budget_exhausted: { label: "budget", cls: "failed" },
};

/** Status descriptor for a panel — null status (in flight) reads "searching…". */
function researchPanelStatus(status) {
  if (status == null) return { label: "searching…", cls: "running" };
  return RESEARCH_STATUS[status] ?? { label: status, cls: "running" };
}

/**
 * One document in a researcher's working set. The shared chip, plus the
 * animation that belongs to this surface alone: chips here appear one at a
 * time as the researcher finds them, which is the surface's whole point.
 */
function ResearchDocChip({ doc }) {
  return html`<${DocChip}
    documentId=${doc.documentId}
    title=${doc.title}
    sourceId=${doc.sourceId}
    className="research-doc-chip"
  />`;
}

/** One researcher's panel: specialist + task header, status rail, doc grid. */
function ResearchPanel({ panel }) {
  const status = researchPanelStatus(panel.status);
  const docs = panel.docs ?? [];
  const steps = panel.stepCount ?? 0;
  const tokens = panel.tokens ?? 0;
  const docNoun = docs.length === 1 ? "document" : "documents";
  return html`
    <div class=${`research-panel research-panel-${status.cls}`}>
      <div class="research-panel-head">
        <div class="research-panel-titles">
          <span class="research-panel-specialist">${panel.specialist}</span>
          <span class="research-panel-task" title=${panel.task}>${panel.task}</span>
        </div>
        <span class=${`research-panel-status research-panel-status-${status.cls}`}>
          ${status.cls === "running"
            ? html`<span class="research-panel-spinner" aria-hidden="true"></span>`
            : null}
          ${status.label}
        </span>
      </div>
      <div class="research-panel-meta">
        <span>${docs.length} ${docNoun}</span>
        <span>·</span>
        <span>${steps} ${steps === 1 ? "step" : "steps"}</span>
        ${tokens > 0 ? html`<span>·</span><span>${formatTokenCount(tokens)} tok</span>` : null}
      </div>
      <div class="research-panel-docs">
        ${docs.length === 0
          ? html`<div class="research-panel-empty">
              ${status.cls === "running" ? "Gathering sources…" : "No documents."}
            </div>`
          : docs.map((doc) => html`<${ResearchDocChip} key=${doc.documentId} doc=${doc} />`)}
      </div>
      ${panel.summary
        ? html`<div class="research-panel-summary">${panel.summary}</div>`
        : null}
    </div>
  `;
}

/**
 * The multi-panel research working-set surface. Rendered by `AgentView`
 * only while `isResearchWorkspaceActive(state)` holds (a live Deep Research
 * run with ≥1 researcher); the view unmounts it when the run ends, so the
 * surface disappears once the answer is complete. `panels` is `researchPanels(state)` —
 * one descriptor per sub-agent, in spawn order.
 */
export function ResearchWorkspace({ panels }) {
  if (!panels || panels.length === 0) return null;
  return html`
    <section class="research-workspace" aria-label="Deep Research working set">
      <header class="research-workspace-head">
        <span class="research-workspace-pulse" aria-hidden="true"></span>
        <span class="research-workspace-title">Deep Research</span>
        <span class="research-workspace-sub">
          ${panels.filter((panel) => panel.status === "complete").length} of ${panels.length} complete
        </span>
      </header>
      <div class="research-workspace-rail">
        ${panels.map((panel) => html`<span class=${`research-worker research-worker-${researchPanelStatus(panel.status).cls}`} key=${panel.subagentId}>${panel.title || panel.specialist}</span>`)}
      </div>
    </section>
  `;
}

// ─── Ephemeral rolling-slot cards ────────────────────────────────────────
//
// `search_documents`, `fetch_document` and `run_sql` render as small
// fixed-height cards with a single rotating slot — items (result docs,
// document lines, SQL lines, SQL rows) cycle through at ~350ms per item,
// then the whole card fades out of the transcript. Mirrors
// `AgentEphemeralCards.swift` on iOS in look, timing, and behaviour.
//
// Constants. 350ms is the slot's slide duration AND the cadence between
// steps, so motion reads as one continuous marquee — no dead time
// between items. The 450ms hold after the last item gives the final
// row a moment to land before the card fades away.
//
// The `// PARITY:<key>` markers below bind these to their iOS + Android
// twins via scripts/check-parity.mjs (the parity-drift guard): a hand-edit
// that diverges one surface reddens CI. Change a value here AND in both
// other clients AND scripts/parity-constants.json in the same commit.
const EPHEMERAL_REVEAL_MS = 350; // PARITY:ephemeral-reveal-ms
const EPHEMERAL_HOLD_MS = 450; // PARITY:ephemeral-hold-ms
const EPHEMERAL_FADE_MS = 300; // PARITY:ephemeral-fade-ms
// Minimum time the card stays visible before it starts its fade-out,
// even when the reducer has buffered tail content that wants it gone.
// A card that pops in and out faster than this would read as a flash
// rather than a step in the agent's narration. Mirror this number on
// iOS (`agentEphemeralMinVisibleSeconds`).
const EPHEMERAL_MIN_VISIBLE_MS = 500; // PARITY:ephemeral-min-visible-ms
const EPHEMERAL_SLOT_HEIGHT = 18;
const EPHEMERAL_SQL_SLOT_HEIGHT = 16;
const EPHEMERAL_SQL_ROWS_MAX = 10;
// Caps on the per-card rotation length. The rolling slot is meant as
// a glance ("agent is reading this"), not an exhaustive replay — a
// 200-line PDF would otherwise roll for 70+ seconds. ~10 items keeps
// each card under ~4s of motion plus the post-roll hold + fade.
const EPHEMERAL_DOC_LINES_MAX = 10;
const EPHEMERAL_SEARCH_RESULTS_MAX = 12;
const EPHEMERAL_TRAIL_DOCS_MAX = 12;
// Same cap as the search card — `lookup_people` is a multi-candidate
// disambiguation surface, not an exhaustive directory listing. Matches
// `LOOKUP_PEOPLE_MAX_LIMIT` in @omnesis/agent; defense-in-depth here
// so a legacy transcript carrying more rows still renders sensibly.
const EPHEMERAL_PEOPLE_RESULTS_MAX = 12;

// ─── Thinking indicator ──────────────────────────────────────────────────
//
// The thinking block reuses the ephemeral cards' cadence: once the agent
// moves on from reasoning, hold a beat (so a quick thought doesn't flash),
// fade out over EPHEMERAL_FADE_MS, then unmount and leave nothing behind.
// Mirrors AgentThinkingBlock on iOS + Android in timing and behaviour.
const THINKING_HOLD_MS = EPHEMERAL_HOLD_MS;
const THINKING_FADE_MS = EPHEMERAL_FADE_MS;

// Quiet window the transcript must hold before the turn-level working dots reveal. Above the
// streaming-token cadence (each token re-arms the timer, so they never flash mid-stream) but short
// enough that the brief gaps a real turn leaves clear it and read as "still working". Mirrors the
// iOS `agentWorkingRevealDelayNs` and Android `WorkingRevealMs` (both 350ms).
const WORKING_INDICATOR_DEBOUNCE_MS = 350;

// Right-pointing chevron; CSS rotates it 90° (to point down) when the
// block is open. Replaces the native <details> disclosure marker so the
// row has no leading vertical rail.
const THINKING_CHEVRON = html`
  <svg class="agent-thinking-chevron" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

/**
 * Thinking indicator. Rendered for a `thinking` part only while it is the
 * live trailing part of an in-flight turn (`active`). The instant the agent
 * appends anything after it — another reasoning pass, a tool call, or the
 * answer text — or the turn ends, `active` flips false: the block holds for
 * a beat, fades out, then unmounts, leaving nothing in the transcript.
 *
 * Two invariants fall out of this:
 *   • never more than one on screen — each block is already fading by the
 *     time the next reasoning pass begins (they're always separated by a
 *     tool/text part, since consecutive thinking deltas coalesce);
 *   • resumed history shows none — the reducer drops thinking parts on
 *     hydration, and any thinking part that mounts already-inactive starts
 *     in the "gone" phase, so it renders nothing without a flash.
 */
function ThinkingBlock({ text, active }) {
  // "live" → visible + animating; "dismissing" → fading out; "gone" → null.
  const [phase, setPhase] = useState(active ? "live" : "gone");
  const holdTimerRef = useRef(null);
  const fadeTimerRef = useRef(null);

  useEffect(() => {
    if (active) {
      // (Re)activated: cancel any pending dismissal and show.
      if (holdTimerRef.current != null) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
      if (fadeTimerRef.current != null) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
      if (phase !== "live") setPhase("live");
      return;
    }
    // active === false. Only a block that is currently live runs the
    // dismiss lifecycle; one that was never live (resumed history) is
    // already "gone" and stays that way. Hold a beat (so a quick thought
    // doesn't flash), then fade out — same cadence as iOS + Android.
    if (phase !== "live") return;
    holdTimerRef.current = setTimeout(() => {
      setPhase("dismissing");
      fadeTimerRef.current = setTimeout(() => setPhase("gone"), THINKING_FADE_MS);
    }, THINKING_HOLD_MS);
  }, [active, phase]);

  // Release any in-flight timer before leaving the tree.
  useEffect(() => () => {
    if (holdTimerRef.current != null) clearTimeout(holdTimerRef.current);
    if (fadeTimerRef.current != null) clearTimeout(fadeTimerRef.current);
  }, []);

  if (phase === "gone") return null;
  const dismissing = phase === "dismissing";
  return html`
    <details class=${`agent-part-thinking${dismissing ? " is-dismissed" : ""}`}>
      <summary>
        ${THINKING_CHEVRON}
        <span class="agent-thinking-label">Thinking</span>
        <span class="agent-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      </summary>
      <div>${text}</div>
    </details>
  `;
}

/**
 * Turn-level "working" dots — the transcript's answer to "is anything still happening?" during the
 * beats where no per-item card carries its own affordance: a finished text block before the next
 * tool call, `message.start` before the first delta, or a completed tool / sub-agent before the
 * next step. Eligibility is the caller's job (`workingIndicatorActive`); this component owns the
 * DEBOUNCE — `rev` bumps on every streamed token, re-arming the reveal timer, so the dots surface
 * only after a genuine quiet gap and never flash mid-stream. Reuses the `.agent-typing` three-dot
 * markup + CSS the old always-on pill used. Mirrors the iOS `AgentWorkingIndicator` / Android
 * `WorkingDots` reveal.
 */
export function WorkingIndicator({ active, rev }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    // Any change — a new token bumps `rev`, or `active` flips — hides the dots and re-arms the
    // quiet timer; a real gap lets it run out and reveal. A streaming turn re-fires this effect on
    // every token, so the dots never reveal mid-stream. The returned cleanup cancels the pending
    // timer before the next run and on unmount.
    setRevealed(false);
    if (!active) return undefined;
    const timer = setTimeout(() => setRevealed(true), WORKING_INDICATOR_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, rev]);

  if (!revealed) return null;
  return html`<div class="agent-typing" role="status" aria-label="Working"><span></span><span></span><span></span></div>`;
}

/**
 * Fixed-height slot that scrolls a vertical stack of items upward at the
 * cadence interval. `currentIndex == null` parks the stack just below the
 * slot (nothing visible); 0…N-1 brings each item up into view in turn.
 * The slot is `overflow: hidden` so only the active item is visible; the
 * inner stack carries `translateY(-i * height)` driven by a CSS
 * transition so the motion itself is GPU-accelerated.
 */
function RollingSlot({ items, currentIndex, slotHeight, itemView }) {
  // currentIndex == null → stack starts one slot below (off-screen);
  // first step (i=0) translates by 0 → first item rolls into view.
  const offsetSlots = currentIndex == null ? 1 : -currentIndex;
  const transform = `translateY(${offsetSlots * slotHeight}px)`;
  return html`
    <div class="agent-ephemeral-slot" style=${`height:${slotHeight}px`}>
      <div class="agent-ephemeral-stack"
           style=${`transform:${transform};transition:transform ${EPHEMERAL_REVEAL_MS}ms linear`}>
        ${items.map((item, i) => html`
          <div key=${i} class="agent-ephemeral-row" style=${`height:${slotHeight}px`}>
            ${itemView(item)}
          </div>
        `)}
      </div>
    </div>
  `;
}

/**
 * Whether the tool call has produced ANY result yet — success OR error.
 *
 * Every ephemeral card runs exactly one dismiss lifecycle per tool call,
 * and it MUST run for every result the tool emits, not just the
 * success-shaped one. The reducer's causality gate
 * (`findActiveGateIndex` in `views/agent-reducer.js`) activates the
 * moment a tool part has *any* result and holds back all following text
 * until the card dispatches `ephemeral-tail-flush` at the end of its
 * fade-out. A tool that fails returns the shared `{ kind: "error" }`
 * result — if the card keyed its spinner + rotation off its
 * success-kind check (`result.kind === "sql.rows"`, …) instead, an
 * error result would leave the card spinning forever and the buffered
 * text would never flush. So the spinner and the rotation's `ready`
 * gate track "a result arrived" (this predicate); the per-card
 * success-kind check only decides whether there are rows/results to
 * roll through.
 */
export function ephemeralResultArrived(call) {
  return call?.result != null;
}

/**
 * Drives a rolling-slot rotation: holds the slot empty until `ready` is
 * true, then steps `currentIndex` from 0…N-1 at EPHEMERAL_REVEAL_MS each,
 * holds for EPHEMERAL_HOLD_MS, fades the card, then removes its rendered
 * DOM node so the transcript flex gap also disappears. Returns
 * `{ currentIndex, phase }`. The `count` and `ready` flags are captured
 * by ref so a late-arriving result (after
 * the empty-state dismiss fired) doesn't re-trigger the rotation.
 *
 * Causality contract — when the reducer parks new content on this
 * card's `pendingTail`, the parent flips `expedite` true. The hook
 * cancels the natural-flow dismiss timer and re-schedules it to fire
 * at `max(0, EPHEMERAL_MIN_VISIBLE_MS − elapsed)` from now, so the
 * card is never seen for less than 500ms (avoid flashes) but never
 * holds longer than that once the agent is ready to keep talking.
 * The fade-out is unchanged (300ms via CSS); `onDone` fires AFTER
 * the fade completes so the caller can dispatch `ephemeral-tail-flush`.
 */
function useRollingRotation(ready, count, options) {
  const expedite = options?.expedite ?? false;
  const onDone = options?.onDone;
  const [currentIndex, setCurrentIndex] = useState(null);
  const [phase, setPhase] = useState("live");
  const startedRef = useRef(false);
  const startedAtRef = useRef(0);
  const revealTimersRef = useRef([]);
  // `dismissTimerRef.current` holds whichever dismiss timer is currently
  // armed (natural-flow or expedited). Re-arming clears the prior one
  // first so the dismiss fires exactly once.
  const dismissTimerRef = useRef(null);
  const fadeTimerRef = useRef(null);

  function fireDismiss() {
    setPhase("dismissing");
    fadeTimerRef.current = setTimeout(() => {
      setPhase("gone");
      onDone?.();
    }, EPHEMERAL_FADE_MS);
  }

  function scheduleDismiss(delayMs) {
    if (dismissTimerRef.current != null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (delayMs <= 0) {
      fireDismiss();
    } else {
      dismissTimerRef.current = setTimeout(fireDismiss, delayMs);
    }
  }

  // Natural-flow start. Fires once when `ready` flips true.
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    startedAtRef.current = Date.now();
    if (count === 0) {
      scheduleDismiss(EPHEMERAL_HOLD_MS + EPHEMERAL_REVEAL_MS);
      return;
    }
    for (let i = 0; i < count; i++) {
      revealTimersRef.current.push(
        setTimeout(() => setCurrentIndex(i), i * EPHEMERAL_REVEAL_MS),
      );
    }
    scheduleDismiss(count * EPHEMERAL_REVEAL_MS + EPHEMERAL_HOLD_MS);
    // `ready` + `count` are deliberately the only deps — the rotation
    // should kick off exactly once when the result lands, not restart
    // if the parent re-renders with the same values.
  }, [ready, count]);

  // Expedite reaction. The reducer's gate set this true; collapse the
  // remaining display time to whatever brings total visible time to
  // exactly EPHEMERAL_MIN_VISIBLE_MS (or 0 if we're already past).
  useEffect(() => {
    if (!expedite || !startedRef.current || phase !== "live") return;
    const elapsed = Date.now() - startedAtRef.current;
    const remaining = EPHEMERAL_MIN_VISIBLE_MS - elapsed;
    scheduleDismiss(remaining);
  }, [expedite, phase]);

  // Unmount cleanup. Any in-flight timer must release before the
  // component leaves the tree so we never call `setState` on an
  // unmounted instance.
  useEffect(() => () => {
    for (const t of revealTimersRef.current) clearTimeout(t);
    if (dismissTimerRef.current != null) clearTimeout(dismissTimerRef.current);
    if (fadeTimerRef.current != null) clearTimeout(fadeTimerRef.current);
  }, []);

  return { currentIndex, phase };
}

/**
 * Shared chrome: leading 2px accent rail, 8px gap to content, no border
 * or bg fill. Reads as "the agent is currently doing something here"
 * without the visual weight of a bordered card. The dismissing phase fades
 * and collapses it; the gone phase removes the flex child and its parent gap.
 */
function EphemeralCard({ phase, children }) {
  if (phase === "gone") return null;
  return html`
    <div class=${`agent-ephemeral${phase === "dismissing" ? " is-dismissed" : ""}`}>
      ${children}
    </div>
  `;
}

function EphemeralHeader({ glyph, label, monospaceArg, headerExtra, showSpinner, trailing }) {
  return html`
    <div class="agent-ephemeral-header">
      <span class="agent-ephemeral-glyph" aria-hidden="true">${glyph}</span>
      <span class="agent-ephemeral-label">${label}</span>
      ${monospaceArg
        ? html`<code class="agent-ephemeral-arg">${monospaceArg}</code>`
        : null}
      ${headerExtra ?? null}
      ${showSpinner
        ? html`<span class="agent-ephemeral-spinner" aria-hidden="true"></span>`
        : null}
      ${trailing ?? null}
    </div>
  `;
}

/**
 * Opt-in right-hand side of a tool card header: the call's instant and a mini
 * icon opening the full payload in an overlay. Both ride on the part
 * (`call.timeText`, `call.rawPayload`) and both are absent by default, so the
 * live agent and cognition views render exactly as before. After-the-fact
 * surfaces (the Direct audit transcript) set them to timestamp every call
 * without a nested expand step and to keep the exact bytes one click away.
 */
function ToolCardTrailing({ timeText, rawTitle, rawPayload }) {
  const [rawOpen, setRawOpen] = useState(false);
  if (timeText == null && rawPayload === undefined) return null;
  return html`<span class="agent-ephemeral-trailing">
    ${timeText != null ? html`<span class="agent-ephemeral-time">${timeText}</span>` : null}
    ${rawPayload !== undefined
      ? html`<button
          type="button"
          class="agent-ephemeral-raw"
          aria-label="Show raw JSON"
          title="Show raw JSON"
          onClick=${() => setRawOpen(true)}
        ><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 3.5 L2.5 8 L6 12.5" />
          <path d="M10 3.5 L13.5 8 L10 12.5" />
        </svg></button>
        <${Modal}
          open=${rawOpen}
          onClose=${() => setRawOpen(false)}
          title=${rawTitle ?? "Raw tool payload"}
          size="lg"
        ><pre class="agent-raw-json">${JSON.stringify(rawPayload, null, 2) ?? "null"}</pre><//>`
      : null}
  </span>`;
}

function EphemeralSearchCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "search.results";
  const resultArrived = ephemeralResultArrived(call);
  const results = hasResult
    ? (call.result.results || []).slice(0, EPHEMERAL_SEARCH_RESULTS_MAX)
    : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, results.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const query = call.args?.query || call.argsSummary || "";
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${SEARCH_GLYPH}
        label="Search"
        monospaceArg=${query}
        showSpinner=${!resultArrived}
      />
      ${hasResult && results.length > 0
        ? html`<${RollingSlot}
            items=${results}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(ref) => html`
              <div class="agent-ephemeral-result">
                <span class="agent-ephemeral-result-icon">${sourceIcon(ref.sourceId, { size: 11 })}</span>
                <span class="agent-ephemeral-result-title">${ref.title || "Untitled"}</span>
                ${loopChip(ref)}
              </div>
            `}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * `trace_connections` rolling card — same shape as `EphemeralSearchCard`,
 * but the items are the documents the walk reached (top-level events plus
 * their attachments, flattened, deduped by documentId). Seeds and depth
 * are deliberately suppressed: they're low-level args the user doesn't
 * need to see. The label "Trace connections" pairs with the same
 * icon + title row format the search card uses, so the agent's tool
 * cards read as one coherent visual family.
 */
function EphemeralTrailCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "event_trail.built";
  const resultArrived = ephemeralResultArrived(call);
  const docs = hasResult ? flattenTrailDocs(call.result.events ?? []) : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, docs.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${TRAIL_GLYPH}
        label="Trace connections"
        showSpinner=${!resultArrived}
      />
      ${hasResult && docs.length > 0
        ? html`<${RollingSlot}
            items=${docs}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(doc) => html`
              <div class="agent-ephemeral-result">
                <span class="agent-ephemeral-result-icon">${sourceIcon(doc.sourceId, { size: 11 })}</span>
                <span class="agent-ephemeral-result-title">${doc.title || "Untitled"}</span>
              </div>
            `}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * Flatten a trail's `events[]` (each with nested `attachments[]`) into
 * a single list of `{ documentId, title, sourceId }` rows for the
 * rolling slot. Walks in chronological order — top-level events plus
 * their attachments — and deduplicates by documentId so the same doc
 * appearing as both a top-level event and an attachment of another
 * doesn't roll twice. Capped at `EPHEMERAL_TRAIL_DOCS_MAX` per the
 * card's "glance, not exhaustive replay" rule.
 */
function flattenTrailDocs(events) {
  const out = [];
  const seen = new Set();
  function push(doc) {
    if (!doc || !doc.documentId || seen.has(doc.documentId)) return;
    seen.add(doc.documentId);
    out.push({ documentId: doc.documentId, title: doc.title, sourceId: doc.sourceId });
  }
  for (const event of events) {
    push(event?.doc);
    for (const attachment of event?.attachments ?? []) {
      push(attachment?.doc);
    }
    if (out.length >= EPHEMERAL_TRAIL_DOCS_MAX) break;
  }
  return out.slice(0, EPHEMERAL_TRAIL_DOCS_MAX);
}

function EphemeralDocumentCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "document";
  const resultArrived = ephemeralResultArrived(call);
  const docRef = hasResult ? call.result.ref : null;
  const content = hasResult ? (call.result.document?.content ?? "") : "";
  // Skip blank lines: an empty slot would flash a void frame and break
  // the cadence. Matches iOS's `filter { !$0.trimmingCharacters(...).isEmpty }`.
  const lines = content
    ? content
        .split("\n")
        .map((s) => s)
        .filter((s) => s.trim().length > 0)
        .slice(0, EPHEMERAL_DOC_LINES_MAX)
    : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, lines.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const titleNode = docRef
    ? html`<span class="agent-ephemeral-doc-title">
        <span class="agent-ephemeral-result-icon">${sourceIcon(docRef.sourceId, { size: 11 })}</span>
        <span>${docRef.title || "Untitled"}</span>
        ${loopChip(docRef)}
      </span>`
    : null;
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${DOC_GLYPH}
        label="Open document"
        headerExtra=${titleNode}
        showSpinner=${!resultArrived}
      />
      ${hasResult && lines.length > 0
        ? html`<${RollingSlot}
            items=${lines}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
            itemView=${(line) => html`
              <div class="agent-ephemeral-doc-line">${line}</div>
            `}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * `search_loops` rolling card — the chat agent read the background agent's
 * tracked obligations (read-only). Same rolling-slot shape as the document
 * search card; each item is a loop's state pill + title.
 */
function EphemeralLoopSearchCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "loops.searched";
  const resultArrived = ephemeralResultArrived(call);
  const loops = hasResult
    ? (call.result.loops || []).slice(0, EPHEMERAL_SEARCH_RESULTS_MAX)
    : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, loops.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const query = call.args?.query || call.argsSummary || "";
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${LOOP_GLYPH}
        label="Search loops"
        monospaceArg=${query}
        showSpinner=${!resultArrived}
      />
      ${hasResult && loops.length > 0
        ? html`<${RollingSlot}
            items=${loops}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(loop) => loopRow(loop)}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * `fetch_loop` rolling card — one loop opened in full (read-only). Header
 * carries the loop's state pill + title; the rolling body streams its detail
 * lines (deadline, people, description). An absent loop is a clean no-match.
 */
function EphemeralLoopFetchCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "loop.fetched";
  const resultArrived = ephemeralResultArrived(call);
  const loop = hasResult ? call.result.loop : null;
  const lines = loop ? loopDetailLines(loop) : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, lines.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const titleNode = loop
    ? html`<span class="agent-ephemeral-doc-title">
        <span class="agent-loop-state agent-loop-state-${loop.state}">${loop.state}</span>
        <span>${loop.title || "Untitled loop"}</span>
      </span>`
    : hasResult
      ? html`<span class="agent-loops-empty">No such loop</span>`
      : null;
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${LOOP_GLYPH}
        label="Open loop"
        headerExtra=${titleNode}
        showSpinner=${!resultArrived}
      />
      ${hasResult && lines.length > 0
        ? html`<${RollingSlot}
            items=${lines}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
            itemView=${(line) => html`<div class="agent-ephemeral-doc-line">${line}</div>`}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * SQL card — two sequential rotations:
 *   1. SQL query lines (kicks off as soon as args land — does NOT wait
 *      for the result).
 *   2. Result rows (kicks off after the SQL rotation has finished AND
 *      the result has arrived). Column headers stay pinned above the
 *      rotating value row. Caps at 10 rows.
 * The card then fades away. If args never land before the result
 * (unusual), the SQL rotation is skipped and we go straight to rows.
 */
function EphemeralSqlCard({ call, dispatch }) {
  const sqlText = typeof call.args?.sql === "string" ? call.args.sql : "";
  // Collapse the query to a single line so the SQL phase ticks once
  // (~350ms) instead of one tick per source line. Visual truncation
  // handles overflow; the full query is still in the persisted history.
  const sqlLines = sqlText.trim()
    ? [sqlText.replace(/\s+/g, " ").trim()]
    : [];
  const argsKnown = sqlText.length > 0;
  const hasResult = call.result?.kind === "sql.rows";
  const resultArrived = ephemeralResultArrived(call);
  const columns = hasResult ? (call.result.columns || []) : [];
  const allRows = hasResult ? (call.result.rows || []).slice(0, EPHEMERAL_SQL_ROWS_MAX) : [];
  // Source attribution + friendly table names come from the analytics
  // catalog server-side (and from the replay fixture for synthetic
  // conversations) — both paths put them on `result.sources` /
  // `result.subjects` so this renderer stays source-agnostic.
  const sources = hasResult ? (call.result.sources || []) : [];
  const subjects = hasResult ? (call.result.subjects || []) : [];
  const headerExtra = (sources.length > 0 || subjects.length > 0)
    ? html`<span class="agent-ephemeral-sql-subject">
        ${sources.map((s) => html`
          <span key=${s.sourceId} class="agent-ephemeral-result-icon">${sourceIcon(s.sourceId, { size: 11 })}</span>
        `)}
        ${subjects.length > 0
          ? html`<span class="agent-ephemeral-sql-subject-text">${subjects.join(" + ")}</span>`
          : null}
      </span>`
    : null;

  // Stage 1: SQL rotation. Starts the moment args arrive.
  const [sqlIndex, setSqlIndex] = useState(null);
  const [sqlDone, setSqlDone] = useState(false);
  const sqlStartedRef = useRef(false);
  useEffect(() => {
    if (!argsKnown || sqlStartedRef.current) return;
    sqlStartedRef.current = true;
    if (sqlLines.length === 0) { setSqlDone(true); return; }
    const timers = [];
    for (let i = 0; i < sqlLines.length; i++) {
      timers.push(setTimeout(() => setSqlIndex(i), i * EPHEMERAL_REVEAL_MS));
    }
    timers.push(setTimeout(() => setSqlDone(true), sqlLines.length * EPHEMERAL_REVEAL_MS));
    return () => { for (const t of timers) clearTimeout(t); };
  }, [argsKnown, sqlLines.length]);

  // Stage 2: row rotation. Waits for both the result AND `sqlDone`. Keys
  // off `resultArrived` (any result, incl. an error) — not the
  // success-only `hasResult` — so an errored query still completes its
  // dismiss lifecycle and flushes the reducer's causality gate.
  const rowsReady = resultArrived && sqlDone;
  const { currentIndex: rowIndex, phase } = useRollingRotation(rowsReady, allRows.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });

  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${SQL_GLYPH}
        label="Run SQL"
        headerExtra=${headerExtra}
        showSpinner=${!resultArrived}
      />
      ${sqlLines.length > 0
        ? html`<${RollingSlot}
            items=${sqlLines}
            currentIndex=${sqlIndex}
            slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
            itemView=${(line) => html`
              <code class="agent-ephemeral-sql-line">${line || " "}</code>
            `}
          />`
        : null}
      ${hasResult && allRows.length > 0 && columns.length > 0
        ? html`
          <div class="agent-ephemeral-sql-rowblock">
            <div class="agent-ephemeral-sql-cols">
              ${columns.map((c, j) => html`<span key=${j} class="agent-ephemeral-sql-col">${c}</span>`)}
            </div>
            <${RollingSlot}
              items=${allRows}
              currentIndex=${rowIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(row) => html`
                <div class="agent-ephemeral-sql-row">
                  ${normaliseRow(row, columns.length).map((cell, j) => html`
                    <span key=${j} class="agent-ephemeral-sql-cell">${formatSqlCell(cell)}</span>
                  `)}
                </div>
              `}
            />
          </div>
        `
        : null}
    </${EphemeralCard}>
  `;
}

function normaliseRow(row, n) {
  if (!Array.isArray(row)) return new Array(n).fill(null);
  if (row.length === n) return row;
  if (row.length > n) return row.slice(0, n);
  return row.concat(new Array(n - row.length).fill(null));
}

function formatSqlCell(v) {
  if (v == null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  // DuckDB date/timestamp objects round-trip as { days } / { micros }.
  if (typeof v === "object") {
    if (v.days != null && Object.keys(v).length === 1) {
      const d = new Date(v.days * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    if (v.micros != null && Object.keys(v).length === 1) {
      const d = new Date(v.micros / 1000);
      return d.toISOString().replace("T", " ").slice(0, 16);
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * People card — fuzzy `lookup_people` result. Mirrors `EphemeralSearchCard`
 * structurally: one row per candidate scrolls through a single slot at
 * the cadence interval, then the whole card fades. Each row shows the
 * person's display name + their primary alias (preferring email — the
 * thing the agent will most often use as a `from:`/`to:` filter in a
 * follow-up search).
 */
function EphemeralPeopleCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "person.results";
  const resultArrived = ephemeralResultArrived(call);
  const results = hasResult
    ? (call.result.results || []).slice(0, EPHEMERAL_PEOPLE_RESULTS_MAX)
    : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, results.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const query = call.args?.query || call.argsSummary || "";
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${PEOPLE_GLYPH}
        label="Find people"
        monospaceArg=${query}
        showSpinner=${!resultArrived}
      />
      ${hasResult && results.length > 0
        ? html`<${RollingSlot}
            items=${results}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(person) => html`
              <div class="agent-ephemeral-people-row">
                <span class="agent-ephemeral-people-name">${person.displayName}</span>
                ${primaryAliasFor(person)
                  ? html`<code class="agent-ephemeral-people-alias">${primaryAliasFor(person)}</code>`
                  : null}
              </div>
            `}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

/**
 * Pick the most agent-useful alias to show alongside the display name.
 * The aliases array comes from the gateway already ordered
 * email → phone → handle → name (see
 * `listMergedAliasesForPerson` in `PersonRepository.ts`), so the
 * first entry is always the most useful for the follow-up `from:` /
 * `to:` filter. Returns `""` (not `null`) when the candidate has no
 * aliases — the row collapses to just the display name in that case.
 */
function primaryAliasFor(person) {
  const aliases = Array.isArray(person?.aliases) ? person.aliases : [];
  return aliases[0] ?? "";
}

/**
 * URL-lookup card — `lookup_document_by_url` returns 0..1 docs. We
 * render it as a single-slot rolling card: one row carrying the
 * matched doc's source icon + title (just like a single search
 * result), or a "no match" row when the URL points outside the
 * corpus. Same rhythm as the search/people cards — fades after the
 * roll completes.
 */
function EphemeralUrlLookupCard({ call, dispatch }) {
  const hasResult = call.result?.kind === "document.byUrl";
  const resultArrived = ephemeralResultArrived(call);
  const ref = hasResult ? call.result.ref ?? null : null;
  // Build a single-item slot — one row of "ref" (the matched doc) OR
  // one row of "no-match" (URL not in corpus). The tagged shape keeps
  // the renderer's branch explicit instead of hiding it behind an
  // `??` fallback, and mirrors `AgentEphemeralUrlLookupCard.SlotItem`
  // on iOS.
  const items = hasResult
    ? [ref ? { kind: "ref", ref } : { kind: "no-match" }]
    : [];
  const { currentIndex, phase } = useRollingRotation(resultArrived, items.length, {
    expedite: (call.pendingTail?.length ?? 0) > 0,
    onDone: () => dispatch?.({ kind: "ephemeral-tail-flush", toolCallId: call.toolCallId }),
  });
  const url = call.args?.url || call.argsSummary || "";
  return html`
    <${EphemeralCard} phase=${phase}>
      <${EphemeralHeader}
        glyph=${LINK_GLYPH}
        label="Lookup URL"
        monospaceArg=${url}
        showSpinner=${!resultArrived}
      />
      ${hasResult && items.length > 0
        ? html`<${RollingSlot}
            items=${items}
            currentIndex=${currentIndex}
            slotHeight=${EPHEMERAL_SLOT_HEIGHT}
            itemView=${(item) => item.kind === "ref"
              ? html`
                  <div class="agent-ephemeral-result">
                    <span class="agent-ephemeral-result-icon">${sourceIcon(item.ref.sourceId, { size: 11 })}</span>
                    <span class="agent-ephemeral-result-title">${item.ref.title || "Untitled"}</span>
                  </div>
                `
              : html`<div class="agent-ephemeral-url-nomatch">No match in your corpus</div>`}
          />`
        : null}
    </${EphemeralCard}>
  `;
}

// Compact accent-tinted glyphs for the card headers. SVG over emoji so
// they pick up `currentColor` and scale crisply at 10px. The
// magnifying-glass / doc / table / people / link icons mirror iOS's
// SF Symbols choices.
const SEARCH_GLYPH = html`
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
`;
const DOC_GLYPH = html`
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
    <path d="M6 8h4 M6 11h4" />
  </svg>
`;
const SQL_GLYPH = html`
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.5h12 M2 9.5h12 M6 3v10 M10 3v10" />
  </svg>
`;
// Three dots connected by a path — pairs with the "Trace connections"
// label and mirrors `point.3.connected.trianglepath.dotted` used as
// the Timeline-empty glyph on iOS.
const TRAIL_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="3.5" cy="4" r="1.5" />
    <circle cx="12.5" cy="4" r="1.5" />
    <circle cx="8" cy="12" r="1.5" />
    <path d="M4.8 5 7 10.7 M11.2 5 9 10.7" />
  </svg>
`;
const BOLT_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"
       aria-hidden="true">
    <path d="M9.5 1.5L3 9h4.2l-.7 5.5L13 7H8.8z" />
  </svg>
`;
const PEOPLE_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" />
    <path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
    <circle cx="11" cy="5.5" r="2" />
    <path d="M10 9.2c2 .2 3.5 1.9 3.5 3.8" />
  </svg>
`;
const LINK_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6.5 9.5L9.5 6.5" />
    <path d="M7.5 4.5L9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5" />
    <path d="M8.5 11.5L7 13a2.8 2.8 0 0 1-4-4l1.5-1.5" />
  </svg>
`;
const LOOP_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 8a5 5 0 0 1 8.6-3.5L13 6" />
    <path d="M13 3.5V6h-2.5" />
    <path d="M13 8a5 5 0 0 1-8.6 3.5L3 10" />
    <path d="M3 12.5V10h2.5" />
  </svg>
`;

// ─── Watch-action card ───────────────────────────────────────────────────
//
// Surfaced inline in the transcript whenever the agent writes a watch. Mirrors
// the iOS AgentWatchCard view so the same action reads the same way on both
// surfaces.
function WatchActionCard({ call }) {
  const result = call.result;
  if (!result) {
    // Pre-result stub: agent has opened the tool block but the result
    // hasn't landed yet. Show a quiet placeholder rather than nothing
    // so the user sees "something is happening".
    return html`
      <div class="agent-watch-card agent-watch-card-pending">
        <span class="agent-watch-icon">${BOLT_GLYPH}</span>
        <span class="agent-watch-title">Setting up watch…</span>
      </div>
    `;
  }
  if (result.kind === "error") {
    return html`<${ToolErrorCard} code=${result.code} message=${result.message} />`;
  }
  let verb;
  let watchName;
  let summary;
  let watchId;
  if (result.kind === "watch.upserted") {
    verb = result.action === "created" ? "Created watch" : "Updated watch";
    watchName = result.name;
    summary = result.summary;
    watchId = result.watchId;
  } else if (result.kind === "trigger.toggled") {
    // Cards from conversations stored before the rename. Rendered rather than
    // dropped: a stored transcript is still the user's.
    verb = result.enabled ? "Enabled watch" : "Disabled watch";
    watchName = result.name;
    summary = undefined;
    watchId = result.triggerId;
  } else if (result.kind === "trigger.upserted") {
    // A card from a stored conversation, written before the result was
    // renamed. Rendered rather than dropped: the conversation is still the
    // user's, and it still describes a watch they asked for.
    verb = result.action === "created" ? "Created watch" : "Updated watch";
    watchName = result.name;
    summary = result.summary;
    watchId = result.triggerId;
  } else {
    return null;
  }
  // Whole card is a tappable button — taps anywhere open the watch the agent
  // just set up, so the user can read what it will do and stop it if that is
  // not what they meant. A left-click runs the SPA `navigate(...)` to avoid a
  // full page reload; Cmd/Ctrl/middle-click fall back to the browser's default
  // (open in new tab) by not preventing it.
  //
  // The id is the watch's own identity and survives a rewrite, so the link
  // keeps resolving after the agent revises the watch later in the conversation.
  // A toggle reports no id, and lands on the list instead.
  const href = watchId ? `/portal/watches/${encodeURIComponent(watchId)}` : "/portal/watches";
  function onClick(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    navigate(href);
  }
  return html`
    <a class="agent-watch-card agent-watch-card-link"
       href=${href}
       onClick=${onClick}
       aria-label=${`${verb} ${watchName} — open Watches`}>
      <span class="agent-watch-icon">${BOLT_GLYPH}</span>
      <div class="agent-watch-body">
        <div class="agent-watch-title">
          ${verb} <span class="agent-watch-name">${watchName}</span>
        </div>
        ${summary ? html`<div class="agent-watch-summary">${summary}</div>` : null}
      </div>
    </a>
  `;
}

// ─── Citation count chip (assistant turn footer) ─────────────────────────
//
// Tiny pill rendered at the bottom of an assistant bubble when the turn
// produced ≥1 cite tool call. Click scrolls the citations sidebar into
// view — useful on mobile widths where the panel is below the fold.

/**
 * Inline "Citing N document(s)" pill rendered at the lead slot of a
 * run of pending annotate calls. A small pulsing accent dot + muted
 * label, sized to read as a soft interjection in the middle of the
 * agent's prose rather than as another action card. The count grows
 * as more annotate calls land in the same run, and shrinks back to
 * zero (the pill disappears) the moment the last annotate resolves.
 */
function CitingPill({ count }) {
  const n = Math.max(1, count ?? 1);
  // "source" covers both citation kinds — a document (`annotate`) and a DuckDB
  // row (`cite_record`, #757) — which coalesce into one pill.
  const label = `Citing ${n} source${n === 1 ? "" : "s"}`;
  return html`
    <div class="agent-citing-pill" role="status" aria-label=${label}>
      <span class="agent-citing-pill-dot" aria-hidden="true"></span>
      <span class="agent-citing-pill-label">${label}</span>
    </div>
  `;
}

function CitationCountChip({ count }) {
  function onClick() {
    const panel = typeof document !== "undefined" && document.querySelector(".agent-cite");
    panel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  return html`
    <button type="button" class="agent-cite-chip" onClick=${onClick}
            title="Jump to citations" aria-label=${`${count} citation${count === 1 ? "" : "s"}`}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 5h3v3H5z M5 8v2c0 1 .5 2 2 2" />
        <path d="M10 5h3v3h-3z M10 8v2c0 1 .5 2 2 2" />
      </svg>
      <span>${count} citation${count === 1 ? "" : "s"}</span>
    </button>
  `;
}

// ─── Tool-call chip + result ─────────────────────────────────────────────

function ToolCallChip({ call }) {
  // search_documents, fetch_document, run_sql, lookup_people, and
  // trace_connections are routed to ephemeral rolling-slot cards upstream
  // in `agentPartView` and never reach here. Anything that lands in this
  // chip is a non-ephemeral tool (annotate, cite_record, …) — show a
  // standard header + result body.
  //
  // While `tool.input_start` has fired but `tool.start` hasn't (args
  // still streaming) we say "building query…"; once args arrive but
  // the tool is still running we say "running…".
  const argsResolved = call.args != null;
  const pendingLabel = argsResolved ? "running…" : "building query…";
  // As in StaticToolCard: the stateful trailing affordances only enter the
  // tree when set, so existing surfaces render exactly as before.
  const trailing =
    call.timeText != null || call.rawPayload !== undefined
      ? html`<${ToolCardTrailing}
          timeText=${call.timeText ?? null}
          rawTitle=${`${prettyToolName(call.tool)} — raw JSON`}
          rawPayload=${call.rawPayload}
        />`
      : null;
  return html`
    <div class="agent-toolcall">
      <div class="agent-toolcall-header">
        <span class="agent-toolcall-tool">${prettyToolName(call.tool)}</span>
        ${call.argsSummary
          ? html`<code class="agent-toolcall-args">${call.argsSummary}</code>`
          : null}
        ${call.result != null
          ? (call.durationMs != null
              ? html`<span class="agent-toolcall-duration">${call.durationMs}ms</span>`
              : null)
          : html`<span class="agent-toolcall-duration agent-toolcall-running">${pendingLabel}</span>`}
        ${trailing}
      </div>
      ${call.result ? renderToolResult(call.result) : null}
    </div>
  `;
}

function prettyToolName(tool) {
  switch (tool) {
    case "trace_connections": return "Trace connections";
    default:                  return tool;
  }
}

function renderToolResult(result) {
  if (!result) return null;
  switch (result.kind) {
    case "event_trail.built":
      // Full Timeline rendering lives behind the side-panel toggle.
      // Inline we surface a one-line summary so the user can see the
      // tool fired and roughly how many events it covers.
      return html`<${EventTrailSummary} result=${result} />`;
    case "error":
      return html`<${ToolErrorCard} code=${result.code} message=${result.message} />`;
    default:
      return null;
  }
}

/** One loop row for a loop-search card: a state pill + the loop title. */
function loopRow(loop) {
  const inner = html`
    <span class="agent-loop-state agent-loop-state-${loop.state}">${loop.state}</span>
    <span class="agent-loop-title">${loop.title || "Untitled loop"}</span>`;
  return loop?.loopId
    ? html`<a
        class="agent-loop-row agent-ephemeral-result-link"
        href=${loopHref(loop.loopId)}
        onClick=${transcriptLinkNav(loopHref(loop.loopId))}
      >${inner}</a>`
    : html`<div class="agent-loop-row">${inner}</div>`;
}

// The fetched-loop header: state pill + title, linked to the loop page.
// Accepts both the interactive shape ({loopId}) and the steward fetch
// shape ({loopId} or {id}).
function loopHeaderExtra(loop) {
  const opened = html`
    <span class="agent-loop-state agent-loop-state-${loop.state}">${loop.state}</span>
    <span>${loop.title || "Untitled loop"}</span>`;
  const id = loop.loopId ?? loop.id;
  return id
    ? html`<a
        class="agent-ephemeral-doc-title agent-ephemeral-result-link"
        href=${loopHref(id)}
        onClick=${transcriptLinkNav(loopHref(id))}
      >${opened}</a>`
    : html`<span class="agent-ephemeral-doc-title">${opened}</span>`;
}

// One linked row per loop summary, capped like the search-result rows.
function loopResultRows(loops) {
  const list = Array.isArray(loops) ? loops : [];
  return list.slice(0, EPHEMERAL_SEARCH_RESULTS_MAX).map((l) => loopRow(l));
}

// The entity_context reap result grouped by kind: documents, people and
// loops link to their pages like the singular-tool rows; annotation
// sentences have no single target and read as plain rows.
function neighborhoodRows(data) {
  const rows = [];
  const docs = Array.isArray(data?.documents) ? data.documents : [];
  for (const d of docs) {
    rows.push(
      staticResultRow(
        sourceIcon(d.sourceId, { size: 11 }),
        d.title,
        d.documentId ? docHref(d.documentId) : null,
      ),
    );
  }
  const people = Array.isArray(data?.people) ? data.people : [];
  for (const p of people) {
    rows.push(staticResultRow(PEOPLE_GLYPH, p.name, p.personId ? personHref(p.personId) : null));
  }
  const loops = Array.isArray(data?.loops) ? data.loops : [];
  for (const l of loops) rows.push(loopRow(l));
  const annotations = Array.isArray(data?.temporalAnnotations) ? data.temporalAnnotations : [];
  for (const a of annotations) {
    rows.push(staticResultRow(null, a.sentence || "Untitled moment"));
  }
  return rows.slice(0, EPHEMERAL_SEARCH_RESULTS_MAX);
}

/** The detail lines for one fetched loop (deadline, people, description). */
function loopDetailLines(loop) {
  const lines = [];
  if (loop.deadline) lines.push(`Due: ${loop.deadline}`);
  const actors = Array.isArray(loop.actors) ? loop.actors.filter(Boolean) : [];
  if (actors.length) lines.push(`Actors: ${actors.join(", ")}`);
  if (loop.description) lines.push(loop.description);
  return lines;
}

/**
 * A tiny "in N loop(s)" pill for a document row when the Cognition Steward tracks open
 * loops that document is a source for (experimental). Returns null otherwise.
 */
function loopChip(ref) {
  const loops = Array.isArray(ref?.openLoops) ? ref.openLoops : [];
  if (loops.length === 0) return null;
  const titles = loops.map((l) => l.title).filter(Boolean).join(" · ");
  return html`<span class="agent-loop-chip" title=${titles}>🔗 ${loops.length}</span>`;
}

function EventTrailSummary({ result }) {
  const count = Array.isArray(result?.events) ? result.events.length : 0;
  const noun = count === 1 ? "event" : "events";
  return html`
    <div class="agent-event-trail-summary">
      <span class="agent-event-trail-summary-label">trace_connections · ${count} ${noun}</span>
      ${result?.truncated
        ? html`<span class="agent-event-trail-summary-trunc">(truncated)</span>`
        : null}
    </div>
  `;
}

// ─── Collapsed error card — one-line muted-red summary, expandable ──────
//
// Replaces the always-visible red error block. Tool failures (SQL binder
// errors, transient fetch_document misses, …) are interesting for
// debugging but noisy in the answer flow — most of the time the agent
// recovers on the next call. Collapsed by default; click to read the
// full message.

function ToolErrorCard({ code, message }) {
  const first = firstLine(message);
  const multi = message && message !== first;
  return html`
    <details class="agent-tool-error">
      <summary class="agent-tool-error-summary">
        <span class="agent-tool-error-code">${code}</span>
        <span class="agent-tool-error-msg">${first}</span>
        ${multi ? html`<svg class="agent-tool-error-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4 L5 7 L8 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>` : null}
      </summary>
      ${multi ? html`<pre class="agent-tool-error-body">${message}</pre>` : null}
    </details>
  `;
}

function firstLine(s) {
  const str = typeof s === "string" ? s : String(s ?? "");
  if (!str) return "";
  const i = str.indexOf("\n");
  return i < 0 ? str : str.slice(0, i);
}

// ─── Timeline panel ─────────────────────────────────────────────────────
//
// The agent drawer's single reference surface — a chronological list of
// every document the agent has referenced in the current conversation.
// Built from two sources, rendered identically:
//
//   • Every `event_trail.built` result merged into one event set (dedup
//     by documentId, most-recent trail wins on metadata).
//   • Every `annotate(documentId, …)` call whose documentId isn't
//     already in that event set synthesises a bare row from the
//     captured DocRef.
//
// Reuses the shared `TimelineColumn` that also drives the document-detail
// Timeline tab — same renderer, same pixels, same source-agnostic affordances.

export function TimelinePanel({ trailAnnotations, records }) {
  const events = buildUnifiedTimeline(trailAnnotations?.byDoc, records ?? []);
  if (events.length === 0) {
    return html`
      <aside class="agent-cite agent-cite-empty">
        <p class="agent-cite-hint">The agent has not referenced any document yet.</p>
      </aside>
    `;
  }
  // Doc ids that are actually rendered as Timeline rows — top-level
  // events AND their nested attachments. Surfaces only those relations
  // ("cites X", "cited by X") whose target lives elsewhere on the same
  // Timeline; the rest stay hidden so we don't clutter the panel with
  // pointers to off-screen docs.
  const visibleDocIds = new Set();
  for (const event of events) {
    if (event?.doc?.documentId) visibleDocIds.add(event.doc.documentId);
    for (const att of event?.attachments ?? []) {
      if (att?.doc?.documentId) visibleDocIds.add(att.doc.documentId);
    }
  }
  return html`
    <aside class="agent-cite">
      <${TimelineColumn}
        events=${events}
        annotations=${trailAnnotations}
        visibleDocIds=${visibleDocIds}
      />
    </aside>
  `;
}

// ─── Plan panel — the agent's transient TODO list ────────────────────────
//
// Pinned region between the transcript and the composer. The agent's
// `plan` tool emits the full current list on every call; the reducer
// mirrors it into `state.planItems`. This component owns the local
// "rendered" projection so it can drive slide-in / done-fade / 1s-then-
// remove animations on top of the canonical state.
//
// Visual states:
//   pending      ○  hollow circle, muted label
//   in_progress  ●  filled circle with a pulse, accent-tinted label
//   done         ✓  checkmark, strikethrough + dim label
//
// Order is preserved exactly as the server sent it — done items stay
// where they were until their 1s removal timer fires.
export function PlanPanel({ items }) {
  // `rendered` is the local projection: { id, label, status, removing }.
  // We diff against incoming `items` on every prop change to:
  //   - add brand-new ids (slide in)
  //   - update status of existing ids
  //   - kick a 1s removal timer when an item newly becomes `done`
  //   - clear everything when `items` goes empty (reducer-driven reset)
  const [rendered, setRendered] = useState([]);
  // Removal timers keyed by item id. Two-stage: at t=1000ms we flip
  // `removing: true` (CSS does the slide-out for 250ms); at t=1250ms
  // we drop the row from `rendered`. Refs (not state) so re-renders
  // don't reset the timers mid-animation.
  const markRemovingTimersRef = useRef(new Map());
  const dropTimersRef = useRef(new Map());
  // Ids that have completed their 1s-then-remove cycle. The server keeps
  // sending those items in subsequent `plan.updated` payloads (the plan
  // tool returns the full list every call), so without this gravestone
  // set we'd re-add them to the rendered list and the panel would flash
  // back into view.
  const tombstonedRef = useRef(new Set());

  function cancelAllTimers() {
    for (const t of markRemovingTimersRef.current.values()) clearTimeout(t);
    for (const t of dropTimersRef.current.values()) clearTimeout(t);
    markRemovingTimersRef.current.clear();
    dropTimersRef.current.clear();
  }

  useEffect(() => {
    // Reducer-driven clear (new conversation, message.end grace period,
    // session reset). Cancel any in-flight per-item timers, drop
    // tombstones, and wipe the local list immediately — the parent has
    // decided the panel goes.
    if (items.length === 0) {
      cancelAllTimers();
      tombstonedRef.current.clear();
      setRendered([]);
      return;
    }
    setRendered((prev) => {
      const prevById = new Map(prev.map((r) => [r.id, r]));
      // Filter out tombstoned ids so items that already finished their
      // removal animation don't get re-rendered when the agent emits
      // another `plan.updated` containing them.
      const visible = items.filter((it) => !tombstonedRef.current.has(it.id));
      const next = visible.map((it) => {
        const existed = prevById.get(it.id);
        // Preserve the `removing` flag on items already mid-exit so a
        // late plan.updated doesn't yank them back into view.
        return {
          id: it.id,
          label: it.label,
          status: it.status,
          removing: existed?.removing ?? false,
        };
      });
      // Schedule removal for items whose status transitioned to `done`
      // on this update. Items that were already done keep their existing
      // timer (don't reset). New ids that arrive already `done` (rare,
      // but possible if a plan completes in one tool call) also get a
      // timer so they appear and gracefully exit.
      for (const it of visible) {
        const wasDone = prevById.get(it.id)?.status === "done";
        if (it.status === "done" && !wasDone && !markRemovingTimersRef.current.has(it.id)) {
          const t1 = setTimeout(() => {
            markRemovingTimersRef.current.delete(it.id);
            setRendered((cur) => cur.map((r) => (r.id === it.id ? { ...r, removing: true } : r)));
            const t2 = setTimeout(() => {
              dropTimersRef.current.delete(it.id);
              tombstonedRef.current.add(it.id);
              setRendered((cur) => cur.filter((r) => r.id !== it.id));
            }, 250);
            dropTimersRef.current.set(it.id, t2);
          }, 1000);
          markRemovingTimersRef.current.set(it.id, t1);
        }
      }
      return next;
    });
  }, [items]);

  // Unmount → cancel all pending timers so a navigate-away mid-animation
  // doesn't leave orphan setTimeouts firing into a dead component.
  useEffect(() => () => cancelAllTimers(), []);

  if (rendered.length === 0) return null;
  return html`
    <div class="agent-plan" role="status" aria-label="Agent plan">
      <ul class="agent-plan-list">
        ${rendered.map((it) => html`
          <li key=${it.id}
              class=${`agent-plan-item agent-plan-${it.status}${it.removing ? " is-removing" : ""}`}>
            <span class="agent-plan-bullet" aria-hidden="true">
              ${it.status === "done"
                ? html`<svg viewBox="0 0 10 10" width="10" height="10" fill="none"
                              stroke="currentColor" stroke-width="1.8"
                              stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 5.5 L4.2 7.5 L8 3" />
                  </svg>`
                : it.status === "in_progress"
                  ? html`<span class="agent-plan-bullet-dot"></span>`
                  : html`<span class="agent-plan-bullet-ring"></span>`}
            </span>
            <span class="agent-plan-label">${it.label}</span>
          </li>
        `)}
      </ul>
    </div>
  `;
}

// ─── Composer ─────────────────────────────────────────────────────────────

// lucide `telescope` — the Deep Research glyph (inline SVG, matching the
// portal's other glyphs which are drawn directly rather than pulled from a
// runtime icon library). Keyed by the descriptor's `icon` name so the
// extensible slash-command registry can introduce more glyphs later.
const SLASH_ICONS = {
  telescope: html`
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" />
      <path d="m13.56 11.747 4.332-.924" />
      <path d="m16 21-3.105-6.21" />
      <path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.212l-1.09.273a2 2 0 0 1-2.425-1.455z" />
      <path d="m6.158 8.633 1.114 4.456" />
      <path d="m8 21 3.105-6.21" />
      <circle cx="12" cy="13" r="2" />
    </svg>
  `,
};

/**
 * Composer renders the textarea + embedded send button, plus a `/`
 * slash-command affordance: typing `/` at the start of an empty composer
 * opens an extensible typeahead menu (seeded today with a single "Deep
 * research" item). Selecting a command arms a per-message pill at the
 * top-left (icon + label + `×`); the typed prompt sits below. On send the
 * armed command's options (e.g. `{ deepResearch: true }`) are handed to
 * `onSubmit(text, options)` and the pill clears — it governs the NEXT send
 * only. `×` dismisses the pill without sending.
 *
 * Two visual variants:
 *  - `default` (active conversation): pinned at the bottom of the chat
 *    pane, compact rows.
 *  - `hero` (empty conversation): centered, larger textarea — the
 *    blank-conversation surface puts the input front and center
 *    instead of buried at the bottom of an empty pane.
 *
 * Keyboard: plain Enter sends; Shift+Enter inserts a newline. The
 * send button is only rendered after the user has typed at least one
 * character so the empty state stays uncluttered. When the slash menu is
 * open, Enter selects the highlighted command instead of sending.
 */
export function Composer({ disabled, onSubmit, onCancel, busy, variant = "default", autoFocus = false, experimental = false }) {
  const [text, setText] = useState("");
  // The armed per-message command (a SLASH_COMMANDS descriptor) or null.
  // Cleared after each send so the next message is an ordinary turn unless
  // re-armed.
  const [armed, setArmed] = useState(null);
  const taRef = useRef(null);
  const canSend = !disabled && !busy && text.trim().length > 0;

  // Slash-menu state derived purely from the current text. When `open`, the
  // textarea's Enter selects the first match rather than submitting.
  // `experimental` remains available to gate future experimental commands.
  // Deep Research itself is available on every gateway.
  const menu = matchSlashCommands(text, { experimental });

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  // Auto-grow up to a max height so a multi-line prompt doesn't get
  // confined to two rows. Resets on text change.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const cap = variant === "hero" ? 240 : 160;
    ta.style.height = Math.min(ta.scrollHeight, cap) + "px";
  }, [text, variant]);

  // Arm a command from the menu: stash the descriptor as the pill, clear the
  // `/query` token so the textarea is ready for the real prompt, refocus.
  function armCommand(cmd) {
    if (!cmd) return;
    setArmed(cmd);
    setText("");
    taRef.current?.focus();
  }

  function disarm() {
    setArmed(null);
    taRef.current?.focus();
  }

  function submit(e) {
    e?.preventDefault?.();
    if (!canSend) return;
    const options = sendOptionsForArmed(armed?.id ?? null);
    onSubmit(text.trim(), options);
    setText("");
    // Per-message: the pill governs this one send only.
    setArmed(null);
  }

  return html`
    <form class=${`agent-composer agent-composer-${variant}`} onSubmit=${submit}>
      ${armed
        ? html`
          <div class="agent-composer-pills">
            <span class="agent-composer-pill" data-command=${armed.id}>
              <span class="agent-composer-pill-icon">${SLASH_ICONS[armed.icon] ?? null}</span>
              <span class="agent-composer-pill-label">${armed.label}</span>
              <button
                type="button"
                class="agent-composer-pill-dismiss"
                onClick=${disarm}
                title="Dismiss"
                aria-label=${`Dismiss ${armed.label}`}>×</button>
            </span>
          </div>
        `
        : null}
      ${menu.open && menu.matches.length > 0
        ? html`
          <div class="agent-slash-menu" role="listbox" aria-label="Slash commands">
            ${menu.matches.map((cmd) => html`
              <button
                key=${cmd.id}
                type="button"
                role="option"
                class="agent-slash-menu-item"
                onClick=${() => armCommand(cmd)}>
                <span class="agent-slash-menu-icon">${SLASH_ICONS[cmd.icon] ?? null}</span>
                <span class="agent-slash-menu-text">
                  <span class="agent-slash-menu-label">${cmd.label}</span>
                  <span class="agent-slash-menu-hint">${cmd.hint}</span>
                </span>
              </button>
            `)}
          </div>
        `
        : null}
      <textarea
        ref=${taRef}
        name="text"
        class="agent-composer-input"
        placeholder=${busy ? "Working…" : (variant === "hero" ? "Ask Omnesis" : "Ask Omnesis…")}
        disabled=${disabled}
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Escape" && menu.open) {
            e.preventDefault();
            // Clear the `/query` token so the menu closes.
            setText("");
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // While the menu is open, Enter picks the top match instead of
            // submitting a literal `/…` string.
            if (menu.open && menu.matches.length > 0) {
              armCommand(menu.matches[0]);
              return;
            }
            submit();
          }
        }}
        rows=${variant === "hero" ? 2 : 1}
      />
      ${busy
        ? html`<button type="button" class="agent-composer-cancel" onClick=${onCancel} aria-label="Cancel">Cancel</button>`
        : canSend
          ? html`<button type="submit" class="agent-composer-send" aria-label="Send">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 13V3" />
                <path d="M3 8l5-5 5 5" />
              </svg>
            </button>`
          : null}
    </form>
  `;
}
