// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Reading a watch's history into something a canvas can light.
//
// The fixtures are multi-key and multi-cell on purpose. A single-instance path
// reads the same whichever way the collapse is written, so it would pass over
// the one bug this module can have: folding two keys' verdicts onto one node
// and showing a reader a single outcome for a moment that produced several.

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
const {
  findWatchPath,
  readWatchHistory,
  watchDebugHref,
  watchNodeVerdict,
  watchPathDelivery,
  watchKeyDisplay,
  watchPathSummary,
  watchPathTone,
  watchPathVerdicts,
  watchTransition,
} = await import("./watch-trace.js");

/** One node's entry as the history route projects it. */
function node(
  nodeId: string,
  key: string,
  verdict: string,
  extra: { detail?: string; failure?: string; steps?: string[] } = {},
) {
  const before = extra.steps ?? [];
  return {
    nodeId,
    key,
    verdict,
    detail: extra.detail ?? null,
    failure: extra.failure ?? null,
    steps: [
      ...before.map((transition) => ({ transition, detail: null, failure: null })),
      { transition: verdict, detail: extra.detail ?? null, failure: extra.failure ?? null },
    ],
  };
}

/**
 * Two firings, a hold in the judge's own words, a nomination the budget parked,
 * a tick that touched two keys at once, and one firing the trace has forgotten.
 */
function history() {
  return readWatchHistory({
    trace: { records: 12, retained: 2000 },
    paths: [
      {
        seq: -1,
        at: "2026-05-04T11:45:00.000Z",
        timer: true,
        traceRetained: true,
        outcome: "fired",
        forced: false,
        keys: ["person=maya"],
        nodes: [node("unanswered_2d", "person=maya", "fired"), node("notify", "singleton", "fired")],
        firings: [
          {
            nodeId: "notify",
            keyHash: "waitmaya:0",
            firedAt: "2026-05-04T11:45:00.000Z",
            noticedAt: "2026-05-04T11:45:02.000Z",
            forced: false,
            payload: {},
            documents: [
              { id: "doc_quote", title: "Re: roof quote", sourceId: "gmail:maya@example.com" },
            ],
            delivery: { kind: "omnesis-notify", delivered: 1, attempted: 1, at: "x" },
          },
        ],
      },
      {
        seq: 14,
        at: "2026-05-04T10:30:00.000Z",
        timer: false,
        traceRetained: true,
        outcome: "considered",
        forced: false,
        keys: ["person=maya"],
        nodes: [
          node("judge", "person=maya", "held", {
            detail: "today's allowance is spent",
            failure: "budget",
          }),
        ],
        firings: [],
      },
      {
        seq: 13,
        at: "2026-05-04T10:02:00.000Z",
        timer: false,
        traceRetained: true,
        outcome: "considered",
        forced: false,
        keys: ["person=david"],
        nodes: [
          node("mail", "person=david", "armed"),
          node("judge", "person=david", "held", {
            detail: "The thread already carries a reply from you.",
            steps: ["armed"],
          }),
        ],
        firings: [],
      },
      {
        seq: 12,
        at: "2026-05-04T09:15:30.000Z",
        timer: false,
        traceRetained: true,
        outcome: "considered",
        forced: false,
        keys: ["person=maya", "person=jamie"],
        nodes: [
          node("mail", "person=maya", "armed"),
          node("mail", "person=jamie", "armed"),
          node("unanswered_2d", "person=maya", "armed"),
          node("unanswered_2d", "person=jamie", "failed", { failure: "provider" }),
        ],
        firings: [],
      },
      {
        seq: 3,
        at: "2026-05-01T08:00:05.000Z",
        timer: false,
        traceRetained: false,
        outcome: "fired",
        forced: false,
        keys: [],
        nodes: [],
        firings: [
          {
            nodeId: "notify",
            keyHash: "rolled:0",
            firedAt: "2026-05-01T08:00:00.000Z",
            noticedAt: "2026-05-01T08:00:05.000Z",
            forced: false,
            payload: {},
            documents: [],
            delivery: null,
          },
        ],
      },
    ],
  });
}

