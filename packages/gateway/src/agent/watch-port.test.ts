// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The operator's own watches, as their agent sees them.
 *
 * Three properties carry this file. **What the agent may see** is a privacy
 * boundary, not a filter: a watch an off-host integration asked for says what
 * an external workflow wanted to be told about, and the operator's own agent
 * has no business reading it. **What the agent may rewrite** is narrower still,
 * because a rewrite here attaches a notification, and doing that to a watch
 * written to record quietly would change what it does without anybody asking.
 * And **a rewrite must forget** what the previous watch had already said —
 * inherited firing state is how a rewritten `once_ever` watch never fires
 * again, silently, on a condition that then holds.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { WatchPortError, type WatchPort } from "@omnesis/agent";

import { InFlightRequests } from "../watch/in-flight-requests.js";
import { createGatewayWatchPort, type WatchFiringRecord } from "./watch-port.js";

import type { AuthorWatchDeps } from "../watch/authoring.js";
import type { StoredWatch } from "../watch/definitions.js";
import type { Ontology } from "@omnesis/watch";

const PROPOSITION = "the message says a parcel has shipped";

function dsl(overrides: { name?: string; delivery?: unknown } = {}): unknown {
  return {
    watch: {
      name: overrides.name ?? "a-parcel-shipped",
      nl_query: "tell me when a parcel ships",
      firing_policy: "stays_active",
      ontology_fingerprint: "an-install-fingerprint",
      nodes: [
        {
          id: "shipped",
          type: "source.document_event",
          filter: { source: "mailbox:someone@example.com", event: ["created"] },
          output_map: { doc_id: "$e.docId" },
          recall: { lexical: { terms: ["shipped"], match: "token" } },
          judge: { proposition: PROPOSITION, output_schema: {} },
        },
      ],
      sink: { input: "shipped", output_map: { evidence: "$n.shipped.doc_id" } },
      ...(overrides.delivery === undefined ? {} : { delivery: overrides.delivery }),
    },
  };
}

const ontology = { fingerprint: "an-install-fingerprint" } as unknown as Ontology;

interface Harness {
  port: WatchPort;
  /** Every watch currently installed, keyed by id. */
  watches: Map<string, StoredWatch>;
  /** `put` / `forget` in the order they happened. */
  order: string[];
}

function harness(
  opts: {
    compile?: AuthorWatchDeps["compile"];
    seed?: readonly StoredWatch[];
    firings?: Record<string, readonly WatchFiringRecord[]>;
    apns?: boolean;
    /** An install assembled without a watch runtime. */
    noRuntime?: boolean;
  } = {},
): Harness {
  const watches = new Map<string, StoredWatch>();
  for (const watch of opts.seed ?? []) watches.set(watch.id, watch);
  const order: string[] = [];
  /** Candidates the port asked the engine to try. */
  const probed: string[] = [];

  const authoring: AuthorWatchDeps = {
    definitions: {
      put: (watch: StoredWatch) => {
        order.push("put");
        watches.set(watch.id, watch);
      },
      get: (id: string) => watches.get(id) ?? null,
      list: () => [...watches.values()],
      remove: (id: string) => watches.delete(id),
    } as unknown as AuthorWatchDeps["definitions"],
    forget: (id: string) => order.push(`forget:${id}`),
    journal: { head: () => 4_242 } as unknown as AuthorWatchDeps["journal"],
    ontology: () => Promise.resolve(ontology),
    compile: opts.compile ?? (() => Promise.resolve({ status: "compiled", document: dsl() })),
    writes: { run: (fn: () => Promise<void>) => fn() } as AuthorWatchDeps["writes"],
    inFlight: new InFlightRequests(),
    setWakeAnchor: () => Promise.resolve(null),
  };

  return {
    watches,
    order,
    probed,
    port: createGatewayWatchPort({
      getAuthoring: () => (opts.noRuntime ? null : authoring),
      // Honours the bound, like the real one: a stub that ignored it would let
      // a caller read a count off a page that can only hold one row and still
      // pass.
      firings: (watchId, limit) => {
        const all = opts.firings?.[watchId] ?? [];
        return limit === undefined ? all : all.slice(-limit);
      },
      firingCount: (watchId) => (opts.firings?.[watchId] ?? []).length,
      ...(opts.noPreflight
        ? {}
        : {
            preflight: (watch: { name: string }) => {
              probed.push(watch.name);
              return Promise.resolve({
                outcome: "probed" as const,
                report: {
                  window: { events: 12, offered: 12, fromSeq: 1, toSeq: 12, from: null, to: null },
                  nodes: [
                    {
                      nodeId: "mail",
                      type: "source.document_event" as const,
                      evaluated: 12,
                      matched: 0,
                      declined: 12,
                      wouldAsk: 0,
                      samples: [
                        {
                          seq: 3,
                          transition: "ignored" as const,
                          detail: "no lexical term matched",
                        },
                      ],
                      diagnostics: ["its lexical arm matches the event title only"],
                    },
                  ],
                  firings: 0,
                  judgeGated: false,
                },
              });
            },
          }),
      isApnsConfigured: () => opts.apns ?? true,
    }),
  };
}

