// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-level E2E driving the REAL WhatsAppProvider through the full
 * collector → gateway → indexer → search pipeline, interrupted half.
 *
 * The `whatsapp-interrupted` universe ships a `fake-corpus.json` whose initial
 * history push STALLS — a `paused` milestone after partial deep history — so
 * the real provider seals INTERRUPTED instead of complete. Asserts,
 * end-to-end through a spawned gateway:
 *   - the real durable store sealed `interrupted` (the messages that DID arrive
 *     are preserved, not discarded);
 *   - the interrupted sync surfaced `coverage: "partial"` through the pipeline;
 *   - the truncated-but-present day-doc is still indexed and searchable.
 *
 * Lives in its own file (separate vitest worker) because the synth packages
 * cache the active universe per worker — a second universe in the same file
 * would be ignored. The controller is reached via a DYNAMIC import inside the
 * test for the same caching reason (see whatsapp-backfill.e2e.test.ts).
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { gatewayLogTail } from "./gateway-request.js";
import type { HistoryCoverage } from "@omnesis/source-sdk";
import type { WhatsAppWrapsRealController } from "@omnesis/provider-whatsapp-synth";

const WA_SOURCE_ID = "whatsapp-messages:+15550100120";
const DAVID_DAY = "15550100123@s.whatsapp.net:2026-03-10";

interface IndexStats {
  state?: string;
  totalIndexed?: number;
  totalGatewayDocs?: number;
}

interface DocRow {
  id: string;
  external_id: string;
  content: string;
  content_hash: string;
}

async function getController(): Promise<WhatsAppWrapsRealController> {
  const mod = await import("@omnesis/provider-whatsapp-synth");
  const ctrl = mod.getWhatsAppWrapsRealController(WA_SOURCE_ID);
  if (!ctrl) throw new Error(`no wraps-real controller registered for ${WA_SOURCE_ID}`);
  return ctrl;
}

function readDoc(db: InstanceType<typeof Database>, externalId: string): DocRow | undefined {
  return db
    .prepare(
      "SELECT id, external_id, content, content_hash FROM documents WHERE external_id = ? LIMIT 1",
    )
    .get(externalId) as DocRow | undefined;
}

/** How long the index may take to catch up with the arrived day-doc. */
const INDEX_WAIT_MS = 45_000;
/** Each later request (snapshot refresh, search) gets this long. */
const REQUEST_MS = 10_000;
/**
 * Above the index wait plus both requests, so a slow step fails through its own
 * deadline with a diagnosis rather than as a bare test timeout.
 */
const SEARCHABLE_TEST_MS = INDEX_WAIT_MS + 2 * REQUEST_MS + 15_000;

/**
 * Run one step of the search check under its own deadline. A failure names the
 * step and carries the spawned gateway's log tail, which tells an indexing wake
 * that never arrived apart from a request the gateway did not answer.
 */
async function diagnosed<T>(
  harness: SyntheticE2EHarness,
  step: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${step}: ${message}${gatewayLogTail(harness.getGatewayLogPath())}`, {
      cause: error,
    });
  }
}

async function waitForIndexed(harness: SyntheticE2EHarness, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: IndexStats | undefined;
  while (Date.now() < deadline) {
    let s: IndexStats;
    try {
      s = await harness.gatewayJson<IndexStats>("/index/stats", {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `waitForIndexed: /index/stats did not answer (${message}; last: ${JSON.stringify(last)})`,
        { cause: error },
      );
    }
    last = s;
    if (
      s.state === "running" &&
      (s.totalGatewayDocs ?? 0) > 0 &&
      (s.totalIndexed ?? 0) >= (s.totalGatewayDocs ?? 0)
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForIndexed: index never caught up (last: ${JSON.stringify(last)})`);
}

async function refreshSearchSnapshot(harness: SyntheticE2EHarness): Promise<void> {
  const res = await harness.gatewayFetch("/admin/search-snapshot/refresh", {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) throw new Error(`gateway returned ${res.status} ${await res.text()}`);
}

async function searchDocs(
  harness: SyntheticE2EHarness,
  q: string,
): Promise<Array<{ id: string; source_id: string }>> {
  const res = (await harness.gatewayJson(`/documents/search?q=${encodeURIComponent(q)}&limit=200`, {
    signal: AbortSignal.timeout(REQUEST_MS),
  })) as { results?: Array<{ id: string; source_id: string }> };
  return res.results ?? [];
}

describe("WhatsApp wraps-real — interrupted bootstrap (partial coverage)", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  let bootstrapCoverage: HistoryCoverage | undefined;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "whatsapp-interrupted",
      embedderBackend: "fake",
      // Info-level gateway logging puts indexer cycles and request handling in
      // the log tail a failed search step reports.
      extraGatewayEnv: { OMNESIS_LOG_LEVEL: "info" },
    });
    await harness.start();
    expect(harness.getFakeEmbedder(), "fake embedder must be wired").not.toBeNull();
    // Capture the coverage the bootstrap sync reports in flight (the engine
    // clears progress once the sync settles).
    bootstrapCoverage = await harness.triggerSyncAndCaptureCoverage(WA_SOURCE_ID, 30_000);
    db = new Database(harness.getDbPath(), { readonly: true });
  }, 120_000);

  afterAll(async () => {
    db?.close();
    await harness.destroy();
  }, 15_000);

  test("the real provider sealed INTERRUPTED in its durable store", async () => {
    const ctrl = await getController();
    expect(ctrl.provider.getStore().historySyncState).toBe("interrupted");
    // The messages that DID arrive before the stall are preserved.
    expect(ctrl.provider.getStore().totalMessages).toBe(2);
  });

  test("the interrupted sync surfaced coverage: partial through the pipeline", () => {
    // The WhatsAppMessagesSource emits `coverage: "partial"` when the
    // durable store sealed `interrupted` — the truncated-corpus signal the
    // collector reports up the sync pipeline.
    expect(bootstrapCoverage).toBe("partial");
  });

  test(
    "the truncated-but-present messages are indexed and searchable",
    async () => {
      await diagnosed(harness, "index catch-up", () => waitForIndexed(harness, INDEX_WAIT_MS));
      await diagnosed(harness, "search snapshot refresh", () => refreshSearchSnapshot(harness));
      // A distinctive token from the day-doc that DID arrive.
      const hits = await diagnosed(harness, "search", () =>
        searchDocs(harness, "kestrel telemetry"),
      );
      const waHits = hits.filter((h) => h.source_id === WA_SOURCE_ID);
      expect(waHits.length, "the arrived WhatsApp day-doc must be searchable").toBeGreaterThan(0);
      // The day-doc exists in the gateway with both arrived messages' content.
      const doc = readDoc(db, DAVID_DAY);
      expect(doc, "David day-doc must exist").toBeDefined();
      expect(doc!.content).toContain("kestrel telemetry");
      expect(doc!.content).toContain("firmware rollback");
    },
    SEARCHABLE_TEST_MS,
  );
});
