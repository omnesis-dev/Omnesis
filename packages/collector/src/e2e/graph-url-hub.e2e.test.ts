// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end coverage for the graph subgraph walker's URL-hub skip,
 * exercised across the full collector → gateway → graph endpoint path.
 *
 * Anchors three things the unit + route tests can't reach together:
 *
 *  1. **Collector push.** The collector reads `urlHub: true` off each
 *     loaded source's `defineSource` descriptor and POSTs the union of
 *     source-type prefixes to `/admin/url-graph-roles` after the
 *     applySourcesSnapshot returns.
 *
 *  2. **Role-driven filter.** `DocumentGraphService` reads the
 *     gateway's process-level url-hub registry at `prepare()` time and
 *     drops `url`-typed edges to/from hub-source documents during BFS.
 *     A direct DB write seeds a deterministic `url` link from a real
 *     gmail-like doc to a chrome-bookmark doc; the graph endpoint must
 *     filter that bookmark out.
 *
 *  3. **Ordinary targets still traverse.** The same seed also has a
 *     `url` edge to an ordinary non-hub document. That target remains in
 *     the result, proving the walker filters by the declared role rather
 *     than suppressing URL traversal wholesale.
 *
 * Why a direct DB write instead of letting `linkBackfill` extract the
 * URL from doc content: the test would otherwise have to know which
 * URLs land in the chrome-bookmarks fixture — fragile against fixture
 * refreshes. The test waits for backfill to process the seed document
 * before its targeted INSERT, so backfill cannot diff-delete the edge.
 * Concurrent writes against the gateway's DB are safe in WAL mode;
 * other E2E suites read from the same handle (see omnesis-chat.e2e).
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { Database as Db } from "better-sqlite3";

const BOOKMARKS_SOURCE_ID = "chrome-bookmarks:john.smith@example.com";
const REAL_DOC_EXTERNAL_ID = "graph-url-hub-test-real-doc";
const ORDINARY_DOC_EXTERNAL_ID = "graph-url-hub-test-ordinary-doc";

interface AdminUrlGraphRolesResp {
  traversalHubPrefixes: string[];
  fallbackRepresentationPrefixes: string[];
  referenceOnlyPrefixes: string[];
  ready: boolean;
}

interface GraphResp {
  seeds: string[];
  vertices: Array<{ id: string; kind: string; sourceId?: string }>;
  edges: Array<{ from: string; to: string; type: string; directed: boolean }>;
}

