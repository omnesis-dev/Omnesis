// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shadow runtime, on a real gateway, across a restart.
 *
 * The property that matters is the one nobody can check by looking: a gateway
 * that goes down mid-stream and comes back must say exactly what it would have
 * said if it never went down. Not "roughly" — a watch that repeats itself after
 * every restart is a watch an operator stops trusting, and one that loses a
 * firing is a watch that was never worth adding.
 *
 * A stimulus is pushed either side of a restart of the same spawned gateway,
 * and what is asserted is that each document is spoken about exactly once: not
 * merely that four firings eventually arrive, but that a settling period after
 * them produces no fifth. Waiting for "at least four" is what would let a
 * from-zero resume pass — the duplicates it produced would be discarded by the
 * firings table's unique constraint, so the count would look right while the
 * runtime was re-reading the whole journal on every restart.
 *
 * Nothing here asserts a delivery, because there is none. A firing is a row.
 */

import "./synth-env.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface WatchSummary {
  id: string;
  name: string;
  status: string;
  fromSeq: number;
  note: string | null;
  firings: number;
}

interface Firing {
  seq: number;
  firedAt: string;
  payload: unknown;
}

/**
 * A watch that fires on every gmail message.
 *
 * Procedural on purpose: no recall arm and no judge, so what the test measures
 * is the runtime's bookkeeping rather than a model's mood. The fingerprint is
 * filled in from the live install before it is added.
 */
function everyEmail(fingerprint: string): unknown {
  return {
    watch: {
      name: "every-email",
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };
}

let harness: SyntheticE2EHarness;

beforeEach(async () => {
  harness = new SyntheticE2EHarness({ gatewayMode: "experimental", universe: "e2e-minimal" });
  await harness.start();
}, 240_000);

afterEach(async () => {
  await harness.destroy();
}, 15_000);

/** The fingerprint this install currently declares. */
async function fingerprint(): Promise<string> {
  const { fingerprint } = await harness.gatewayJson<{ fingerprint: string }>(
    "/admin/watch/ontology",
  );
  expect(fingerprint, "the install declared no ontology").toBeTruthy();
  return fingerprint;
}

/** What the runtime currently thinks of a watch — the first thing to read on a surprise. */
async function statusOf(id: string): Promise<{ status: string; note: string | null }> {
  const { watches } = await harness.gatewayJson<{ watches: WatchSummary[] }>(
    "/admin/watch/watches",
  );
  const found = watches.find((watch) => watch.id === id);
  return { status: found?.status ?? "missing", note: found?.note ?? null };
}

async function addWatch(fromSeq: number): Promise<WatchSummary> {
  const { watch } = await harness.gatewayJson<{ watch: WatchSummary }>("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl: everyEmail(await fingerprint()), fromSeq }),
  });
  return watch;
}

async function firingsOf(id: string): Promise<Firing[]> {
  const { firings } = await harness.gatewayJson<{ firings: Firing[] }>(
    `/admin/watch/watches/${id}/firings`,
  );
  return firings;
}

/** Wait until asynchronous document events have reached the watch journal. */
async function waitForJournalHead(timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { journalHead } = await harness.gatewayJson<{ journalHead: number }>(
      "/admin/watch/watches",
    );
    if (journalHead > 0) return journalHead;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`watch journal remained empty for ${timeoutMs}ms after source sync`);
}

/**
 * Wait for a watch to have said as much as it is going to, then keep watching.
 *
 * The settle is the discriminating half. Returning the moment the count is
 * reached would accept a runtime that goes on to say it again — and since two
 * evaluation ticks are seconds apart, a duplicate would land just after the
 * assertion that was supposed to catch it.
 */
