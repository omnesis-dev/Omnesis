// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A firing on its way to an agent.
 *
 * The wake itself is not built here — it is the one the harnesses already
 * understand, unchanged. What this module does is report a firing into the
 * anchor that owns the approval, the grant and the answer authority, and from
 * there the existing machinery does the rest.
 *
 * So the properties worth pinning are the ones that decide whether an agent is
 * woken at all, whether it is woken twice, and what it will be allowed to read
 * when it asks what happened.
 */

import { describe, expect, it } from "vitest";

import { agentWakeDelivery, type WatchWakeAnchorPort } from "./wake.js";
import type { WatchNotification } from "./engine-host.js";
import type { WatchV2EvidenceKind } from "../subscriptions/watch-v2-plan.js";

const FIRING: WatchNotification = {
  watchId: "w-1",
  watchName: "an-order-shipped",
  // Two keys, on purpose: `firingKey` is the deep-link key several firings of
  // one tick share, and `firingId` is the identity that tells them apart.
  firingKey: "w-1:41",
  firingId: "w-1:41:notify:ka",
  title: "Omnesis",
  body: "Tell me when an order I was told about ships.",
  authoredCopy: {},
  condition: "Tell me when an order I was told about ships.",
  firedAt: "2026-03-04T09:00:00.000Z",
  documentIds: ["doc-a", "doc-b"],
  payload: { crates: 42, depot: "Northgate" },
};

/** An anchor set that records what it was asked to do. */
function anchors(
  overrides: {
    anchor?: { subscriptionId: string; revision: number; evidence: WatchV2EvidenceKind } | null;
    fired?: boolean;
  } = {},
): { port: WatchWakeAnchorPort; reported: Parameters<WatchWakeAnchorPort["fire"]>[0][] } {
  const reported: Parameters<WatchWakeAnchorPort["fire"]>[0][] = [];
  return {
    reported,
    port: {
      anchorFor: () =>
        overrides.anchor === undefined
          ? { subscriptionId: "sub_1", revision: 3, evidence: "documents" }
          : overrides.anchor,
      fire: (input) => {
        reported.push(input);
        return Promise.resolve({ fired: overrides.fired ?? true });
      },
    },
  };
}

