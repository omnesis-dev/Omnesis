// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One path from a sentence to a running watch, whoever asked for it.
 *
 * Two surfaces call this — the operator's compile route and an integration's
 * own create — and the reason they share it is that a watch must not mean two
 * things depending on which one was used. So the tests are about what the two
 * callers may differ in (whom it wakes, and whether anyone has agreed yet) and
 * what they may not (the compile, the definition, where the journal starts).
 *
 * The other property here is an ordering one. The definition and the anchor are
 * two stores with no shared transaction, and only one order is recoverable: a
 * watch with no anchor wakes nobody until `reconcile` clears it, while an anchor
 * with no watch is an approved record pointing at nothing.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it, vi } from "vitest";
import { InFlightRequests } from "./in-flight-requests.js";

import {
  ANCHOR_UNMINTED_NOTE,
  authorWatch,
  previewWatch,
  retireAuthoredWatch,
  type AuthorWatchDeps,
} from "./authoring.js";
import type { StoredWatch } from "./definitions.js";
import type { Ontology } from "@omnesis/watch";

const WATCH_DSL = {
  watch: {
    name: "a-parcel-shipped",
    // Deliberately not the request any test asks with: `interpretation` is the
    // compiler's restatement, and a fixture echoing the request back would let
    // a wrong implementation — one returning the request — pass.
    nl_query: "the courier says a parcel has left the depot",
    firing_policy: "stays_active",
    ontology_fingerprint: "an-install-fingerprint",
    nodes: [
      {
        id: "shipped",
        type: "source.document_event",
        filter: { source: "mailbox:someone@example.com", event: ["created"] },
        output_map: { doc_id: "$e.docId" },
        recall: { lexical: { terms: ["shipped"], match: "token" } },
        judge: { proposition: "the message says a parcel has shipped", output_schema: {} },
      },
    ],
    sink: { input: "shipped", output_map: { evidence: "$n.shipped.doc_id" } },
  },
};

/** Enough of an ontology for the DSL parse; the compiler is stubbed out. */
const ontology = { fingerprint: "an-install-fingerprint" } as unknown as Ontology;

function deps(overrides: Partial<AuthorWatchDeps> = {}): {
  deps: AuthorWatchDeps;
  order: string[];
  stored: StoredWatch[];
} {
  const order: string[] = [];
  const stored: StoredWatch[] = [];
  return {
    order,
    stored,
    deps: {
      definitions: {
        put: (watch: StoredWatch) => {
          order.push("definition");
          stored.push(watch);
        },
        remove: (id: string) => {
          order.push(`remove:${id}`);
          return true;
        },
        get: (id: string) => stored.find((watch) => watch.id === id) ?? null,
        // The store's own uniqueness on the asker's key, as far as this cares:
        // what has been installed under it, if anything.
        findByRequestKey: (key: string) => stored.find((watch) => watch.requestKey === key) ?? null,
        setStatus: (id: string, status: string, note: string | null) => {
          order.push(`status:${id}:${status}`);
          const found = stored.findIndex((watch) => watch.id === id);
          if (found >= 0) {
            stored[found] = { ...stored[found]!, status: status as StoredWatch["status"], note };
          }
        },
      } as unknown as AuthorWatchDeps["definitions"],
      forget: (id: string) => order.push(`forget:${id}`),
      journal: { head: () => 4_242 } as unknown as AuthorWatchDeps["journal"],
      ontology: () => Promise.resolve(ontology),
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        }),
      writes: { run: (fn: () => Promise<void>) => fn() } as AuthorWatchDeps["writes"],
      inFlight: new InFlightRequests(),
      setWakeAnchor: () => {
        order.push("anchor");
        return Promise.resolve("sub_minted");
      },
      ...overrides,
    },
  };
}

