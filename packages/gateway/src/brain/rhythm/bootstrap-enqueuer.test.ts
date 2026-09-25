// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the retrospective bootstrap enqueuer's lifecycle: it enqueues
 * candidates, goes quiet without work, skips the corpus probe while quiet,
 * and reopens when a source arrives or a new day begins. Also covers the boot
 * hold (which covers every pass, and expires on wall clock rather than on
 * process lifetime), the ordering that keeps the cheap room checks ahead of
 * the corpus probe, the lifetime backstop parking (rather than ending) the
 * lane, and the per-source coverage tallies the enqueue pass feeds —
 * including the direction of that dependency, which runs one way only: the
 * pass writes coverage and never consults it.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../../enrichment/dates/storage.js";
import { listCognitionRuns } from "../storage/run-queue.js";
import { listCognitionCoverage, recordCognitionCoverage } from "../storage/coverage.js";
import {
  getCognitionEngineState,
  COGNITION_BOOTSTRAP_STATE_KEY,
  COGNITION_BOOTSTRAP_TOTAL_KEY,
} from "../storage/engine-state.js";
import {
  runBootstrapEnqueuePass,
  BOOTSTRAP_BOOT_GRACE_MS,
  type BootstrapEnqueuerDeps,
  type BootstrapSettings,
} from "./bootstrap-enqueuer.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Far enough ahead that the "still relevant" period-end test always holds. */
const FUTURE = "2099-06-01";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const SETTINGS: BootstrapSettings = {
  enabled: true,
  // One week, matching the live waker's default recency window.
  recencyWindowMs: 7 * DAY_MS,
  direction: "recent-first",
  backlogTarget: 200,
  maxRunsPerDay: 200,
  maxRuns: 1_000_000,
  batchSize: 100,
};

