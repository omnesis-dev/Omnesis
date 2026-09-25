// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../data/schema.js";
import { setCognitionEngineState } from "./storage/engine-state.js";
import {
  CachedScanProbe,
  readBootstrapStatus,
  type BootstrapBacklog,
  type BootstrapSettingsView,
} from "./bootstrap-status.js";

const DEFAULTS: BootstrapSettingsView = {
  enabled: true,
  direction: "recent-first",
  backlogTarget: 200,
  maxRunsPerDay: 200,
  maxRuns: 1_000_000,
  batchSize: 100,
  recencyWindowMs: 7 * 86_400_000,
};

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
/** Far enough back that the boot hold has certainly lapsed. */
const BOOTED_LONG_AGO = NOW - 60 * 60_000;

describe("bootstrap status", () => {
  let db: Database.Database;
  let path: string;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = new Database(path);
    runSchemaSetup(db);
    // Starting the backfill is its own operator decision, so a fresh database
    // has not made it and every lane would otherwise read as `unstarted`. The
    // test that cares about that state clears this key itself.
    db.prepare(
      "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("bootstrap_started_at", "1");
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  });

  const read = (settings = DEFAULTS, startedAt = BOOTED_LONG_AGO) =>
    readBootstrapStatus(db, settings, { now: NOW, startedAt });

  it("reports a fresh lane as running, with every counter at zero", () => {
    const s = read();
    expect(s.state).toBe("running");
    expect(s.enqueuedToday).toBe(0);
    expect(s.totalEnqueued).toBe(0);
    expect(s.runs).toEqual({ pending: 0, completed: 0, failed: 0 });
    expect(s.processedDocs).toBe(0);
    // The floor is what the lane would compare a datum against right now —
    // exactly `now - recencyWindow`, so the two lanes' boundary is visible.
    expect(s.recencyFloor).toBe(new Date(NOW - DEFAULTS.recencyWindowMs).toISOString());
  });

  it("derives `off` from the knob, without consulting stored state", () => {
    setCognitionEngineState(db, "bootstrap_state", "running");
    const s = read({ ...DEFAULTS, enabled: false });
    expect(s.state).toBe("off");
    expect(s.reason).toContain("brain.bootstrap.enabled");
  });

  it("surfaces the parked state and names the ceiling to raise", () => {
    setCognitionEngineState(db, "bootstrap_state", "parked");
    setCognitionEngineState(db, "bootstrap_total_enqueued", "2200");
    const s = read({ ...DEFAULTS, maxRuns: 2200 });
    expect(s.state).toBe("parked");
    expect(s.totalEnqueued).toBe(2200);
    // The sentence has to name the knob: this state is otherwise indefinite
    // and there is no other signal that anything is wrong.
    expect(s.reason).toContain("brain.bootstrap.maxRuns");
    expect(s.reason).toContain("2,200");
  });

  it("surfaces drained together with the two facts that would wake it", () => {
    // The drained day must be TODAY and the roster mark current, or the lane's
    // reopen condition already holds and it is not really quiet.
    setCognitionEngineState(db, "bootstrap_state", "drained");
    setCognitionEngineState(db, "bootstrap_drained_day", "2026-08-23");
    setCognitionEngineState(db, "bootstrap_drained_sources", "0");
    const s = read();
    expect(s.state).toBe("drained");
    expect(s.drainedDay).toBe("2026-08-23");
    expect(s.reason).toMatch(/new local day|source is added/);
  });

  it("does not call a lane quiet when its reopen condition already holds", () => {
    // Stored `drained`, but the day has turned — the lane will probe on its
    // very next pass. Reporting "nothing left to review" would be a lie with a
    // shelf life of one tick, and the shared predicate is what prevents it.
    setCognitionEngineState(db, "bootstrap_state", "drained");
    setCognitionEngineState(db, "bootstrap_drained_day", "2026-08-22");
    setCognitionEngineState(db, "bootstrap_drained_sources", "0");
    const s = read();
    expect(s.state).toBe("running");
    expect(s.reason).toContain("Reopening");
    expect(s.reason).toContain("a new day");
  });

  it("reopens when a source has been added since the lane went quiet", () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, paired_at, last_seen_at) VALUES ('d1','d','cli',1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES ('synthetic:new','synthetic','new','d1','{}',1,9999,9999)`,
    ).run();
    setCognitionEngineState(db, "bootstrap_state", "drained");
    setCognitionEngineState(db, "bootstrap_drained_day", "2026-08-23");
    setCognitionEngineState(db, "bootstrap_drained_sources", "1");
    const s = read();
    expect(s.state).toBe("running");
    expect(s.reason).toContain("source was added");
  });

  it("reports an unreadable source watermark as absent, not as zero", () => {
    // The enqueuer treats an ABSENT watermark as grounds to re-probe rather
    // than stay quiet. Reporting a garbled value as 0 would imply a quiet lane
    // had a basis for being quiet that it does not actually have.
    setCognitionEngineState(db, "bootstrap_state", "drained");
    setCognitionEngineState(db, "bootstrap_drained_sources", "not-a-number");
    expect(read().drainedSourceWatermark).toBeNull();
  });

  it("reads the backstop live, so raising it clears `parked` before the next pass", () => {
    // The panel's own advice is "raise brain.bootstrap.maxRuns — the ceiling is
    // re-read live, so no restart is needed". If the status came off the stored
    // key it would keep saying parked until a pass rewrote it, contradicting
    // the instruction it just gave.
    setCognitionEngineState(db, "bootstrap_state", "parked");
    setCognitionEngineState(db, "bootstrap_total_enqueued", "2200");
    expect(read({ ...DEFAULTS, maxRuns: 5000 }).state).toBe("running");
  });

  it("parks on the live comparison even while the stored state says running", () => {
    // The mirror case: lowering the ceiling under a lane that is already past
    // it must not read as "working through history at its configured pace".
    setCognitionEngineState(db, "bootstrap_state", "running");
    setCognitionEngineState(db, "bootstrap_total_enqueued", "2200");
    expect(read({ ...DEFAULTS, maxRuns: 100 }).state).toBe("parked");
  });

  it("reports a lane that has spent the day's allowance as waiting, not running", () => {
    setCognitionEngineState(db, "bootstrap_state", "running");
    setCognitionEngineState(db, `bootstrap_enqueued:${"2026-08-23"}`, "200");
    const s = read();
    // With the allowance spent and nothing queued the lane commits nothing
    // until the local day turns — the same clock-bound quiet a shut window
    // produces. Reporting `running` would show a healthy lane for the rest of
    // the day while it executed nothing at all.
    expect(s.state).toBe("waiting");
    expect(s.reason).toContain("allowance is spent");
    expect(s.reason).toContain("brain.bootstrap.maxRunsPerDay");
  });

  it("is still running while its own queued runs drain, allowance or not", () => {
    setCognitionEngineState(db, "bootstrap_state", "running");
    setCognitionEngineState(db, `bootstrap_enqueued:${"2026-08-23"}`, "200");
    db.prepare(
      `INSERT INTO cognition_runs (id, kind, payload_json, status, attempts, next_attempt_at, enqueued_at, cycle_anchor_at)
       VALUES ('queued-1', 'bootstrap', '{}', 'pending', 0, 0, 0, 0)`,
    ).run();
    const s = read();
    // The allowance governs what the lane commits, not what it finishes.
    expect(s.state).toBe("running");
    expect(s.reason).toContain("allowance is spent");
  });

  describe("the boot hold", () => {
    it("reports holding while the process is young, and dates when it lifts", () => {
      const startedAt = NOW - 2 * 60_000;
      setCognitionEngineState(db, "bootstrap_hold_since", String(startedAt));
      const s = read(DEFAULTS, startedAt);
      expect(s.state).toBe("holding");
      expect(s.holdSince).toBe(startedAt);
      expect(s.holdEndsAt).toBe(startedAt + 10 * 60_000);
      expect(s.reason).toContain("8 minute");
    });

    it("prefers the stamped instant over the process start", () => {
      // The enqueuer stamps `hold_since` on its first deferred pass, and that
      // is the instant the hold is actually measured from. A status that used
      // its own idea of process start would report a different deadline.
      const stamped = NOW - 9 * 60_000;
      setCognitionEngineState(db, "bootstrap_hold_since", String(stamped));
      const s = read(DEFAULTS, NOW - 30_000);
      expect(s.holdEndsAt).toBe(stamped + 10 * 60_000);
    });

    it("never lets a hold mask a parked lane", () => {
      // A parked lane outlives the hold; a hold resolves itself. Showing
      // `holding` here would hide the one state that needs an operator for
      // ten minutes after every restart — and a gateway that restarts often
      // would hide it almost always.
      setCognitionEngineState(db, "bootstrap_state", "parked");
      setCognitionEngineState(db, "bootstrap_total_enqueued", "2200");
      setCognitionEngineState(db, "bootstrap_hold_since", String(NOW - 60_000));
      const s = read({ ...DEFAULTS, maxRuns: 2200 }, NOW - 60_000);
      expect(s.state).toBe("parked");
      // The hold is still reported, so a surface can say both things.
      expect(s.holdEndsAt).not.toBeNull();
    });

    it("does let a hold mask running and drained, which ask nothing of anyone", () => {
      setCognitionEngineState(db, "bootstrap_state", "drained");
      setCognitionEngineState(db, "bootstrap_hold_since", String(NOW - 60_000));
      expect(read(DEFAULTS, NOW - 60_000).state).toBe("holding");
    });

    it("is not holding once the window has lapsed, even on a young process", () => {
      // The hold is bounded by wall clock, not process lifetime: a restart
      // loop must not be able to hold the lane off forever.
      const stamped = NOW - 11 * 60_000;
      setCognitionEngineState(db, "bootstrap_hold_since", String(stamped));
      const s = read(DEFAULTS, NOW - 60_000);
      expect(s.state).toBe("running");
      expect(s.holdSince).toBeNull();
    });
  });

  it("counts bootstrap runs by status and ignores other kinds", () => {
    const insert = db.prepare(
      `INSERT INTO cognition_runs (id, kind, payload_json, status, attempts, next_attempt_at, enqueued_at, cycle_anchor_at)
       VALUES (?, ?, '{}', ?, 0, 0, 0, 0)`,
    );
    insert.run("r1", "bootstrap", "pending");
    insert.run("r2", "bootstrap", "completed");
    insert.run("r3", "bootstrap", "completed");
    insert.run("r4", "bootstrap", "failed");
    // A neighbour on the same queue, which must not be counted.
    insert.run("r5", "data", "pending");
    expect(read().runs).toEqual({ pending: 1, completed: 2, failed: 1 });
  });
  describe("a running lane that is getting no drain capacity", () => {
    /** One pending run of a kind, due now. */
    function seedRun(id: string, kind: string, dedupeKey: string | null = null): void {
      db.prepare(
        `INSERT INTO cognition_runs (id, kind, payload_json, dedupe_key, status, attempts,
           next_attempt_at, enqueued_at, cycle_anchor_at)
         VALUES (?, ?, '{}', ?, 'pending', 0, 0, 0, 0)`,
      ).run(id, kind, dedupeKey);
    }

    it("says it is waiting behind higher-priority work, not that it is working", () => {
      // The stall this exists for, seen live: the drainer claims strictly by
      // rank, so while reactions are due the lane's own runs are due, claimable
      // and simply never reached. It completed nothing for six hours while the
      // panel read "Working through history at its configured pace".
      seedRun("r_boot_1", "bootstrap");
      seedRun("r_boot_2", "bootstrap");
      seedRun("r_data_1", "data");
      seedRun("r_data_2", "data");
      const s = read();
      expect(s.state).toBe("running");
      expect(s.blockedByHigherPriority).toBe(2);
      expect(s.reason).toContain("Waiting for drain capacity");
      expect(s.reason).toContain("2 higher-priority runs");
    });

    it("a provenance recheck does not count as higher priority", () => {
      // It rides the `feedback` kind but claims as maintenance, at the same rank
      // as the backlog. Counting it would report the lane as blocked by work
      // that is not ahead of it.
      seedRun("r_boot_3", "bootstrap");
      seedRun("r_prov", "feedback", "feedback:provenance:loop-1");
      const s = read();
      expect(s.blockedByHigherPriority).toBe(0);
      expect(s.reason).not.toContain("Waiting for drain capacity");
    });

    it("says nothing about capacity when the lane has nothing queued", () => {
      // Higher-priority work is only worth mentioning as an explanation for the
      // lane's own runs not moving.
      seedRun("r_data_3", "data");
      const s = read();
      expect(s.blockedByHigherPriority).toBe(1);
      expect(s.reason).not.toContain("Waiting for drain capacity");
    });
  });
});

describe("CachedScanProbe", () => {
  const snapshot = (at: number): BootstrapBacklog => ({
    remaining: 10,
    dateScanPending: 0,
    dateScanned: 100,
    computedAt: at,
  });

  it("computes once and serves the snapshot until the TTL lapses", async () => {
    let clock = 1_000;
    const compute = vi.fn(async () => snapshot(clock));
    const probe = new CachedScanProbe(compute, 60_000, () => clock);

    await probe.get();
    await probe.get();
    expect(compute).toHaveBeenCalledTimes(1);

    clock += 59_000;
    await probe.get();
    expect(compute).toHaveBeenCalledTimes(1);

    clock += 2_000;
    await probe.get();
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent misses onto one computation", async () => {
    // Two portal tabs opening together must not both pay for a scan that
    // takes seconds — the whole reason this probe exists.
    let release: (v: BootstrapBacklog) => void = () => {};
    const compute = vi.fn(
      () =>
        new Promise<BootstrapBacklog>((res) => {
          release = res;
        }),
    );
    const probe = new CachedScanProbe(compute, 60_000, () => 1_000);

    const a = probe.get();
    const b = probe.get();
    expect(compute).toHaveBeenCalledTimes(1);
    release(snapshot(1_000));
    expect(await a).toEqual(await b);
  });

  it("does not cache a failure", async () => {
    let attempt = 0;
    const compute = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("probe failed");
      return snapshot(1_000);
    });
    const probe = new CachedScanProbe(compute, 60_000, () => 1_000);

    await expect(probe.get()).rejects.toThrow("probe failed");
    // A cached rejection would leave the surface blank for the whole TTL over
    // a transient error.
    await expect(probe.get()).resolves.toMatchObject({ remaining: 10 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("peek never triggers a computation", () => {
    const compute = vi.fn(async () => snapshot(1_000));
    const probe = new CachedScanProbe(compute, 60_000, () => 1_000);
    // The polling half of a surface reads through `peek` precisely so that
    // showing the backlog can never be what causes the scan.
    expect(probe.peek()).toBeNull();
    expect(compute).not.toHaveBeenCalled();
  });
});
