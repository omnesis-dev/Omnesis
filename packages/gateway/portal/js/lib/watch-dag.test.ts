// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Reading a stored watch definition into a drawable graph. The fixtures are
// the runtime's own validated, replay-tested watches, so these assert against
// definitions the DSL actually accepts rather than against shapes invented to
// suit the reader — the failure mode this file exists to catch is the portal
// disagreeing with the runtime about what a definition means.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
const { readWatchDag, layoutWatchDag, badgeRows, MAX_VISIBLE_BADGES } = await import(
  "./watch-dag.js"
);
// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
const { WATCH_SINK_ID, watchDeliveryFields, watchNodeBadges, watchNodeSummary, watchPropositions } =
  await import("./watch-dsl.js");

const FIXTURES = fileURLToPath(new URL("../../../../watch/universes/poc/watches/", import.meta.url));

function fixture(name: string) {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8"));
}

function dagOf(name: string) {
  const read = readWatchDag(fixture(name));
  if (!read.ok) throw new Error(`fixture ${name} did not read: ${read.reason}`);
  return read.dag;
}

function rankIds(dag: any): string[][] {
  return dag.ranks.map((rank: any[]) => rank.map((node) => node.id));
}

function edgeBetween(dag: any, from: string, to: string) {
  const found = dag.edges.find((edge: any) => edge.from === from && edge.to === to);
  if (!found) throw new Error(`no edge ${from} → ${to}`);
  return found;
}

function noteKinds(edge: any): string[] {
  return edge.notes.map((note: any) => note.kind);
}

describe("ranking a real definition", () => {
  test("puts the sources on the top rank and the sink alone on the last", () => {
    const dag = dagOf("important-email-unanswered");
    expect(rankIds(dag)).toEqual([
      ["inbound_email", "my_reply"],
      ["unanswered_3d"],
      [WATCH_SINK_ID],
    ]);
    // Every top-rank node is a trip-wire, and nothing below it is.
    expect(dag.ranks[0].every((node: any) => node.isSource)).toBe(true);
    expect(dag.ranks[1].some((node: any) => node.isSource)).toBe(false);
  });

  test("ranks a four-deep graph in declaration order within each rank", () => {
    expect(rankIds(dagOf("alice-decided-to-leave"))).toEqual([
      ["alice_email", "alice_chats"],
      ["any_signal"],
      ["decided_judge"],
      [WATCH_SINK_ID],
    ]);
  });

  test("keeps the sink below everything, not merely below its own input", () => {
    // The threshold's three arms include a time source, which would otherwise
    // sit on the same rank as the sink if ranks were computed from the input.
    const dag = dagOf("same-topic-across-two-channels");
    const sink = dag.nodeById.get(WATCH_SINK_ID);
    const deepest = Math.max(
      ...dag.nodes
        .filter((node: any) => node.kind === "node")
        .map((node: any) => node.rank as number),
    );
    expect(sink.rank).toBe(deepest + 1);
    expect(rankIds(dag).at(-1)).toEqual([WATCH_SINK_ID]);
  });

  test("draws the sink as a box carrying its own input and delivery", () => {
    const dag = dagOf("quote-accepted-then-invoiced");
    const sink = dag.nodeById.get(WATCH_SINK_ID);
    expect(sink.kind).toBe("sink");
    expect(sink.node.input).toBe("accepted_then_invoiced");
    // No fixture in the poc universe delivers anywhere.
    expect(sink.delivery).toBeNull();
    expect(edgeBetween(dag, "accepted_then_invoiced", WATCH_SINK_ID).sink).toBe(true);
  });
});