describe("a sentence becomes a running watch", () => {
  it("installs the definition before it mints the anchor", async () => {
    // The recoverable order. Reversed, a crash between the two stores leaves an
    // approved record naming a watch that does not exist — and nothing sweeps
    // for that, because the sweep runs over the watches.
    const d = deps();

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_1", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(d.order).toEqual(["definition", "anchor"]);
  });

  it("starts the watch at the journal's head, not at the beginning", async () => {
    // A watch that started at zero would wake on the entire corpus the moment
    // it was created, which is the loudest possible version of this feature.
    const d = deps();

    await authorWatch(d.deps, { request: "tell me when a parcel ships", authoredBy: "operator" });

    expect(d.stored[0]?.fromSeq).toBe(4_242);
  });

  it("wakes the device it was told to, not one it looked up", async () => {
    const setWakeAnchor = vi.fn().mockResolvedValue("sub_minted");
    const d = deps({ setWakeAnchor });

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_caller", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(setWakeAnchor.mock.calls[0]?.[1]).toMatchObject({
      target: { kind: "device", deviceId: "dev_caller" },
      authoredBy: "integration",
    });
  });

  it("installs a watch that wakes nobody when no instruction came with it", async () => {
    // A condition worth recording is not always a condition worth waking for,
    // and the operator's surface can install one either way.
    // Called for every watch now, so that a rewrite turning a wake into a push
    // has its record retired rather than left standing.
    const setWakeAnchor = vi.fn().mockResolvedValue(null);
    const d = deps({ setWakeAnchor });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });

    expect(result.status).toBe("installed");
    if (result.status !== "installed") return;
    expect(result.anchorSubscriptionId).toBeNull();
    // Called with the watch and nothing else to say: the definition wakes
    // nobody, so what comes back is a retirement rather than a record.
    expect(setWakeAnchor.mock.calls[0]?.[0]).toBe(result.watch.id);
  });

  it("reports the record a caller will be asked to approve", async () => {
    const d = deps();

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_1", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(result.status === "installed" && result.anchorSubscriptionId).toBe("sub_minted");
  });

  it("holds the watch rather than reporting one that wakes nobody", async () => {
    // The harness named by the watch is not paired, so nothing was minted. The
    // watch would otherwise be installed and evaluating with nothing to hear it
    // fire, and a caller told only that it was created would wait forever on a
    // wake nobody is going to send.
    const d = deps({ setWakeAnchor: () => Promise.resolve(null) });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "harness", name: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(result.status).toBe("unarmed");
  });
});

describe("a watch that wakes says so in its own definition", () => {
  // The bug this exists for was silent on every surface. The anchor was minted,
  // the record read `active`, the watch evaluated and matched — and nothing
  // woke, because the runtime asks the *watch* whether it delivers and
  // `deliver()` returns early on a definition with none. The anchor sweep reads
  // the same block, so at the next start it would also retire the record for
  // belonging to a watch that wakes nobody.
  function deliveryOf(stored: { dsl: unknown }): Record<string, unknown> | undefined {
    return (stored.dsl as { watch?: { delivery?: Record<string, unknown> } }).watch?.delivery;
  }

  it("carries the agent-wake block the asker paid for", async () => {
    const d = deps();

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_1", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(result.status).toBe("installed");
    expect(deliveryOf(d.stored[0]!)).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "post it to the channel",
    });
  });

  it("records the harness, not the device that happens to hold it today", async () => {
    // A device id changes when a harness re-pairs. A definition written against
    // one would stop waking anybody the day that happened, while still firing
    // perfectly well — the anchor is what binds to the device, and it is minted
    // fresh each time.
    const d = deps();

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_this_week", harness: "hermes" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(deliveryOf(d.stored[0]!)).toMatchObject({ integration: "hermes" });
    expect(JSON.stringify(d.stored[0]!.dsl)).not.toContain("dev_this_week");
  });

  it("leaves a watch that wakes nobody without one", async () => {
    const d = deps();

    await authorWatch(d.deps, { request: "tell me when a parcel ships", authoredBy: "operator" });

    expect(deliveryOf(d.stored[0]!)).toBeUndefined();
  });

  it("carries the referents the instruction names", async () => {
    // Written into the definition rather than kept with the request, because
    // the anchor is a reading of the definition: referents that lived only in
    // the request would be gone the first time the record was re-minted.
    const d = deps();

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "harness", name: "openclaw" },
        instruction: "reply in the conversation this came from",
        bindings: { conversation: "thread-8821", reply_to: "maya.reeves@example.com" },
      },
      authoredBy: "operator",
    });

    expect(deliveryOf(d.stored[0]!)).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "reply in the conversation this came from",
      bindings: { conversation: "thread-8821", reply_to: "maya.reeves@example.com" },
    });
  });

  it("writes no referents at all when the asker named none", async () => {
    // An empty map and an absent one say the same thing, and the anchor keys
    // them the same. Writing one would put a field that names nothing into
    // every definition an operator reads back.
    const d = deps();

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "harness", name: "openclaw" },
        instruction: "post it to the channel",
        bindings: {},
      },
      authoredBy: "operator",
    });

    expect(deliveryOf(d.stored[0]!)).not.toHaveProperty("bindings");
  });

  it("refuses a delivery the DSL would not accept, rather than storing it", async () => {
    // Parsed after the block is written. An integration name the schema
    // rejects — this one starts with a digit — has to be a refusal, not a
    // watch stored in a shape the runtime cannot read back.
    const d = deps();

    await expect(
      authorWatch(d.deps, {
        request: "tell me when a parcel ships",
        delivery: {
          kind: "agent-wake",
          wake: { kind: "harness", name: "9-lives" },
          instruction: "post it to the channel",
        },
        authoredBy: "operator",
      }),
    ).rejects.toThrow();
    expect(d.stored, "an invalid delivery was stored anyway").toHaveLength(0);
  });
});

