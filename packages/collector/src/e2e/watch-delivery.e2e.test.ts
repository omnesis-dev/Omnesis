// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch that interrupts a person, on a real gateway.
 *
 * Shadow mode is the default and this is the first thing that leaves the host,
 * so the properties worth an end-to-end test are the ones about *restraint*
 * rather than about reach:
 *
 * - a watch that did not ask for delivery never acquires it;
 * - a watch that did asks once per firing and no more;
 * - a daily cap withholds the notification and keeps the firing, visibly;
 * - none of it changes what a shadow watch records.
 *
 * The APNs leg is deliberately not exercised here. A spawned gateway has no
 * push credentials and no registered device, so a test that asserted a delivered
 * push would be asserting the mock rather than the system. What this proves is
 * that the runtime *asks* exactly as often as it should, which is the half the
 * caps govern; the translation into a push is unit-tested against the runner.
 */

import "./synth-env.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface WatchSummary {
  id: string;
  name: string;
  status: string;
  firings: number;
}

interface Report {
  failed: number;
  delivery: { dailyCap: number; perWatchDailyCap: number; attempted: number } | null;
  watches: {
    id: string;
    name: string;
    firings: number;
    delivery: string | null;
    attemptedToday: number;
  }[];
}

interface TraceRow {
  seq: number;
  nodeId: string;
  transition: string;
  detail: string | null;
}

/** A watch that fires on every gmail message. Delivery is turned on afterwards. */
function everyEmail(fingerprint: string, name: string): unknown {
  return {
    watch: {
      name,
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

async function fingerprint(): Promise<string> {
  const { fingerprint } = await harness.gatewayJson<{ fingerprint: string }>(
    "/admin/watch/ontology",
  );
  return fingerprint;
}

async function addWatch(name: string, deliver: boolean): Promise<WatchSummary> {
  const { watch } = await harness.gatewayJson<{ watch: WatchSummary }>("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl: everyEmail(await fingerprint(), name) }),
  });
  // Two steps on purpose: a watch is never installed already notifying, so
  // turning it on is the same act here as it is for an operator.
  if (deliver) {
    await harness.gatewayJson(`/admin/watch/watches/${watch.id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: "omnesis-notify" }),
    });
  }
  return watch;
}

async function report(): Promise<Report> {
  return harness.gatewayJson<Report>("/admin/watch/report");
}

async function traceOf(id: string): Promise<TraceRow[]> {
  const { records } = await harness.gatewayJson<{ records: TraceRow[] }>(
    `/admin/watch/watches/${id}/trace?limit=200`,
  );
  return records;
}

async function pushMail(externalId: string, title: string): Promise<void> {
  await harness.pushDocument({
    externalId,
    sourceId: "gmail",
    providerId: "google",
    documentType: "email",
    title,
    content: `${title}. Body for ${externalId}.`,
  });
}

/** Wait until a watch has fired `want` times, then let it settle. */
async function waitForFirings(id: string, want: number, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const found = (await report()).watches.find((watch) => watch.id === id);
    seen = found?.firings ?? 0;
    if (seen >= want) {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return (await report()).watches.find((watch) => watch.id === id)?.firings ?? seen;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`watch ${id} fired ${seen} time(s), expected ${want}, within ${timeoutMs}ms`);
}

describe("Watch V2 delivery (e2e-minimal universe)", () => {
  test("a watch delivers only when it asked to, and a shadow one is untouched", async () => {
    const shadow = await addWatch("shadow-watch", false);
    const delivering = await addWatch("delivering-watch", true);

    await pushMail("dl-1", "Spring works — quote");
    await waitForFirings(delivering.id, 1);
    await waitForFirings(shadow.id, 1);

    const now = await report();
    const shadowRow = now.watches.find((watch) => watch.id === shadow.id);
    const deliveringRow = now.watches.find((watch) => watch.id === delivering.id);

    expect(shadowRow?.delivery, "a watch acquired delivery by being installed").toBeNull();
    expect(shadowRow?.attemptedToday, "a shadow watch delivered").toBe(0);
    expect(shadowRow?.firings, "the shadow watch stopped recording").toBe(1);

    expect(deliveringRow?.delivery).toBe("omnesis-notify");
    expect(deliveringRow?.attemptedToday, "the delivering watch did not ask to send").toBe(1);
    // Both fired. Delivery is something that happens *to* a firing, not
    // something that replaces one.
    expect(deliveringRow?.firings).toBe(1);
  }, 300_000);

  test("delivery can be turned on and off on an installed watch", async () => {
    // An operator decides this after watching a watch for a week, not when
    // they write it — so it has to be changeable without losing its history.
    const watch = await addWatch("switchable-watch", false);
    await pushMail("dl-2", "Spring works — revised");
    await waitForFirings(watch.id, 1);

    // Sent under the OLD spelling on purpose: this is the compat proof for
    // every operator alias and script that still says `ios-push`. What the
    // report answers is the current spelling, because that is what landed on
    // disk — the acceptance is one hop wide, not a second vocabulary.
    await harness.gatewayJson(`/admin/watch/watches/${watch.id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: "ios-push" }),
    });
    expect(
      (await report()).watches.find((w) => w.id === watch.id)?.delivery,
      "turning delivery on did not take",
    ).toBe("omnesis-notify");

    await harness.gatewayJson(`/admin/watch/watches/${watch.id}/delivery`, {
      method: "PUT",
      body: JSON.stringify({ kind: null }),
    });
    const after = (await report()).watches.find((w) => w.id === watch.id);
    expect(after?.delivery, "turning delivery off did not take").toBeNull();
    // The whole point of changing it in place rather than re-adding the watch.
    expect(after?.firings, "switching delivery cost the watch its history").toBe(1);
  }, 300_000);

  test("a spent daily cap withholds the notification and keeps the firing", async () => {
    // The cap is on notifications, not on watching. A firing over it is still a
    // row and still a trace record — and the trace says why nothing was sent,
    // because a person who stops hearing from a watch has to be able to tell a
    // quiet week from a cap they set too low.
    const watch = await addWatch("chatty-watch", true);
    const cap = (await report()).delivery?.perWatchDailyCap ?? 5;

    for (let index = 0; index <= cap; index += 1) {
      await pushMail(`dl-cap-${index}`, `Spring works — item ${index}`);
    }
    const fired = await waitForFirings(watch.id, cap + 1);
    expect(fired, "a cap swallowed a firing rather than a notification").toBe(cap + 1);

    const now = await report();
    const row = now.watches.find((w) => w.id === watch.id);
    expect(row?.attemptedToday, "the cap did not bind").toBe(cap);
    expect(now.delivery?.attempted).toBeGreaterThanOrEqual(cap);

    const suppressed = (await traceOf(watch.id)).filter((r) => r.transition === "suppressed");
    expect(suppressed.length, "a notification was withheld in silence").toBeGreaterThan(0);
    expect(suppressed[0]?.detail).toContain("not delivered");
  }, 420_000);
});