describe("edges", () => {
  test("carry the key expression that flows across them", () => {
    const dag = dagOf("important-email-unanswered");
    expect(edgeBetween(dag, "inbound_email", "unanswered_3d").key).toEqual({
      thread_id: ".thread_id",
    });
    expect(edgeBetween(dag, "my_reply", "unanswered_3d").key).toEqual({ thread_id: ".thread_id" });
  });

  test("distinguish an arm from a cancel", () => {
    const dag = dagOf("important-email-unanswered");
    expect(edgeBetween(dag, "inbound_email", "unanswered_3d").role).toBe("arm");
    const cancel = edgeBetween(dag, "my_reply", "unanswered_3d");
    expect(cancel.role).toBe("cancel");
    expect(noteKinds(cancel)).toContain("cancel");
  });

  test("mark where a key is first derived", () => {
    // `any_signal` is an OR node with no key of its own, so the edge into the
    // judge is where a person key is first computed.
    const dag = dagOf("alice-decided-to-leave");
    expect(noteKinds(edgeBetween(dag, "any_signal", "decided_judge"))).toContain("derived");
    expect(dag.nodeById.get("decided_judge").keyComponents).toEqual(["person"]);
    expect(dag.nodeById.get("any_signal").keyed).toBe(false);
  });

  test("mark where two keyed arms join", () => {
    const dag = dagOf("quote-accepted-then-invoiced");
    for (const from of ["quote_accepted", "invoice_issued"]) {
      expect(noteKinds(edgeBetween(dag, from, "accepted_then_invoiced"))).toContain("joined");
    }
  });

  test("mark where the key is dropped, collapsing to one global cell", () => {
    // No poc fixture drops a key between two nodes, so this one is written for
    // it: a per-thread wait feeding a cooldown that keys nothing, which funnels
    // every thread's firings through a single quiet period.
    const read = readWatchDag({
      watch: {
        name: "one-quiet-period-for-every-thread",
        firing_policy: "stays_active",
        nodes: [
          {
            id: "inbound",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"] },
            output_map: { thread_id: "$e.metadata.extra.threadId" },
          },
          {
            id: "per_thread_wait",
            type: "stateful.wait",
            inputs: { inbound: { role: "arm", key: { thread_id: ".thread_id" } } },
            duration: "2 days",
            on_collision: "reset",
          },
          {
            id: "one_at_a_time",
            type: "stateful.cooldown",
            inputs: { per_thread_wait: { role: "arm" } },
            min_interval: "1 day",
          },
        ],
        sink: { input: "one_at_a_time" },
      },
    });
    expect(read.ok).toBe(true);
    expect(noteKinds(edgeBetween(read.dag, "per_thread_wait", "one_at_a_time"))).toContain(
      "dropped",
    );
    // The sink is where the flow ends, not a node that collapses a population,
    // so its edge is never marked as a drop.
    const keyed = dagOf("same-topic-across-two-channels");
    expect(noteKinds(edgeBetween(keyed, "two_of_three", WATCH_SINK_ID))).not.toContain("dropped");
  });

  test("show a broadcast, which reaches every live key rather than starting one", () => {
    const dag = dagOf("same-topic-across-two-channels");
    const broadcast = edgeBetween(dag, "weekly_horizon", "two_of_three");
    expect(broadcast.broadcast).toBe(true);
    expect(broadcast.key).toBeNull();
    expect(noteKinds(broadcast)).toContain("broadcast");
    // A keyless edge that is declared a broadcast is not a dropped key.
    expect(noteKinds(broadcast)).not.toContain("dropped");
  });

  test("name the branch a node reports through $fired_by", () => {
    const or = dagOf("alice-decided-to-leave");
    expect(edgeBetween(or, "alice_email", "any_signal").notes).toContainEqual(
      expect.objectContaining({ kind: "fired-by", label: "$fired_by: alice_email" }),
    );
    // A threshold branches too, so its arms report the same way.
    const threshold = dagOf("same-topic-across-two-channels");
    expect(noteKinds(edgeBetween(threshold, "email_mention", "two_of_three"))).toContain("fired-by");
    // A wait does not branch, so nothing claims it does.
    const wait = dagOf("important-email-unanswered");
    expect(noteKinds(edgeBetween(wait, "inbound_email", "unanswered_3d"))).not.toContain("fired-by");
  });

  test("render both parents of a fan-in", () => {
    const dag = dagOf("alice-decided-to-leave");
    const intoOr = dag.edges.filter((edge: any) => edge.to === "any_signal");
    expect(intoOr.map((edge: any) => edge.from)).toEqual(["alice_email", "alice_chats"]);
  });
});

