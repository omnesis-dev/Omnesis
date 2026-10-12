// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backtest infrastructure smoke: a spawned gateway booted with
 * `OMNESIS_BRIEFS_VIRTUAL_CLOCK=1`, driven end-to-end by the
 * mirror-gateway bridge from an invented snapshot DB.
 *
 * Asserts the two composable halves and their product:
 *   - the clock route reports virtual time and moves on POST;
 *   - backfilled and dripped documents receive current-version discovery;
 *   - no-op interpretation creates no canonical obligation.
 *
 * Zero tokens: the scripted loop-model server answers every run with a
 * no-behavior no-op; what is under test is wake mechanics, not agent
 * behavior. All snapshot data is INVENTED (privacy rule).
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// Side-effect import: sets OMNESIS_SYNTHETIC=1 before SyntheticE2EHarness
// runs, so the collector's discovery loop loads the synth provider packages.
import "./synth-env.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { openHarnessDb } from "./briefs-scorecard.js";
import { runBridge } from "./briefs-backtest-bridge.js";
import { startScriptedLoopModelServer, type ScriptedLoopModelServer } from "./fake-loop-model.js";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const DATUM_AT = Date.parse("2026-03-01T09:30:00.000Z");
const UNTIL = Date.parse("2026-03-02T00:00:00.000Z");

let harness: SyntheticE2EHarness | undefined;
let server: ScriptedLoopModelServer | undefined;
let snapshotPath: string;
let priorEnv: Record<string, string | undefined> = {};

/** Env the spawned mirror needs: briefs active + fast cadences + the clock. */
const MIRROR_ENV: Record<string, string> = {
  OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1",
  OMNESIS_COGNITION_WAKER_INTERVAL_MS: "100",
  OMNESIS_COGNITION_WAKER_IDLE_MS: "200",
  OMNESIS_COGNITION_WAKER_START_DELAY_MS: "300",
  OMNESIS_COGNITION_DRAIN_INTERVAL_MS: "150",
  OMNESIS_COGNITION_DRAIN_IDLE_MS: "300",
  OMNESIS_COGNITION_DRAIN_START_DELAY_MS: "500",
};

function seedSnapshot(): void {
  const db = new Database(snapshotPath);
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    content_hash TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    source_created_at TEXT NOT NULL, source_updated_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', 'imap:jamie@example.com', ?, ?, ?, 'h',
             '{"documentType":"email"}', ?, ?, ?, ?)`,
  );
  const at = (ms: number): string => new Date(ms).toISOString();
  // Ten historical context documents form the as-of-T0 corpus.
  for (let i = 0; i < 10; i += 1) {
    const ts = at(T0 - (i + 10) * 86_400_000);
    insert.run(
      randomUUID(),
      `bt-backfill-${i}`,
      `Backfill note ${i} about the studio project`,
      `Progress note ${i}: nothing actionable, context only.`,
      ts,
      ts,
      ts,
      ts,
    );
  }
  // One window datum: a request dated 9:30am on T0's morning.
  const ts = at(DATUM_AT);
  insert.run(
    randomUUID(),
    "bt-window-1",
    "Could you send the seating plan (BT-4411) by Friday?",
    "Hi — could you send over the seating plan (BT-4411) by Friday? — Jamie Reeves",
    ts,
    ts,
    ts,
    ts,
  );
  db.close();
}

describe("briefs backtest bridge (virtual clock + mirror replay)", () => {
  beforeAll(async () => {
    snapshotPath = `/tmp/omnesis-test-snapshot-${randomUUID()}.db`;
    seedSnapshot();
    // Empty behavior table: every woken run completes as a no-op — the
    // smoke exercises wake mechanics, not agent behavior.
    server = await startScriptedLoopModelServer({ behaviors: new Map() });
    priorEnv = Object.fromEntries(Object.keys(MIRROR_ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, MIRROR_ENV);
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "e2e-minimal",
      extraGatewayConfig: {
        brain: {
          bootstrap: { enabled: false },
          knowledge: { soonDelay: "1s", routineDelay: "1s" },
        },
      },
      extraInference: {
        backends: { scripted: { type: "http", url: server.url } },
        assignments: { "background-agent": `scripted/${server.modelId}` },
      },
    });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await harness?.destroy();
    await server?.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(snapshotPath + suffix)) unlinkSync(snapshotPath + suffix);
    }
  }, 30_000);

  test("the clock route is virtual, the replay interprets historical and window evidence at virtual time", async () => {
    const h = harness!;

    const status = (await h.gatewayJson("/status")) as {
      briefs?: { active: boolean; modelAssigned: boolean };
    };
    expect(status.briefs?.modelAssigned).toBe(true);
    expect(status.briefs?.active).toBe(true);

    const clock = (await h.gatewayJson("/admin/brain/clock")) as {
      virtual: boolean;
      now: string;
    };
    expect(clock.virtual).toBe(true);

    const report = await runBridge({
      snapshotPath,
      gatewayUrl: h.gatewayUrl,
      token: h.apiKey,
      t0Ms: T0,
      untilMs: UNTIL,
      log: () => {},
    });
    expect(report.backfilled).toBe(10);
    expect(report.dripped).toBe(1);

    // Virtual now landed on the window end, months from wall now.
    const after = (await h.gatewayJson("/admin/brain/clock")) as { now: string };
    expect(Date.parse(after.now)).toBe(UNTIL);

    // Both historical and window evidence enter current discovery. Completion
    // must refer to each current content hash, not a legacy data-run key.
    const db = openHarnessDb(h);
    try {
      await expect
        .poll(
          () =>
            db
              .prepare(
                `SELECT COUNT(DISTINCT d.id) AS n
        FROM documents d JOIN knowledge_discovery_coverage c ON c.subject_id=d.id
        AND c.input_revision=d.content_hash AND c.phase='interpretation' AND c.status='considered'
        WHERE d.external_id LIKE 'bt-%'`,
              )
              .get(),
          { timeout: 60_000, interval: 500 },
        )
        .toEqual({ n: 11 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM open_loops").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    // The corpus is fully present in the mirror (backfill + window).
    const search = (await h.gatewayJson("/documents/search?q=BT-4411&limit=5")) as {
      results?: unknown[];
      items?: unknown[];
    };
    const hits = search.results ?? search.items ?? [];
    expect(hits.length).toBeGreaterThan(0);
  }, 240_000);
});
