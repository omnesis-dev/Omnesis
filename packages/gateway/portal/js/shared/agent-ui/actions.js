// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import {
  RollingSlot,
  EphemeralCard,
  EphemeralHeader,
  useRollingRotation,
  ephemeralResultArrived,
  EPHEMERAL_SLOT_HEIGHT,
} from "./lifecycle.js";
import { LOOP_GLYPH, BRIEF_GLYPH, CLOCK_GLYPH, DOC_GLYPH } from "./glyphs.js";

function actionToolLabel(tool) {
  return (
    {
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
    }[tool] ?? tool
  );
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
export function EphemeralActionCard({ call, dispatch }) {
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
      ${
        items.length > 0
          ? html`<${RollingSlot}
              items=${items}
              currentIndex=${currentIndex}
              slotHeight=${EPHEMERAL_SLOT_HEIGHT}
              itemView=${(item) => html`
                <div
                  class=${`agent-ephemeral-result${item.isError ? " agent-ephemeral-error" : ""}`}
                >
                  <span class="agent-ephemeral-result-title">${item.line}</span>
                </div>
              `}
            />`
          : null
      }
    </${EphemeralCard}>
  `;
}
