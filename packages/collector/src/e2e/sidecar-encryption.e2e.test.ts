// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end proof that the HNSW graph persists across an ENCRYPTED gateway
 * restart, through the REAL gateway boot/shutdown path, with search correctness
 * preserved.
 *
 * `OMNESIS_SECRET_STORE=file` + a provisioned install root key boots the gateway
 * with storage encryption ARMED, so the plaintext `index.usearch` is not durable
 * at rest — the gateway writes the encrypted `index.usearch.enc` at shutdown and
 * restores the plaintext from it at boot (mmap-served while running). The
 * `"fake"` embedder makes the vector space deterministic, so a search returns
 * identical results across the restart — the correctness invariant we assert.
 *
 * (The rejection/rebuild fallbacks for a corrupt, stale, or wrong-key `.enc` are
 * covered deterministically at the handle level in
 * `packages/gateway/src/indexer/usearch-sidecar-integration.test.ts`; a clean
 * restart here would overwrite any corruption on shutdown, so those paths can't
 * be exercised through this harness.)
 */

import "./synth-env.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureInstallRootKey } from "@omnesis/core";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface SearchResult {
  documentId: string;
  title: string;
  score: number;
}
interface SearchResponse {
  results?: SearchResult[];
  stages?: { vector?: { status?: "ran" | "skipped"; candidates?: number } };
}

const QUERY = "reservation at the riverside restaurant on saturday";
const CORPUS = [
  { externalId: "sx-1", title: "Marathon plan", content: "weekly long runs and interval workouts" },
  {
    externalId: "sx-2",
    title: "Q4 budget",
    content: "quarterly review of department spending forecasts",
  },
  {
    externalId: "sx-3",
    title: "Dinner booking",
    content: "table booked at the riverside restaurant saturday evening",
  },
  {
    externalId: "sx-4",
    title: "Flight itinerary",
    content: "morning departure with a connecting flight and a window seat",
  },
  {
    externalId: "sx-5",
    title: "Book club",
    content: "the group meets to discuss the new novel next thursday",
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(h: SyntheticE2EHarness, text: string): Promise<SearchResponse> {
  return h.gatewayJson<SearchResponse>("/search", {
    method: "POST",
    body: JSON.stringify({ text, limit: 10, verbose: true }),
  });
}

/** Poll until the vector stage returns candidates for `text` (the index is warm). */
async function waitForVectorHits(
  h: SyntheticE2EHarness,
  text: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: SearchResponse | undefined;
  while (Date.now() < deadline) {
    await h.refreshSearchSnapshot();
    const res = await search(h, text);
    lastResponse = res;
    const vec = res.stages?.vector;
    if (vec?.status === "ran" && (vec.candidates ?? 0) > 0 && (res.results?.length ?? 0) > 0)
      return;
    await sleep(1500);
  }
  throw new Error(
    `sidecar e2e: vector stage never produced candidates for "${text}" ` +
      `(embedCount=${h.getEmbedCount()}, lastResponse=${JSON.stringify(lastResponse)})`,
  );
}

const rank = (r: SearchResponse): string[] => (r.results ?? []).map((x) => x.documentId);

describe("encrypted sidecar persists the HNSW graph across a restart", () => {
  let harness: SyntheticE2EHarness;
  let priorSecretStore: string | undefined;
  let encPath = "";
  let plaintextPath = "";

  beforeAll(async () => {
    priorSecretStore = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      // Put the corpus behind the gateway as soon as HTTP is ready to pressure
      // the startup indexing and persistence handoff. Worker-level tests pin
      // the exact boot phase deterministically.
      initialDocuments: CORPUS,
    });
    // Provision the install root key in the file secret store so the gateway
    // boots with storage encryption ARMED — that is what turns on the encrypted
    // sidecar path (`init.indexDbKeyHex` reaches the indexer worker).
    await ensureInstallRootKey({ backend: "file", configDir: harness.getConfigDir() });
    await harness.start();
    await waitForVectorHits(harness, QUERY);
    encPath = join(harness.getConfigDir(), "index.usearch.enc");
    plaintextPath = join(harness.getConfigDir(), "index.usearch");
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  }, 30_000);

  it("a clean restart restores the graph from the encrypted sidecar, search unchanged", async () => {
    const golden = rank(await search(harness, QUERY));
    expect(golden.length).toBeGreaterThan(0);
    const pidBefore = harness.gatewayPid;

    await harness.restartGateway(); // shutdown encrypts the sidecar → boot restores it
    await waitForVectorHits(harness, QUERY);

    // The restart truly replaced the process (so what follows measures the NEW
    // instance, not a lingering old one mid-shutdown).
    expect(harness.gatewayPid).not.toBe(pidBefore);
    // Durable encrypted sidecar + a plaintext working copy re-materialised at boot.
    expect(existsSync(encPath)).toBe(true);
    expect(readFileSync(encPath).length).toBeGreaterThan(0);
    expect(existsSync(plaintextPath)).toBe(true);
    // The correctness invariant: identical results across the encrypted restart.
    // (That the restore path — not a full rebuild — was taken is proven
    // deterministically at the handle level in usearch-sidecar-integration.test.ts,
    // where a restored graph is asserted loaded, NOT rebuilt.)
    expect(rank(await search(harness, QUERY))).toEqual(golden);
  }, 150_000);

  it("new documents indexed after the encrypted restore grow the live vector index", async () => {
    // Guards against read-handle staleness after a restore: a restored graph
    // must still pick up vectors added post-restart (the worker save() + the
    // read handle's mmap refresh must keep working over the restored file). In
    // this tiny corpus the HNSW returns every vector as a candidate, so the
    // candidate count IS the live index size — the deterministic `fake` embedder
    // is not semantic, so we assert the index GREW, not a semantic ranking.
    const before = (await search(harness, QUERY)).stages?.vector?.candidates ?? 0;
    expect(before).toBeGreaterThanOrEqual(CORPUS.length);

    await harness.pushDocuments([
      {
        externalId: "sx-new",
        title: "Excursion",
        content: "an extra document added after the restore",
      },
    ]);

    const deadline = Date.now() + 120_000;
    let after = before;
    while (Date.now() < deadline) {
      await harness.refreshSearchSnapshot();
      after = (await search(harness, QUERY)).stages?.vector?.candidates ?? 0;
      if (after > before) break;
      await sleep(1500);
    }
    expect(after).toBe(before + 1); // the read handle refreshed over the restored graph
  }, 150_000);

  it("survives a SECOND restart with search still identical", async () => {
    const golden = rank(await search(harness, QUERY));
    const pidBefore = harness.gatewayPid;
    await harness.restartGateway();
    await waitForVectorHits(harness, QUERY);
    expect(harness.gatewayPid).not.toBe(pidBefore);
    expect(rank(await search(harness, QUERY))).toEqual(golden);
    expect(existsSync(encPath)).toBe(true);
  }, 150_000);
});
