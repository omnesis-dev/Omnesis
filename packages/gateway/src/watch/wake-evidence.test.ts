// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch's firings may hand an agent, decided once and for all of them.
 *
 * The classification is made when a watch's anchor is minted and has to hold
 * for every firing that watch will ever produce, because the two sides are
 * checked against each other at fire time and a mismatch is refused in both
 * directions. So the rule is conservative on purpose: losing the documents on
 * a mixed watch costs the agent detail it could have asked about, while
 * claiming documents a firing does not have costs the firing itself.
 */

import { describe, expect, it } from "vitest";

import { wakeEvidenceKind, reachableSources } from "./wake-evidence.js";
import type { WatchDefinition } from "@omnesis/watch";

function watch(nodes: unknown[], sinkInput: string): WatchDefinition {
  return {
    name: "w",
    firing_policy: "stays_active",
    nodes,
    sink: { input: sinkInput },
  } as unknown as WatchDefinition;
}

const mail = { id: "mail", type: "source.document_event", filter: {} };
const chat = { id: "chat", type: "source.document_event", filter: {} };
const tick = { id: "tick", type: "source.time", recurring: "0 9 * * *" };
const row = { id: "row", type: "source.analytics_row", table: "t" };

describe("what a watch can offer", () => {
  it("offers documents when every reachable source is a document source", () => {
    expect(wakeEvidenceKind(watch([mail], "mail"))).toBe("documents");
  });

  it("offers documents for a join over two document arms", () => {
    // Both arms contribute, and the firing carries both — which is what an
    // agent asking "what caused this" usually needs, since the answer to a
    // join is rarely one document.
    const join = { id: "both", type: "stateful.and", inputs: { mail: {}, chat: {} } };
    expect(wakeEvidenceKind(watch([mail, chat, join], "both"))).toBe("documents");
  });

  it("offers documents even when a clock can also fire it", () => {
    // This watch has two ways of being true, and only one of them has a
    // document behind it. Both firings are correct, so the claim has to admit
    // the document case — the timer firing simply carries nothing, which the
    // store allows and the agent reads as the condition alone.
    const or = { id: "either", type: "stateful.or", inputs: { mail: {}, tick: {} } };
    expect(wakeEvidenceKind(watch([mail, tick, or], "either"))).toBe("documents");
  });

  it("offers nothing but the condition for an analytics watch", () => {
    expect(wakeEvidenceKind(watch([row], "row"))).toBe("condition-only");
  });

  it("ignores a node the sink cannot reach", () => {
    // A definition may carry a node nothing downstream reads. It cannot
    // contribute to a firing, so it must not decide what a firing can offer.
    const orphan = { ...row, id: "orphan" };
    expect(wakeEvidenceKind(watch([mail, orphan], "mail"))).toBe("documents");
    expect(reachableSources(watch([mail, orphan], "mail")).map((n) => n.id)).toEqual(["mail"]);
  });

  it("offers nothing when the sink names a node that is not there", () => {
    // A watch that cannot fire has no firings to make a claim about, and a
    // claim about firings that never happen is still a claim.
    expect(wakeEvidenceKind(watch([mail], "missing"))).toBe("condition-only");
  });
});
