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
import { toolCardLabel } from "./tool-card-table.js";
import { toolCardGlyph } from "./tool-cards.js";

export function actionToolLabel(tool) {
  return toolCardLabel(tool);
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
        glyph=${toolCardGlyph(call.tool)}
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
