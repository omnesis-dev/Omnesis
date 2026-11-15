// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keyword-index rebuild across lexical versions, end to end.
 *
 * A real gateway indexes a corpus with the lexical version its code targets
 * (the base version below), then restarts with a
 * newer version as its target (test-only versions 9001 and 9002, which reverse
 * every word, so a query cut by the wrong version matches nothing). The test
 * proves the agreed behavior of a rebuild:
 *
 * - the gateway answers at once, and search keeps answering by the old version
 *   until the switch, then by the new one, never anything in between;
 * - chunks added, changed and deleted during the rebuild end up right;
 * - a gateway killed mid-rebuild resumes from where it stopped;
 * - a newer version arriving mid-rebuild discards the unfinished one;
 * - the replaced index is deleted and the final index passes SQLite's own
 *   integrity check;
 * - a later downgrade rebuilds back to the version the code knows;
 * - search stays responsive throughout.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerLexicalFunctions } from "@omnesis/gateway/src/indexer/lexical-index-store.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const TOPICS = ["garden", "harbor", "orchard", "lantern", "meadow"];
const DOCS = 1200;
/** Documents carrying the probe word; the probe expects exactly this many results. */
const PROBE_DOCS = 10;
const PROBE_WORD = "zephyrine";

interface SearchAnswer {
  results: Array<{ documentId: string }>;
  stages?: { bm25?: { lexicalVersion?: number } };
}

interface LexicalStatus {
  activeVersion: number | null;
  targetVersion: number;
  retiring: boolean;
  building: {
    version: number;
    chunksDone: number;
    chunksTotal: number;
    phase: "copying" | "switching";
  } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Keyword-index rebuild between lexical versions", () => {
  let harness: SyntheticE2EHarness;
  /** The version the gateway's code targets, read from the first status. */
  let base = -1;