describe("reading the response", () => {
  test("keeps the order the gateway sent, which is by when things happened", () => {
    // A deadline is journaled with a sequence counting down from -1. Re-sorting
    // here would file it before every arrival however recently it elapsed.
    expect(history().paths.map((path: any) => path.seq)).toEqual([-1, 14, 13, 12, 3]);
    expect(history().retained).toBe(12);
  });

  test("reads a payload this build does not recognise as nothing rather than throwing", () => {
    expect(readWatchHistory(null).paths).toEqual([]);
    expect(readWatchHistory({ paths: "nope" }).paths).toEqual([]);
    // A path with no sequence number cannot be addressed, so it is dropped
    // rather than rendered as a row nothing can select.
    expect(readWatchHistory({ paths: [{ at: "x" }, { seq: 4 }] }).paths).toHaveLength(1);
    expect(readWatchHistory({ paths: [{ seq: 4 }] }).paths[0]).toMatchObject({
      seq: 4,
      nodes: [],
      firings: [],
      keys: [],
      // Absent means retained: only the gateway saying so makes it false, and
      // a reader must never be told a trace rolled off because a field was
      // missing from a response.
      traceRetained: true,
    });
  });

  test("finds one event by its sequence, negatives included", () => {
    const { paths } = history();
    expect(findWatchPath(paths, -1)?.timer).toBe(true);
    expect(findWatchPath(paths, 13)?.seq).toBe(13);
    expect(findWatchPath(paths, 99)).toBe(null);
    expect(findWatchPath(paths, null)).toBe(null);
  });
});

describe("lighting the canvas", () => {
  test("gives one chip per node, and none to a node the event never reached", () => {
    const chips = watchPathVerdicts(findWatchPath(history().paths, 13));
    expect([...chips.keys()]).toEqual(["mail", "judge"]);
    // Absent rather than present-and-empty: the canvas dims what it cannot find.
    expect(chips.get("notify")).toBe(undefined);
    expect(chips.get("judge")?.label).toBe("Held");
  });

  test("keeps two keys' verdicts apart on one node, and shows the one worth acting on", () => {
    const chips = watchPathVerdicts(findWatchPath(history().paths, 12));
    const contested = chips.get("unanswered_2d");

    // Armed under one key, failed under the other. A box carries one chip, and
    // it carries the failure — reporting "Armed" would hide the thing an
    // operator has to act on behind the thing that went fine.
    expect(contested.tone).toBe("failed");
    expect(contested.label).toBe("Failed ·2");
    expect(contested.cells.map((cell: any) => cell.key)).toEqual([
      "person=maya",
      "person=jamie",
    ]);
    // Both are still readable, because the count alone does not say which key
    // is which.
    expect(contested.title).toContain("person=maya: Armed");
    expect(contested.title).toContain("person=jamie: Failed");

    // A node the tick touched under two keys with the same verdict still says
    // how many cells it was.
    expect(chips.get("mail").label).toBe("Armed ·2");
  });

  test("prefers a hold nothing answered over one the judge decided", () => {
    // Both are `held` and both are amber, so tone alone leaves the first cell
    // holding the box. Only the parked one is something an operator can act
    // on, and a box reading "Held" over it would say the judge had decided
    // when it never ran.
    const chips = watchPathVerdicts({
      nodes: [
        node("judge", "person=david", "held", { detail: "Nothing is outstanding." }),
        node("judge", "person=maya", "held", { failure: "budget" }),
      ],
    });
    expect(chips.get("judge").label).toBe("Parked ·2");
    expect(chips.get("judge").tone).toBe("held");
  });

  test("carries the judge's own sentence into the chip a reader hovers", () => {
    const chips = watchPathVerdicts(findWatchPath(history().paths, 13));
    expect(chips.get("judge").title).toContain("The thread already carries a reply from you.");
  });

  test("lights nothing for a firing whose trace has rolled off", () => {
    expect(watchPathVerdicts(findWatchPath(history().paths, 3)).size).toBe(0);
  });
});