describe("per-node summaries and badges", () => {
  test("summarise a source by its filter", () => {
    const nodes = fixture("important-email-unanswered").watch.nodes;
    expect(watchNodeSummary(nodes[0])).toBe("gmail · email · on created");
  });

  test("summarise a threshold by its count and deadline", () => {
    // Three inputs, two arms: the third is a broadcast timer that reaches every
    // live key rather than one of the things counted towards the threshold.
    // Counting it printed a firing rule the runtime does not use.
    const nodes = fixture("same-topic-across-two-channels").watch.nodes;
    const threshold = nodes.find((node: any) => node.type === "stateful.threshold");
    expect(Object.keys(threshold.inputs)).toHaveLength(3);
    expect(watchNodeSummary(threshold)).toBe("2 of 2 arms within 3 days");
  });

  test("summarise a judge by the proposition's first words", () => {
    const nodes = fixture("alice-decided-to-leave").watch.nodes;
    const judge = nodes.find((node: any) => node.type === "llm");
    expect(watchNodeSummary(judge)).toBe("judge: Alice has DECIDED to leave her job — not…");
  });

  test("badge every property that changes how a node behaves", () => {
    const nodes = fixture("sleep-materially-worse").watch.nodes;
    const labels = (id: string) =>
      watchNodeBadges(nodes.find((node: any) => node.id === id)).map((b: any) => b.label);

    expect(labels("sleep_trend")).toEqual(
      expect.arrayContaining(["collision: accumulate", "rising edge", "first observation", "holds 2 days"]),
    );
    expect(labels("materiality_judge")).toEqual(
      expect.arrayContaining(["collision: spawn", "≤ 2 live", "deadline 1 hour"]),
    );
    expect(labels("fortnight_cap")).toEqual(expect.arrayContaining(["≥ 14 days apart"]));
    // A time source configures nothing that changes behaviour.
    expect(labels("daily_tick")).toEqual([]);
  });

  test("badge a persistence window's event floor", () => {
    const nodes = fixture("large-card-spending-streak").watch.nodes;
    const persistence = nodes.find((node: any) => node.type === "stateful.persistence");
    expect(watchNodeBadges(persistence).map((b: any) => b.label)).toEqual(
      expect.arrayContaining([`≥ ${persistence.min_events} events`]),
    );
  });

  test("attribute every proposition to the node that puts it", () => {
    const found = watchPropositions(fixture("alice-decided-to-leave").watch);
    expect(found.map((item: any) => [item.nodeId, item.kind])).toEqual([
      ["alice_email", "judge"],
      ["alice_chats", "judge"],
      ["decided_judge", "judge"],
    ]);
    expect(found[2].outputSchema).toHaveProperty("confidence");
  });
});