describe("the compile a watch came from", () => {
  it("travels with the watch, so every surface can reach the transcript", async () => {
    // Kept on the watch and not only on the subscription revision, because
    // most watches have no revision: only one that wakes an agent keeps a
    // record among the subscriptions. Without this an operator's notify-only
    // watch has no path from the thing they installed to the reasoning that
    // produced it.
    const d = deps();

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
      delivery: { kind: "omnesis-notify" },
    });

    expect(d.stored[0]?.compileRunId).toBe("run_the_compile");
  });

  it("is null when nothing was recorded, rather than a link to nothing", async () => {
    const d = deps({
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: null,
        }),
    });

    await authorWatch(d.deps, { request: "tell me when a parcel ships", authoredBy: "operator" });

    expect(d.stored[0]?.compileRunId).toBe(null);
  });
});

describe("the two ways of coming back without a watch", () => {
  it("keeps a refusal's reasons, which are what make a better question", async () => {
    const d = deps({
      compile: () =>
        Promise.resolve({
          status: "refused",
          reasons: ["no source matches that"],
          codes: ["unsupported_condition"],
          compileRunId: "run_the_refusal",
        }),
    });

    const result = await authorWatch(d.deps, { request: "something", authoredBy: "operator" });

    expect(result).toEqual({
      status: "refused",
      reasons: ["no source matches that"],
      // The disclosable half, carried alongside the words: a caller on the far
      // side of the privacy boundary gets these and never the reasons.
      codes: ["unsupported_condition"],
      // The refusal's own ledger row: what the compiler read before declining
      // is the whole explanation, and without the id it is found by scanning
      // the runs list for the right timestamp.
      compileRunId: "run_the_refusal",
    });
    expect(d.order, "a refused compile still wrote something").toEqual([]);
  });

  it("separates having no model from declining to write a watch", async () => {
    // A caller acts on these differently: one is the install's configuration
    // and the other is their own request. Collapsing them tells someone their
    // question was unreasonable when nothing was ever asked.
    const d = deps({ compile: undefined });

    expect(await authorWatch(d.deps, { request: "something", authoredBy: "operator" })).toEqual({
      status: "no-compiler",
    });
  });
});