  const search = (text: string, limit = 50) =>
    harness.gatewayJson<SearchAnswer>("/search", {
      method: "POST",
      body: JSON.stringify({ text, limit }),
    });
  const lexical = async (): Promise<LexicalStatus> => {
    const { lexicalIndex } = await harness.gatewayJson<{ lexicalIndex?: LexicalStatus }>(
      "/index/stats",
    );
    if (!lexicalIndex) throw new Error("/index/stats reported no keyword index");
    return lexicalIndex;
  };
  const until = async <T>(
    what: string,
    read: () => Promise<T>,
    done: (v: T) => boolean,
    timeoutMs = 180_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        const value = await read();
        if (done(value)) return value;
        last = value;
      } catch (err) {
        // The gateway can be between states (a worker still starting); read again.
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
      await sleep(250);
    }
  };

  /**
   * Searches for the probe word every 150 ms while the gateway is up, recording
   * how long each took, how many results came back and which lexical version
   * answered.
   */
  const probe = {
    running: false,
    paused: false,
    samples: [] as Array<{ ms: number; count: number; version: number | undefined }>,
    errors: [] as string[],
    loop: Promise.resolve(),
    start() {
      this.running = true;
      this.loop = (async () => {
        while (this.running) {
          if (!this.paused) {
            const sent = Date.now();
            try {
              const answer = await search(PROBE_WORD);
              this.samples.push({
                ms: Date.now() - sent,
                count: answer.results.length,
                version: answer.stages?.bm25?.lexicalVersion,
              });
            } catch (err) {
              if (!this.paused) this.errors.push(err instanceof Error ? err.message : String(err));
            }
          }
          await sleep(150);
        }
      })();
    },
    async stop() {
      this.running = false;
      await this.loop;
    },
  };
  const restart = async (options: Parameters<SyntheticE2EHarness["restartGateway"]>[0]) => {
    probe.paused = true;
    await harness.restartGateway(options);
    probe.paused = false;
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      // Small batches and long pauses keep the rebuild running long enough to
      // observe, change and interrupt it.
      extraGatewayConfig: { indexer: { lexicalRebuild: { batchSize: 10, pause: "400ms" } } },
    });
    await harness.start();
    const docs = Array.from({ length: DOCS }, (_, i) => ({
      externalId: `lexical-rebuild-${i}`,
      title: `Planning note ${i}`,
      content:
        `Quarterly budget note number ${i} about the ${TOPICS[i % TOPICS.length]} project, ` +
        `filed under tag${i}.${i < PROBE_DOCS ? ` ${PROBE_WORD}` : ""}`,
    }));
    for (let i = 0; i < docs.length; i += 200) await harness.pushDocuments(docs.slice(i, i + 200));
    await until(
      "the corpus to be indexed",
      () => harness.gatewayJson<{ totalIndexed?: number }>("/index/stats"),
      (s) => (s.totalIndexed ?? 0) >= DOCS,
    );
  }, 300_000);

  afterAll(async () => {
    await probe.stop();
    await harness?.destroy();
  });

  test("a new gateway indexes with the version its code targets and has nothing to rebuild", async () => {
    const status = await lexical();
    base = status.targetVersion;
    expect(status).toMatchObject({ activeVersion: base, building: null });
    const answer = await search(PROBE_WORD);
    expect(answer.results).toHaveLength(PROBE_DOCS);
    expect(answer.stages?.bm25?.lexicalVersion).toBe(base);
  });

  test("rebuilds to a new version in the background while search keeps answering by the old one", async () => {
    await restart({ extraGatewayEnv: { OMNESIS_LEXICAL_TEST_VERSION: "9001" } });
    probe.start();
    const copying = await until(
      "the rebuild to start",
      lexical,
      (s) => s.building?.version === 9001 && s.building.phase === "copying",
      60_000,
    );
    expect(copying).toMatchObject({ activeVersion: base, targetVersion: 9001 });
    const answer = await search(PROBE_WORD);
    expect(answer.results).toHaveLength(PROBE_DOCS);
    expect(answer.stages?.bm25?.lexicalVersion).toBe(base);
  }, 120_000);

  test("chunks written during the rebuild, a crash and a newer version are all absorbed", async () => {
    // Changes while the rebuild copies.
    await harness.pushDocuments([
      { externalId: "lexical-rebuild-new", title: "Festival", content: "Zebra lantern festival" },
      {
        externalId: "lexical-rebuild-15",
        title: "Planning note 15",
        content: "Quarterly budget note number 15, revised with the cobaltium supplier.",
      },
    ]);
    // Neither touches the probe documents (0-9), so the probe's count stays fixed.
    const deleted = (await search("tag17")).results;
    expect(deleted).toHaveLength(1);
    await harness.gatewayJson(`/documents/${encodeURIComponent(deleted[0].documentId)}`, {
      method: "DELETE",
    });

    // A crash mid-copy: the rebuild resumes from its cursor, not from zero.
    const beforeCrash = await until("the copy in progress", lexical, (s) => s.building !== null);
    expect(beforeCrash.building?.phase).toBe("copying");
    await restart({ signal: "SIGKILL" });
    const afterCrash = await until(
      "the build after the crash",
      lexical,
      (s) => s.building !== null,
    );
    expect(afterCrash.building?.version).toBe(9001);
    expect(afterCrash.building!.chunksDone).toBeGreaterThanOrEqual(
      beforeCrash.building!.chunksDone,
    );
    expect(afterCrash.activeVersion).toBe(base);

    // A newer version before the copy finished: the unfinished build is discarded.
    const beforeNewer = await until("the copy in progress", lexical, (s) => s.building !== null);
    expect(beforeNewer.building?.phase).toBe("copying");
    await restart({ extraGatewayEnv: { OMNESIS_LEXICAL_TEST_VERSION: "9002" } });
    const superseded = await until("the newer build", lexical, (s) => s.building?.version === 9002);
    expect(superseded.activeVersion).toBe(base);

    const finished = await until(
      "the switch to version 9002",
      lexical,
      (s) => s.activeVersion === 9002 && s.building === null && !s.retiring,
      300_000,
    );
    expect(finished.targetVersion).toBe(9002);
    // Search workers take up the new in-memory index once it has caught up with
    // the writes since it was built; keep probing until one answers by it.
    const adopted = Date.now() + 60_000;
    while (probe.samples.at(-1)?.version !== 9002 && Date.now() < adopted) await sleep(250);
    await probe.stop();

    const versions = probe.samples.map((s) => s.version);
    // Every probe found every probe document: no search ever saw a half-switched index.
    expect(probe.samples.filter((s) => s.count !== PROBE_DOCS)).toEqual([]);
    expect(probe.errors).toEqual([]);
    // Answered by the base version before the switch and 9002 after it, and by
    // nothing else; for a moment at the switch, search workers that have not
    // yet taken up the new in-memory index still answer, correctly, by the base.
    expect(new Set(versions)).toEqual(new Set([base, 9002]));
    expect(versions[0]).toBe(base);
    expect(versions[versions.length - 1]).toBe(9002);
    // Search stayed responsive while the rebuild ran.
    const latencies = probe.samples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    expect(p95).toBeLessThan(2_000);

    // What changed during the rebuild is searchable as it is now.
    const ids = async (q: string) => (await search(q)).results.length;
    expect(await ids("zebra lantern")).toBe(1);
    expect(await ids("cobaltium")).toBe(1);
    expect(await ids("tag17")).toBe(0);
    expect(await ids("tag15")).toBe(0);
    expect((await search("tag8")).stages?.bm25?.lexicalVersion).toBe(9002);
  }, 600_000);

  test("the replaced index is gone and the active one passes SQLite's integrity check", async () => {
    let tables: string[] = [];
    await restart({
      whileStopped: () => {
        const db = new Database(harness.indexDbPath);
        try {
          registerLexicalFunctions(db);
          tables = db
            .prepare<[], { name: string }>(
              "SELECT name FROM sqlite_master WHERE name LIKE 'chunks_fts%' ORDER BY name",
            )
            .all()
            .map((r) => r.name);
          db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
        } finally {
          db.close();
        }
      },
    });
    expect(tables.filter((t) => t.includes("_next") || t.includes("_retired"))).toEqual([]);
    expect(tables).toContain("chunks_fts");
  }, 120_000);

  test("a downgrade rebuilds back to the version the running code targets", async () => {
    await restart({ extraGatewayEnv: {} });
    const during = await search(PROBE_WORD);
    expect(during.results).toHaveLength(PROBE_DOCS);
    await until(
      "the switch back to the base version",
      lexical,
      (s) => s.activeVersion === base && s.building === null && !s.retiring,
      300_000,
    );
    const answer = await search(PROBE_WORD);
    expect(answer.results).toHaveLength(PROBE_DOCS);
    expect(answer.stages?.bm25?.lexicalVersion).toBe(base);
  }, 400_000);
});
