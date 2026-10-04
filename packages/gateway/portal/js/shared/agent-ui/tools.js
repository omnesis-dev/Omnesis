// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useRef, useEffect } from "preact/hooks";
import {
  RollingSlot,
  EphemeralCard,
  EphemeralHeader,
  useRollingRotation,
  ephemeralResultArrived,
  EPHEMERAL_REVEAL_MS,
  EPHEMERAL_SLOT_HEIGHT,
  EPHEMERAL_SQL_SLOT_HEIGHT,
  EPHEMERAL_SQL_ROWS_MAX,
  EPHEMERAL_DOC_LINES_MAX,
  EPHEMERAL_SEARCH_RESULTS_MAX,
  EPHEMERAL_TRAIL_DOCS_MAX,
  EPHEMERAL_PEOPLE_RESULTS_MAX,
} from "./lifecycle.js";
import {
  SEARCH_GLYPH,
  DOC_GLYPH,
  SQL_GLYPH,
  TRAIL_GLYPH,
  PEOPLE_GLYPH,
  LINK_GLYPH,
  LOOP_GLYPH,
} from "./glyphs.js";
/** Browser-only renderer shared by native Find and the portal. Host navigation stays injected. */
import { flattenTrailDocs, normaliseRow, formatSqlCell } from "./tool-values.js";
export { flattenTrailDocs, normaliseRow, formatSqlCell } from "./tool-values.js";

import { EphemeralActionCard } from "./actions.js";

