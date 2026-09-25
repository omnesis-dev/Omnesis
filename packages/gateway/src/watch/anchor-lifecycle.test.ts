// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch's anchor set looks like after the operator changes their mind.
 *
 * A watch that wakes an agent owns exactly one record carrying that wake, and
 * every edit to its delivery block has to leave it so. Two ways that invariant
 * breaks, both of which look like success from every surface:
 *
 * 1. **The ordering.** A delivery change revokes and mints inside one request,
 *    so both rows carry the same millisecond and recency cannot separate them.
 *    An ordering that falls through to the id is a coin flip on `randomUUID`
 *    draws, describing a live watch as revoked half the time.
 * 2. **The lifecycle.** Changing a delivery A -> B -> back to A re-derives the
 *    first request's idempotency key, and the store's lookup on that key does
 *    not read status — so it answers with the record the change revoked, and
 *    the watch is left firing into nobody while `set()` reports an install.
 *
 * The rest is the same invariant from its other sides: expiry, repeated
 * reverts, a deliberate pause, and the boundary between a key this module
 * derived and one an integration supplied.
 *
 * Fixture data is invented — no corpus content.
 */

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDevice } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import { SubscriptionService } from "../subscriptions/service.js";
import {
  createWakeAnchors,
  readAnchors,
  watchAnchorBreaches,
  type WakeAnchors,
} from "./anchors.js";
import { watchDisclosure } from "./disclosure.js";
import type { StoredWatch } from "./definitions.js";

import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * The watch as the definition store holds it.
 *
 * The delivery block is the fixture's load-bearing part: the anchor is read
 * from the definition rather than from the request that changes it, so a case
 * that changes the instruction changes it *here*.
 */
const WATCH_ID = "w_shipped";

function watchWith(instruction = "Draft a reply."): StoredWatch {
  return {
    id: WATCH_ID,
    name: "an-order-shipped",
    status: "active",
    dsl: {
      watch: {
        name: "an-order-shipped",
        delivery: { kind: "agent-wake", integration: "openclaw", instruction },
      },
    },
    addedAt: "2026-03-01T09:00:00.000Z",
    fromSeq: 0,
    note: null,
    compileRunId: null,
    requestKey: null,
    referenceDigest: null,
  };
}

interface Harness {
  db: Db;
  service: SubscriptionService;
  anchors: WakeAnchors;
  /** Every watch the module stopped for want of a wake record, with its note. */
  holds: { watchId: string; note: string }[];
  /** What the definition store would return — the anchor reads this, not a request. */
  watch: StoredWatch | null;
  now: number;
  cleanup: () => void;
}

/**
 * Ids are handed out from a descending-then-ascending list so the FIRST minted
 * subscription id sorts lexicographically ABOVE the second — exactly what a
 * randomUUID draw produces half the time in production.
 */
function setup(ids: string[]): Harness {
  const db = new SqliteDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  createDevice(db, {
    name: "Fictional OpenClaw integration",
    kind: "agent",
    capabilities: {
      agentIntegration: {
        harness: "openclaw",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 1,
      },
    },
  });
  const harness: Harness = {
    holds: [],
    db,
    now: 5_000,
    watch: null,
    service: undefined as unknown as SubscriptionService,
    anchors: undefined as unknown as WakeAnchors,
    cleanup: () => db.close(),
  };
  harness.service = new SubscriptionService({
    db,
    writeGate: directWriteGate(db),
    policyStore: {
      get: () =>
        Promise.resolve({
          policy: "# Fictional",
          generation: 1,
          digest: "a-fictional-digest",
          revision: "policy-a",
          updatedAt: 1,
          schema: null,
        }),
    },
    now: () => harness.now,
    id: () => ids.shift() ?? `overflow-${Math.random()}`,
  });
  harness.watch = watchWith();
  harness.anchors = createWakeAnchors({
    db,
    subscriptions: () => harness.service,
    definition: () => harness.watch,
    hold: (watchId, note) => {
      harness.holds.push({ watchId, note });
      return Promise.resolve();
    },
  });
  return harness;
}

function install(
  h: Harness,
  overrides: {
    authoredBy?: "operator" | "integration";
    instruction?: string;
    idempotencyKey?: string;
  } = {},
): Promise<string | null> {
  // The instruction is a property of the watch, so changing it is a change to
  // the stored definition — which is what the anchor then reads.
  if (overrides.instruction !== undefined) h.watch = watchWith(overrides.instruction);
  return h.anchors.set(WATCH_ID, {
    target: { kind: "harness", name: "openclaw" },
    ...(overrides.authoredBy === undefined ? {} : { authoredBy: overrides.authoredBy }),
    ...(overrides.idempotencyKey === undefined ? {} : { idempotencyKey: overrides.idempotencyKey }),
  });
}

/** Put a record into a status the anchor path does not write for itself. */
function setStatus(h: Harness, subscriptionId: string, status: string): void {
  h.db
    .prepare<[string, string]>(`UPDATE subscriptions SET status = ? WHERE id = ?`)
    .run(status, subscriptionId);
}

describe("disclosure ordering under a delivery change", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("describes the live pending record, not the revoked one, whatever the ids drew", async () => {
    // First anchor consumes ids z1..z3 (sub_z1 > sub_a1 lexicographically);
    // the replacement consumes a1..a3. Same clock -> same updated_at.
    h = setup(["z1", "z2", "z3", "a1", "a2", "a3", "a4", "a5"]);

    await install(h, { authoredBy: "integration", instruction: "Draft a reply." });
    const replacement = await install(h, {
      authoredBy: "integration",
      instruction: "Summarise the order instead.",
    });

    // The first record is revoked; the replacement is pending approval and is
    // the record that authorises the watch now.
    const disclosure = watchDisclosure(h.db, WATCH_ID);
    expect(replacement).not.toBeNull();
    expect(disclosure?.subscriptionId).toBe(replacement);
  });
});

