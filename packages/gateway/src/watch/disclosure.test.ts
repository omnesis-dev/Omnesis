// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch discloses, read from the record that authorised it.
 *
 * Against a real store, for the same reason the anchor tests are: every claim
 * here is a claim about a row — that the summary a listing shows and the detail
 * a page shows describe the same record, that a watch waking nobody discloses
 * nothing rather than something empty, and that a revoked record stops being
 * an active disclosure without its history disappearing.
 *
 * Fixture data is invented — no corpus content.
 */

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDevice } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import { SubscriptionService } from "../subscriptions/service.js";
import { createWakeAnchors, type WakeAnchors } from "./anchors.js";
import { watchDisclosure, watchDisclosureSummaries } from "./disclosure.js";
import type { StoredWatch } from "./definitions.js";

import type Database from "better-sqlite3";

type Db = Database.Database;

const INTEGRATION_DEVICE_NAME = "Fictional OpenClaw integration";

const WATCH_ID = "w_shipped";

/**
 * The watch as the definition store holds it.
 *
 * The anchor is read from this document rather than from the request that asks
 * for it, so a case that changes what the watch says it will do changes the
 * stored watch.
 */
function watchWith(instruction = "Draft a reply."): StoredWatch {
  return {
    id: WATCH_ID,
    name: "an-order-shipped",
    status: "active",
    dsl: {
      watch: {
        name: "an-order-shipped",
        nl_query: "Tell me when an order I was told about ships.",
        firing_policy: "stays_active",
        nodes: [
          {
            id: "mail",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            output_map: { doc_id: "$e.docId" },
          },
        ],
        sink: { input: "mail", output_map: {} },
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
  /** What the definition store would return; the anchor reads this. */
  watch: StoredWatch;
  now: number;
  cleanup: () => void;
}

function setup(): Harness {
  const db = new SqliteDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  createDevice(db, {
    name: INTEGRATION_DEVICE_NAME,
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
  let sequence = 0;
  const harness: Harness = {
    holds: [],
    db,
    now: 5_000,
    watch: watchWith(),
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
    id: () => `fictional-${++sequence}`,
  });
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

/** Install the watch's anchor exactly as the delivery route does. */
function install(
  h: Harness,
  overrides: { authoredBy?: "operator" | "integration"; instruction?: string } = {},
): Promise<string | null> {
  if (overrides.instruction !== undefined) h.watch = watchWith(overrides.instruction);
  return h.anchors.set(WATCH_ID, {
    ...(overrides.authoredBy === undefined ? {} : { authoredBy: overrides.authoredBy }),
  });
}

describe("what a watch discloses", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("names the integration it wakes and what it was approved to say", async () => {
    const subscriptionId = await install(h, { authoredBy: "integration" });

    const disclosure = watchDisclosure(h.db, WATCH_ID);

    expect(disclosure).not.toBeNull();
    expect(disclosure?.subscriptionId).toBe(subscriptionId);
    expect(disclosure?.integrationName).toBe(INTEGRATION_DEVICE_NAME);
    expect(disclosure?.authoredBy).toBe("integration");
    expect(disclosure?.instruction).toBe("Draft a reply.");
    expect(disclosure?.interpretation.length).toBeGreaterThan(0);
    expect(disclosure?.policyRevision).toBe("policy-a");
  });

  // The distinction the row indicator exists to draw. An operator can perfectly
  // well write a watch that wakes an agent, and reading the delivery block
  // instead of the record would attribute their own request to the integration.
  it("says the operator asked when the operator asked", async () => {
    await install(h, { authoredBy: "operator" });

    expect(watchDisclosure(h.db, WATCH_ID)?.authoredBy).toBe("operator");
  });

  // Most watches wake nobody. Null rather than an empty record: a page that
  // rendered a disclosure section for one of those would report the ordinary
  // case as something missing.
  it("is absent for a watch that wakes nobody", () => {
    expect(watchDisclosure(h.db, "w_nothing_wakes")).toBeNull();
    expect(watchDisclosureSummaries(h.db).size).toBe(0);
  });

  it("summarises the same record the detail describes", async () => {
    await install(h, { authoredBy: "integration" });

    const summary = watchDisclosureSummaries(h.db).get(WATCH_ID);
    const detail = watchDisclosure(h.db, WATCH_ID);

    expect(summary).toBeDefined();
    expect(summary?.subscriptionId).toBe(detail?.subscriptionId);
    expect(summary?.integrationName).toBe(detail?.integrationName);
    expect(summary?.authoredBy).toBe(detail?.authoredBy);
  });

  /**
   * A revoked record still describes a disclosure that happened. Dropping it
   * would take the egress ledger with it, leaving what the watch already sent
   * with nothing on any screen accounting for it — which is exactly the thing
   * a privacy ledger exists to prevent.
   *
   * This is why the disclosure reader has its own query rather than reusing
   * the anchor set: that one answers "where does this watch wake through NOW",
   * and skips everything terminal by design.
   */
  it("keeps describing a revoked record, and says it is revoked", async () => {
    const subscriptionId = await install(h, { authoredBy: "integration" });

    await h.service.revokeTrusted(subscriptionId!);

    const disclosure = watchDisclosure(h.db, WATCH_ID);
    expect(disclosure?.subscriptionId).toBe(subscriptionId);
    expect(disclosure?.status).toBe("revoked");
    expect(disclosure?.revokedAt).not.toBeNull();
    expect(watchDisclosureSummaries(h.db).get(WATCH_ID)?.status).toBe("revoked");
  });
});