describe("the sink, which the runtime never names", () => {
  test("wears the delivery outcome instead of dimming as unreached", () => {
    // `$sink` is drawn by the portal, not declared by the watch, so no trace
    // record ever mentions it. Left to the trace alone, the box that stands for
    // delivery would grey out on exactly the events that reached it.
    const chips = watchPathVerdicts(findWatchPath(history().paths, -1));
    expect(chips.get("$sink")).toMatchObject({ label: "Delivered", tone: "fired" });
  });

  test("stays unlit on an event that produced no firing", () => {
    expect(watchPathVerdicts(findWatchPath(history().paths, 13)).get("$sink")).toBe(undefined);
  });

  test("says a firing the daily cap dropped did not arrive", () => {
    // A suppressed firing has no delivery row at all — the runtime records the
    // cap as a transition and never reaches an outcome — so reading
    // `delivered === 0` alone would report it as having gone out fine.
    const capped = {
      ...findWatchPath(history().paths, -1),
      nodes: [node("notify", "singleton", "suppressed")],
      firings: [{ ...findWatchPath(history().paths, -1).firings[0], delivery: null }],
    };
    expect(watchPathDelivery(capped)).toBe("undelivered");
    expect(watchPathSummary(capped)).toBe("Fired — not delivered");
    expect(watchPathVerdicts(capped).get("$sink").label).toBe("Not delivered");
  });

  test("calls a watch that delivers nowhere recorded, not undelivered", () => {
    const quiet = {
      ...findWatchPath(history().paths, -1),
      nodes: [],
      firings: [{ ...findWatchPath(history().paths, -1).firings[0], delivery: null }],
    };
    expect(watchPathDelivery(quiet)).toBe("recorded");
    expect(watchPathSummary(quiet)).toBe("Fired");
  });
});

describe("the runtime's vocabulary", () => {
  test("tells a judgement of no from a nomination the budget parked", () => {
    // Both are `held`. Only one of them is a decision — and a shadow period
    // measuring precision would count a model outage as a judgement if the two
    // read the same.
    const judged = watchNodeVerdict(
      node("judge", "person=david", "held", { detail: "Nothing is outstanding." }),
    );
    expect(judged.label).toBe("Held");
    expect(judged.failure).toBe(null);

    const parked = watchNodeVerdict(
      node("judge", "person=maya", "held", { failure: "budget" }),
    );
    expect(parked.label).toBe("Parked");
    expect(parked.failure.label).toBe("budget");
    expect(parked.meaning).toContain("asked again");
  });

  test("prints a transition this build has never heard of as itself", () => {
    // The table is mirrored from the runtime's, so it can drift. An invented
    // friendly name would be worse than the runtime's own word.
    expect(watchTransition("teleported").label).toBe("teleported");
    expect(watchTransition("teleported").tone).toBe("noted");
    expect(watchTransition("fired").tone).toBe("fired");
    expect(watchTransition("suppressed").tone, "a suppressed firing is still a firing").toBe(
      "fired",
    );
  });
});

