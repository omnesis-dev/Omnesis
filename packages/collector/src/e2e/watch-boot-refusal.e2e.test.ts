// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a real gateway does when the watch stores refuse to open.
 *
 * The subsystem comes up in two halves against one file. The materializer is
 * built first, because it opens the journal first and subscribes to the ingest
 * bus as it does. The engine's stores are opened second, and that is the step
 * allowed to refuse: every store on this file brings a copy written by an older
 * build up to the shape its queries expect, and those upgrades take the write
 * lock.
 *
 * So there is a window where the materializer is standing and the runtime
 * behind it does not exist. Leaving it there pushes every indexed document into
 * a queue nothing drains, behind a log line saying the journal is recording —
 * which is worse than the refusal, because it is silent. The gateway stops it
 * again.
 *
 * That was argued from reading the boot script rather than tested: `index.ts`
 * is a script, and nothing exercised the branch. This does, against a spawned
 * gateway, by planting a journal whose schema cannot be upgraded.
 *
 * The lever is a view. `CREATE TABLE IF NOT EXISTS` steps over an object that
 * already has the name, so the tables come up clean; `ALTER TABLE … ADD COLUMN`
 * cannot add a column to a view, and bringing an older file up to date is the
 * one thing every store on this path does. The journal store's own tables are
 * untouched, so it opens exactly as it would on a healthy install — which is
 * what puts the boot in the state under test rather than in the simpler one
 * where nothing opened at all.
 */

import "./synth-env.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";

describe("a gateway whose watch stores refuse to open", () => {
  let harness: SyntheticE2EHarness;
  let journalPath: string;

  beforeAll(async () => {
    // Without this the subsystem is off entirely: no file, no subscription, no
    // task — and the test would pass while proving nothing.
    harness = new SyntheticE2EHarness({ gatewayMode: "experimental", universe: "e2e-minimal" });
    // The config dir exists from the constructor; the gateway is not spawned
    // until `start()`. That gap is where the journal has to be planted.
    journalPath = join(harness.getConfigDir(), "watch.db");
    const planted = new Database(journalPath);
    // `watch_state` carries added columns, so it is one of the tables the
    // upgrade walks. A view of that name survives the `CREATE` and refuses the
    // `ALTER`.
    planted.exec("CREATE VIEW watch_state AS SELECT 'w' AS watch_id, 1 AS active");
    planted.close();

    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("boots the rest of the gateway rather than dying on the way past", async () => {
    // The posture the refusal exists for. Exiting here would be a crash loop
    // under a restarting supervisor — the gateway dies, restarts, takes the
    // lock again — and an operator needs a running gateway to read the reason
    // from.
    const health = await harness.gatewayFetch("/health");
    expect(health.status, "the gateway did not survive a refusing journal").toBe(200);
  });

  test("says which half refused, and does not claim the other one started", () => {
    const log = readFileSync(harness.getGatewayLogPath(), "utf8");
    expect(log, "the refusal was not reported anywhere an operator can read").toContain(
      "the watch stores could not be opened",
    );
    // The discriminating half, and the reason this fixture is a view rather
    // than an unreadable file. If the materializer had refused too there would
    // be nothing standing to stop, and every assertion below would pass on a
    // gateway that never reached the branch under test.
    expect(
      log,
      "the journal half refused as well — this booted the simpler case, not the one under test",
    ).not.toContain("the watch journal could not be started");
  });

  test("stops the materializer rather than leaving it subscribed to the bus", async () => {
    // The assertion the branch exists for, read off the file rather than the
    // process: stopping the materializer closes its connection to the journal,
    // and SQLite deletes the write-ahead log and shared-memory files when the
    // last connection to a database closes. A materializer left standing holds
    // that connection open for the life of the gateway, so those files stay.
    //
    // Ingest first, so the claim is about a gateway that has actually had
    // documents pushed at it — the state where a standing materializer would be
    // queueing them.
    await harness.syncAllSources();

    expect(existsSync(journalPath), "the planted journal is gone entirely").toBe(true);
    expect(
      existsSync(`${journalPath}-wal`),
      "something still holds the journal open — the materializer was left standing",
    ).toBe(false);
    expect(existsSync(`${journalPath}-shm`), "the journal still has a live connection").toBe(false);
  }, 240_000);

  test("leaves the watch surface unavailable rather than half-running", async () => {
    // A subsystem that refused must not answer as though it came up. Reading a
    // listing off stores that were never opened is the shape of a half-started
    // feature reporting health.
    const res = await harness.gatewayFetch("/admin/watch/watches");
    expect(res.status, "the watch surface answered though its stores never opened").not.toBe(200);
  });
});
