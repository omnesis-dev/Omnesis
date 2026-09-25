// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-level E2E driving the REAL WhatsAppProvider through the full
 * collector → gateway → indexer → search/links pipeline, backfill half.
 *
 * The `whatsapp-backfill` universe ships a `fake-corpus.json`, which makes the
 * synth WhatsApp twin take its WRAPS-REAL path: it instantiates the real
 * provider (durable store.db, the history seal, the day-doc deepening)
 * against an injected `FakeWhatsAppServer`. The real provider's writable home
 * is the harness's isolated config dir, threaded via `CreateOptions.configDir`.
 *
 * The corpus seals COMPLETE on a shallow recent-window slice (initialDepth: 1);
 * a later backfill streams the older messages so the affected day-doc DEEPENS
 * in place. Asserts, end-to-end through a spawned gateway:
 *   - the backfill deepens the day-doc (same id, more content);
 *   - the messages' bare external-URL links resolve to no registered source, so
 *     they are dropped at extraction rather than stored unresolved — the
 *     deepened day-doc carries no outbound graph edges (the URLs stay in the
 *     searchable content);
 *   - deep-history search finds the older backfilled message;
 *   - re-embed is O(1): a backfill that re-emits both day-docs re-embeds only
 *     the CHANGED one's chunk (the gateway content-hash gate skips the rest).
 *
 * The wraps-real controller (`getWhatsAppWrapsRealController`) is reached via a
 * DYNAMIC import inside the tests — a static top-of-file import would load the
 * synth package (and cache the active universe) before the harness constructor
 * sets `OMNESIS_SYNTH_UNIVERSE`, pinning the wrong universe for the whole worker.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { HistoryCoverage } from "@omnesis/source-sdk";
import type { WhatsAppWrapsRealController } from "@omnesis/provider-whatsapp-synth";

const WA_SOURCE_ID = "whatsapp-messages:+15550100120";
const MAYA_DAY = "15550100121@s.whatsapp.net:2026-03-10";
const JAMIE_DAY = "15550100122@s.whatsapp.net:2026-03-13";

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

function linkTargets(db: InstanceType<typeof Database>, sourceDocId: string): string[] {
  return (
    db
      .prepare(
        "SELECT normalized_target FROM document_links WHERE source_doc_id = ? ORDER BY normalized_target",
      )
      .all(sourceDocId) as Array<{ normalized_target: string }>
  ).map((r) => r.normalized_target);
}