describe("delivery", () => {
  test("reads an authored notify block", () => {
    const delivery = watchDeliveryFields({
      kind: "omnesis-notify",
      title: "Invoice still open",
      body: "Studio Northstar's invoice has been unpaid for a week.",
    });
    expect(delivery.kind).toBe("omnesis-notify");
    expect(delivery.fields).toEqual([
      ["Title", "Invoice still open"],
      ["Body", "Studio Northstar's invoice has been unpaid for a week."],
    ]);
    expect(delivery.note).toBeNull();
  });

  test("accepts the pre-rename spelling, because stored watches keep it", () => {
    const delivery = watchDeliveryFields({ kind: "ios-push" });
    expect(delivery).not.toBeNull();
    expect(delivery.note).toMatch(/composes the banner/);
  });

  test("reads an agent wake as its integration and instruction", () => {
    const delivery = watchDeliveryFields({
      kind: "agent-wake",
      integration: "studio-northstar-bot",
      instruction: "Draft a reminder to Jamie Lopez and wait for me to approve it.",
    });
    expect(delivery.fields).toEqual([
      ["Integration", "studio-northstar-bot"],
      ["Instruction", "Draft a reminder to Jamie Lopez and wait for me to approve it."],
    ]);
  });

  test("shows the referents the instruction names, after the instruction", () => {
    // The operator approved a wake at particular things. A surface that showed
    // the words and not what they point at would be describing half of it —
    // and the half that is the same for every watch on the install.
    const delivery = watchDeliveryFields({
      kind: "agent-wake",
      integration: "studio-northstar-bot",
      instruction: "Reply in the conversation this came from.",
      bindings: { ticket: "RQ-4417", conversation: "thread-8821" },
    });

    expect(delivery.fields).toEqual([
      ["Integration", "studio-northstar-bot"],
      ["Instruction", "Reply in the conversation this came from."],
      // Sorted by name: a map is unordered, and a list that followed the
      // enumeration order would reshuffle on a rewrite that changed nothing.
      ["Referent · conversation", "thread-8821"],
      ["Referent · ticket", "RQ-4417"],
    ]);
    expect(delivery.note).toMatch(/alongside the instruction/);
  });

  test("says nothing about referents when a wake names none", () => {
    const delivery = watchDeliveryFields({
      kind: "agent-wake",
      integration: "studio-northstar-bot",
      instruction: "Draft a reminder.",
      bindings: {},
    });

    expect(delivery.fields).toHaveLength(2);
    expect(delivery.note).toBeNull();
  });

  test("drops a referent whose value is not a string", () => {
    // The stored DSL is served verbatim, so a block written by something that
    // did not go through the schema can carry anything. A row reading
    // `[object Object]` is worse than one that is not there.
    const delivery = watchDeliveryFields({
      kind: "agent-wake",
      integration: "studio-northstar-bot",
      instruction: "Draft a reminder.",
      bindings: { conversation: { id: 7 }, ticket: "RQ-4417" },
    });

    expect(delivery.fields).toEqual([
      ["Integration", "studio-northstar-bot"],
      ["Instruction", "Draft a reminder."],
      ["Referent · ticket", "RQ-4417"],
    ]);
  });

  test("says nothing at all when a watch delivers nowhere", () => {
    expect(watchDeliveryFields(undefined)).toBeNull();
    expect(watchDeliveryFields({ kind: "carrier-pigeon" })).toBeNull();
  });
});

