// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Projection of an open loop into a corpus `DocumentInput` — the
 * omnesis-chat `buildDocumentInput` shape. Pure and deterministic given
 * the same loop + ledger, so re-upserting an unchanged loop is a no-op
 * (stable `contentHash`).
 *
 * The rendered body is what `open_loop_search` matches against: title,
 * state/description, and the ledger notes (the loop's traceable
 * history). Structured fields the agent needs verbatim come from
 * `open_loop_fetch` (the table row), not from this rendering.
 */

import { createHash } from "node:crypto";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import {
  OPEN_LOOP_DOCUMENT_TYPE,
  OPEN_LOOP_PROVIDER_ID,
  OPEN_LOOP_SOURCE_ID,
} from "./source-meta.js";
import type { OpenLoopLedgerEntry, OpenLoopRow } from "../storage/types.js";

export function renderOpenLoopBody(
  loop: OpenLoopRow,
  ledger: readonly OpenLoopLedgerEntry[],
): string {
  const lines: string[] = [`# ${loop.title}`, "", `State: ${loop.state}`, "", loop.description];
  if (ledger.length > 0) {
    lines.push("", "## History");
    for (const entry of ledger) {
      lines.push(`- ${new Date(entry.at).toISOString()} — ${entry.note}`);
    }
  }
  return lines.join("\n");
}

export function buildOpenLoopDocumentInput(
  loop: OpenLoopRow,
  ledger: readonly OpenLoopLedgerEntry[],
): DocumentInput {
  const body = renderOpenLoopBody(loop, ledger);
  return {
    providerId: ProviderId(OPEN_LOOP_PROVIDER_ID),
    sourceId: SourceId(OPEN_LOOP_SOURCE_ID),
    externalId: loop.id,
    title: loop.title,
    content: body,
    contentHash: createHash("sha256").update(body).digest("hex"),
    sourceCreatedAt: new Date(loop.createdAt).toISOString(),
    sourceUpdatedAt: new Date(loop.lastUpdate).toISOString(),
    metadata: {
      documentType: OPEN_LOOP_DOCUMENT_TYPE,
      extra: {
        state: loop.state,
        confidence: loop.confidence,
        importance: loop.importance,
      },
    },
  };
}