async function waitForIndexed(harness: SyntheticE2EHarness, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: IndexStats | undefined;
  while (Date.now() < deadline) {
    const s = await harness.gatewayJson<IndexStats>("/index/stats");
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

/**
 * Wait until link extraction has RUN for a doc (`links_extracted_at` set).
 * These messages' only links are bare external URLs that resolve to no source,
 * so they are dropped at extraction and never appear in `document_links`
 * — meaning we can't wait for a link row. We wait for the extraction watermark
 * instead, then assert the drop.
 */
async function waitForLinkExtraction(
  db: InstanceType<typeof Database>,
  sourceDocId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const stmt = db.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND links_extracted_at IS NOT NULL",
  );
  while (Date.now() < deadline) {
    if (stmt.get(sourceDocId) !== undefined) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForLinkExtraction: ${sourceDocId} not link-extracted within ${timeoutMs}ms`);
}

async function searchDocs(
  harness: SyntheticE2EHarness,
  q: string,
): Promise<Array<{ id: string; source_id: string }>> {
  const res = (await harness.gatewayJson(
    `/documents/search?q=${encodeURIComponent(q)}&limit=200`,
  )) as { results?: Array<{ id: string; source_id: string }> };
  return res.results ?? [];
}

describe("WhatsApp wraps-real — backfill deepens day-docs, drops unresolvable links, O(1) re-embed", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  let bootstrapCoverage: HistoryCoverage | undefined;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "whatsapp-backfill",
      embedderBackend: "fake",
    });
    await harness.start();
    expect(harness.getFakeEmbedder(), "fake embedder must be wired").not.toBeNull();
    // Sync 1: the shallow recent-window slice (initialDepth: 1). Capture the
    // coverage it reports in flight (cleared once the sync settles).
    bootstrapCoverage = await harness.triggerSyncAndCaptureCoverage(WA_SOURCE_ID, 30_000);
    db = new Database(harness.getDbPath(), { readonly: true });
  }, 120_000);

  afterAll(async () => {
    db?.close();
    await harness.destroy();
  }, 15_000);

  test("sync 1 produced shallow day-docs and sealed complete (coverage: complete)", async () => {
    const ctrl = await getController();
    expect(ctrl.provider.getStore().historySyncState).toBe("complete");
    expect(bootstrapCoverage).toBe("complete");

    // The shallow Maya day-doc holds only its most-recent message (the marathon
    // link), not the older Q3-retrospective message.
    const maya = readDoc(db, MAYA_DAY);
    expect(maya, "Maya day-doc must exist after sync 1").toBeDefined();
    expect(maya!.content).toContain("marathon-entry");
    expect(maya!.content).not.toContain("Q3 retrospective");
  });

  test("backfill deepens the Maya day-doc, drops unresolvable links, and re-embeds O(1)", async () => {
    await waitForIndexed(harness, 60_000);
    const mayaBefore = readDoc(db, MAYA_DAY)!;
    const jamieBefore = readDoc(db, JAMIE_DAY)!;
    // The shallow message's only outbound link is a bare external URL
    // (example.org/marathon-entry) that resolves to no registered source — it
    // is dropped at extraction, not stored unresolved. Wait for
    // extraction to RUN, then assert the URL produced no graph edge.
    await waitForLinkExtraction(db, mayaBefore.id, 60_000);
    expect(
      linkTargets(db, mayaBefore.id).some((t) => t.includes("example.org/marathon-entry")),
      "a bare external URL must not become a document_links edge",
    ).toBe(false);

    // Both day-docs are at index steady-state; snapshot the embed counter so the
    // post-backfill delta reflects ONLY the re-embed work the backfill caused.
    const embedBefore = harness.getEmbedCount();

    // ── Drive the backfill: stream the older messages into the live store ──
    const ctrl = await getController();
    expect(ctrl.pushBackfill(), "backfill must push").toBe(true);
    // Re-sync: the deepened Maya day re-emits; Jamie re-emits identically.
    await harness.triggerSyncAndWait(WA_SOURCE_ID, 30_000);
    await waitForIndexed(harness, 60_000);
    await new Promise((r) => setTimeout(r, 2_000)); // settle one extra tick

    const mayaAfter = readDoc(db, MAYA_DAY)!;
    // The day-doc DEEPENED: same external id / gateway id, more content.
    expect(mayaAfter.id).toBe(mayaBefore.id);
    expect(mayaAfter.content.length).toBeGreaterThan(mayaBefore.content.length);
    expect(mayaAfter.content).toContain("Q3 retrospective");
    expect(mayaAfter.content).toContain("marathon-entry");
    // Content actually changed (basis for the re-embed accounting below).
    expect(mayaAfter.content_hash).not.toBe(mayaBefore.content_hash);

    // ── O(1) re-embed: only the CHANGED day-doc's chunks were re-embedded ──
    // The backfill re-emits both day-docs to the gateway, but the content-hash
    // gate skips Jamie (unchanged). Maya's deepened content is one chunk (<2048
    // chars), so the ingest-side embedder sees exactly one new input — not two.
    const embedDelta = harness.getEmbedCount() - embedBefore;
    expect(
      embedDelta,
      "a deepen-one-day backfill must re-embed only the changed day-doc's chunk",
    ).toBe(1);
    // Jamie's untouched day-doc is unchanged (same hash) across the backfill.
    const jamieAfter = readDoc(db, JAMIE_DAY)!;
    expect(jamieAfter.content_hash).toBe(jamieBefore.content_hash);

    // ── Re-extraction ran on the deepened doc; its links are still bare
    // external URLs (the recent marathon one + the newly-surfaced Q3 one), both
    // resolving to no source → still dropped. The deepened doc carries no
    // outbound edges; the URLs stay in the message content — the deep-history
    // search test below confirms the backfilled message stays searchable.
    await waitForLinkExtraction(db, mayaAfter.id, 60_000);
    const linksAfter = linkTargets(db, mayaAfter.id);
    expect(
      linksAfter.some((t) => t.includes("example.org/marathon-entry")),
      `marathon URL must not be a graph edge; got ${linksAfter.join(", ")}`,
    ).toBe(false);
    expect(
      linksAfter.some((t) => t.includes("example.com/q3-retrospective")),
      `backfilled Q3 URL must not be a graph edge; got ${linksAfter.join(", ")}`,
    ).toBe(false);
  }, 120_000);

  test("deep-history search finds the older backfilled message", async () => {
    await harness.refreshSearchSnapshot();
    const hits = await searchDocs(harness, "Q3 retrospective notes");
    const waHits = hits.filter((h) => h.source_id === WA_SOURCE_ID);
    expect(waHits.length, "the backfilled deep-history message must be searchable").toBeGreaterThan(
      0,
    );
  });
});