describe("summarising one event", () => {
  test("says plainly when the trace can no longer explain a firing", () => {
    expect(watchPathSummary(findWatchPath(history().paths, 3))).toBe("Trace no longer retained");
  });

  test("names the node that ended a consideration, not the fact that nothing happened", () => {
    // "Considered" answers nothing. The node that held is the answer to why it
    // did not fire, which is what this lens is for.
    expect(watchPathSummary(findWatchPath(history().paths, 13))).toBe("Held at judge");
    expect(watchPathSummary(findWatchPath(history().paths, 14))).toBe("Parked at judge");
  });

  test("reports a firing, and a failure over the arms that merely armed", () => {
    expect(watchPathSummary(findWatchPath(history().paths, -1))).toBe("Fired");
    const failed = { ...findWatchPath(history().paths, 12), outcome: "failed" };
    expect(watchPathSummary(failed)).toBe("Failed — provider");
  });

  test("never calls an event that did not fire by the name of a node that did", () => {
    // Every event that matches a source node at all begins with that node
    // firing, and a counting node downstream of it is bookkeeping — so the only
    // verdict on this path with a tone is the source's. Reaching back for it
    // would put "Fired" on a row where nothing fired, which is the one
    // distinction this list exists to draw.
    const counting = {
      seq: 91,
      at: "2026-05-04T09:00:00.000Z",
      timer: false,
      traceRetained: true,
      outcome: "considered",
      forced: false,
      keys: ["person=p-1"],
      nodes: [
        { nodeId: "arrival", key: "singleton", steps: [{ transition: "fired" }], verdict: "fired" },
        {
          nodeId: "three_from_them",
          key: "person=p-1",
          steps: [{ transition: "accumulated" }],
          verdict: "accumulated",
          detail: "1 of 3 within 3650 days",
        },
      ],
      firings: [],
    };
    expect(watchPathSummary(counting)).toBe("Considered");
    // And the colour agrees with the words. Read at a glance, a green row is a
    // firing — so a consideration wearing the firing tone says the opposite of
    // what its own label says.
    expect(watchPathTone(counting)).not.toBe("fired");
  });

  test("the colour and the words are one reading, so they cannot disagree", () => {
    const paths = history().paths;
    expect(watchPathTone(findWatchPath(paths, -1))).toBe("fired");
    expect(watchPathTone(findWatchPath(paths, 13))).toBe("held");
    expect(watchPathTone(findWatchPath(paths, 3))).toBe("noted");
    expect(watchPathTone({ ...findWatchPath(paths, 12), outcome: "failed" })).toBe("failed");
  });
});

describe("naming the keys a trace wrote", () => {
  const names = new Map([["p-1", "Maya Reeves"]]);

  test("swaps an id the state read resolved, so one page names a key one way", () => {
    expect(watchKeyDisplay("person=p-1", names)).toBe("person=Maya Reeves");
    expect(watchKeyDisplay("person=p-1,day=2026-05-04", names)).toBe(
      "person=Maya Reeves,day=2026-05-04",
    );
  });

  test("leaves a key the directory does not know exactly as the runtime wrote it", () => {
    expect(watchKeyDisplay("person=p-9", names)).toBe("person=p-9");
    expect(watchKeyDisplay("singleton", names)).toBe("singleton");
    // No state loaded is the common case on first paint, and the raw key is
    // what this said before any resolution existed.
    expect(watchKeyDisplay("person=p-1", null)).toBe("person=p-1");
    expect(watchKeyDisplay("person=p-1", new Map())).toBe("person=p-1");
  });
});

describe("addressing a canvas", () => {
  test("encodes a watch id, which is opaque and need not be path-safe", () => {
    expect(watchDebugHref("a/b")).toBe("/portal/debug/watch/a%2Fb");
  });

  test("carries one event, including a timer's negative sequence", () => {
    expect(watchDebugHref("w1", 412)).toBe("/portal/debug/watch/w1/history/412");
    expect(watchDebugHref("w1", -3)).toBe("/portal/debug/watch/w1/history/-3");
    // Zero is a real sequence number; only an absent one drops the segment.
    expect(watchDebugHref("w1", 0)).toBe("/portal/debug/watch/w1/history/0");
    expect(watchDebugHref("w1", null)).toBe("/portal/debug/watch/w1");
    expect(watchDebugHref("w1", undefined)).toBe("/portal/debug/watch/w1");
  });
});
