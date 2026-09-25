// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { buildOpenLoopDocumentInput, renderOpenLoopBody } from "./document-projection.js";
import {
  OPEN_LOOP_DOCUMENT_TYPE,
  OPEN_LOOP_PROVIDER_ID,
  OPEN_LOOP_SOURCE_ID,
} from "./source-meta.js";
import type { OpenLoopLedgerEntry, OpenLoopRow } from "../storage/types.js";

function loop(over: Partial<OpenLoopRow> = {}): OpenLoopRow {
  return {
    id: "olp_1",
    createdByRun: "run_1",
    state: "open",
    confidence: 0.8,
    importance: 0.6,
    title: "Reimburse 10 GBP to Maya Reeves",
    description: "Agreed to split the taxi fare.",
    deadline: null,
    actors: [],
    involved: [],
    docs: ["doc_a"],
    blockedBy: [],
    createdAt: Date.UTC(2026, 6, 1, 9, 0, 0),
    lastUpdate: Date.UTC(2026, 6, 2, 9, 0, 0),
    lastDecayCheck: null,
    ...over,
  };
}

const LEDGER: OpenLoopLedgerEntry[] = [
  {
    seq: 1,
    loopId: "olp_1",
    runId: "run_1",
    at: Date.UTC(2026, 6, 1, 9, 0, 0),
    note: "created from the taxi conversation",
  },
  {
    seq: 2,
    loopId: "olp_1",
    runId: "run_2",
    at: Date.UTC(2026, 6, 2, 9, 0, 0),
    note: "no matching bank transaction yet",
  },
];

describe("open-loop document projection", () => {
  test("projects under the system source identity with type open-loop", () => {
    const doc = buildOpenLoopDocumentInput(loop(), LEDGER);
    expect(doc.providerId).toBe(OPEN_LOOP_PROVIDER_ID);
    expect(doc.sourceId).toBe(OPEN_LOOP_SOURCE_ID);
    expect(doc.externalId).toBe("olp_1");
    expect(doc.title).toBe("Reimburse 10 GBP to Maya Reeves");
    expect(doc.metadata.documentType).toBe(OPEN_LOOP_DOCUMENT_TYPE);
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.sourceCreatedAt).toBe("2026-07-01T09:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-07-02T09:00:00.000Z");
  });

  test("body carries title, state, description, and the ledger history", () => {
    const body = renderOpenLoopBody(loop(), LEDGER);
    expect(body).toContain("# Reimburse 10 GBP to Maya Reeves");
    expect(body).toContain("State: open");
    expect(body).toContain("Agreed to split the taxi fare.");
    expect(body).toContain("created from the taxi conversation");
    expect(body).toContain("no matching bank transaction yet");
    // Ledger section is omitted entirely for a ledger-less loop.
    expect(renderOpenLoopBody(loop(), [])).not.toContain("## History");
  });

  test("deterministic: same loop + ledger yields the same contentHash", () => {
    const a = buildOpenLoopDocumentInput(loop(), LEDGER);
    const b = buildOpenLoopDocumentInput(loop(), LEDGER);
    expect(a.contentHash).toBe(b.contentHash);
    const changed = buildOpenLoopDocumentInput(loop({ description: "Paid?" }), LEDGER);
    expect(changed.contentHash).not.toBe(a.contentHash);
  });
});