describe("retiring the watch a revoked record was the front of", () => {
  it("removes the definition and the runtime state together", async () => {
    // Half of this is not enough. A definition left behind keeps evaluating
    // and spending judge budget on a watch its owner believes they deleted;
    // runtime state left behind is a cursor and a record of documents already
    // seen, which a watch added afterwards would inherit.
    const d = deps();

    await retireAuthoredWatch(d.deps, "w_gone");

    expect(d.order).toEqual(["remove:w_gone", "forget:w_gone"]);
  });

  it("drops a delivery block the compiler wrote, when nobody asked for one", async () => {
    // The one caller that reaches this: the operator's compile route with no
    // instruction, which asks for a watch that records and interrupts nobody.
    // The DSL has a `delivery` field and the compiler is shown the schema, so a
    // model fills it in for a request that merely sounds urgent — and since the
    // compiler reads the corpus, a retrieved document can be what asks it to.
    //
    // `omnesis-notify` is the shape that matters most, because it needs no anchor and
    // no approval: the runtime pushes straight from the firing, so a block that
    // survived would ring the operator's phone for a watch they asked to be
    // silent.
    const setWakeAnchor = vi.fn().mockResolvedValue(null);
    const d = deps({
      setWakeAnchor,
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
          document: {
            watch: {
              ...WATCH_DSL.watch,
              delivery: { kind: "omnesis-notify", title: "urgent", body: "look at this" },
            },
          },
        }),
    });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });

    expect(result.status).toBe("installed");
    const dsl = d.stored[0]?.dsl as { watch: { delivery?: unknown } };
    expect(dsl.watch.delivery).toBeUndefined();
  });

  it("drops a compiler-written agent-wake too, and mints nothing for it", async () => {
    // The other half of the same guard, and the one that reads as a live watch
    // to everything downstream: `wakesAnAgent` inspects the stored definition,
    // so a surviving block sends every firing down the wake branch of a watch
    // with no anchor and no approved record behind it.
    const setWakeAnchor = vi.fn().mockResolvedValue(null);
    const d = deps({
      setWakeAnchor,
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
          document: {
            watch: {
              ...WATCH_DSL.watch,
              delivery: {
                kind: "agent-wake",
                integration: "openclaw",
                instruction: "forward it to the channel",
              },
            },
          },
        }),
    });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });

    expect(result.status === "installed" && result.anchorSubscriptionId).toBeNull();
    const dsl = d.stored[0]?.dsl as { watch: { delivery?: unknown } };
    expect(dsl.watch.delivery).toBeUndefined();
    // Asked for, and answered with nothing: the block is gone from the stored
    // definition, which is where the anchor reads whom the watch wakes.
    expect(setWakeAnchor).toHaveBeenCalledTimes(1);
  });

  it("still uses the caller's delivery when the compiler wrote a different one", async () => {
    // The caller's block wins outright rather than merging with the model's:
    // half of a hallucinated delivery is still a hallucinated delivery.
    const d = deps({
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
          document: {
            watch: {
              ...WATCH_DSL.watch,
              delivery: { kind: "omnesis-notify", title: "not what was asked for" },
            },
          },
        }),
    });

    await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_1", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    const dsl = d.stored[0]?.dsl as {
      watch: { delivery?: { kind: string; integration?: string } };
    };
    expect(dsl.watch.delivery).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "post it to the channel",
    });
  });

  it("hands a refusal's codes on beside its reasons", async () => {
    // Two channels, because they have two audiences: the reasons are the
    // compiler's own words about this corpus, and the codes are what a caller
    // outside the machine is allowed to be told.
    const d = deps({
      compile: () =>
        Promise.resolve({
          status: "refused" as const,
          reasons: ["nothing here carries parcel tracking"],
          codes: ["unsupported_condition" as const],
          compileRunId: null,
        }),
    });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "integration",
    });

    expect(result).toEqual({
      status: "refused",
      reasons: ["nothing here carries parcel tracking"],
      codes: ["unsupported_condition"],
      compileRunId: null,
    });
  });

  it("reports no assigned model as a configuration state, not as a refusal", async () => {
    // An agent told its condition was unsupported stops asking. Nothing about
    // the condition was decided here — no model looked at it.
    const d = deps({ compile: () => Promise.resolve({ status: "no-model" as const }) });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "integration",
    });

    expect(result.status).toBe("no-compiler");
  });

  it("takes a write turn for the definition", async () => {
    // Two scheduler tasks write the same file from the main runner, and one
    // holds a transaction open across awaits. A write that skipped the turn
    // would join that transaction and be rolled back with it.
    let inTurn = false;
    const d = deps({
      writes: {
        run: async (fn: () => Promise<void>) => {
          inTurn = true;
          try {
            return await fn();
          } finally {
            inTurn = false;
          }
        },
      } as AuthorWatchDeps["writes"],
      definitions: {
        put: () => {},
        remove: () => {
          expect(inTurn, "the definition was removed outside a write turn").toBe(true);
          return true;
        },
      } as unknown as AuthorWatchDeps["definitions"],
    });

    await retireAuthoredWatch(d.deps, "w_gone");
  });
});

/**
 * The half-done install, which used to be permanent.
 *
 * Compiling and installing are two stores that cannot share a transaction, so
 * between them is a watch that evaluates, spends judge budget and wakes nobody.
 * Nothing revisits a watch that never fired, so it stayed that way — while the
 * caller was handed a 500 over a watch that was quietly running.
 */