describe("runBootstrapEnqueuePass", () => {
  let path: string;
  let db: Db;
  let now: number;
  let settings: BootstrapSettings;
  /** Corpus probes counted by wrapping the read handle's `prepare`. */
  let probes: number;
  /** Every statement prepared since the last reset, in order. */
  let preparedSql: string[];
  /** Info lines the pass logged — the operator guidance is part of the contract. */
  let infoLines: string[];

  /** A logger that keeps what it was told, so a test can read the guidance. */
  function captureLog(): Logger {
    return {
      debug: () => {},
      info: (message: string) => void infoLines.push(message),
      warn: () => {},
      error: () => {},
      child: () => captureLog(),
    };
  }

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    // A started lane is the state nearly every test here is about. Starting is
    // its own operator decision (see "the lane waits to be started"), so a
    // fresh database has not made it — and without this every test would be
    // asserting the un-started case by accident.
    db.prepare(
      "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("bootstrap_started_at", String(NOW));
    now = NOW;
    settings = { ...SETTINGS };
    probes = 0;
    preparedSql = [];
    infoLines = [];
    seq = 0;
    // The candidate probe is the only statement joining the extracted-date
    // table, so counting those preparations counts corpus scans.
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("document_extracted_dates")) probes += 1;
      preparedSql.push(sql);
      return realPrepare(sql);
    }) as Db["prepare"];
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  // Run ids stay unique across every pass a test drives, so a second pass
  // enqueues a new row instead of colliding with the first one's.
  let seq = 0;

  function deps(overrides: Partial<BootstrapEnqueuerDeps> = {}): BootstrapEnqueuerDeps {
    return {
      db,
      writeGate: directWriteGate(db),
      clock: () => now,
      getSettings: () => settings,
      log: captureLog(),
      // Default the tests past the boot window; the ones that care set their
      // own value.
      startedAt: NOW - BOOTSTRAP_BOOT_GRACE_MS - 1,
      idGen: () => `b${++seq}`,
      ...overrides,
    };
  }

  /** A historical document with a still-future extracted date. */
  function seedCandidate(externalId: string, sourceId: string): void {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: sourceId as DocumentInput["sourceId"],
      externalId,
      title: "Storage lease renewal",
      content: "The lease runs until 2099.",
      contentHash: `hash-${externalId}`,
      metadata: { documentType: "email" },
      // Well outside the recency window, so this is the bootstrap lane's.
      sourceCreatedAt: "2024-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    const id = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
    applyExtractedDates(db, [
      {
        id,
        dates: [
          {
            kind: "date",
            resolvedStart: FUTURE,
            resolvedEnd: null,
            relative: false,
            text: FUTURE,
            timex: FUTURE,
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
  }

  /** A `sources` row — what the lane watches to know a corpus arrived. */
  function seedSource(id: string, createdAt: number): void {
    db.prepare("INSERT OR IGNORE INTO devices (id, name, kind, paired_at) VALUES (?, ?, ?, ?)").run(
      "device-1",
      "Test collector",
      "collector",
      1,
    );
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'device-1', '{}', 1, ?, ?)`,
    ).run(id, id.split(":")[0], id.split(":")[1] ?? "local", createdAt, createdAt);
  }

  const laneState = (): string | null => getCognitionEngineState(db, COGNITION_BOOTSTRAP_STATE_KEY);
  const bootstrapRuns = (): ReturnType<typeof listCognitionRuns> =>
    listCognitionRuns(db, { limit: 200 }).filter((r) => r.kind === "bootstrap");

  test("enqueues its candidates and tallies them per source", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    seedCandidate("lease-2", "mail:maya@example.com");

    const result = await runBootstrapEnqueuePass(deps());

    expect(result).toMatchObject({ enqueued: 2, state: "running" });
    expect(bootstrapRuns()).toHaveLength(2);
    expect(listCognitionCoverage(db)).toEqual([
      {
        sourceId: "mail:maya@example.com",
        workflowId: "source-bootstrap",
        workflowVersion: 1,
        eligible: 2,
        processed: 0,
        skipped: 0,
        promptTokens: 0,
        completionTokens: 0,
        lastProgressAt: now,
        status: "in-progress",
      },
    ]);
  });

  test("goes quiet without candidates, and stays quiet without paying for a probe", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "drained" });
    expect(laneState()).toBe("drained");

    // A drained lane costs two key reads, not a corpus scan.
    const probesAfterDrain = probes;
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "drained" });
    expect(probes).toBe(probesAfterDrain);
  });

  test("reopens when a source is added", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    await runBootstrapEnqueuePass(deps());
    expect(laneState()).toBe("drained");

    // The very shape of the bug this replaced: a lane that went quiet on a
    // young install, then a source arrives carrying years of history.
    seedSource("files:jamie@example.com", now);
    seedCandidate("contract-1", "files:jamie@example.com");

    const result = await runBootstrapEnqueuePass(deps());
    expect(result).toMatchObject({ enqueued: 1, state: "running" });
    expect(bootstrapRuns()).toHaveLength(1);
  });

  test("reopens on a new day, so a document that ages into range is not stranded", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    await runBootstrapEnqueuePass(deps());
    expect(laneState()).toBe("drained");

    // No new source — only time passing, and a document whose date enrichment
    // landed after the lane went quiet.
    seedCandidate("invoice-1", "mail:maya@example.com");
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "drained" });

    now += DAY_MS;
    const result = await runBootstrapEnqueuePass(
      deps({ startedAt: now - BOOTSTRAP_BOOT_GRACE_MS - 1 }),
    );
    expect(result).toMatchObject({ enqueued: 1, state: "running" });
  });

  test("holds the re-probe inside the boot window", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    await runBootstrapEnqueuePass(deps());
    seedCandidate("invoice-1", "mail:maya@example.com");
    now += DAY_MS;

    // Freshly booted: the reopen reason holds until the backfill workers have
    // had the read handle to themselves for a while.
    const justBooted = deps({ startedAt: now - 1_000 });
    expect(await runBootstrapEnqueuePass(justBooted)).toMatchObject({
      enqueued: 0,
      state: "drained",
    });

    now += BOOTSTRAP_BOOT_GRACE_MS;
    expect(await runBootstrapEnqueuePass(justBooted)).toMatchObject({
      enqueued: 1,
      state: "running",
    });
  });

  test("holds a first-ever lane too, not only a drained one's re-probe", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    const probesBefore = probes;

    // Nothing recorded and candidates waiting — the lane has never gone quiet,
    // so no reopen decision is involved. It must still stay off the corpus
    // while the backfill workers own the handle.
    const justBooted = deps({ startedAt: now - 1_000 });
    expect(await runBootstrapEnqueuePass(justBooted)).toMatchObject({
      enqueued: 0,
      state: "running",
    });
    expect(probes).toBe(probesBefore);
    expect(bootstrapRuns()).toHaveLength(0);
    expect(laneState()).toBeNull();

    now += BOOTSTRAP_BOOT_GRACE_MS;
    expect(await runBootstrapEnqueuePass(justBooted)).toMatchObject({
      enqueued: 1,
      state: "running",
    });
  });

  test("a restart loop cannot starve the lane forever", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    await runBootstrapEnqueuePass(deps());
    seedCandidate("invoice-1", "mail:maya@example.com");
    now += DAY_MS;

    // A gateway restarting more often than the window is long: every pass runs
    // inside a fresh process's boot window, so no process ever outlives it.
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      expect(await runBootstrapEnqueuePass(deps({ startedAt: now - 1_000 }))).toMatchObject({
        enqueued: 0,
        state: "drained",
      });
    }

    // The hold is measured in wall clock, so it expires on schedule regardless
    // of how many times the process was replaced under it.
    now += BOOTSTRAP_BOOT_GRACE_MS;
    expect(await runBootstrapEnqueuePass(deps({ startedAt: now - 1_000 }))).toMatchObject({
      enqueued: 1,
      state: "running",
    });
  });

  test("the backlog cap short-circuits ahead of the corpus probe", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    seedCandidate("lease-2", "mail:maya@example.com");
    settings.backlogTarget = 1;
    settings.batchSize = 1;

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 1, state: "running" });

    // The queue is at its cap, so this pass can enqueue nothing whatever the
    // corpus holds — and the probe is the expensive part of a pass.
    const probesBefore = probes;
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "running" });
    expect(probes).toBe(probesBefore);
  });

  test("the daily cap short-circuits ahead of the probe, and names the knob to raise", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    seedCandidate("lease-2", "mail:maya@example.com");
    settings.maxRunsPerDay = 1;
    settings.batchSize = 1;

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 1, state: "running" });
    // The pace cap is what an operator watching history converge slowly would
    // want to raise, so the lane says which knob that is when it hits it.
    expect(infoLines.some((line) => line.includes("brain.bootstrap.maxRunsPerDay"))).toBe(true);

    const probesBefore = probes;
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "running" });
    expect(probes).toBe(probesBefore);
  });

  test("parks at the lifetime run backstop and resumes when it is raised", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    seedCandidate("lease-2", "mail:maya@example.com");
    settings.maxRuns = 1;
    settings.batchSize = 1;

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 1, state: "running" });
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "parked" });
    expect(laneState()).toBe("parked");
    expect(getCognitionEngineState(db, COGNITION_BOOTSTRAP_TOTAL_KEY)).toBe("1");

    // Parked, not finished: raising the ceiling resumes on the next tick,
    // with no state row for the operator to find and edit.
    settings.maxRuns = 5;
    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 1, state: "running" });
    expect(bootstrapRuns()).toHaveLength(2);
  });

  test("a source its own tally calls covered is still selected", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    // A tally asserting this source's catch-up is finished, over the exact
    // (source, workflow, version) key the lane writes. Selection is decided by
    // the datum's own timestamp against the recency window, so this must not
    // move the outcome — were it consulted, a mis-count would silently strand
    // a source's history.
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          eligible: 500,
          processed: 500,
        },
      ],
      now,
    );
    expect(listCognitionCoverage(db)[0]?.status).toBe("settled");

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 1, state: "running" });
    expect(bootstrapRuns()).toHaveLength(1);
  });

  test("the pass writes coverage and never reads it", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");

    // Only the pass's own statements — the seeding above prepares plenty.
    preparedSql = [];
    await runBootstrapEnqueuePass(deps());

    const touching = preparedSql.filter((sql) => sql.includes("cognition_coverage"));
    expect(touching.length).toBeGreaterThan(0);
    expect(touching.map((sql) => sql.trimStart().slice(0, 6).toUpperCase())).toEqual(
      touching.map(() => "INSERT"),
    );
  });

  test("does nothing at all while the knob is off", async () => {
    seedSource("mail:maya@example.com", NOW - 30 * DAY_MS);
    seedCandidate("lease-1", "mail:maya@example.com");
    settings.enabled = false;

    expect(await runBootstrapEnqueuePass(deps())).toMatchObject({ enqueued: 0, state: "idle" });
    expect(laneState()).toBeNull();
    expect(bootstrapRuns()).toHaveLength(0);
  });

  describe("what the pass reports about the backlog", () => {
    test("a pass that probed the corpus says what is left", async () => {
      seedCandidate("bs-a", "src:a");
      seedCandidate("bs-b", "src:b");
      const result = await runBootstrapEnqueuePass(deps());
      expect(result.enqueued).toBeGreaterThan(0);
      expect(typeof result.remaining).toBe("number");
    });

    test("a pass that never looked reports nothing rather than zero", async () => {
      // The distinction the progress gauge depends on. A boot hold, a shut
      // window or a quiet lane all return without probing, and a gauge reading
      // their silence as "0 remaining" would show the backfill as finished
      // while it still owed thousands of documents.
      seedCandidate("bs-c", "src:a");
      const held = await runBootstrapEnqueuePass(deps({ startedAt: now - 1_000 }));
      expect(held.enqueued).toBe(0);
      expect(held.remaining).toBeUndefined();
    });

    test("an off lane reports nothing either", async () => {
      const off = await runBootstrapEnqueuePass(
        deps({ getSettings: () => ({ ...settings, enabled: false }) }),
      );
      expect(off.remaining).toBeUndefined();
    });
  });

  describe("the lane waits to be started", () => {
    test("buys nothing until the operator has started it", async () => {
      // Assigning a background-agent model is a capability choice. Reading it
      // as consent to spend for days working through history is a commitment
      // nobody made, so the lane sits still until asked.
      seedCandidate("bs-unstarted", "src:a");
      db.prepare("DELETE FROM cognition_engine_state WHERE key = ?").run("bootstrap_started_at");
      const result = await runBootstrapEnqueuePass(deps());
      expect(result.enqueued).toBe(0);
      expect(result.state).toBe("idle");
      // And it reports no backlog figure, so a gauge cannot read the silence
      // as "nothing left".
      expect(result.remaining).toBeUndefined();
    });

    test("works normally once started", async () => {
      seedCandidate("bs-started", "src:a");
      db.prepare(
        "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("bootstrap_started_at", String(now));
      const result = await runBootstrapEnqueuePass(deps());
      expect(result.enqueued).toBeGreaterThan(0);
    });
  });
});