async function waitForFirings(
  id: string,
  want: number,
  timeoutMs = 120_000,
  settleMs = 8_000,
): Promise<Firing[]> {
  const deadline = Date.now() + timeoutMs;
  let seen: Firing[] = [];
  while (Date.now() < deadline) {
    seen = await firingsOf(id);
    if (seen.length >= want) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      const settled = await firingsOf(id);
      if (settled.length !== seen.length) {
        throw new Error(
          `watch ${id} was still firing after it had said everything: ${seen.length} then ${settled.length}`,
        );
      }
      return settled;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const state = await statusOf(id);
  throw new Error(
    `watch ${id} fired ${seen.length} time(s), expected ${want}, within ${timeoutMs}ms ` +
      `(status ${state.status}${state.note ? `: ${state.note}` : ""})`,
  );
}

const MAIL = [
  { externalId: "rt-1", title: "Spring works — quote" },
  { externalId: "rt-2", title: "Spring works — revised" },
  { externalId: "rt-3", title: "Spring works — accepted" },
  { externalId: "rt-4", title: "Spring works — invoice" },
];

async function push(index: number): Promise<void> {
  const mail = MAIL[index]!;
  await harness.pushDocument({
    externalId: mail.externalId,
    sourceId: "gmail",
    providerId: "google",
    documentType: "email",
    title: mail.title,
    content: `${mail.title}. Body for ${mail.externalId}.`,
  });
}

describe("Watch V2 runtime (e2e-minimal universe)", () => {
  test("the admin surface is not there when the feature is off", async () => {
    // The gate runs before auth and before validation, so a gateway with the
    // feature off is indistinguishable from one that never had it.
    try {
      await harness.restartGateway({ gatewayMode: "stable" });
      const res = await harness.gatewayFetch("/admin/watch/watches");
      expect(res.status, "the surface answered with the feature off").toBe(404);
    } finally {
      await harness.restartGateway({ gatewayMode: "experimental" });
    }
  }, 180_000);

  test("a watch added now does not wake on the corpus that preceded it", async () => {
    // The universe has already synced a corpus by this point. A watch added
    // after it is a claim about what happens next.
    await harness.syncAllSources();
    // Source sync completion means the documents are durable, but the watch
    // journal consumes their events asynchronously. Wait for that boundary so
    // the assertion measures start-at-head semantics rather than queue timing.
    await waitForJournalHead();
    const watch = await addWatch(0 /* replaced below by the head default */);
    expect(watch.fromSeq, "a watch was added pointing at the beginning of the journal").toBe(0);

    // And with the default — no fromSeq — it starts at the head.
    const { watch: atHead } = await harness.gatewayJson<{ watch: WatchSummary }>(
      "/admin/watch/watches",
      { method: "POST", body: JSON.stringify({ dsl: everyEmail(await fingerprint()) }) },
    );
    expect(
      atHead.fromSeq,
      "a watch added with no start point began at the beginning",
    ).toBeGreaterThan(0);
  }, 240_000);

  test("a gateway that restarts mid-stream says exactly what one that did not says", async () => {
    const watch = await addWatch(0);

    // Two messages, then the gateway goes down and comes back, then two more.
    await push(0);
    await push(1);
    await waitForFirings(watch.id, 2);

    await harness.restartGateway();

    await push(2);
    await push(3);
    const after = await waitForFirings(watch.id, 4);

    expect(after.length, "the restart lost or duplicated a firing").toBe(4);
    // Each document is spoken about exactly once, and the sequence numbers are
    // strictly increasing — a repeat would show as a duplicate payload, a loss
    // as a missing one.
    const docIds = after.map((firing) => (firing.payload as { doc_id?: string }).doc_id);
    expect(new Set(docIds).size, "a document was reported twice").toBe(4);
    const seqs = after.map((firing) => firing.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // And the runtime keeps an account of itself that survived the restart.
    const { records } = await harness.gatewayJson<{ records: { transition: string }[] }>(
      `/admin/watch/watches/${watch.id}/trace`,
    );
    expect(records.filter((r) => r.transition === "fired").length).toBe(4);
  }, 300_000);

  test("a watch can be held and let go again without losing what it said", async () => {
    // The runtime holds a watch on its own — its ontology moved, one of its
    // nodes threw. Without a way back the only recovery is to remove it and add
    // it again, which starts it at the head and loses its history.
    const watch = await addWatch(0);
    await push(0);
    await waitForFirings(watch.id, 1);

    const paused = await harness.gatewayFetch(`/admin/watch/watches/${watch.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);

    // Held means held: a document arriving now is not spoken about.
    await push(1);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect((await firingsOf(watch.id)).length, "a held watch kept firing").toBe(1);

    const resumed = await harness.gatewayFetch(`/admin/watch/watches/${watch.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    expect(resumed.status).toBe(200);

    // And it picks up what it missed rather than starting over.
    const after = await waitForFirings(watch.id, 2);
    expect(after.length, "a resumed watch repeated itself or stayed silent").toBe(2);
    expect(new Set(after.map((f) => (f.payload as { doc_id?: string }).doc_id)).size).toBe(2);
  }, 300_000);

  test("removing a watch takes its firings with it", async () => {
    // What `rm` has to mean, or a watch added afterwards inherits a cursor and
    // a firing history belonging to something the operator deleted.
    const watch = await addWatch(0);
    await push(0);
    await waitForFirings(watch.id, 1);

    const removed = await harness.gatewayFetch(`/admin/watch/watches/${watch.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const replacement = await addWatch(0);
    // Same DSL, same name, a fresh identity — and it starts where it was told
    // to rather than wherever its predecessor had got to.
    const after = await waitForFirings(replacement.id, 1);
    expect(after.length, "the replacement inherited its predecessor's cursor").toBe(1);
  }, 300_000);

  test("the report summarises the period in one read", async () => {
    const watch = await addWatch(0);
    await push(0);
    await waitForFirings(watch.id, 1);

    const report = await harness.gatewayJson<{
      journalEvents: number;
      judge: { calls: number; deferrals: number; errors: number };
      evaluation: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
      watches: {
        name: string;
        firings: number;
        traceRecords: number;
        pendingNominations: number;
      }[];
    }>("/admin/watch/report");

    expect(report.journalEvents).toBeGreaterThan(0);
    const mine = report.watches.find((w) => w.name === "every-email");
    expect(mine?.firings).toBe(1);
    expect(mine?.traceRecords, "a firing was reported with no account of itself").toBeGreaterThan(
      0,
    );
    // No judge was involved: this watch is procedural, and a shadow report that
    // showed spend against it would be reporting a call nobody made.
    expect(report.judge.calls, "a procedural watch spent judge budget").toBe(0);
    expect(mine?.pendingNominations, "a procedural watch parked a nomination").toBe(0);
    // The resource accounting the shadow period is read through. A report whose
    // latency block is always zero cannot answer "is this affordable".
    expect(report.evaluation.samples, "no evaluation was ever measured").toBeGreaterThan(0);
    expect(report.evaluation.p95Ms).toBeGreaterThanOrEqual(report.evaluation.p50Ms);
  }, 240_000);
});