/** A watch already installed, in the shape the definition store holds one. */
function installed(id: string, delivery: unknown, name = "a-parcel-shipped"): StoredWatch {
  return {
    id,
    name,
    status: "active",
    dsl: dsl({ name, ...(delivery === undefined ? {} : { delivery }) }),
    addedAt: "2026-03-01T09:00:00.000Z",
    fromSeq: 100,
    note: null,
  };
}

/** The operator's own surface — the portal, the phone, a conversation. */
const OPERATOR = { kind: "operator" } as const;
/** The integration the WAKE fixture below names as its recipient. */
const OPENCLAW = { kind: "integration", slug: "openclaw" } as const;
/** A second integration, so "only its own" is tested rather than asserted. */
const HERMES = { kind: "integration", slug: "hermes" } as const;

const PUSH = { kind: "omnesis-notify" as const };
const WAKE = { kind: "agent-wake" as const, integration: "openclaw", instruction: "post it" };

async function rejection(call: Promise<unknown>): Promise<WatchPortError["rejection"]> {
  try {
    await call;
  } catch (err) {
    if (err instanceof WatchPortError) return err.rejection;
    throw err;
  }
  throw new Error("expected the call to be rejected");
}

describe("asking for a watch in conversation", () => {
  it("installs one that notifies the user, and reads back what it will decide", async () => {
    // The interpretation is the whole iteration loop: the user corrects a
    // misreading in the same conversation, and the proposition is the one part
    // of a compiled plan written to be read.
    const h = harness();

    const result = await h.port.create(OPERATOR, { request: "tell me when a parcel ships" });

    expect(result.action).toBe("created");
    expect(result.enabled).toBe(true);
    expect(result.interpretation).toBe(PROPOSITION);
    const stored = h.watches.get(result.watchId);
    expect((stored?.dsl as { watch: { delivery?: { kind: string } } }).watch.delivery?.kind).toBe(
      "omnesis-notify",
    );
  });

  it("names the watch what the compiler named it", async () => {
    // One name across the conversation, the phone, the portal and the CLI. A
    // prettier second label held only here would be the one the user learns
    // and the only one nothing else knows.
    const h = harness();

    const result = await h.port.create(OPERATOR, { request: "tell me when a parcel ships" });

    expect(result.name).toBe("a-parcel-shipped");
    expect(h.watches.get(result.watchId)?.name).toBe("a-parcel-shipped");
  });

  it("says so when this gateway cannot deliver a notification", async () => {
    // The watch is still worth creating — it will match, and the operator can
    // configure push later. Silently creating one that can never reach anybody
    // is the version of this that reads as working.
    const h = harness({ apns: false });

    const result = await h.port.create(OPERATOR, { request: "tell me when a parcel ships" });

    expect(h.watches.size).toBe(1);
    expect(result.warnings.join(" ")).toContain("no push delivery configured");
  });

  it("keeps a refusal and a deadline apart", async () => {
    // They mean opposite things to the agent holding the answer. A refusal is
    // settled, so the only way forward is a different request; a deadline is
    // the install failing to ask, and the same words may well work next time.
    const refused = harness({
      compile: () =>
        Promise.resolve({
          status: "refused",
          reasons: ["no source carries that"],
          codes: ["unsupported_condition"],
        }),
    });
    const late = harness({ compile: () => Promise.resolve({ status: "timed-out" }) });

    expect(await rejection(refused.port.create(OPERATOR, { request: "x" }))).toMatchObject({
      reason: "uncompilable",
      code: "unsupported_condition",
    });
    expect(await rejection(late.port.create(OPERATOR, { request: "x" }))).toMatchObject({
      reason: "timed_out",
    });

    // And a compile that produced nothing legal is a third thing again. The
    // tool's description tells the model that `unsupported_condition` means
    // stop rephrasing; reporting it here for a compile that merely fumbled
    // would retire a request that another attempt would have compiled.
    const fumbled = harness({
      compile: () =>
        Promise.resolve({
          status: "refused",
          reasons: ["the compiler could not produce a valid watch (invalid)"],
          codes: ["compiler_failed"],
        }),
    });
    expect(await rejection(fumbled.port.create(OPERATOR, { request: "x" }))).toMatchObject({
      reason: "uncompilable",
      code: "compiler_failed",
    });
    expect(refused.watches.size).toBe(0);
    expect(late.watches.size).toBe(0);
  });

  it("reports an install with no watch runtime rather than failing mid-turn", async () => {
    const h = harness({ noRuntime: true });

    expect(await rejection(h.port.create(OPERATOR, { request: "x" }))).toMatchObject({
      reason: "compiler_unavailable",
    });
  });
});