describe("a watch whose wake record cannot be created", () => {
  it("is held with the reason on it, rather than left evaluating into nothing", async () => {
    const d = deps({
      setWakeAnchor: () => Promise.reject(new Error("the subscription store is locked")),
    });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "harness", name: "openclaw" },
        instruction: "Draft a reply.",
      },
      authoredBy: "operator",
    });

    expect(result.status).toBe("unarmed");
    if (result.status !== "unarmed") return;
    expect(result.watch.status).toBe("paused");
    expect(result.watch.note).toBe(ANCHOR_UNMINTED_NOTE);
    // Written where an operator reads it, not only returned: the caller may be
    // a retry that never comes back, and the watch outlives the request.
    expect(d.order).toContain(`status:${result.watch.id}:paused`);
  });

  it("finds its own watch on a retry rather than compiling a second one", async () => {
    // The retry that made a duplicate: the record was never created, so there
    // is nothing downstream to deduplicate against — and the watch it already
    // installed goes on evaluating beside the new one forever.
    let compiles = 0;
    const anchors: string[] = [];
    const d = deps({
      compile: () => {
        compiles += 1;
        return Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        });
      },
      setWakeAnchor: (watchId: string) => {
        anchors.push(watchId);
        // Fails the first time and works the second, which is the shape of a
        // retry: the same request, a moment later, against a store that has
        // stopped being busy.
        return anchors.length === 1
          ? Promise.reject(new Error("the subscription store is locked"))
          : Promise.resolve("sub_minted");
      },
    });
    const ask = {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake" as const,
        wake: { kind: "harness" as const, name: "openclaw" },
        instruction: "Draft a reply.",
      },
      authoredBy: "integration" as const,
      requestKey: "one-request-two-attempts",
    };

    const first = await authorWatch(d.deps, ask);
    const second = await authorWatch(d.deps, ask);

    expect(first.status).toBe("unarmed");
    expect(second.status).toBe("installed");
    expect(compiles, "the retry compiled a second watch").toBe(1);
    expect(d.stored, "the retry installed a second watch").toHaveLength(1);
    // The same watch, finished off: both attempts armed the one that exists.
    expect(new Set(anchors).size).toBe(1);
  });

  it("does not hold a watch that was never going to wake anyone", async () => {
    // A watch that only records has no record to mint, so a null answer is the
    // correct one and holding it would stop a watch that is working.
    const d = deps({ setWakeAnchor: () => Promise.resolve(null) });

    const result = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });

    expect(result.status).toBe("installed");
  });

  it("lets the watch run again once the retry arms it", async () => {
    // The retry finds the held watch and finishes the job — and the job is not
    // finished while the watch is still stopped. Nothing else revisits it, and
    // an anchor exists now, so reconcile is satisfied and would leave a watch
    // nothing evaluates sitting behind a record that works.
    const anchors: string[] = [];
    const d = deps({
      setWakeAnchor: (watchId: string) => {
        anchors.push(watchId);
        return anchors.length === 1
          ? Promise.reject(new Error("the subscription store is locked"))
          : Promise.resolve("sub_minted");
      },
    });
    const ask = {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake" as const,
        wake: { kind: "harness" as const, name: "openclaw" },
        instruction: "Draft a reply.",
      },
      authoredBy: "integration" as const,
      requestKey: "one-request-two-attempts",
    };

    await authorWatch(d.deps, ask);
    const second = await authorWatch(d.deps, ask);

    expect(second.status).toBe("installed");
    if (second.status !== "installed") return;
    expect(second.watch.status, "the retry answered 201 over a stopped watch").toBe("active");
    expect(second.watch.note).toBeNull();
    expect(d.stored[0]?.status).toBe("active");
  });

  it("refuses a key that already names a watch when the request rewrites another", async () => {
    // Two requests wearing one label. Honouring the key arms the watch it names
    // and skips the rewrite entirely; honouring the rewrite moves somebody
    // else's key onto it. Neither is what was asked, and neither would say so.
    const d = deps();
    const ask = {
      request: "tell me when a parcel ships",
      authoredBy: "integration" as const,
      requestKey: "a-key-of-their-own",
    };
    const first = await authorWatch(d.deps, ask);
    expect(first.status).toBe("installed");

    const collided = await authorWatch(d.deps, { ...ask, replaces: "some-other-watch" });

    expect(collided.status).toBe("conflict");
    expect(d.stored, "a second watch was installed under one key").toHaveLength(1);
    expect(d.order, "the collided request compiled anyway").not.toContain(
      "remove:some-other-watch",
    );
  });

  it("still honours a rewrite that names the watch the key already installed", async () => {
    // The ordinary retry of a rewrite: the same request, the same key, the
    // same watch. Nothing collides, and arming again finishes the job.
    const d = deps();
    const ask = {
      request: "tell me when a parcel ships",
      authoredBy: "integration" as const,
      requestKey: "a-key-of-their-own",
    };
    const first = await authorWatch(d.deps, ask);
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;

    const again = await authorWatch(d.deps, { ...ask, replaces: first.watch.id });

    expect(again.status).toBe("installed");
    expect(d.stored).toHaveLength(1);
  });

  it("converges a lost race for one key on the watch the winner installed", async () => {
    // Two creates carrying one key, both past the lookup, both compiled. The
    // loser reaches the unique index the winner has just filled. Sequentially
    // this same request would have found that row in the lookup and armed it;
    // arriving a moment sooner must not change the answer, which is the whole
    // promise of carrying a key.
    const d = deps();
    const winner: StoredWatch = {
      id: "w-the-winner",
      name: "a-parcel-ships",
      status: "active",
      referenceDigest: null,
      dsl: WATCH_DSL,
      addedAt: "2026-03-01T09:00:00.000Z",
      fromSeq: 0,
      note: null,
      compileRunId: null,
      requestKey: "one-key-two-racers",
    };
    // The message better-sqlite3 actually emits for this partial single-column
    // index — asserted as it is written, so a predicate tightened to some other
    // wording cannot stay green here while failing in production.
    const collision = Object.assign(new Error("UNIQUE constraint failed: watch_defs.request_key"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    // The winner becomes visible at the moment the loser's write refuses, and
    // not before. Seeding it into the store up front would be a different test:
    // the lookup ahead of the write would find it and return by the ordinary
    // retry path, leaving the collision branch unreached and the convergence
    // this case is named for unexercised.
    (d.deps.definitions as unknown as { put: (w: StoredWatch) => void }).put = () => {
      d.stored.push(winner);
      throw collision;
    };

    const lost = await authorWatch(d.deps, {
      request: "tell me when a parcel ships",
      authoredBy: "integration",
      requestKey: "one-key-two-racers",
    });

    expect(lost.status, "the loser was refused rather than converged").toBe("installed");
    if (lost.status !== "installed") return;
    expect(lost.watch.id).toBe("w-the-winner");
  });

  it("still raises when a collision leaves no winner to converge on", async () => {
    // The index refused and nothing is there to find. Something is wrong with
    // this store rather than with this request, and answering as though a
    // watch exists would report an install of nothing.
    const d = deps();
    (d.deps.definitions as unknown as { put: (w: StoredWatch) => void }).put = () => {
      throw Object.assign(new Error("UNIQUE constraint failed: watch_defs.request_key"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    };

    await expect(
      authorWatch(d.deps, {
        request: "tell me when a parcel ships",
        authoredBy: "integration",
        requestKey: "one-key-no-winner",
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  it("does not read an unrelated write failure as a collision", async () => {
    // A conflict tells the caller to change the request; every other write
    // failure is a fault, and reporting one as a conflict sends them to fix
    // something that is not wrong.
    const d = deps();
    (d.deps.definitions as unknown as { put: (w: StoredWatch) => void }).put = () => {
      throw Object.assign(new Error("UNIQUE constraint failed: watch_defs.id"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      });
    };

    await expect(
      authorWatch(d.deps, {
        request: "tell me when a parcel ships",
        authoredBy: "integration",
        requestKey: "one-key-two-racers",
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  it("compiles again for a request that carries no key of its own", async () => {
    // An operator installing twice means two watches. Only an asker with a
    // name for its request is asking for the same thing twice.
    let compiles = 0;
    const d = deps({
      compile: () => {
        compiles += 1;
        return Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        });
      },
    });
    const ask = { request: "tell me when a parcel ships", authoredBy: "operator" as const };

    await authorWatch(d.deps, ask);
    await authorWatch(d.deps, ask);

    expect(compiles).toBe(2);
    expect(d.stored).toHaveLength(2);
  });
});

describe("compiling without installing", () => {
  /**
   * The install's dependencies with every write replaced by a throw.
   *
   * The assertion is the deps object, not any `expect` below it: a preview
   * that reached a store at all would fail here rather than quietly leave a
   * row behind for someone to find later.
   */
  function unwritable(overrides: Partial<AuthorWatchDeps> = {}): AuthorWatchDeps {
    const refuse = (what: string) => () => {
      throw new Error(`a preview wrote to ${what}`);
    };
    return {
      definitions: {
        put: refuse("the definition store"),
        remove: refuse("the definition store"),
        get: refuse("the definition store"),
        findByRequestKey: refuse("the definition store"),
        setStatus: refuse("the definition store"),
      } as unknown as AuthorWatchDeps["definitions"],
      forget: refuse("the runtime state"),
      inFlight: new InFlightRequests(),
      journal: { head: refuse("the journal") } as unknown as AuthorWatchDeps["journal"],
      ontology: () => Promise.resolve(ontology),
      compile: () =>
        Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        }),
      writes: { run: refuse("the write lease") } as unknown as AuthorWatchDeps["writes"],
      setWakeAnchor: refuse("the anchor store"),
      ...overrides,
    };
  }

  it("writes nothing at all", async () => {
    const result = await previewWatch(unwritable(), {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });

    expect(result.status).toBe("compiled");
  });

  it("hands back the document an install would have written down", async () => {
    // Same delivery block, same stripping of the model's own. A preview of a
    // different document would be a measurement of a watch that never runs.
    const result = await previewWatch(unwritable(), {
      request: "tell me when a parcel ships",
      delivery: {
        kind: "agent-wake",
        wake: { kind: "device", deviceId: "dev_1", harness: "openclaw" },
        instruction: "post it to the channel",
      },
      authoredBy: "integration",
    });

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    const watch = (result.document as { watch: Record<string, unknown> }).watch;
    expect(watch["delivery"]).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "post it to the channel",
    });
    expect(result.interpretation).toBe("the courier says a parcel has left the depot");
    expect(result.compileRunId).toBe("run_the_compile");
  });

  it("takes out a delivery block the model wrote, exactly as an install would", async () => {
    // The guardrail this path must not lose: the compiler reads the corpus, so
    // a document it retrieved can ask it to interrupt somebody. A preview that
    // showed the block would report a watch nobody would have installed.
    const withModelDelivery = {
      watch: {
        ...WATCH_DSL.watch,
        delivery: { kind: "omnesis-notify", title: "the model chose this" },
      },
    };
    const result = await previewWatch(
      unwritable({
        compile: () =>
          Promise.resolve({
            status: "compiled" as const,
            document: withModelDelivery,
            diagnostics: [],
            backtest: null,
            compileRunId: "run_the_compile",
          }),
      }),
      { request: "tell me when a parcel ships", authoredBy: "operator" },
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(
      (result.document as { watch: Record<string, unknown> }).watch["delivery"],
    ).toBeUndefined();
  });

  it("tells the compile it is a preview, so the ledger can say so", async () => {
    // A run that installed nothing reads exactly like one whose install failed
    // after it, and the runs list is where an operator tells them apart.
    const seen: { compileOnly?: boolean }[] = [];
    await previewWatch(
      unwritable({
        compile: (input) => {
          seen.push(input);
          return Promise.resolve({
            status: "compiled" as const,
            document: WATCH_DSL,
            diagnostics: [],
            backtest: null,
            compileRunId: "run_the_compile",
          });
        },
      }),
      { request: "tell me when a parcel ships", authoredBy: "operator" },
    );

    expect(seen[0]?.compileOnly).toBe(true);
  });

  it("passes on a request to compile without replaying, and does not invent one", async () => {
    // The link between the route and the compiler, and the one that fails
    // silently: every other test of this switch starts downstream of here, so a
    // preview that dropped the flag would leave the compiler replaying in both
    // arms while the route, the port and the compiler each still passed their
    // own test. The control arm would then be the same compiler measured twice
    // — a latency difference of nothing, reported as the cost of the loop.
    const seen: { withoutBacktest?: boolean }[] = [];
    const compile = (input: { withoutBacktest?: boolean }) => {
      seen.push(input);
      return Promise.resolve({
        status: "compiled" as const,
        document: WATCH_DSL,
        diagnostics: [],
        backtest: null,
        compileRunId: "run_the_compile",
      });
    };

    await previewWatch(unwritable({ compile }), {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
      withoutBacktest: true,
    });
    expect(seen[0]?.withoutBacktest, "the preview dropped the caller's request").toBe(true);

    // The other half. A preview that sent it unconditionally would withhold the
    // replay from every compile on the install, which is the whole feature off.
    await previewWatch(unwritable({ compile }), {
      request: "tell me when a parcel ships",
      authoredBy: "operator",
    });
    expect(seen[1], "the preview asked to skip a replay nobody declined").not.toHaveProperty(
      "withoutBacktest",
    );
  });

  it("never asks to skip the replay on a compile that installs", async () => {
    // Where the invariant actually lives. The HTTP body refuses the pairing,
    // but nothing below it does — and a watch about to be armed is the one case
    // where the replay is worth its minutes whatever anyone asked for.
    const seen: Record<string, unknown>[] = [];
    const { deps: d } = deps({
      compile: (input) => {
        seen.push(input as Record<string, unknown>);
        return Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        });
      },
    });
    await authorWatch(d, { request: "tell me when a parcel ships", authoredBy: "operator" });
    expect(seen[0], "an installing compile was told to skip its replay").not.toHaveProperty(
      "withoutBacktest",
    );
  });

  it("reports a refusal as a refusal rather than as an empty preview", async () => {
    const result = await previewWatch(
      unwritable({
        compile: () =>
          Promise.resolve({
            status: "refused" as const,
            reasons: ["no source publishes what this asks about"],
            codes: ["unsupported_condition" as const],
            compileRunId: "run_the_refusal",
          }),
      }),
      { request: "tell me when the fictional ledger posts", authoredBy: "operator" },
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.codes).toEqual(["unsupported_condition"]);
    expect(result.compileRunId).toBe("run_the_refusal");
  });
});

describe("one intent arriving more than once while it compiles", () => {
  it("compiles once and installs one watch", async () => {
    // The idempotency key deduplicates against the record a compile leaves
    // behind, so it settles a retry that arrives after the first finished and
    // does nothing for one that arrives during it. With a compile measured in
    // minutes and a client that retries on a timeout, during it is the ordinary
    // case — observed live as one intent, five compiles, and five watches.
    let compiles = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps: d, stored } = deps({
      compile: async () => {
        compiles += 1;
        await held;
        return {
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        };
      },
    });
    const ask = () =>
      authorWatch(d, {
        request: "tell me when the thing happens",
        authoredBy: "integration",
        requestKey: "device-a\u0000the-agent-key",
      });

    const both = Promise.all([ask(), ask()]);
    release();
    const [first, second] = await both;

    expect(compiles, "the second arrival paid for its own compile").toBe(1);
    expect(stored).toHaveLength(1);
    expect(first.status).toBe("installed");
    expect(second.status).toBe("installed");
  });

  it("still compiles twice for two different requests wearing one key", async () => {
    // A key naming one request and a different request wearing the same key are
    // what the conflict guard exists for. Sharing the run would hand the second
    // caller a watch it never asked for, with nothing to notice it by.
    let compiles = 0;
    const { deps: d } = deps({
      compile: () => {
        compiles += 1;
        return Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        });
      },
    });
    await Promise.all([
      authorWatch(d, {
        request: "tell me when the thing happens",
        authoredBy: "integration",
        requestKey: "device-a\u0000the-agent-key",
      }),
      authorWatch(d, {
        request: "tell me when something else happens",
        authoredBy: "integration",
        requestKey: "device-a\u0000the-agent-key",
      }),
    ]);
    expect(compiles).toBe(2);
  });

  it("leaves a request that named nothing to run on its own", async () => {
    // No key is no identity: two such requests are two requests, and sharing
    // them would answer one caller with another's watch.
    let compiles = 0;
    const { deps: d } = deps({
      compile: () => {
        compiles += 1;
        return Promise.resolve({
          status: "compiled" as const,
          document: WATCH_DSL,
          diagnostics: [],
          backtest: null,
          compileRunId: "run_the_compile",
        });
      },
    });
    await Promise.all([
      authorWatch(d, { request: "tell me when the thing happens", authoredBy: "operator" }),
      authorWatch(d, { request: "tell me when the thing happens", authoredBy: "operator" }),
    ]);
    expect(compiles).toBe(2);
  });
});
