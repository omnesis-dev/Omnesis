// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Adjacency-aware retrieval end-to-end coverage.
 *
 * Boots a real gateway against the `default` universe, syncs Gmail + WhatsApp,
 * and waits for the real link-graph workers to materialise the "Q4 Vendor
 * Assessment" cluster (attachment + email-thread + duplicate-content edges),
 * plus a calibrated near-duplicate pair. Then it runs the *actual* gateway-side
 * adjacency code — the shared `expandOneHop` walker and the
 * `fetch_many(includeNeighbors)` document port — against those real,
 * pipeline-produced graphs.
 *
 * Why exercise the gateway functions in-process rather than over HTTP: the new
 * surfaces (refCount, breadcrumb, neighbours, the honest trail budget) are
 * agent-tool-only — there is no plain HTTP route, and the replay backend bakes
 * canned tool results rather than executing tools. Running the real functions
 * against the spawned gateway's on-disk DB is the highest-fidelity automated
 * check available: real corpus, real workers, real walker, real port. The
 * field-shaping branches (refCount mapping, breadcrumb attach, schema) are
 * covered exhaustively by the gateway unit/integration suites; this file proves
 * the substrate is real end to end.
 */

import "./synth-env.js";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expandOneHop } from "@omnesis/gateway/src/domain/DocumentGraphService.js";
import { createGatewayDocumentPort } from "@omnesis/gateway/src/agent/ports.js";
import { nearDupRebuildOnAnyFile, SyntheticE2EHarness } from "./synth-harness.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const PDF_TITLE = "Q4-Vendor-Assessment.pdf";
const NEAR_DUP_SHARED = `Migration rehearsal checklist. The delivery plan covers schema validation, access controls, rollback rehearsal, audit logging, and capacity checks. The team will stage the migration in an isolated environment, compare record counts, verify checksums, and rehearse the recovery procedure before approving the production window. Every owner will record evidence in the change log, confirm that alerts reach the on-call rotation, and validate that the read-only fallback remains available throughout the cutover. The final checklist includes dependency health, queue depth, error budgets, customer communication, and a signed go-or-no-go decision.`;
const NEAR_DUP_A = "e2e-near-dup-a";
const NEAR_DUP_B = "e2e-near-dup-b";
const PARKED_NEAR_DUP_PERIOD_MS = 999_999_999;