describe("anchor lifecycle A -> B -> A", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup(["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3", "c4"]);
  });
  afterEach(() => h.cleanup());

  it("leaves the watch with a live anchor after its delivery is changed back", async () => {
    await install(h, { instruction: "Draft a reply." });
    h.now += 1000;
    await install(h, { instruction: "Summarise the order instead." });
    h.now += 1000;
    const third = await install(h, { instruction: "Draft a reply." });

    // set() reported success, so the watch believes it wakes an agent again —
    // there must be a live anchor carrying that wake.
    expect(third).not.toBeNull();
    const anchor = readAnchors(h.db).get(WATCH_ID);
    expect(anchor).toBeDefined();
    expect(anchor?.status).toBe("active");
  });

  it("leaves exactly one live anchor, however many times the delivery flips", async () => {
    // The second revert is the interesting one: a walk that finds a free slot
    // once and then collides again would pass a single A -> B -> A and fail
    // here.
    const ids: (string | null)[] = [];
    for (const instruction of [
      "Draft a reply.",
      "Summarise the order instead.",
      "Draft a reply.",
      "Summarise the order instead.",
      "Draft a reply.",
    ]) {
      ids.push(await install(h, { instruction }));
      h.now += 1000;
    }

    expect(ids.every((id) => id !== null)).toBe(true);
    // Five installs, five distinct records: nothing was resurrected, and the
    // firings of each stay attached to the instruction they were sent under.
    expect(new Set(ids).size).toBe(5);
    const live = h.db
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('active', 'pending_approval')`)
      .get();
    expect(live?.n).toBe(1);
    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId).toBe(ids.at(-1));
  });

  it("restores the wake when an unchanged watch is re-installed after expiry", async () => {
    // Nothing about the watch changed, so the shape-derived key is the same
    // one the expired record holds. Converging on it would report a healthy
    // install of a watch whose delivery quietly stopped working — and
    // re-installing is exactly how an operator asks for it back.
    const first = await install(h);
    expect(first).not.toBeNull();
    setStatus(h, first!, "expired");
    h.now += 1000;

    const second = await install(h);

    expect(second).not.toBe(first);
    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).toBe(second);
  });

  it("never mints a second record behind a key the caller supplied", async () => {
    // The boundary the slot walk must not cross. A key this module derived
    // names a *shape*, and a shape whose record is spent is a new request. A
    // key the caller supplied names *their* request: a retry of it converges
    // on what that request made, which is the duplicate the key exists to
    // prevent — so a revoked one stays revoked rather than being replaced.
    const first = await install(h, { authoredBy: "integration", idempotencyKey: "their-own-key" });
    expect(first).not.toBeNull();
    await h.service.revokeTrusted(first!);
    h.now += 1000;

    const retry = await install(h, { authoredBy: "integration", idempotencyKey: "their-own-key" });

    // No wake: the record their key names is revoked, and saying otherwise is
    // the report this module exists to stop making.
    expect(retry).toBeNull();
    const records = h.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM subscriptions`)
      .get();
    expect(records?.n).toBe(1);
  });
});

describe("exactly one standing anchor", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup(["a1", "a2", "a3", "b1", "b2", "b3"]);
  });
  afterEach(() => h.cleanup());

  it("says nothing about a watch holding exactly one standing record", async () => {
    await install(h);

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([]);
  });

  it("names a watch that declares a wake and has nothing to carry it", async () => {
    // A watch in this state evaluates, judges and records exactly as a healthy
    // one does, and reaches nobody. No other surface can tell them apart.
    const id = await install(h);
    await h.service.revokeTrusted(id!);

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);
  });

  it("counts an expired anchor as nothing to carry the wake", async () => {
    // Not revoked, so `readAnchors` still returns it — and it wakes nobody,
    // which is the only thing this question is about.
    const id = await install(h);
    setStatus(h, id!, "expired");

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);
  });

  it("says nothing about a watch whose record is deliberately paused", async () => {
    // A pause is somebody's decision, not a fault. Reporting it every boot
    // would train the operator to ignore the one line that means a watch is
    // reaching nobody by accident.
    const id = await install(h);
    setStatus(h, id!, "paused");

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([]);
  });

  it("names a watch holding a second standing record no surface can reach", async () => {
    // Every reader here is one-per-watch, so a second standing record is not
    // merely redundant: it holds a grant that no screen lists and no sweep
    // retires. Two installs leave a retired record and a live one; putting the
    // retired one back on its feet is the state a pair of concurrent installs
    // would reach, without needing to race them.
    const first = await install(h);
    await install(h, { instruction: "Summarise the order instead." });
    setStatus(h, first!, "active");

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 2 }]);
  });
});

describe("one ordering, two surfaces", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("names the same record on the watch page and in the wake path", async () => {
    // These read overlapping row sets for different questions — where the
    // watch wakes through now, and what it has ever been authorised to say.
    // Two orderings could answer with two different records from one history.
    h = setup(["z1", "z2", "z3", "a1", "a2", "a3", "a4", "a5"]);
    await install(h);
    await install(h, { instruction: "Summarise the order instead." });

    expect(watchDisclosure(h.db, WATCH_ID)?.subscriptionId).toBe(
      readAnchors(h.db).get(WATCH_ID)?.subscriptionId,
    );
  });
});
