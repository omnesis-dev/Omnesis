// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// The definition canvas, mounted. `lib/watch-dag.test.ts` pins what a stored
// definition *means*; these pin what a reader is actually shown — which boxes
// appear, what an edge is labelled with, which properties earn a badge, and
// what the right pane says once a node is opened. The in-tree poc watches are
// used wherever one covers the case; the delivering watch is invented here,
// because no fixture in that universe delivers anywhere.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  getWatchV2History,
  getWatchV2JudgeExchanges,
  getWatchV2Watch,
  getWatchV2WatchState,
  listWatchV2Watches,
  navigate,
} = vi.hoisted(() => ({
  getWatchV2History: vi.fn(),
  getWatchV2JudgeExchanges: vi.fn(),
  getWatchV2Watch: vi.fn(),
  getWatchV2WatchState: vi.fn(),
  listWatchV2Watches: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api.js", () => ({
  getWatchV2History,
  getWatchV2JudgeExchanges,
  getWatchV2Watch,
  getWatchV2WatchState,
  listWatchV2Watches,
}));
vi.mock("../lib/router.js", () => ({ navigate }));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { WatchDebugTab } from "./watch-debug.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../watch/universes/poc/watches/", import.meta.url),
);

function fixture(name: string) {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8"));
}

/**
 * A watch that delivers, with invented content: the poc universe has no
 * `delivery` block, no metadata predicate and no lexical recall arm, and all
 * three are things the pane must render.
 */
const DELIVERING_DSL = {
  watch: {
    name: "northstar-invoice-unpaid",
    nl_query: "Tell me when a Studio Northstar invoice is still unpaid a week after it lands.",
    firing_policy: "stays_active",
    expires_at: "2027-03-01T09:00:00.000Z",
    ontology_fingerprint: "fixture-ontology-7",
    constants: {
      account_ref: {
        type: "string",
        value: "INV-4471",
        provenance_doc: "doc-fixture-1",
        provenance_note: "The reference printed on the vendor's first invoice.",
      },
    },
    nodes: [
      {
        id: "invoice_arrived",
        type: "source.document_event",
        comment: "Only mail somebody else sent: an invoice the user issued is a different thing.",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", isSelf: false }],
          metadata: [{ path: "extra.labels", op: "contains", value: "invoices" }],
        },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
        recall: {
          semantic: { query: "invoice amount due payment terms", threshold: 0.42 },
          lexical: { terms: ["INV-4471"], match: "token" },
        },
        judge: {
          proposition: "This email is an unpaid invoice addressed to the user",
          output_schema: { amount: "number" },
        },
      },
      {
        id: "payment_sent",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], people: [{ role: "sender", isSelf: true }] },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "unpaid_a_week",
        type: "stateful.wait",
        inputs: {
          invoice_arrived: { role: "arm", key: { thread_id: ".thread_id" } },
          payment_sent: { role: "cancel", key: { thread_id: ".thread_id" } },
        },
        duration: "7 days",
        on_collision: "ignore",
        max_live_instances: 3,
        output_map: { thread: "$n.invoice_arrived.thread_id" },
      },
    ],
    sink: { input: "unpaid_a_week", output_map: { thread: "$n.unpaid_a_week.thread" } },
    delivery: {
      kind: "omnesis-notify",
      title: "Invoice still unpaid",
      body: "A Studio Northstar invoice has been open for a week.",
    },
  },
};

/**
 * Two stateful nodes keyed differently, so a key lens has something to dim.
 *
 * Invented here because no poc watch has two keyed populations of different
 * shapes, and one keyed population makes "dims to the slice" and "dims nothing"
 * the same picture.
 */
const TWO_KEYED_DSL = {
  watch: {
    name: "two-populations",
    firing_policy: "stays_active",
    ontology_fingerprint: "fixture-ontology-7",
    nodes: [
      {
        id: "arrival",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { person_id: "$e.people.sender", order_ref: "$e.metadata.extra.orderRef" },
      },
      {
        id: "reply",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], people: [{ role: "sender", isSelf: true }] },
        output_map: { person_id: "$e.people.recipient" },
      },
      {
        id: "quiet",
        type: "stateful.wait",
        inputs: {
          arrival: { role: "arm", key: { person: ".person_id" } },
          reply: { role: "cancel", key: { person: ".person_id" } },
        },
        duration: "2 days",
        on_collision: "spawn",
        max_live_instances: 2,
        output_map: { order_ref: "$n.arrival.order_ref" },
      },
      {
        id: "streak",
        type: "stateful.persistence",
        inputs: { quiet: { role: "arm", key: { order_id: ".order_ref" } } },
        duration: "7 days",
        min_events: 3,
        output_map: { order_ref: "$n.quiet.order_ref" },
      },
    ],
    sink: { input: "streak", output_map: { order_ref: "$n.streak.order_ref" } },
  },
};

const MAYA = "a1111111-0000-4000-8000-000000000001";
const JAMIE = "a1111111-0000-4000-8000-000000000002";
const AT = Date.parse("2026-04-06T09:00:00.000Z");
const DAY_MS = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(AT + offsetMs).toISOString();
}

/** A cell on `quiet`, keyed by a person the directory has a name for. */
function personCell(id: string, name: string, instance: number, hash: string) {
  return {
    keyHash: hash,
    instance,
    key: { person: id },
    keyLabel: `person=${id}`,
    components: [{ name: "person", raw: id, display: name }],
    state: "live",
    armedAt: iso(instance * 3_600_000),
    deadlineAt: iso(instance * 3_600_000 + 2 * DAY_MS),
    lastFiredAt: null,
    detail: { kind: "wait", firesAt: iso(instance * 3_600_000 + 2 * DAY_MS) },
  };
}

/** A watch with two live people on one node and one order on the other. */
function holdingTwoPopulations() {
  return {
    watch: { id: "watch-01", name: "two-populations" },
    asOf: { at: iso(DAY_MS), seq: 412, journalHead: 418 },
    nodes: [
      {
        id: "arrival",
        type: "source.document_event",
        cells: 0,
        onCollision: null,
        maxLiveInstances: null,
        cancelledBy: [],
        instances: [],
      },
      {
        id: "reply",
        type: "source.document_event",
        cells: 0,
        onCollision: null,
        maxLiveInstances: null,
        cancelledBy: [],
        instances: [],
      },
      {
        id: "quiet",
        type: "stateful.wait",
        cells: 3,
        onCollision: "spawn",
        maxLiveInstances: 2,
        cancelledBy: ["reply"],
        instances: [
          personCell(MAYA, "Maya Reeves", 0, "h-maya"),
          personCell(MAYA, "Maya Reeves", 1, "h-maya"),
          personCell(JAMIE, "Jamie Lopez", 0, "h-jamie"),
        ],
      },
      {
        id: "streak",
        type: "stateful.persistence",
        cells: 1,
        onCollision: null,
        maxLiveInstances: null,
        cancelledBy: [],
        instances: [
          {
            keyHash: "h-order",
            instance: 0,
            key: { order_id: "SO-8841" },
            keyLabel: "order_id=SO-8841",
            components: [{ name: "order_id", raw: "SO-8841", display: null }],
            state: "accumulating",
            armedAt: iso(0),
            deadlineAt: null,
            lastFiredAt: null,
            detail: {
              kind: "persistence",
              count: 2,
              required: 3,
              window: "7 days",
              windowMs: 7 * DAY_MS,
              oldestArrivalAt: iso(0),
            },
          },
        ],
      },
    ],
    timers: [
      {
        nodeId: "quiet",
        keyHash: "h-jamie",
        instance: 0,
        key: { person: JAMIE },
        keyLabel: `person=${JAMIE}`,
        components: [{ name: "person", raw: JAMIE, display: "Jamie Lopez" }],
        kind: "wait",
        dueAt: iso(-DAY_MS),
        overdue: true,
      },
      {
        nodeId: "quiet",
        keyHash: "h-maya",
        instance: 0,
        key: { person: MAYA },
        keyLabel: `person=${MAYA}`,
        components: [{ name: "person", raw: MAYA, display: "Maya Reeves" }],
        kind: "wait",
        dueAt: iso(2 * DAY_MS),
        overdue: false,
      },
    ],
    parked: [
      { nodeId: "arrival", docId: "doc-77", seq: 400, at: iso(0), failure: "budget" },
    ],
    judge: { dailyCap: 200, perWatchDailyCap: 50, spentToday: 7, watchSpentToday: 2 },
  };
}

