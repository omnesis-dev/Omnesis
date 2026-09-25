// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Why a watch is stopped, kept where it can still be read tomorrow.
 *
 * A node failure pauses a watch durably: the cursor does not advance past the
 * event whose effects were rolled back, so a resumed run re-reads it and stops
 * on it again. That is the right default. What it lacked was a reason anyone
 * could act on — the trace held the message, traces are pruned, and the only
 * escape left was deleting the watch and adding it again, which restarts it at
 * the journal head and discards every firing it had recorded.
 *
 * Three things are recorded and they are chosen deliberately. The **class**
 * says who to ask about it. The **node** says where in the definition to look.
 * The **sequence** is the one a recovery acts on. There is no message: an error
 * from a query engine or a model backend can quote a value out of the corpus,
 * and this record outlives the run that produced it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { WatchStateStore } from "./state.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch2-failure-record-"));
  scratch.push(dir);
  return dir;
}

describe("what the store remembers about a stopped watch", () => {
  it("keeps the class, the node and the event, and nothing else", () => {
    const store = new WatchStateStore();
    store.recordFailure("w-1", { seq: 10417, nodeId: "spend", failure: "query" });

    expect(store.failure("w-1")).toEqual({ seq: 10417, nodeId: "spend", failure: "query" });
    store.close();
  });

  it("has nothing to say about a watch that never failed", () => {
    const store = new WatchStateStore();
    store.setActive("w-1", false);
    expect(store.failure("w-1"), "a watch merely held read as broken").toBeNull();
    store.close();
  });

  it("replaces an older reason rather than accumulating them", () => {
    // The current reason is the only one worth holding: a watch stopped by a
    // query error yesterday and a provider outage today is stopped by the
    // provider outage, and a reader shown both has to work out which is live.
    const store = new WatchStateStore();
    store.recordFailure("w-1", { seq: 1, nodeId: "spend", failure: "query" });
    store.recordFailure("w-1", { seq: 9, nodeId: "topic", failure: "provider" });
    expect(store.failure("w-1")).toEqual({ seq: 9, nodeId: "topic", failure: "provider" });
    store.close();
  });

  it("forgets it the moment the watch is let go", () => {
    // A recorded failure describes a watch that is *not running*. Kept against
    // one that is, it sends the next reader to diagnose something already dealt
    // with — and there is no second signal to tell them it is stale.
    const store = new WatchStateStore();
    store.recordFailure("w-1", { seq: 3, nodeId: "spend", failure: "query" });
    store.setActive("w-1", true);
    expect(store.failure("w-1")).toBeNull();
    expect(store.isActive("w-1")).toBe(true);
    store.close();
  });

  it("does not disturb another watch's reason", () => {
    const store = new WatchStateStore();
    store.recordFailure("w-1", { seq: 3, nodeId: "spend", failure: "query" });
    store.recordFailure("w-2", { seq: 4, nodeId: "topic", failure: "budget" });
    store.setActive("w-1", true);
    expect(store.failure("w-2")?.failure).toBe("budget");
    store.close();
  });

  it("stops a watch that was running, in the same statement as the reason", () => {
    // The stop and the reason are one fact. Written as two statements, a crash
    // between them leaves a watch visibly stopped that cannot say what stopped
    // it — the state this record exists to make impossible, and the one that
    // then makes every recovery path refuse for want of something to act on.
    const store = new WatchStateStore();
    store.setActive("w-1", true);
    store.recordFailure("w-1", { seq: 4, nodeId: "spend", failure: "provider" });

    expect(store.isActive("w-1"), "a failed watch was left running").toBe(false);
    expect(store.failure("w-1")?.failure).toBe("provider");
    store.close();
  });

  it("stops a watch it has never seen, rather than losing the reason", () => {
    // The live shape: the failure is written outside the transaction it rolled
    // back, and a watch that failed on its very first event may have no row in
    // this table yet. An UPDATE-only write would have silently kept nothing.
    const store = new WatchStateStore();
    store.recordFailure("fresh", { seq: 2, nodeId: "spend", failure: "query" });
    expect(store.failure("fresh")?.seq).toBe(2);
    expect(store.isActive("fresh"), "recording a failure left the watch running").toBe(false);
    store.close();
  });
});

describe("a store written before these columns existed", () => {
  it("gains them on open, and reads its watches as unbroken rather than failing", () => {
    // Every live install's journal already exists, and `CREATE TABLE IF NOT
    // EXISTS` does nothing at all to it. Without the additive upgrade the first
    // query naming these columns throws and the whole runtime is down.
    const path = join(tempDir(), "old.db");
    const legacy = new DatabaseConstructor(path);
    legacy.exec(`
      CREATE TABLE watch_state (
        watch_id       TEXT PRIMARY KEY,
        active         INTEGER NOT NULL,
        next_timer_seq INTEGER NOT NULL DEFAULT -1
      )`);
    legacy.prepare("INSERT INTO watch_state (watch_id, active) VALUES ('w-1', 0)").run();
    legacy.close();

    const store = new WatchStateStore(path);
    expect(store.failure("w-1"), "an old row read as a failure it never had").toBeNull();
    expect(store.isActive("w-1"), "the existing state was lost").toBe(false);

    store.recordFailure("w-1", { seq: 7, nodeId: "spend", failure: "query" });
    expect(store.failure("w-1")?.seq).toBe(7);
    store.close();
  });

  it("is safe to open twice — the upgrade does not run again", () => {
    const path = join(tempDir(), "twice.db");
    const first = new WatchStateStore(path);
    first.recordFailure("w-1", { seq: 5, nodeId: "spend", failure: "internal" });
    first.close();

    const second = new WatchStateStore(path);
    expect(second.failure("w-1")?.nodeId).toBe("spend");
    second.close();
  });

  it("reads a class it does not recognise as one it can act on", () => {
    // A newer build writing a class this one has never heard of must not make
    // the reason unreadable. The alternative is a watch that is visibly stopped
    // and cannot say why, which is the whole defect this record exists to fix.
    const path = join(tempDir(), "future.db");
    const seeded = new WatchStateStore(path);
    seeded.recordFailure("w-1", { seq: 2, nodeId: "spend", failure: "query" });
    seeded.close();

    const raw = new DatabaseConstructor(path);
    raw.prepare("UPDATE watch_state SET failed_class = 'from-a-later-build'").run();
    raw.close();

    const store = new WatchStateStore(path);
    expect(store.failure("w-1")?.failure).toBe("internal");
    store.close();
  });
});