describe("Adjacency-aware retrieval — expandOneHop + includeNeighbors (default universe)", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: join(REPO_ROOT, "evals/universes/default"),
      extraGatewayConfig: {
        nearDuplicates: {
          scheduler: {
            computePeriodMs: PARKED_NEAR_DUP_PERIOD_MS,
            computeIdlePeriodMs: PARKED_NEAR_DUP_PERIOD_MS,
            ...nearDupRebuildOnAnyFile(),
          },
        },
      },
    });
    await harness.start();

    const targets = harness
      .getSourceIds()
      .filter((id) => id.startsWith("whatsapp-messages:") || id.startsWith("gmail:"));
    await Promise.all(targets.map((id) => harness.triggerSyncAndWait(id, 90_000)));
    const drainedSync = await harness.stopSyncLoopsAndDrain(60_000);
    expect(
      drainedSync.timedOut,
      `collector did not drain (started with ${drainedSync.inflight} syncs in flight)`,
    ).toBe(false);

    // Inject the calibrated pair only after source ingestion is permanently
    // drained. The long automatic compute cadence prevents it being consumed
    // against an older DF snapshot before the exact pipeline below runs.
    await harness.pushDocuments([
      {
        externalId: NEAR_DUP_A,
        documentType: "note",
        title: "Migration rehearsal checklist — draft",
        content: `${NEAR_DUP_SHARED}\n\n${NEAR_DUP_SHARED}\n\nVersion marker: alpha.`,
      },
      {
        externalId: NEAR_DUP_B,
        documentType: "note",
        title: "Migration rehearsal checklist — revised",
        content: `${NEAR_DUP_SHARED}\n\n${NEAR_DUP_SHARED}\n\nVersion marker: beta.`,
      },
    ]);

    db = new Database(harness.getDbPath(), { readonly: true });
    await harness.convergeNearDuplicates(120_000);

    // The walker depends on the async link-backfill worker having produced the
    // attachment + thread edges. linkBackfill populates these incrementally, so
    // gate on the SPECIFIC 023↔024 thread edge the test asserts — a generic
    // "any thread edge exists" gate can pass a beat before this pair lands
    // (the race trail-graph.e2e handles the same way).
    await waitForLinkCondition(
      db,
      () => {
        const attachments = (
          db
            .prepare("SELECT COUNT(*) AS c FROM document_links WHERE link_type = 'contains'")
            .get() as { c: number }
        ).c;
        if (attachments < 2) return false;
        const e023 = findDoc(db, "synth-gmail-023");
        const e024 = findDoc(db, "synth-gmail-024");
        if (!e023 || !e024) return false;
        const threadEdge = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM document_links
               WHERE link_type = 'part-of-thread'
                 AND ((source_doc_id = ? AND target_doc_id = ?)
                   OR (source_doc_id = ? AND target_doc_id = ?))`,
            )
            .get(e023.id, e024.id, e024.id, e023.id) as { c: number }
        ).c;
        return threadEdge >= 1;
      },
      90_000,
    );
  }, 540_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 15_000);

  test("expandOneHop surfaces the Gmail email's neighbourhood, attachment ranked first", () => {
    const email = findDoc(db, "synth-gmail-023");
    expect(email, "gmail-023 should exist").toBeTruthy();

    const { neighbors } = expandOneHop(db, email!.id);
    const titles = neighbors.map((n) => n.title ?? "");

    // The attachment PDF and the thread reply are produced by the readiness-
    // gated workers, so both are reliably present.
    expect(titles, "should reach the attached PDF").toContain(PDF_TITLE);
    expect(
      titles.some((t) => t.includes("Re: Q4 Vendor Assessment")),
      "should reach the thread reply (synth-gmail-024)",
    ).toBe(true);

    // Ranking: attachment (rank 0) is the single most-structural edge, so it
    // is the first neighbour regardless of how many others landed.
    expect(neighbors[0]?.title).toBe(PDF_TITLE);
    expect(neighbors[0]?.edgeType).toBe("contains");
    // Direction reflects however linkBackfill stored the parent↔attachment
    // edge (child→parent in the real corpus → "inbound" from the email); the
    // expander faithfully reports it. Assert it's a real direction, not a
    // specific storage convention.
    expect(["inbound", "outbound", "peer"]).toContain(neighbors[0]?.direction);

    // Bounded: the one-hop expansion never returns an unbounded blob.
    expect(neighbors.length).toBeLessThanOrEqual(8);
  });

  test("fetch_many(includeNeighbors) returns compact neighbour DocRefs", async () => {
    const email = findDoc(db, "synth-gmail-023");
    const out = await createGatewayDocumentPort(db).fetch(email!.id, { includeNeighbors: true });

    expect(out?.neighbors, "neighbours present").toBeDefined();
    const att = out!.neighbors!.find((n) => n.title === PDF_TITLE);
    expect(att, "the attached PDF is among the neighbours").toBeTruthy();
    // A neighbour DocRef is a pointer, not a payload: no snippet body.
    expect(att!.snippet).toBeUndefined();
    // …and it carries the id that makes it fetchable / citable.
    expect(att!.documentId).toBeTruthy();
  });

  test("the converged near-duplicate edge is reachable in one hop", () => {
    const first = findDoc(db, NEAR_DUP_A);
    const second = findDoc(db, NEAR_DUP_B);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const edge = db
      .prepare(
        `SELECT COUNT(*) AS c FROM near_dup_edges
         WHERE (doc_a = ? AND doc_b = ?) OR (doc_a = ? AND doc_b = ?)`,
      )
      .get(first!.id, second!.id, second!.id, first!.id) as { c: number };
    expect(edge.c, "the production pipeline should materialise the intended pair").toBe(1);

    const hashes = db
      .prepare("SELECT content_hash FROM documents WHERE id IN (?, ?) ORDER BY id")
      .all(first!.id, second!.id) as Array<{ content_hash: string }>;
    expect(hashes).toHaveLength(2);
    expect(hashes[0]!.content_hash, "the pair must not be exact duplicates").not.toBe(
      hashes[1]!.content_hash,
    );

    const { neighbors } = expandOneHop(db, first!.id);
    expect(
      neighbors.some(
        (neighbor) => neighbor.documentId === second!.id && neighbor.edgeType === "near-duplicate",
      ),
      "the near-duplicate neighbour is reachable in one hop",
    ).toBe(true);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function findDoc(
  db: InstanceType<typeof Database>,
  externalId: string,
): { id: string; title: string } | undefined {
  return db.prepare("SELECT id, title FROM documents WHERE external_id = ?").get(externalId) as
    | { id: string; title: string }
    | undefined;
}

async function waitForLinkCondition(
  db: InstanceType<typeof Database>,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Link condition not met within ${timeoutMs}ms`);
}