describe("rewriting a watch", () => {
  it("keeps the id, so one the agent already mentioned still resolves", async () => {
    const h = harness({ seed: [installed("w_1", PUSH)] });

    const result = await h.port.update(OPERATOR, {
      watchId: "w_1",
      request: "tell me when a parcel ships",
    });

    expect(result.watchId).toBe("w_1");
    expect(result.action).toBe("updated");
    expect(h.watches.size).toBe(1);
  });

  it("forgets what the old watch said before storing the new one", async () => {
    // Inherited state is how a rewritten `once_ever` watch never fires again:
    // the runtime still remembers the firing that ended the previous one, and
    // the replacement is finished before it starts. Silence, on a condition
    // that then holds — the one outcome this layer exists to prevent. The
    // order matters too: a crash between the two costs at most one repeated
    // notification from the definition still in place.
    const h = harness({ seed: [installed("w_1", PUSH)] });

    await h.port.update(OPERATOR, { watchId: "w_1", request: "tell me when a parcel ships" });

    expect(h.order).toEqual(["forget:w_1", "put"]);
  });

  it("starts the rewritten watch at the journal head", async () => {
    // A rewrite is a new question, and it asks about what happens next. Kept
    // from the original would have it wake on everything since.
    const h = harness({ seed: [{ ...installed("w_1", PUSH), fromSeq: 7 }] });

    await h.port.update(OPERATOR, { watchId: "w_1", request: "tell me when a parcel ships" });

    expect(h.watches.get("w_1")?.fromSeq).toBe(4_242);
  });

  it("refuses a watch that records without notifying", async () => {
    // Visible, because it is the operator's own. Not rewritable, because a
    // rewrite from here attaches a push — turning a watch written to sit
    // quietly in the ledger into one that interrupts.
    const h = harness({ seed: [installed("w_shadow", undefined)] });

    expect(
      await rejection(h.port.update(OPERATOR, { watchId: "w_shadow", request: "x" })),
    ).toMatchObject({
      reason: "not_manageable",
      watchId: "w_shadow",
    });
  });

  it("tells the operator why an integration's watch cannot be rewritten, rather than hiding it", async () => {
    // The operator may read it — it is running on their gateway — but a rewrite
    // would aim another integration's delivery somewhere its owner never agreed
    // to. Answering `not_found` instead would make their own agent report that
    // a watch they commissioned does not exist.
    const h = harness({ seed: [installed("w_wake", WAKE)] });

    const refusal = await rejection(h.port.update(OPERATOR, { watchId: "w_wake", request: "x" }));
    expect(refusal).toMatchObject({ reason: "not_manageable" });
    // And it says which of the two read-only reasons this is. Telling the
    // operator a wake watch "notifies nobody" is a plain falsehood about the
    // loudest thing it does.
    expect(refusal.message).toContain("wakes openclaw");
    expect(refusal.message).not.toContain("without notifying anyone");
    expect(await h.port.get(OPERATOR, "w_wake")).toMatchObject({ watchId: "w_wake" });
  });

  it("reads an integration's watch as absent to a different integration", async () => {
    // Two surfaces, one story. Saying `not_manageable` here would confirm it
    // exists and name what another workflow asked to be told about.
    const h = harness({ seed: [installed("w_wake", WAKE)] });

    expect(
      await rejection(h.port.update(HERMES, { watchId: "w_wake", request: "x" })),
    ).toMatchObject({ reason: "not_found" });
    expect(await h.port.get(HERMES, "w_wake")).toBe(null);
  });

  it("maps an unknown id to not_found without calling the compiler", async () => {
    // A stale id costs nothing. Compiling first would spend a minute of model
    // time before finding out there is nothing to write it to.
    let compiled = 0;
    const h = harness({
      compile: () => {
        compiled += 1;
        return Promise.resolve({ status: "compiled", document: dsl() });
      },
    });

    expect(
      await rejection(h.port.update(OPERATOR, { watchId: "w_gone", request: "x" })),
    ).toMatchObject({
      reason: "not_found",
      watchId: "w_gone",
    });
    expect(compiled).toBe(0);
  });
});