/** The same watch, with the runtime holding nothing for it. */
function holdingNothing() {
  const empty = holdingTwoPopulations();
  return {
    ...empty,
    nodes: empty.nodes.map((node) => ({ ...node, cells: 0, instances: [] })),
    timers: [],
    parked: [],
  };
}

function storedWatch(dsl: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "watch-01",
    name: (dsl as any)?.watch?.name ?? "unnamed",
    status: "active",
    dsl,
    addedAt: "2026-08-01T09:00:00.000Z",
    fromSeq: 4210,
    note: null,
    compileRunId: "run-77",
    ...overrides,
  };
}

describe("Watch definition canvas", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    // Opening a watch reads its state and its history alongside its definition,
    // so both need an answer on every mount. The defaults are empty — a runtime
    // holding nothing, a watch that has done nothing — so the definition tests
    // never depend on either; the state and history tests replace the one they
    // are about before they open a watch.
    getWatchV2WatchState.mockResolvedValue(holdingNothing());
    getWatchV2History.mockResolvedValue({ trace: { records: 0 }, paths: [] });
    // Read alongside the history and allowed to fail on its own, so the default
    // is a gateway that has kept none rather than one that refused.
    getWatchV2JudgeExchanges.mockResolvedValue({ exchanges: [] });
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  async function open(
    dsl: unknown,
    overrides: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ) {
    getWatchV2Watch.mockResolvedValue({ watch: storedWatch(dsl, overrides) });
    await act(async () => {
      render(h(WatchDebugTab, { watchId: "watch-01", ...props }), host);
    });
    await settle();
  }

  const texts = (selector: string) =>
    [...host.querySelectorAll(selector)].map((el) => el.textContent!.replace(/\s+/g, " ").trim());

  const box = (id: string) =>
    host.querySelector(`[data-node-id="${id}"]`) as unknown as HTMLElement | null;

  const drawerText = () =>
    (host.querySelector(".watch-dag-drawer")?.textContent ?? "").replace(/\s+/g, " ");

  async function click(el: HTMLElement | null) {
    if (!el) throw new Error("nothing to click");
    await act(async () => {
      el.click();
    });
  }

  test("draws every node of the definition, with sources first and the sink last", async () => {
    await open(fixture("important-email-unanswered"));
    expect(texts("[data-node-id]").length).toBe(4);
    expect(box("inbound_email")).not.toBeNull();
    expect(box("my_reply")).not.toBeNull();
    expect(box("unanswered_3d")).not.toBeNull();
    expect(box("$sink")).not.toBeNull();

    // The two trip-wires share the top row; the sink is alone below everything.
    const top = (id: string) => Number(/top:([\d.]+)px/.exec(box(id)!.getAttribute("style")!)![1]);
    expect(top("inbound_email")).toBe(top("my_reply"));
    expect(top("unanswered_3d")).toBeGreaterThan(top("inbound_email"));
    expect(top("$sink")).toBeGreaterThan(top("unanswered_3d"));

    expect(box("inbound_email")!.className).toContain("is-source");
    expect(box("$sink")!.className).toContain("is-sink");
  });

  test("puts the node type, its id and one summary line in each box", async () => {
    await open(fixture("important-email-unanswered"));
    const wait = box("unanswered_3d")!;
    expect(wait.querySelector(".watch-dag-node-type")!.textContent).toBe("stateful.wait");
    expect(wait.querySelector(".watch-dag-node-id")!.textContent).toBe("unanswered_3d");
    expect(wait.querySelector(".watch-dag-node-summary")!.textContent!.trim()).toBe(
      "3 days after arming",
    );
  });

  test("labels an edge with the key expression that flows across it", async () => {
    await open(fixture("important-email-unanswered"));
    const keys = texts(".watch-dag-key");
    // Both edges into the wait key on the thread; the sink edge carries no key.
    expect(keys).toEqual(["(thread_id)", "(thread_id)"]);
    expect(host.querySelector(".watch-dag-key")!.getAttribute("title")).toBe(
      "thread_id = .thread_id",
    );
  });

  test("distinguishes a cancel edge from an arm", async () => {
    await open(fixture("important-email-unanswered"));
    expect(texts(".watch-dag-note.cancel")).toEqual(["cancels"]);
  });

  test("shows a broadcast, and an OR node's $fired_by participation", async () => {
    await open(fixture("same-topic-across-two-channels"));
    expect(texts(".watch-dag-note.broadcast")).toEqual(["broadcast"]);
    expect(texts(".watch-dag-note.fired-by")).toEqual([
      "$fired_by: email_mention",
      "$fired_by: chat_mention",
      "$fired_by: weekly_horizon",
    ]);
    expect(texts(".watch-dag-note.joined")).toEqual(["joins", "joins"]);
  });

  test("badges the properties that change how a node behaves", async () => {
    await open(fixture("sleep-materially-worse"));
    const badges = (id: string) =>
      [...box(id)!.querySelectorAll(".watch-dag-badge")].map((el) =>
        el.textContent!.replace(/\s+/g, " ").trim(),
      );
    expect(badges("sleep_trend")).toEqual(
      expect.arrayContaining(["collision: accumulate", "rising edge"]),
    );
    expect(badges("materiality_judge")).toEqual(
      expect.arrayContaining(["collision: spawn", "≤ 2 live"]),
    );
    expect(badges("fortnight_cap")).toEqual(["≥ 14 days apart"]);
    // A time source has no behaviour switches, so it wears no badges at all.
    expect(badges("daily_tick")).toEqual([]);
  });

  test("badges a persistence window's event floor", async () => {
    await open(fixture("large-card-spending-streak"));
    const persistence = fixture("large-card-spending-streak").watch.nodes.find(
      (node: any) => node.type === "stateful.persistence",
    );
    const badges = [...box(persistence.id)!.querySelectorAll(".watch-dag-badge")].map((el) =>
      el.textContent!.replace(/\s+/g, " ").trim(),
    );
    expect(badges).toEqual(expect.arrayContaining([`≥ ${persistence.min_events} events`]));
  });

  test("renders both parents of a fan-in", async () => {
    await open(fixture("alice-decided-to-leave"));
    expect(box("alice_email")).not.toBeNull();
    expect(box("alice_chats")).not.toBeNull();
    // Two arms into the OR, each named as a branch it can report firing by.
    expect(texts(".watch-dag-note.fired-by")).toEqual([
      "$fired_by: alice_email",
      "$fired_by: alice_chats",
    ]);
    // The key is first computed on the edge below the OR.
    expect(texts(".watch-dag-note.derived")).toEqual(["derives key"]);
  });

  test("opens a node's whole configuration in the right pane", async () => {
    await open(DELIVERING_DSL);
    expect(host.querySelector(".watch-dag-drawer")).toBeNull();
    await click(box("invoice_arrived"));

    const pane = drawerText();
    expect(pane).toContain("source.document_event");
    // The filter, predicate by predicate.
    expect(pane).toContain("gmail");
    expect(pane).toContain("extra.labels contains invoices");
    expect(pane).toContain("sender: anyone but you");
    // Both recall arms, with the floor written into the plan.
    expect(pane).toContain("invoice amount due payment terms");
    expect(pane).toContain("0.42");
    expect(pane).toContain("INV-4471");
    // The judge's sentence and the shape it must answer in.
    expect(pane).toContain("This email is an unpaid invoice addressed to the user");
    expect(pane).toContain("amount");
    // The compiler's note about why the node exists.
    expect(pane).toContain("an invoice the user issued is a different thing");
    // What it hands downstream.
    expect(pane).toContain("$e.metadata.extra.threadId");
  });

  test("keeps the raw JSON one toggle away", async () => {
    await open(DELIVERING_DSL);
    await click(box("invoice_arrived"));
    const raw = host.querySelector(".watch-dag-drawer .watch-dag-raw");
    expect(raw!.querySelector("summary")!.textContent).toBe("Raw JSON");
    const parsed = JSON.parse(raw!.querySelector("pre")!.textContent!);
    expect(parsed.id).toBe("invoice_arrived");
    expect(parsed.recall.semantic.threshold).toBe(0.42);
  });

  test("reports a stateful node's keying, inputs and behaviour", async () => {
    await open(DELIVERING_DSL);
    await click(box("unpaid_a_week"));
    const pane = drawerText();
    expect(pane).toContain("Yes — a cell lives between arm and fire");
    expect(pane).toContain("one cell per (thread_id)");
    expect(pane).toContain("invoice_arrived");
    expect(pane).toContain("payment_sent");
    expect(pane).toContain("cancel");
    expect(pane).toContain("collision: ignore");
    expect(pane).toContain("≤ 3 live");
    expect(pane).toContain("7 days");
  });

  test("treats the sink as a node of its own — input, output map, delivery", async () => {
    await open(DELIVERING_DSL);
    await click(box("$sink"));
    const pane = drawerText();
    expect(pane).toContain("unpaid_a_week");
    expect(pane).toContain("$n.unpaid_a_week.thread");
    expect(pane).toContain("omnesis-notify");
    expect(pane).toContain("Invoice still unpaid");
    expect(pane).toContain("A Studio Northstar invoice has been open for a week.");
  });

  test("the sink box wears the delivery kind a firing will leave by", async () => {
    await open(DELIVERING_DSL);
    const sink = box("$sink")!;
    expect(sink.querySelector(".watch-dag-node-summary")!.textContent!.trim()).toBe(
      "Notifies your devices",
    );
    expect(
      [...sink.querySelectorAll(".watch-dag-badge")].map((el) => el.textContent!.trim()),
    ).toEqual(["omnesis-notify"]);
  });

  test("says plainly when a watch delivers nowhere", async () => {
    await open(fixture("important-email-unanswered"));
    await click(box("$sink"));
    expect(drawerText()).toContain("Delivers nowhere");
  });

  test("clicking the header opens the watch as a whole", async () => {
    await open(DELIVERING_DSL, { note: null, status: "active" });
    await click(host.querySelector(".watch-dag-header-button") as unknown as HTMLElement);

    const pane = drawerText();
    expect(pane).toContain("Tell me when a Studio Northstar invoice is still unpaid");
    expect(pane).toContain("Stays active");
    expect(pane).toContain("2027-03-01T09:00:00.000Z");
    expect(pane).toContain("fixture-ontology-7");
    expect(pane).toContain("Notifies your devices");
    expect(pane).toContain("Active");
    expect(pane).toContain("journal event 4210");
    expect(pane).toContain("View the compile transcript");
    // The propositions, attributed — an installed watch has no stored
    // interpretation, and the pane says so rather than inventing one.
    expect(pane).toContain("An installed watch stores no approved interpretation");
    expect(pane).toContain("This email is an unpaid invoice addressed to the user");
    // A compiler-resolved constant, with the document it was read out of.
    expect(pane).toContain("INV-4471");
    expect(pane).toContain("doc-fixture-1");
  });

  test("names the pause reason when the runtime paused the watch", async () => {
    await open(fixture("important-email-unanswered"), {
      status: "paused",
      note: "The ontology it validated against has moved.",
    });
    expect(host.querySelector(".privacy-banner.warning")!.textContent).toContain(
      "The ontology it validated against has moved.",
    );
  });

  test("moves to another node without being closed first", async () => {
    // The canvas stays live beside the open pane — that is what the top-to-
    // bottom layout is for, and a backdrop over it would take it back.
    await open(DELIVERING_DSL);
    await click(box("invoice_arrived"));
    expect(drawerText()).toContain("invoice_arrived");
    await click(box("payment_sent"));
    expect(drawerText()).toContain("payment_sent");
    expect(drawerText()).not.toContain("unpaid invoice addressed to the user");
    expect(box("payment_sent")!.className).toContain("is-selected");
    expect(box("invoice_arrived")!.className).not.toContain("is-selected");
  });

  test("closes the pane again", async () => {
    await open(DELIVERING_DSL);
    await click(box("$sink"));
    expect(host.querySelector(".watch-dag-drawer")).not.toBeNull();
    await click(host.querySelector(".sources-drawer-header .btn-tiny") as unknown as HTMLElement);
    expect(host.querySelector(".watch-dag-drawer")).toBeNull();
  });

  test("a definition this build cannot read says so, and still shows the JSON", async () => {
    const broken = {
      watch: {
        name: "unreadable",
        nodes: [
          { id: "tick", type: "source.time", recurring: "0 7 * * *" },
          { id: "gate", type: "stateless.or", inputs: { missing: { role: "arm" } } },
        ],
        sink: { input: "gate" },
      },
    };
    await open(broken);
    expect(host.querySelector(".watch-dag")).toBeNull();
    const error = host.querySelector(".debug-error")!;
    expect(error.textContent).toContain("This definition cannot be drawn.");
    expect(error.textContent).toContain("`missing`");
    // The stored definition is still what the runtime is running, so it is here.
    const raw = host.querySelector(".watch-dag-unreadable .watch-dag-raw pre")!;
    expect(JSON.parse(raw.textContent!).watch.name).toBe("unreadable");
    // The watch itself is still openable — its fields do not depend on a graph.
    await click(host.querySelector(".watch-dag-header-button") as unknown as HTMLElement);
    expect(drawerText()).toContain("unreadable");
  });

  describe("the state lens", () => {
    const chips = () =>
      [...host.querySelectorAll(".watch-key-chip")] as unknown as HTMLElement[];
    const chip = (label: string) =>
      chips().find((el) => el.textContent!.replace(/\s+/g, " ").includes(label)) ?? null;
    const dimmed = () =>
      [...host.querySelectorAll(".watch-dag-node.is-dim")].map((el) =>
        el.getAttribute("data-node-id"),
      );

    test("states the moment the whole page belongs to, and re-reads on demand", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);

      const bar = host.querySelector(".watch-state-asof-text")!.textContent!.replace(/\s+/g, " ");
      expect(bar).toContain("journal seq 412");
      // The producer is six events ahead, which is how far behind this watch is.
      expect(bar).toContain("6 behind the journal head");
      expect(getWatchV2WatchState).toHaveBeenCalledTimes(1);

      await click(
        [...host.querySelectorAll(".watch-state-asof button")][0] as unknown as HTMLElement,
      );
      await settle();
      expect(getWatchV2WatchState).toHaveBeenCalledTimes(2);
    });

    test("badges the nodes holding cells, and leaves the empty ones bare", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);

      const count = (id: string) =>
        box(id)!.querySelector(".watch-dag-count")?.textContent?.trim() ?? null;
      expect(count("quiet")).toBe("3");
      expect(count("streak")).toBe("1");
      // A `0` on every trip-wire would read as a fault; absence is the same
      // claim and keeps the eye on the boxes that hold something.
      expect(count("arrival")).toBeNull();
      expect(count("$sink")).toBeNull();
    });

    test("a selected key narrows the badges to that key's cells", async () => {
      // `quiet` holds three cells across two people. Under the lens it must
      // report the two Maya Reeves holds, not the three it holds in total: the
      // reader asked for one key's slice, and on a watch where every node holds
      // every key the badge is the only thing on the canvas that changes — so a
      // whole-population count makes selecting a key look like it did nothing.
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);

      const count = (id: string) =>
        box(id)!.querySelector(".watch-dag-count")?.textContent?.trim() ?? null;
      expect(count("quiet")).toBe("3");

      await click(chip("Maya Reeves")!);
      await settle();
      expect(count("quiet")).toBe("2");
      // The other keyed node holds nothing for her, and says so by going bare
      // rather than by keeping the count it has for somebody else.
      expect(count("streak")).toBeNull();

      await click(chip("Maya Reeves")!);
      await settle();
      expect(count("quiet")).toBe("3");
    });

    test("groups the live keys by shape and resolves person ids to names", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);

      expect(texts(".watch-key-shape")).toEqual(["(order_id)", "(person)"]);
      // Ordered by what the chip says, and the count rides in a span of its
      // own — the flex gap is what separates the two on screen.
      expect(texts(".watch-key-chip")).toEqual([
        "order_id=SO-88411",
        "person=Jamie Lopez1",
        // Two instances of one key are one chip, counted — not two chips.
        "person=Maya Reeves2",
      ]);
      // The raw id stays a hover away from the name that replaced it.
      expect(chip("Maya Reeves")!.getAttribute("title")).toContain(MAYA);
    });

    test("dims the canvas to the selected key's slice, and back again", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      expect(dimmed()).toEqual([]);

      await click(chip("Maya Reeves"));
      // `streak` is keyed and holds nothing for this key. The trip-wires and
      // the sink are unkeyed, so they are never outside a key's slice.
      expect(dimmed()).toEqual(["streak"]);

      await click(chip("SO-8841"));
      expect(dimmed()).toEqual(["quiet"]);

      await click(host.querySelector(".watch-key-lens-head button") as unknown as HTMLElement);
      expect(dimmed()).toEqual([]);
    });

    test("searches keys by name and by raw id alike", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      const search = host.querySelector(".watch-key-search") as unknown as HTMLInputElement;

      const type = async (value: string) => {
        search.value = value;
        await act(async () => {
          search.dispatchEvent(new (globalThis.window as any).Event("input", { bubbles: true }));
        });
      };

      await type("jamie");
      expect(texts(".watch-key-chip")).toEqual(["person=Jamie Lopez1"]);
      await type(MAYA);
      expect(texts(".watch-key-chip")).toEqual(["person=Maya Reeves2"]);
      await type("nothing like this");
      expect(texts(".watch-key-chip")).toEqual([]);
    });

    test("shows a node's whole population, then just the selected key's", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      await click(box("quiet"));

      // Three cells with no lens: both people, and both of Maya's instances.
      expect(host.querySelectorAll(".watch-dag-drawer .watch-cell")).toHaveLength(3);
      expect(drawerText()).toContain("person=Maya Reeves");
      expect(drawerText()).toContain("person=Jamie Lopez");
      // `spawn` bounds instances per key, so the ceiling is stated per key.
      expect(drawerText()).toContain("Spawns up to 2 parallel instances per key");
      expect(drawerText()).toContain("Cancelled by an arrival on `reply`");

      await click(chip("Maya Reeves"));
      expect(host.querySelectorAll(".watch-dag-drawer .watch-cell")).toHaveLength(2);
      expect(drawerText()).not.toContain("Jamie Lopez");
      expect(drawerText()).toContain("2 of 2 live instances under this key");
    });

    test("says plainly when a node is outside the selected key's slice", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      await click(chip("Maya Reeves"));
      await click(box("streak"));
      expect(drawerText()).toContain("this node is not part of that slice");
    });

    test("draws each cell as its own node type means it", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);

      // A wait is a countdown: a span with a marker for now on it.
      await click(box("quiet"));
      expect(host.querySelectorAll(".watch-dag-drawer .watch-countdown-now").length).toBe(3);

      // An accumulator is a count against a floor, with its window named.
      await click(box("streak"));
      expect(drawerText()).toContain("2 of 3 arms inside 7 days");
      expect(host.querySelector(".watch-dag-drawer .watch-countdown-track.is-meter")).not.toBeNull();
    });

    test("lists what the watch will do next, soonest first", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      await click(host.querySelector(".watch-state-summary button") as unknown as HTMLElement);

      const timers = [...host.querySelectorAll(".watch-timer")];
      expect(timers).toHaveLength(2);
      // The route sends them soonest first and the list keeps that order.
      expect(timers[0].textContent).toContain("Jamie Lopez");
      // Due is not fired: a timer is only swept by an evaluation pass.
      expect(timers[0].className).toContain("is-overdue");
      expect(timers[1].className).not.toContain("is-overdue");
    });

    test("names the class a parked nomination is waiting on, and the day's budget", async () => {
      getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
      await open(TWO_KEYED_DSL);
      await click(host.querySelector(".watch-state-summary button") as unknown as HTMLElement);

      expect(texts(".watch-dag-drawer .watch-parked-class")).toEqual(["budget"]);
      expect(drawerText()).toContain("journal event 400 ·");
      expect(drawerText()).toContain("2 of 50 calls today for this watch");
      expect(drawerText()).toContain("7 of 200 across the install");
    });

    test("a watch holding nothing says so rather than rendering blank", async () => {
      await open(TWO_KEYED_DSL);

      expect(host.querySelector(".watch-dag-count")).toBeNull();
      expect(host.querySelector(".watch-key-lens")).toBeNull();
      expect(host.querySelector(".watch-state-summary")!.textContent).toContain(
        "Nothing live: no cell, no armed timer, no parked nomination.",
      );
      // The definition is still fully drawn — nothing about it depends on the
      // runtime holding anything.
      expect(texts("[data-node-id]").length).toBe(5);
    });

    test("a state read that fails leaves the definition readable", async () => {
      getWatchV2WatchState.mockRejectedValue(new Error("the runtime is not answering"));
      await open(TWO_KEYED_DSL);

      expect(host.querySelector(".watch-state-bar .debug-error")).not.toBeNull();
      expect(texts("[data-node-id]").length).toBe(5);
    });
  });

  test("a watch id nothing answers to reads as an empty install, not a crash", async () => {
    getWatchV2Watch.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
    await act(async () => {
      render(h(WatchDebugTab, { watchId: "ghost" }), host);
    });
    await settle();
    expect(host.querySelector(".debug-error")!.textContent).toContain(
      "This install has no watch with that id.",
    );
  });

  test("with no watch chosen, it lists the ones there are", async () => {
    listWatchV2Watches.mockResolvedValue({
      watches: [
        {
          id: "watch-01",
          name: "northstar-invoice-unpaid",
          status: "active",
          request: "Tell me when an invoice goes unpaid.",
        },
        { id: "watch-02", name: "quiet-week", status: "paused", request: null },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();
    const rows = [...host.querySelectorAll(".watch-dag-picker a")];
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/portal/debug/watch/watch-01",
      "/portal/debug/watch/watch-02",
    ]);
    expect(rows[0].textContent).toContain("Tell me when an invoice goes unpaid.");
    expect(rows[1].textContent).toContain("Paused");

    await click(rows[0] as unknown as HTMLElement);
    expect(navigate).toHaveBeenCalledWith("/portal/debug/watch/watch-01");
  });

  test("the list says which watches are holding something, and which are resting", async () => {
    // The question a list answers that no page can: which of these is awake.
    // Without it every row reads the same whether the runtime is tracking
    // fourteen people for it or nothing at all.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 4400,
      watches: [
        {
          id: "watch-01",
          name: "holding",
          status: "active",
          request: "Tell me when an invoice goes unpaid.",
          live: {
            keys: 14,
            cells: 21,
            holdingKeys: 14,
            holdingCells: 21,
            timers: 14,
            nextDueAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
            cursorSeq: 4400,
          },
        },
        {
          id: "watch-02",
          name: "resting",
          status: "active",
          request: null,
          live: {
            keys: 0,
            cells: 0,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAt: null,
            cursorSeq: 4400,
          },
        },
        {
          id: "watch-03",
          name: "catching-up",
          status: "active",
          request: null,
          live: {
            keys: 0,
            cells: 0,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAt: null,
            cursorSeq: 2900,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = (n: number) =>
      [...host.querySelectorAll(".watch-dag-picker a")][n]!.textContent!.replace(/\s+/g, " ");
    // Keys rather than cells: a node holding several instances of one key is
    // still tracking one thing.
    // Spelled with their separating spaces: the template collapses a newline
    // between two interpolations, so a row can render "●14 keys" or
    // "○nothing live" while every looser assertion still passes.
    expect(row(0)).toContain("● 14 keys");
    expect(row(0)).toContain("next in 3 days");
    expect(row(1)).toContain("○ nothing live");
    // Holding nothing *yet* is not the same as having nothing to hold, and it
    // is invisible from every other field on the row.
    expect(row(2)).toContain("1500 behind");
    expect(row(1)).not.toContain("behind");

    const marks = [...host.querySelectorAll(".watch-liveness-mark")];
    expect(marks[0]!.className).toContain("is-holding");
    expect(marks[1]!.className).not.toContain("is-holding");
  });

  test("counts the keys still holding, not every cell the runtime kept", async () => {
    // Fourteen keys with a cell, two of them still waiting on something. The
    // mark's claim is that the watch is tracking things, and the population
    // includes a spent cooldown stamp and a drained window, which track
    // nothing. The gap is named in the title rather than left as a
    // contradiction against the state tab, which lists all fourteen.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 4400,
      watches: [
        {
          id: "watch-01",
          name: "mostly-husks",
          status: "active",
          request: null,
          live: {
            keys: 14,
            cells: 21,
            holdingKeys: 2,
            holdingCells: 2,
            timers: 0,
            nextDueAt: null,
            cursorSeq: 4400,
          },
        },
        {
          id: "watch-02",
          name: "all-husks",
          status: "active",
          request: null,
          live: {
            keys: 3,
            cells: 3,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAt: null,
            cursorSeq: 4400,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const rows = [...host.querySelectorAll(".watch-dag-picker a")];
    const text = (n) => rows[n].textContent.replace(/\s+/g, " ");
    const title = (n) => host.querySelectorAll(".watch-liveness")[n].getAttribute("title");
    expect(text(0)).toContain("● 2 keys");
    expect(text(0)).not.toContain("14 keys");
    // Cells, counted from the cell numbers: the state tab enumerates cells, and
    // this row holds 21 of them against 14 keys, so counting keys here would
    // name a number that tab never shows.
    expect(title(0)).toContain("19 more cells are kept as bookkeeping");
    // Every cell is bookkeeping: the mark goes hollow rather than claiming the
    // watch is tracking three things it is not waiting on.
    expect(text(1)).toContain("○ nothing live");
    expect(title(1)).toContain("3 more cells are kept as bookkeeping");
  });

  test("reads a gateway that sends no holding count as holding its whole population", async () => {
    // The count is the gateway's to make — each node type reads its own cells —
    // and one that predates the distinction sends only the population. Over-
    // reporting a husk is the fallback worth having: a hollow mark on a watch
    // that is genuinely tracking things is the failure that matters.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 4400,
      watches: [
        {
          id: "watch-01",
          name: "older-gateway",
          status: "active",
          request: null,
          live: { keys: 5, cells: 5, timers: 0, nextDueAt: null, cursorSeq: 4400 },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = host.querySelector(".watch-dag-picker a").textContent.replace(/\s+/g, " ");
    expect(row).toContain("● 5 keys");
    expect(host.querySelector(".watch-liveness").getAttribute("title")).toBe("");
  });

  test("a watch holding only a timer is awake, not resting", async () => {
    // A watch whose source is a clock holds no cell — the runtime writes a
    // timer row and nothing else. It is the one kind that acts with nothing
    // arriving at all, so reading it as empty puts the only self-starting watch
    // in the same bucket as the resting ones, on the same line that prints the
    // deadline it will fire on.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 4400,
      watches: [
        {
          id: "watch-01",
          name: "daily-digest",
          status: "active",
          request: null,
          live: {
            keys: 0,
            cells: 0,
            timers: 1,
            nextDueAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
            cursorSeq: 4400,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = host.querySelector(".watch-dag-picker a")!.textContent!.replace(/\s+/g, " ");
    expect(row).toContain("● armed");
    expect(row).not.toContain("nothing live");
    expect(host.querySelector(".watch-liveness-mark")!.className).toContain("is-holding");
  });

  test("a watch that stopped is not lagging, and has no next", async () => {
    // The runtime only evaluates active watches. A finished one is not behind:
    // its cursor stopped where it stopped, and the gap to the head grows
    // forever with traffic that has nothing to do with it. Nor will it ever
    // honour the deadline it was holding.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 21_000,
      watches: [
        {
          id: "watch-01",
          name: "invoice-once",
          status: "retired",
          request: null,
          live: {
            keys: 0,
            cells: 0,
            timers: 1,
            nextDueAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
            cursorSeq: 1547,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = host.querySelector(".watch-dag-picker a")!.textContent!.replace(/\s+/g, " ");
    expect(row).toContain("Finished");
    expect(row).not.toContain("behind");
    expect(row).not.toContain("next");
  });

  test("a watch that has never run claims no backlog", async () => {
    // A watch is added at the journal head and its cursor is seeded on the
    // first pass that evaluates it. Until then it has no cursor row — which is
    // "has not started", not "sitting at sequence zero". Read as zero it would
    // be accused of a backlog of the whole journal it was never going to read.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 19_453,
      watches: [
        {
          id: "watch-01",
          name: "just-added",
          status: "active",
          request: null,
          live: {
            keys: 0,
            cells: 0,
            holdingKeys: 0,
            holdingCells: 0,
            timers: 0,
            nextDueAt: null,
            cursorSeq: null,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    expect(
      host.querySelector(".watch-dag-picker a")!.textContent!.replace(/\s+/g, " "),
    ).not.toContain("behind");
  });

  test("a deadline already passed reads as due, not as a date in the past", async () => {
    // Timers are only swept by an evaluation pass, so a due one sits until the
    // next tick. "next 3 months ago" is not a sentence.
    listWatchV2Watches.mockResolvedValue({
      journalHead: 4400,
      watches: [
        {
          id: "watch-01",
          name: "overdue",
          status: "active",
          request: null,
          live: {
            keys: 1,
            cells: 1,
            timers: 1,
            nextDueAt: new Date(Date.now() - 90 * DAY_MS).toISOString(),
            cursorSeq: 4400,
          },
        },
      ],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = host.querySelector(".watch-dag-picker a")!.textContent!.replace(/\s+/g, " ");
    expect(row).toContain("due now");
    expect(row).not.toContain("ago");
  });

  test("a listing from a gateway that does not report state says nothing about it", async () => {
    // An older gateway omits `live` entirely. The row must read as a watch
    // holding nothing rather than crash or invent a number — and it must not
    // claim the watch is behind, which needs a cursor it was never sent.
    listWatchV2Watches.mockResolvedValue({
      watches: [{ id: "watch-01", name: "unknown-state", status: "active", request: null }],
    });
    await act(async () => {
      render(h(WatchDebugTab, {}), host);
    });
    await settle();

    const row = host.querySelector(".watch-dag-picker a")!.textContent!.replace(/\s+/g, " ");
    expect(row).toContain("nothing live");
    expect(row).not.toContain("behind");
    expect(row).not.toContain("next");
  });

  // ── The history lens ─────────────────────────────────────────────────────
  //
  // The definition tests above pin what a watch *is*. These pin what it did:
  // one journal event selected, and the path it took lit across the same
  // canvas. The fixture is deliberately multi-key — a tick that armed one cell
  // and broke on another — because a single-instance path would read the same
  // whichever way the collapse were written.

  const HISTORY = {
    trace: { records: 9, retained: 2000 },
    paths: [
      {
        seq: -2,
        at: "2026-05-04T11:45:00.000Z",
        timer: true,
        traceRetained: true,
        outcome: "fired",
        forced: false,
        keys: ["thread_id=t-880"],
        nodes: [
          {
            nodeId: "unpaid_a_week",
            key: "thread_id=t-880",
            verdict: "fired",
            detail: "the wait elapsed",
            failure: null,
            steps: [{ transition: "fired", detail: "the wait elapsed", failure: null }],
          },
        ],
        firings: [
          {
            nodeId: "unpaid_a_week",
            keyHash: "h1:0",
            firedAt: "2026-05-04T11:45:00.000Z",
            noticedAt: "2026-05-04T11:45:02.000Z",
            forced: false,
            payload: { thread_id: "t-880" },
            documents: [
              { id: "doc-invoice", title: "Invoice INV-4471", sourceId: "gmail:ap@example.com" },
            ],
            delivery: { kind: "omnesis-notify", delivered: 1, attempted: 1, at: "2026-05-04T11:45:03.000Z" },
          },
        ],
      },
      {
        seq: 88,
        at: "2026-05-04T09:15:30.000Z",
        timer: false,
        traceRetained: true,
        outcome: "considered",
        forced: false,
        keys: ["thread_id=t-880", "thread_id=t-991"],
        nodes: [
          {
            nodeId: "invoice_arrived",
            key: "thread_id=t-880",
            verdict: "held",
            detail: "The attachment is a receipt, not an invoice awaiting payment.",
            failure: null,
            steps: [
              { transition: "armed", detail: null, failure: null },
              {
                transition: "held",
                detail: "The attachment is a receipt, not an invoice awaiting payment.",
                failure: null,
              },
            ],
          },
          {
            nodeId: "invoice_arrived",
            key: "thread_id=t-991",
            verdict: "held",
            detail: "today's allowance is spent",
            failure: "budget",
            steps: [
              { transition: "held", detail: "today's allowance is spent", failure: "budget" },
            ],
          },
        ],
        firings: [],
      },
      {
        seq: 4,
        at: "2026-04-28T07:00:00.000Z",
        timer: false,
        traceRetained: false,
        outcome: "fired",
        forced: false,
        keys: [],
        nodes: [],
        firings: [
          {
            nodeId: "unpaid_a_week",
            keyHash: "old:0",
            firedAt: "2026-04-28T07:00:00.000Z",
            noticedAt: "2026-04-28T07:00:01.000Z",
            forced: false,
            payload: {},
            documents: [],
            delivery: null,
          },
        ],
      },
    ],
  };

  // A chip is a sibling of its box, placed on the box's own top-centre. Both
  // coordinates are needed to find it: boxes alone on their rank share a centre
  // x, so matching `left` only picks whichever of them is drawn first.
  const verdictOf = (nodeId: string) => {
    const chips = [...host.querySelectorAll(".watch-dag-verdict")] as unknown as HTMLElement[];
    const boxStyle = box(nodeId)!.getAttribute("style")!;
    const num = (field: string) => Number(new RegExp(`${field}:([\\d.]+)px`).exec(boxStyle)![1]);
    const want = `left:${num("left") + num("width") / 2}px;top:${num("top")}px;`;
    return chips.find((chip) => chip.getAttribute("style") === want) ?? null;
  };

  test("lists what the watch has done, considerations beside firings", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL);

    const rows = [...host.querySelectorAll(".watch-history-row")];
    // Newest first, and a deadline's negative sequence does not sort it last.
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/portal/debug/watch/watch-01/history/-2",
      "/portal/debug/watch/watch-01/history/88",
      "/portal/debug/watch/watch-01/history/4",
    ]);
    // "Why didn't it fire" is answered on the row, by the node that held.
    expect(texts(".watch-history-verdict")).toEqual([
      "Fired",
      "Parked at invoice_arrived",
      "Trace no longer retained",
    ]);
  });

  test("offers the judge's own words on the nodes an event touched", async () => {
    // The verdict beside a node says which way the judge went. This is the one
    // place that says what it was given to decide on — a proposition asking
    // about the wrong field declines correctly and reads as a quiet week.
    getWatchV2History.mockResolvedValue(HISTORY);
    getWatchV2JudgeExchanges.mockResolvedValue({
      exchanges: [
        {
          nodeId: "unpaid_a_week",
          key: "thread_id=t-880",
          subject: "doc-invoice",
          verdict: "declined",
          prompt: "Does this message confirm the invoice was paid?",
          reply: '{"decision":"not_matched"}',
          ms: 120,
          at: "2026-05-04T11:44:00.000Z",
        },
        {
          // A node this event never touched. Showing it here would attach an
          // answer to a path that did not ask the question.
          nodeId: "invoice_arrived",
          key: "singleton",
          subject: "doc-other",
          verdict: "matched",
          prompt: "Is this an invoice?",
          reply: '{"decision":"matched"}',
          ms: 90,
          at: "2026-05-04T09:00:00.000Z",
        },
      ],
    });

    await open(DELIVERING_DSL, {}, { seq: -2 });

    const summaries = texts(".watch-history-exchange summary");
    expect(summaries).toEqual(["view judge exchange"]);
    const shown = host.querySelector(".watch-history-exchange")!.textContent!;
    expect(shown).toContain("Does this message confirm the invoice was paid?");
    expect(shown).toContain('{"decision":"not_matched"}');
    // Scoped to the nodes this event touched.
    expect(shown).not.toContain("Is this an invoice?");
  });

  test("says nothing about the judge when no exchange was kept", async () => {
    // A gateway that predates them, or a watch nothing has judged. An empty
    // section reading "no exchanges" would be a row on every watch that has
    // never had a judge.
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });
    expect(host.querySelectorAll(".watch-history-exchange")).toHaveLength(0);
  });

  test("keeps the history when the exchanges cannot be read", async () => {
    // Two independent reads. Losing the history over a 404 on the newer one
    // would cost the reader the thing they came for.
    getWatchV2History.mockResolvedValue(HISTORY);
    getWatchV2JudgeExchanges.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));

    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(box("unpaid_a_week")!.className).toContain("is-on-path");
    expect(host.querySelectorAll(".watch-history-exchange")).toHaveLength(0);
  });

  test("lights the path a firing took, and dims what it never reached", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(box("unpaid_a_week")!.className).toContain("is-on-path");
    expect(verdictOf("unpaid_a_week")!.textContent!.trim()).toBe("Fired");
    // The event never reached the other trip-wire, and a canvas that left it
    // looking the same would say the signal went everywhere.
    expect(box("payment_sent")!.className).toContain("is-off-path");
    expect(verdictOf("payment_sent")).toBeNull();
  });

  test("keeps two keys apart on one node and shows the one worth acting on", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: 88 });

    // Held in the judge's own words under one thread, parked on budget under
    // the other. One box, one chip — and the chip says how many cells it is.
    const chip = verdictOf("invoice_arrived")!;
    expect(chip.textContent!.trim()).toBe("Parked ·2");
    expect(chip.getAttribute("title")).toContain(
      "thread_id=t-880: Held — The attachment is a receipt",
    );
    expect(chip.getAttribute("title")).toContain("thread_id=t-991: Parked");
  });

  test("opens the pane on the event, with the sentence, the evidence and the delivery", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    const drawer = drawerText();
    expect(drawer).toContain("Deadline");
    expect(drawer).toContain("A deadline this watch armed for itself elapsed.");
    expect(drawer).toContain("the wait elapsed");
    expect(drawer).toContain("Notified your devices");
    // The evidence renders as the ledger renders it, so the two surfaces agree.
    expect(host.querySelectorAll(".watch-firing-evidence a").length).toBe(1);
  });

  test("a firing an operator forced is neither a deadline nor an arrival", async () => {
    // `fireByHand` draws from the same counter a deadline does, so this event
    // has a negative sequence and no arrival behind it. Told only "is it a
    // deadline", the pane would say something arrived on the journal — an
    // account of an event that never happened, beside a line saying an operator
    // fired it. The two sentences are in the same pane.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      paths: [
        {
          ...HISTORY.paths[0],
          timer: false,
          forced: true,
          nodes: [{ ...HISTORY.paths[0].nodes[0], verdict: "forced", steps: [{ transition: "forced" }] }],
          firings: [{ ...HISTORY.paths[0].firings[0], forced: true, documents: [] }],
        },
      ],
    });
    await open(DELIVERING_DSL, {}, { seq: -2 });

    const drawer = drawerText();
    expect(drawer).toContain("An operator fired this watch by hand.");
    expect(drawer).not.toContain("Something arrived on the journal.");
    expect(drawer).not.toContain("A deadline this watch armed for itself elapsed.");
    // And the row agrees with the pane about what it was.
    expect(texts(".watch-history-row .watch-history-verdict")).toEqual(["Fired by hand"]);
  });

  /**
   * A path where one node acted and three siblings shrugged.
   *
   * The shape a multi-arm watch produces on every event: each arm looks, one
   * takes it up, and the rest write "no lexical term matched". Listed flat,
   * the arms that did nothing outnumber the one that did and bury it.
   */
  const CROWDED = {
    trace: { records: 9, retained: 2000 },
    paths: [
      {
        seq: 120,
        at: "2026-05-04T09:15:30.000Z",
        timer: false,
        traceRetained: true,
        outcome: "fired",
        forced: false,
        keys: ["thread_id=t-880"],
        nodes: [
          {
            nodeId: "invoice_arrived",
            key: "thread_id=t-880",
            verdict: "fired",
            detail: "an invoice arrived",
            failure: null,
            steps: [{ transition: "fired", detail: "an invoice arrived", failure: null }],
          },
          ...["by_whatsapp", "by_calendar", "by_receipt"].map((nodeId) => ({
            nodeId,
            key: "singleton",
            verdict: "ignored",
            detail: "no lexical term matched",
            failure: null,
            steps: [{ transition: "ignored", detail: "no lexical term matched", failure: null }],
          })),
        ],
        firings: [],
      },
      {
        seq: 121,
        at: "2026-05-04T09:20:30.000Z",
        timer: false,
        traceRetained: true,
        outcome: "considered",
        forced: false,
        keys: [],
        nodes: ["by_whatsapp", "by_calendar"].map((nodeId) => ({
          nodeId,
          key: "singleton",
          verdict: "ignored",
          detail: "no lexical term matched",
          failure: null,
          steps: [{ transition: "ignored", detail: "no lexical term matched", failure: null }],
        })),
        firings: [],
      },
    ],
  };

  test("leads with the nodes that did something, folding the arms that shrugged", async () => {
    getWatchV2History.mockResolvedValue(CROWDED);
    await open(DELIVERING_DSL, {}, { seq: 120 });

    const path = host.querySelector(".watch-history-path")!;
    // The node that acted is what the section opens with, alone.
    expect([...path.querySelectorAll("code")].map((c) => c.textContent)).toContain(
      "invoice_arrived",
    );
    expect(path.textContent).not.toContain("by_whatsapp");
    // The rest are one line, and still there to open.
    const fold = host.querySelector(".watch-history-declined");
    expect(fold).not.toBeNull();
    expect(fold!.querySelector("summary")!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "3 other arms looked and declined",
    );
    expect(fold!.textContent).toContain("by_whatsapp");
    expect(fold!.textContent).toContain("no lexical term matched");
  });

  test("keeps the declines in the open when nothing acted, because they are the answer", async () => {
    // The whole reason the fold is conditional. On an event where nothing took
    // anything up, "two arms looked and declined" IS why nothing happened, and
    // hiding it would leave the section saying nothing at all.
    getWatchV2History.mockResolvedValue(CROWDED);
    await open(DELIVERING_DSL, {}, { seq: 121 });

    expect(host.querySelector(".watch-history-declined")).toBeNull();
    const path = host.querySelector(".watch-history-path")!;
    expect(path.textContent).toContain("by_whatsapp");
    expect(path.textContent).toContain("by_calendar");
  });

  test("renders a document the firing carried as the document it is", async () => {
    // The lineage says which payload fields carry a document; everything else
    // prints as itself. Guessing from the field's name is what this replaces —
    // `thread_id` is named like an id and is not a document.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      lineage: { $sink: ["doc"] },
      documents: {
        "doc-invoice": { id: "doc-invoice", title: "Invoice INV-4471", sourceId: "gmail" },
      },
      paths: [
        {
          ...HISTORY.paths[0],
          firings: [
            {
              ...HISTORY.paths[0]!.firings[0]!,
              payload: { doc: "doc-invoice", thread_id: "t-880" },
            },
          ],
        },
      ],
    });
    await open(DELIVERING_DSL, {}, { seq: -2 });

    const drawer = drawerText();
    expect(drawer).toContain("Invoice INV-4471");
    // Unmarked values are printed, not chipped: the page never claims a
    // document it was not told about.
    expect(drawer).toContain("t-880");
    expect(host.querySelectorAll(".doc-chip").length).toBeGreaterThan(0);
  });

  test("does not chip the same document twice, once labelled and once not", async () => {
    // A sink's evidence field is usually derived from the same provenance chain
    // the documents come from, so rendering both put the identical chip on
    // screen twice — once under the field that carries it and once unlabelled
    // beneath it, which reads as a rendering fault rather than as two facts.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      lineage: { $sink: ["doc"] },
      documents: {
        "doc-invoice": { id: "doc-invoice", title: "Invoice INV-4471", sourceId: "gmail" },
      },
      paths: [
        {
          ...HISTORY.paths[0],
          firings: [
            {
              ...HISTORY.paths[0]!.firings[0]!,
              payload: { doc: "doc-invoice" },
              documents: [
                { id: "doc-invoice", title: "Invoice INV-4471", sourceId: "gmail" },
              ],
            },
          ],
        },
      ],
    });
    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(host.querySelectorAll(".doc-chip").length).toBe(1);
    // And the "nothing behind this one" line must not appear: there *is*
    // something behind it, and the labelled row is where it is said.
    expect(drawerText()).not.toContain("Nothing in the corpus is behind this one");
  });

  test("still shows a document the payload never names", async () => {
    // A join's second arm, or a document the author's output_map does not
    // mention. The labelled rows leave it out, so the evidence block is the
    // only place it can be said.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      lineage: { $sink: ["doc"] },
      documents: {},
      paths: [
        {
          ...HISTORY.paths[0],
          firings: [
            {
              ...HISTORY.paths[0]!.firings[0]!,
              payload: { doc: "doc-invoice" },
              documents: [{ id: "doc-chat", title: "A chat thread", sourceId: "whatsapp" }],
            },
          ],
        },
      ],
    });
    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(drawerText()).toContain("A chat thread");
  });

  test("says how many it declined in all, not how many samples it kept", async () => {
    // The runtime keeps a bounded sample of declines, so the retained rows are
    // a sample and the count is the history. Reporting the sample would say a
    // watch declined a handful when it declined thousands — and thousands with
    // no firing is the diagnostic the line exists for.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      events: { total: 8, untouched: 5, showing: "engaged" },
      classes: { ignored: 4183, fired: 2 },
    });
    await open(DELIVERING_DSL);

    const note = host.querySelector(".watch-history-untouched")!.textContent!.replace(/\s+/g, " ");
    expect(note).toContain("4,183");
    expect(note).toContain("keeps a sample");
  });

  test("says nothing about a sample when the store still holds them all", async () => {
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      events: { total: 8, untouched: 5, showing: "engaged" },
      classes: { ignored: 5 },
    });
    await open(DELIVERING_DSL);

    const note = host.querySelector(".watch-history-untouched")!.textContent!.replace(/\s+/g, " ");
    expect(note).not.toContain("keeps a sample");
  });

  test("says a firing's trace is gone rather than drawing an empty path", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: 4 });

    expect(drawerText()).toContain("Trace no longer retained for this firing.");
    // Nothing is lit, because nothing is known — not because nothing happened.
    expect(host.querySelectorAll(".watch-dag-verdict").length).toBe(0);
    expect(box("unpaid_a_week")!.className).toContain("is-off-path");
  });

  test("clicking a node takes the pane back to the definition, canvas still lit", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    await click(box("unpaid_a_week"));
    expect(drawerText()).toContain("The wait is the deadline");
    // The lit path belongs to the URL, so opening a node does not clear it.
    expect(verdictOf("unpaid_a_week")).not.toBeNull();
  });

  test("lights the sink with what delivering the firing did", async () => {
    // `$sink` is the portal's own box — the runtime never records a transition
    // against it — so without this the box that stands for delivery greys out
    // as unreached on exactly the events that reached it.
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(box("$sink")!.className).toContain("is-on-path");
    expect(verdictOf("$sink")!.textContent!.trim()).toBe("Delivered");
  });

  test("re-picking the selected event brings its pane back from a node", async () => {
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    await click(box("unpaid_a_week"));
    expect(drawerText()).toContain("The wait is the deadline");

    // The path in the address bar does not change, so nothing re-derives from
    // the route — picking the row has to say so itself, or the event's pane is
    // unreachable without picking a different one first.
    const selected = host.querySelector(".watch-history-row.is-selected");
    await click(selected as unknown as HTMLElement);
    expect(drawerText()).toContain("A deadline this watch armed for itself elapsed.");
  });

  test("the canvas makes room for an event's pane, not only for a node's", async () => {
    // The graph is laid out top-to-bottom precisely so a right-hand pane never
    // covers it. An event's pane is the one most worth not covering — the path
    // it lights is on the canvas underneath.
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: -2 });

    expect(host.querySelector(".watch-dag-drawer")).not.toBeNull();
    expect(host.querySelector(".watch-dag-scroll")!.className).toContain("has-pane");
  });

  test("the keys a trace wrote wear the names the state read resolved", async () => {
    // The key selector above the canvas calls this key a person by name. The
    // rows below it must not call the same key a UUID: one page, one name for
    // one key, or a reader cannot tell that the chip and the row are the same.
    //
    // The trace stores a key as the runtime rendered it — ids, no components to
    // resolve — so the names come from the state read, which resolved them.
    getWatchV2History.mockResolvedValue({
      ...HISTORY,
      paths: [{ ...HISTORY.paths[0], keys: [`person=${MAYA}`, "thread_id=t-991"] }],
    });
    getWatchV2WatchState.mockResolvedValue(holdingTwoPopulations());
    await open(DELIVERING_DSL);

    const keys = texts(".watch-history-row .watch-dag-key");
    expect(keys).toContain("person=Maya Reeves");
    expect(keys.some((key) => key.includes(MAYA))).toBe(false);
    // A component the directory has no row for is left as the runtime wrote it,
    // rather than being given an invented name.
    expect(keys).toContain("thread_id=t-991");
  });

  test("a page emptied by folding does not claim the runtime looked at nothing", async () => {
    // Folding creates a second reason for an empty page, and the old copy
    // asserts the first one. A watch whose recall arm declined everything has
    // been looked at a great many times — telling its operator the runtime
    // evaluated no event for it sends them looking for a broken runtime.
    getWatchV2History.mockResolvedValue({
      trace: { records: 34 },
      events: { total: 17, untouched: 17, showing: "engaged" },
      paths: [],
    });
    await open(DELIVERING_DSL);

    const shown = host.querySelector(".watch-history")!.textContent!.replace(/\s+/g, " ");
    expect(shown).not.toContain("evaluated no event");
    expect(shown).toContain("17 of 17");
    // And the way to see them has to be here, not only on a page that has rows.
    expect(host.querySelector(".watch-history-untouched button")).not.toBeNull();
  });

  test("an event the page cannot find lights nothing and says so", async () => {
    // The ledger links every firing here, but the page holds only the newest
    // events. Landing on one it does not hold must not look like a watch that
    // did nothing.
    getWatchV2History.mockResolvedValue(HISTORY);
    await open(DELIVERING_DSL, {}, { seq: 9999 });

    expect(host.querySelector(".watch-dag-drawer")).toBeNull();
    expect(host.querySelectorAll(".watch-dag-verdict").length).toBe(0);
    expect(box("payment_sent")!.className).not.toContain("is-off-path");
    expect(texts(".privacy-banner").join(" ")).toContain("Event 9999 is not on this page");
  });
});