describe("a definition this build cannot read", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["no watch block", { nodes: [] }, /no `watch` block/],
    ["no nodes", { watch: { name: "x", nodes: [], sink: { input: "a" } } }, /declares no nodes/],
    [
      "a node with no id",
      { watch: { nodes: [{ type: "source.time" }], sink: { input: "a" } } },
      /no id/,
    ],
    [
      "two nodes sharing an id",
      {
        watch: {
          nodes: [
            { id: "a", type: "source.time", recurring: "0 7 * * *" },
            { id: "a", type: "source.time", recurring: "0 8 * * *" },
          ],
          sink: { input: "a" },
        },
      },
      /share the id/,
    ],
    [
      "a sink naming nothing",
      { watch: { nodes: [{ id: "a", type: "source.time" }], sink: { input: "nope" } } },
      /sink names no node/,
    ],
    [
      "an input naming a node that is not there",
      {
        watch: {
          nodes: [
            { id: "a", type: "source.time" },
            { id: "b", type: "stateless.or", inputs: { ghost: { role: "arm" } } },
          ],
          sink: { input: "b" },
        },
      },
      /which is not declared here/,
    ],
    [
      "a cycle",
      {
        watch: {
          nodes: [
            { id: "a", type: "stateless.or", inputs: { b: { role: "arm" } } },
            { id: "b", type: "stateless.or", inputs: { a: { role: "arm" } } },
          ],
          sink: { input: "a" },
        },
      },
      /cycle/,
    ],
  ];

  test.each(cases)("says what is wrong with %s rather than drawing nothing", (_, dsl, reason) => {
    const read = readWatchDag(dsl);
    expect(read.ok).toBe(false);
    expect(read.reason).toMatch(reason);
  });

  test("still draws a node whose type this build has never heard of", () => {
    const read = readWatchDag({
      watch: {
        name: "future-node",
        nodes: [
          { id: "tick", type: "source.time", recurring: "0 7 * * *" },
          { id: "oracle", type: "stateful.premonition", inputs: { tick: { role: "arm" } } },
        ],
        sink: { input: "oracle" },
      },
    });
    expect(read.ok).toBe(true);
    const oracle = read.dag.nodeById.get("oracle");
    expect(oracle.type).toBe("stateful.premonition");
    expect(oracle.rank).toBe(1);
    // No claim is made about what it does.
    expect(watchNodeSummary(oracle.node)).toBeNull();
  });
});

describe("geometry", () => {
  test("stacks ranks downward and centres each one", () => {
    const layout = layoutWatchDag(dagOf("alice-decided-to-leave"));
    const at = (id: string) => layout.nodes.find((node: any) => node.id === id);

    // Two sources share the top row; everything below sits strictly lower.
    expect(at("alice_email").y).toBe(at("alice_chats").y);
    expect(at("any_signal").y).toBeGreaterThan(at("alice_email").y);
    expect(at("decided_judge").y).toBeGreaterThan(at("any_signal").y);
    expect(at(WATCH_SINK_ID).y).toBeGreaterThan(at("decided_judge").y);

    // A single-node rank is centred over the pair above it.
    const pairCentre = (at("alice_email").x + at("alice_chats").x + at("alice_email").w) / 2;
    expect(at("any_signal").x + at("any_signal").w / 2).toBeCloseTo(pairCentre, 5);
  });

  test("keeps every box and every edge inside the canvas it reports", () => {
    const layout = layoutWatchDag(dagOf("same-topic-across-two-channels"));
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.w).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.h).toBeLessThanOrEqual(layout.height);
    }
    for (const edge of layout.edges) {
      expect(edge.y1).toBeLessThan(edge.y2);
      for (const value of [edge.x1, edge.y1, edge.x2, edge.y2, edge.labelX, edge.labelY]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  test("gives a fan-in separate entry points rather than one line drawn twice", () => {
    const layout = layoutWatchDag(dagOf("same-topic-across-two-channels"));
    const arriving = layout.edges.filter((edge: any) => edge.to === "two_of_three");
    expect(arriving).toHaveLength(3);
    expect(new Set(arriving.map((edge: any) => edge.x2)).size).toBe(3);
  });
});

describe("how many badge rows a box is measured for", () => {
  // The box is sized here and drawn in the canvas. When those two disagreed
  // about the sink's delivery badge the box came out 22px short and flex-shrink
  // silently squashed every line inside it, so the cap is shared rather than
  // declared twice.
  test("allows a row for one badge and two for any number beyond it", () => {
    expect(badgeRows(0)).toBe(0);
    expect(badgeRows(1)).toBe(1);
    expect(badgeRows(2)).toBe(2);
    expect(badgeRows(9)).toBe(2);
  });

  test("caps the chips a box can draw at what two rows hold", () => {
    // The canvas draws at most MAX_VISIBLE_BADGES plus one overflow chip, and
    // the box is measured for exactly that many rows.
    expect(MAX_VISIBLE_BADGES + 1).toBeLessThanOrEqual(4);
    expect(badgeRows(MAX_VISIBLE_BADGES + 1)).toBe(2);
  });
});