export function createAgentToolRenderer({ sourceIcon = () => "📄", renderLoopRow } = {}) {
  const loopRow =
    renderLoopRow ??
    ((loop) =>
      html`<div class="agent-loop-row">
        <span class=${`agent-loop-state agent-loop-state-${loop.state}`}>${loop.state}</span
        ><span class="agent-loop-title">${loop.title || "Untitled loop"}</span>
      </div>`);
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

  function loopDetailLines(loop) {
    const lines = [];
    if (loop.deadline) lines.push(`Due: ${loop.deadline}`);
    const actors = Array.isArray(loop.actors) ? loop.actors.filter(Boolean) : [];
    if (actors.length) lines.push(`Actors: ${actors.join(", ")}`);
    if (loop.description) lines.push(loop.description);
    return lines;
  }

  function loopChip(ref) {
    const loops = Array.isArray(ref?.openLoops) ? ref.openLoops : [];
    if (loops.length === 0) return null;
    const titles = loops
      .map((l) => l.title)
      .filter(Boolean)
      .join(" · ");
    return html`<span class="agent-loop-chip" title=${titles}>🔗 ${loops.length}</span>`;
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
      ${
        hasResult && results.length > 0
          ? html`<${RollingSlot}
              items=${results}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(ref) => html`
                <div class="agent-ephemeral-result">
                  <span class="agent-ephemeral-result-icon"
                    >${sourceIcon(ref.sourceId, { size: 11 })}</span
                  >
                  <span class="agent-ephemeral-result-title">${ref.title || "Untitled"}</span>
                  ${loopChip(ref)}
                </div>
              `}
            />`
          : null
      }
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
      ${
        hasResult && docs.length > 0
          ? html`<${RollingSlot}
              items=${docs}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(doc) => html`
                <div class="agent-ephemeral-result">
                  <span class="agent-ephemeral-result-icon"
                    >${sourceIcon(doc.sourceId, { size: 11 })}</span
                  >
                  <span class="agent-ephemeral-result-title">${doc.title || "Untitled"}</span>
                </div>
              `}
            />`
          : null
      }
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
          <span class="agent-ephemeral-result-icon"
            >${sourceIcon(docRef.sourceId, { size: 11 })}</span
          >
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
      ${
        hasResult && lines.length > 0
          ? html`<${RollingSlot}
              items=${lines}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
              itemView=${(line) => html` <div class="agent-ephemeral-doc-line">${line}</div> `}
            />`
          : null
      }
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
    const loops = hasResult ? (call.result.loops || []).slice(0, EPHEMERAL_SEARCH_RESULTS_MAX) : [];
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
      ${
        hasResult && loops.length > 0
          ? html`<${RollingSlot}
              items=${loops}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(loop) => loopRow(loop)}
            />`
          : null
      }
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
      ${
        hasResult && lines.length > 0
          ? html`<${RollingSlot}
              items=${lines}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
              itemView=${(line) => html`<div class="agent-ephemeral-doc-line">${line}</div>`}
            />`
          : null
      }
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
    const sqlLines = sqlText.trim() ? [sqlText.replace(/\s+/g, " ").trim()] : [];
    const argsKnown = sqlText.length > 0;
    const hasResult = call.result?.kind === "sql.rows";
    const resultArrived = ephemeralResultArrived(call);
    const columns = hasResult ? call.result.columns || [] : [];
    const allRows = hasResult ? (call.result.rows || []).slice(0, EPHEMERAL_SQL_ROWS_MAX) : [];
    // Source attribution + friendly table names come from the analytics
    // catalog server-side (and from the replay fixture for synthetic
    // conversations) — both paths put them on `result.sources` /
    // `result.subjects` so this renderer stays source-agnostic.
    const sources = hasResult ? call.result.sources || [] : [];
    const subjects = hasResult ? call.result.subjects || [] : [];
    const headerExtra =
      sources.length > 0 || subjects.length > 0
        ? html`<span class="agent-ephemeral-sql-subject">
            ${sources.map(
              (s) => html`
                <span key=${s.sourceId} class="agent-ephemeral-result-icon"
                  >${sourceIcon(s.sourceId, { size: 11 })}</span
                >
              `,
            )}
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
      if (sqlLines.length === 0) {
        setSqlDone(true);
        return;
      }
      const timers = [];
      for (let i = 0; i < sqlLines.length; i++) {
        timers.push(setTimeout(() => setSqlIndex(i), i * EPHEMERAL_REVEAL_MS));
      }
      timers.push(setTimeout(() => setSqlDone(true), sqlLines.length * EPHEMERAL_REVEAL_MS));
      return () => {
        for (const t of timers) clearTimeout(t);
      };
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
      ${
        sqlLines.length > 0
          ? html`<${RollingSlot}
              items=${sqlLines}
              currentIndex=${sqlIndex}
              slotHeight=${EPHEMERAL_SQL_SLOT_HEIGHT}
              itemView=${(line) => html`
                <code class="agent-ephemeral-sql-line">${line || " "}</code>
              `}
            />`
          : null
      }
      ${
        hasResult && allRows.length > 0 && columns.length > 0
          ? html`
              <div class="agent-ephemeral-sql-rowblock">
                <div class="agent-ephemeral-sql-cols">
                  ${columns.map(
                    (c, j) => html`<span key=${j} class="agent-ephemeral-sql-col">${c}</span>`,
                  )}
                </div>
                <${RollingSlot}
                  items=${allRows}
                  currentIndex=${rowIndex}
                  slotHeight=${EPHEMERAL_SLOT_HEIGHT}
                  itemView=${(row) => html`
                    <div class="agent-ephemeral-sql-row">
                      ${normaliseRow(row, columns.length).map(
                        (cell, j) => html`
                          <span key=${j} class="agent-ephemeral-sql-cell"
                            >${formatSqlCell(cell)}</span
                          >
                        `,
                      )}
                    </div>
                  `}
                />
              </div>
            `
          : null
      }
    </${EphemeralCard}>
  `;
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
      ${
        hasResult && results.length > 0
          ? html`<${RollingSlot}
              items=${results}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(person) => html`
                <div class="agent-ephemeral-people-row">
                  <span class="agent-ephemeral-people-name">${person.displayName}</span>
                  ${primaryAliasFor(person)
                    ? html`<code class="agent-ephemeral-people-alias"
                        >${primaryAliasFor(person)}</code
                      >`
                    : null}
                </div>
              `}
            />`
          : null
      }
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
    const ref = hasResult ? (call.result.ref ?? null) : null;
    // Build a single-item slot — one row of "ref" (the matched doc) OR
    // one row of "no-match" (URL not in corpus). The tagged shape keeps
    // the renderer's branch explicit instead of hiding it behind an
    // `??` fallback, and mirrors `AgentEphemeralUrlLookupCard.SlotItem`
    // on iOS.
    const items = hasResult ? [ref ? { kind: "ref", ref } : { kind: "no-match" }] : [];
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
      ${
        hasResult && items.length > 0
          ? html`<${RollingSlot}
              items=${items}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(item) =>
                item.kind === "ref"
                  ? html`
                      <div class="agent-ephemeral-result">
                        <span class="agent-ephemeral-result-icon"
                          >${sourceIcon(item.ref.sourceId, { size: 11 })}</span
                        >
                        <span class="agent-ephemeral-result-title"
                          >${item.ref.title || "Untitled"}</span
                        >
                      </div>
                    `
                  : html`<div class="agent-ephemeral-url-nomatch">No match in your corpus</div>`}
            />`
          : null
      }
    </${EphemeralCard}>
  `;
  }

  function renderToolPart(part, key, dispatch) {
    if (part.tailDismissed) return null;
    if (part.tool === "search_many" || part.tool === "fetch_many") {
      const tool = part.tool === "search_many" ? "search_documents" : "fetch_document";
      return deriveBatchChildren(part, tool).map((c) =>
        renderToolPart(
          {
            kind: "tool",
            toolCallId: `${part.toolCallId}#${c.index}`,
            tool: c.tool || tool,
            args: null,
            argsSummary: c.argsSummary ?? "",
            result: c.result ?? null,
            durationMs: null,
            timeText: c.timeText ?? null,
            rawPayload: c.rawPayload,
          },
          `${key}-${c.index}`,
          dispatch,
        ),
      );
    }
    const Component =
      {
        search_documents: EphemeralSearchCard,
        fetch_document: EphemeralDocumentCard,
        run_sql: EphemeralSqlCard,
        trace_connections: EphemeralTrailCard,
        lookup_people: EphemeralPeopleCard,
        lookup_document_by_url: EphemeralUrlLookupCard,
        search_loops: EphemeralLoopSearchCard,
        fetch_loop: EphemeralLoopFetchCard,
      }[part.tool] ?? EphemeralActionCard;
    return html`<${Component} key=${key} call=${part} dispatch=${dispatch} />`;
  }
  return { renderToolPart };
}