describe("Graph URL-hub skipping (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let writeDb: Db;
  let realDocId: string;
  let ordinaryDocId: string;
  let bookmarkDocId: string;
  let collectorToken: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    const collector = harness.getDevices().find((device) => device.kind === "collector");
    if (!collector) throw new Error("The e2e-minimal universe has no collector device");
    collectorToken = collector.token;

    // Sync chrome-bookmarks so the corpus has hub docs to link to.
    await harness.triggerSyncAndWait(BOOKMARKS_SOURCE_ID, 30_000);

    // The collector pushes urlHub prefixes asynchronously after
    // applySourcesSnapshot. Poll the admin endpoint until the push
    // has landed (15s deadline is generous — the actual push completes
    // in <500ms once provider registration is done).
    await waitForHubRegistered(harness, "chrome-bookmarks", 15_000);

    // Direct DB handle for the bookmark-doc lookup + link seeding. WAL
    // mode lets the test process write while the gateway subprocess
    // also has the DB open.
    writeDb = new Database(harness.getDbPath());

    const bookmark = writeDb
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(BOOKMARKS_SOURCE_ID);
    if (!bookmark) {
      throw new Error(
        `No chrome-bookmark doc found in DB after sync (source_id=${BOOKMARKS_SOURCE_ID}). ` +
          `Has the e2e-minimal corpus drifted?`,
      );
    }
    bookmarkDocId = bookmark.id;

    // Ingest a synthetic "real" gmail-like doc — the source-id prefix
    // is NOT in the url-hub registry, so its outbound `url` edges
    // should walk normally to ordinary URL targets.
    const ingest = await fetch(`${harness.gatewayUrl}/documents`, {
      method: "POST",
      headers: {
        // Declaration writes require the real collector's broad write scope;
        // the harness bootstrap token is intentionally admin/read only.
        Authorization: `Bearer ${collectorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        documents: [
          {
            providerId: "graph-url-hub-test:provider",
            sourceId: "graph-url-hub-test-source:acct",
            externalId: REAL_DOC_EXTERNAL_ID,
            title: "Graph url-hub regression doc",
            content: "irrelevant — link is seeded directly via DB write",
            contentHash: `ch-${REAL_DOC_EXTERNAL_ID}`,
            metadata: { documentType: "email" },
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            providerId: "graph-url-hub-test:provider",
            sourceId: "graph-url-hub-test-source:acct",
            externalId: ORDINARY_DOC_EXTERNAL_ID,
            title: "Ordinary graph target",
            content: "ordinary non-hub document",
            contentHash: `ch-${ORDINARY_DOC_EXTERNAL_ID}`,
            metadata: { documentType: "note" },
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    if (!ingest.ok) {
      throw new Error(`POST /documents failed: ${ingest.status} ${await ingest.text()}`);
    }
    const realRow = writeDb
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ? LIMIT 1")
      .get(REAL_DOC_EXTERNAL_ID);
    if (!realRow) throw new Error("Real doc did not show up in DB after ingest");
    realDocId = realRow.id;
    const ordinaryRow = writeDb
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ? LIMIT 1")
      .get(ORDINARY_DOC_EXTERNAL_ID);
    if (!ordinaryRow) throw new Error("Ordinary target did not show up in DB after ingest");
    ordinaryDocId = ordinaryRow.id;

    // Backfill replaces every extracted-link type, including `url`. Wait until
    // it has processed this document before inserting the controlled edge.
    const backfillState = writeDb.prepare<[string], { links_extracted_at: string | null }>(
      "SELECT links_extracted_at FROM documents WHERE id = ?",
    );
    const backfillDeadline = Date.now() + 30_000;
    while (backfillState.get(realDocId)?.links_extracted_at == null) {
      if (Date.now() >= backfillDeadline) {
        throw new Error(`Link backfill did not process ${realDocId} within 30s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Seed two `url` edges. The walker must drop real → bookmark while
    // retaining real → ordinary.
    const insertLink = writeDb.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
            target_doc_id, resolved_at, created_at)
         VALUES (?, 'url', ?, ?, ?, ?, ?)`,
    );
    insertLink.run(
      realDocId,
      `id://${bookmarkDocId}`,
      `id://${bookmarkDocId}`,
      bookmarkDocId,
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00Z",
    );
    insertLink.run(
      realDocId,
      `id://${ordinaryDocId}`,
      `id://${ordinaryDocId}`,
      ordinaryDocId,
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00Z",
    );
  }, 180_000);

  afterAll(async () => {
    try {
      writeDb?.close();
    } catch {
      /* best effort */
    }
    await harness.destroy();
  }, 30_000);

  test("collector pushes the urlHub prefixes; admin GET surfaces them", async () => {
    const res = await harness.gatewayJson<AdminUrlGraphRolesResp>("/admin/url-graph-roles");
    // chrome-bookmarks + browser-history come from collector-declared
    // descriptors (defineSource carries `urlHub: true`). The unified `web`
    // source is the gateway's built-in hub seed (the webpage entity is the
    // graph hub), present even before any extension pairs or instance configs.
    expect(res.traversalHubPrefixes).toContain("chrome-bookmarks");
    expect(res.traversalHubPrefixes).toContain("browser-history");
    expect(res.traversalHubPrefixes).toContain("web");
    // Traversal hubs are not automatically fallback URL representations.
    // Web-page captures alone currently yield URL ownership to a dedicated source.
    expect(res.fallbackRepresentationPrefixes).toEqual(["web"]);
    expect(res.referenceOnlyPrefixes).toEqual(["chrome-bookmarks"]);
    expect(res.ready).toBe(true);
  });

  test("graph endpoint skips a bookmark hub but retains an ordinary URL target", async () => {
    const graph = await harness.gatewayJson<GraphResp>(`/documents/${realDocId}/graph?depth=2`);
    const ids = graph.vertices.map((v) => v.id);
    expect(ids).toContain(`doc:${realDocId}`);
    expect(ids).toContain(`doc:${ordinaryDocId}`);
    // The seeded url → bookmark edge must be filtered out because
    // chrome-bookmarks is registered as a urlHub.
    expect(ids).not.toContain(`doc:${bookmarkDocId}`);
    const edgesToBookmark = graph.edges.filter(
      (e) => e.from === `doc:${bookmarkDocId}` || e.to === `doc:${bookmarkDocId}`,
    );
    expect(edgesToBookmark).toEqual([]);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: `doc:${realDocId}`,
        to: `doc:${ordinaryDocId}`,
        type: "url",
      }),
    );
  });
});

/**
 * Poll the admin endpoint until the named prefix shows up in the merged
 * registry. The collector pushes urlHub prefixes fire-and-forget after
 * applySourcesSnapshot — the harness's `start()` returns once provider
 * registration is done, but the HTTP POST is a separate microtask.
 */
async function waitForHubRegistered(
  harness: SyntheticE2EHarness,
  prefix: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] | undefined;
  while (Date.now() < deadline) {
    const res = await harness.gatewayJson<AdminUrlGraphRolesResp>("/admin/url-graph-roles");
    last = res.traversalHubPrefixes;
    if (res.traversalHubPrefixes.includes(prefix)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForHubRegistered: prefix '${prefix}' never appeared within ${timeoutMs}ms ` +
      `(last seen: ${JSON.stringify(last)})`,
  );
}