describe("reporting a firing into its anchor", () => {
  it("hands over the documents that made it true", async () => {
    // The whole difference between an agent that was woken and one that can
    // act. Without them the answer path has nothing to release but a sentence.
    const { port, reported } = anchors();
    await agentWakeDelivery(() => port).send(FIRING);

    expect(reported[0]?.evidenceDocumentIds).toEqual(["doc-a", "doc-b"]);
  });

  it("withholds documents from an anchor approved for the condition alone", async () => {
    // The anchor's claim bounds the firing, not the other way round. A watch
    // reclassified under a newer build can produce a firing carrying documents
    // against an approval that never admitted any, and releasing them would put
    // corpus content past a decision nobody made.
    const { port, reported } = anchors({
      anchor: { subscriptionId: "sub_1", revision: 3, evidence: "condition-only" },
    });
    await agentWakeDelivery(() => port).send(FIRING);

    expect(reported[0]?.evidenceDocumentIds).toEqual([]);
  });

  it("carries what the plan observed only where it is the whole of the evidence", async () => {
    // A condition-only firing has no documents to say what happened, so what
    // the plan saw satisfying it is the only account of the occurrence that
    // will ever exist. Recorded now rather than re-queried later, when the
    // same condition can be true of a different row.
    const { port, reported } = anchors({
      anchor: { subscriptionId: "sub_1", revision: 3, evidence: "condition-only" },
    });
    await agentWakeDelivery(() => port).send(FIRING);

    expect(reported[0]?.observation).toEqual({ crates: 42, depot: "Northgate" });
  });

  it("leaves the observation behind where documents already say what happened", async () => {
    // Two descriptions of one occurrence can disagree, and the documents are
    // the ones the approval admitted.
    const { port, reported } = anchors();
    await agentWakeDelivery(() => port).send(FIRING);

    expect(reported[0]?.observation).toBeUndefined();
  });

  it("reports the firing's full identity, so a repeat is one firing", async () => {
    // The anchor is unique on (subscription, revision, eventKey). Reusing an
    // identity the runtime already assigned makes that constraint the replay
    // guard, rather than a second one invented here that could disagree.
    const { port, reported } = anchors();
    await agentWakeDelivery(() => port).send(FIRING);

    expect(reported[0]?.eventKey).toBe("w-1:41:notify:ka");
    expect(reported[0]?.subscriptionId).toBe("sub_1");
    expect(reported[0]?.revision).toBe(3);
  });

  it("gives two firings of one tick two keys, so the second one wakes somebody", async () => {
    // A broadcast arm re-judges every live cell at the tick's own sequence
    // number, so several firings about different evidence share a
    // `watchId:seq`. Keyed on that, the anchor takes the first and discards
    // every other as a replay — the agent is never told, nothing is logged as
    // lost, and the silence reads exactly like a week in which nothing
    // happened.
    const { port, reported } = anchors();
    const wake = agentWakeDelivery(() => port);

    await wake.send({ ...FIRING, firingId: "w-1:41:notify:ka", documentIds: ["doc-a"] });
    await wake.send({ ...FIRING, firingId: "w-1:41:notify:kb", documentIds: ["doc-b"] });

    expect(new Set(reported.map((r) => r.eventKey)).size).toBe(2);
  });

  it("gives the same firing reported twice one key, so the replay guard holds", async () => {
    // The other half, and the reason the identity has to be the firing's own
    // rather than something minted here: a re-presented firing must still
    // collide with itself.
    //
    // This one holds under a coarser key too — that is the point. It pins the
    // property the widening had to preserve, not the widening itself.
    const { port, reported } = anchors();
    const wake = agentWakeDelivery(() => port);

    await wake.send(FIRING);
    await wake.send(FIRING);

    expect(new Set(reported.map((r) => r.eventKey)).size).toBe(1);
  });

  it("reports a repeat as nothing delivered", async () => {
    // A firing the anchor already had wakes nobody a second time, and the
    // caller must not count it — the allowance is for interruptions that
    // happened.
    const { port } = anchors({ fired: false });
    expect(await agentWakeDelivery(() => port).send(FIRING)).toMatchObject({ delivered: 0 });
  });

  it("carries the firing's own instant, not the moment it was reported", async () => {
    const { port, reported } = anchors();
    await agentWakeDelivery(() => port).send(FIRING);
    expect(reported[0]?.firedAt).toBe(Date.parse("2026-03-04T09:00:00.000Z"));
  });

  it("falls back to now when a firing's instant cannot be read", async () => {
    // A firing with an unparseable time is still a firing. Reporting it with
    // NaN would make the anchor's row unorderable and the agent's answer
    // unanchored in time.
    const { port, reported } = anchors();
    await agentWakeDelivery(() => port).send({ ...FIRING, firedAt: "not a time" });
    expect(Number.isFinite(reported[0]?.firedAt)).toBe(true);
  });

  it("sends nothing when the watch has no anchor", async () => {
    // A watch naming an integration nothing holds. It goes on firing and
    // recording, and the log says why nobody was woken — silence here reads
    // exactly like an agent that read every wake and did nothing.
    const { port, reported } = anchors({ anchor: null });
    expect(await agentWakeDelivery(() => port).send(FIRING)).toMatchObject({ delivered: 0 });
    expect(reported, "a firing was reported with no anchor to report it into").toEqual([]);
  });

  it("sends nothing, and does not throw, with no integration wired at all", async () => {
    expect(await agentWakeDelivery(() => null).send(FIRING)).toMatchObject({ delivered: 0 });
  });

  it("asks for the anchors each time, so a re-paired harness is picked up", async () => {
    const first = anchors();
    const second = anchors();
    let current = first.port;
    const delivery = agentWakeDelivery(() => current);

    await delivery.send(FIRING);
    current = second.port;
    await delivery.send(FIRING);

    expect(first.reported).toHaveLength(1);
    expect(second.reported).toHaveLength(1);
  });
});