describe("reading the watches back", () => {
  it("lists the operator's own and hides an integration's", async () => {
    const h = harness({
      seed: [
        installed("w_push", PUSH, "a-parcel-shipped"),
        installed("w_shadow", undefined, "a-quiet-one"),
        installed("w_wake", WAKE, "an-integrations-one"),
      ],
      firings: { w_push: [{ firedAt: "2026-03-04T10:00:00.000Z", payload: { evidence: "d1" } }] },
    });

    const listed = await h.port.list(OPERATOR);

    // Every watch on the operator's own install, so their agent can answer
    // "is it working?" about any of them — and manageable only where a rewrite
    // cannot misdirect a delivery someone else is owed.
    expect(listed.map((w) => w.watchId).sort()).toEqual(["w_push", "w_shadow", "w_wake"]);
    expect(listed.find((w) => w.watchId === "w_push")).toMatchObject({
      manageable: true,
      firedCount: 1,
      lastFiredAt: "2026-03-04T10:00:00.000Z",
      request: "tell me when a parcel ships",
    });
    expect(listed.find((w) => w.watchId === "w_shadow")?.manageable).toBe(false);
    expect(listed.find((w) => w.watchId === "w_wake")?.manageable).toBe(false);

    // An integration sees the one it is woken by and cannot learn the rest
    // exist — an enumerable inventory is itself a disclosure.
    const asOpenclaw = await h.port.list(OPENCLAW);
    expect(asOpenclaw.map((w) => w.watchId)).toEqual(["w_wake"]);
    // Read-only even to its owner: a rewrite here would re-author it as the
    // operator's, pointed at the operator's devices.
    expect(asOpenclaw[0]?.manageable).toBe(false);

    // And a second integration sees nothing at all, including the first's.
    expect(await h.port.list(HERMES)).toEqual([]);
  });

  it("still manages a watch stored under the old spelling of the notify kind", async () => {
    // This rule decides what the agent can see at all. A watch whose stored
    // document spells the notify kind the old way is still a watch the
    // operator asked for — and a rule that did not recognise it would drop it
    // from every manage and rewrite tool with no error and no log line, on the
    // one surface most of these watches were created through.
    const h = harness({
      seed: [installed("w_legacy", { kind: "ios-push" }, "a-parcel-shipped")],
    });

    const listed = await h.port.list(OPERATOR);

    expect(listed.map((w) => w.watchId)).toEqual(["w_legacy"]);
    expect(listed[0]?.manageable).toBe(true);
  });

  it("counts every firing, not the page it read the last one from", async () => {
    // The number the model relays when the operator asks whether a watch is
    // working. Read off a bounded page it would be 1 for a watch that has
    // fired fifty times and 1 for a watch that has fired once.
    const h = harness({
      seed: [installed("w_busy", PUSH, "a-parcel-shipped")],
      firings: {
        w_busy: [
          { firedAt: "2026-03-01T10:00:00.000Z", payload: {} },
          { firedAt: "2026-03-02T10:00:00.000Z", payload: {} },
          { firedAt: "2026-03-03T10:00:00.000Z", payload: {} },
        ],
      },
    });

    const listed = await h.port.list(OPERATOR);

    expect(listed[0]?.firedCount).toBe(3);
    expect(listed[0]?.lastFiredAt).toBe("2026-03-03T10:00:00.000Z");
  });

  it("reports the most recent firings, not the first ones it ever made", async () => {
    // The store hands firings over oldest-first. A watch that has been running
    // for months would otherwise tell the agent what it said when it was new
    // and nothing since — and answer "when did it last fire?" with the day it
    // first did. A single-firing fixture cannot tell the two apart, which is
    // why this one has three.
    const h = harness({
      seed: [installed("w_push", PUSH, "a-parcel-shipped")],
      firings: {
        w_push: [
          { firedAt: "2026-03-01T09:00:00.000Z", payload: { evidence: "oldest" } },
          { firedAt: "2026-03-02T09:00:00.000Z", payload: { evidence: "middle" } },
          { firedAt: "2026-03-03T09:00:00.000Z", payload: { evidence: "newest" } },
        ],
      },
    });

    const listed = await h.port.list(OPERATOR);
    expect(
      listed.find((w) => w.watchId === "w_push")?.lastFiredAt,
      "lastFiredAt named the first firing",
    ).toBe("2026-03-03T09:00:00.000Z");

    const detail = await h.port.get(OPERATOR, "w_push");
    expect(detail?.firings.map((f) => (f.payload as { evidence: string }).evidence)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("carries the condition and the firings, which is what answers 'is it working?'", async () => {
    // A watch that has never fired is either waiting or mis-stated, and only
    // the condition the gateway is actually deciding on tells the two apart.
    const h = harness({
      seed: [installed("w_push", PUSH)],
      firings: { w_push: [{ firedAt: "2026-03-04T10:00:00.000Z", payload: { evidence: "d1" } }] },
    });

    const detail = await h.port.get(OPERATOR, "w_push");

    expect(detail?.interpretation).toBe(PROPOSITION);
    expect(detail?.firings).toEqual([
      { firedAt: "2026-03-04T10:00:00.000Z", payload: { evidence: "d1" } },
    ]);
    expect(detail?.createdAt).toBe("2026-03-01T09:00:00.000Z");
  });

  it("hides a definition this build cannot read rather than offering a rewrite", async () => {
    // Describing it from the row's name alone would offer an update that then
    // fails on a parse. The admin surface still shows it.
    const h = harness({
      seed: [{ ...installed("w_odd", PUSH), dsl: { watch: { name: "from-a-later-build" } } }],
    });

    expect(await h.port.list(OPERATOR)).toEqual([]);
    expect(await h.port.get(OPERATOR, "w_odd")).toBe(null);
  });
});

describe("removing a watch", () => {
  it("takes it out of the store and forgets what it said", async () => {
    const h = harness({ seed: [installed("w_push", PUSH)] });

    await h.port.remove(OPERATOR, "w_push");

    expect(h.watches.size).toBe(0);
    expect(h.order).toContain("forget:w_push");
  });

  it("refuses exactly what a rewrite refuses", async () => {
    const h = harness({
      seed: [installed("w_shadow", undefined), installed("w_wake", WAKE, "an-integrations-one")],
    });

    expect(await rejection(h.port.remove(OPERATOR, "w_shadow"))).toMatchObject({
      reason: "not_manageable",
    });
    expect(await rejection(h.port.remove(OPERATOR, "w_wake"))).toMatchObject({
      reason: "not_manageable",
    });
    // To an integration that owns neither, both are simply absent.
    expect(await rejection(h.port.remove(HERMES, "w_wake"))).toMatchObject({ reason: "not_found" });
    expect(h.watches.size).toBe(2);
  });
});

/**
 * The verb that lets this surface check its own work.
 *
 * A watch that catches nothing and one that is right about a quiet week make
 * the same silence, so "your watch is set up" was previously a claim with
 * nothing behind it.
 */
describe("trying a watch it just installed", () => {
  it("reports what the candidate would have decided, per node", async () => {
    const h = harness({ seed: [installed("w_push", PUSH, "a-parcel-shipped")] });

    const probe = await h.port.probe(OPERATOR, "w_push");

    expect(h.probed, "the port did not run the candidate").toEqual(["a-parcel-shipped"]);
    expect(probe.events).toBe(12);
    expect(probe.nodes[0]).toMatchObject({ nodeId: "mail", evaluated: 12, matched: 0 });
    // The reason, in the runtime's own words. This is what makes a zero
    // actionable rather than merely discouraging.
    expect(probe.nodes[0]?.samples[0]?.detail).toContain("lexical");
  });

  it("will not report on a watch this surface cannot manage", async () => {
    // A probe stores nothing, spends nothing and asks no model, so refusing the
    // operator one protects nobody — it only denies them an answer about their
    // own gateway. An integration that owns no such watch still learns nothing.
    const h = harness({ seed: [installed("w_wake", WAKE, "an-integrations-one")] });

    expect(await h.port.probe(OPERATOR, "w_wake")).toMatchObject({ events: expect.any(Number) });
    expect(h.probed).toEqual(["an-integrations-one"]);

    expect(await rejection(h.port.probe(HERMES, "w_wake"))).toMatchObject({ reason: "not_found" });
    expect(h.probed).toEqual(["an-integrations-one"]);
  });

  it("says so when this gateway has no engine to try against", async () => {
    const h = harness({ seed: [installed("w_push", PUSH)], noPreflight: true });

    expect(await rejection(h.port.probe(OPERATOR, "w_push"))).toMatchObject({
      reason: "compiler_unavailable",
    });
  });
});
