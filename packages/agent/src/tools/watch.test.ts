// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the six watch tools — `watch_create`, `watch_update`,
 * `watch_delete`, `watches_list`, `watch_get`, `watch_probe`. All run against an in-memory
 * fake port, so what is asserted here is the tool contract — argument
 * validation, the wire result the transcript cards render, that the two read
 * tools pass the port's data through untouched under the new
 * `watches.listed` / `watch.fetched` result kinds, and the mapping from a
 * port rejection to a stable error code. The gateway-side behaviour
 * (compilation, catalog re-check, the definition that lands in the watch
 * store) is covered in `packages/gateway/src/agent/watch-port.test.ts`.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, it, expect } from "vitest";

import {
  createWatchCreateTool,
  createWatchDeleteTool,
  createWatchGetTool,
  createWatchProbeTool,
  createWatchUpdateTool,
  createWatchesListTool,
} from "./watch.js";
import {
  WatchPortError,
  type WatchPort,
  type WatchPortDetail,
  type WatchPortEntry,
  type WatchPortProbe,
  type WatchPortResult,
} from "./types.js";

const CTX = {
  sessionId: "S",
  messageId: "M",
  caller: { kind: "operator" } as const,
  abortSignal: new AbortController().signal,
};

function makeResult(overrides: Partial<WatchPortResult> = {}): WatchPortResult {
  return {
    action: overrides.action ?? "created",
    watchId: overrides.watchId ?? "trg_watch",
    name: overrides.name ?? "Delivery alerts",
    enabled: overrides.enabled ?? true,
    interpretation: overrides.interpretation ?? "New document mentioning a delivery delay",
    warnings: overrides.warnings ?? [],
  };
}

function makeEntry(overrides: Partial<WatchPortEntry> = {}): WatchPortEntry {
  return {
    watchId: overrides.watchId ?? "trg_watch",
    name: overrides.name ?? "Delivery alerts",
    request: overrides.request ?? "when a message mentions a delayed delivery",
    enabled: overrides.enabled ?? true,
    note: overrides.note,
    manageable: overrides.manageable ?? true,
    firedCount: overrides.firedCount ?? 0,
    lastFiredAt: overrides.lastFiredAt,
  };
}

function makeDetail(overrides: Partial<WatchPortDetail> = {}): WatchPortDetail {
  return {
    ...makeEntry(overrides),
    interpretation: overrides.interpretation ?? "New document mentioning a delivery delay",
    createdAt: overrides.createdAt ?? "2026-03-01T09:00:00.000Z",
    firings: overrides.firings ?? [],
  };
}

function fakePort(state: {
  create?: WatchPort["create"];
  update?: WatchPort["update"];
  remove?: WatchPort["remove"];
  list?: WatchPort["list"];
  get?: WatchPort["get"];
  probe?: WatchPort["probe"];
}): WatchPort {
  return {
    async create(caller, input) {
      if (state.create) return state.create(caller, input);
      throw new Error("create not stubbed in this test");
    },
    async update(caller, input) {
      if (state.update) return state.update(caller, input);
      throw new Error("update not stubbed in this test");
    },
    async remove(caller, watchId) {
      if (state.remove) return state.remove(caller, watchId);
      throw new Error("remove not stubbed in this test");
    },
    async list(caller) {
      if (state.list) return state.list(caller);
      throw new Error("list not stubbed in this test");
    },
    async get(caller, watchId) {
      if (state.get) return state.get(caller, watchId);
      throw new Error("get not stubbed in this test");
    },
    async probe(caller, watchId) {
      if (state.probe) return state.probe(caller, watchId);
      throw new Error("probe not stubbed in this test");
    },
  };
}

describe("who the port is told is asking", () => {
  // The thread only earns its keep if it actually arrives. A tool that read the
  // context and dropped it would pass every test above, because the fake port
  // ignores the caller — so these assert the value, not the arity.
  it("hands the port the caller the session was opened for", async () => {
    const seen: unknown[] = [];
    const port = fakePort({
      list: async (caller) => {
        seen.push(caller);
        return [];
      },
      get: async (caller) => {
        seen.push(caller);
        return null;
      },
    });

    const integration = { ...CTX, caller: { kind: "integration", slug: "openclaw" } as const };
    await createWatchesListTool({ port }).invoke({}, integration);
    await createWatchGetTool({ port }).invoke({ watchId: "w_1" }, integration);

    expect(seen).toEqual([
      { kind: "integration", slug: "openclaw" },
      { kind: "integration", slug: "openclaw" },
    ]);
  });

  it("stands an unidentified turn in as nobody, never as the operator", async () => {
    // A path that forgets to thread its identity must lose visibility, not gain
    // it: reading the other way would hand every watch on the install to the
    // first caller whose boundary was not taught to say who it is.
    let seen: unknown = null;
    const port = fakePort({
      list: async (caller) => {
        seen = caller;
        return [];
      },
    });

    await createWatchesListTool({ port }).invoke({}, { sessionId: "S", messageId: "M" });

    expect(seen).not.toEqual({ kind: "operator" });
    expect(seen).toMatchObject({ kind: "integration" });
  });
});

describe("watch_create tool", () => {
  it("forwards the natural-language request and returns the compiler's reading", async () => {
    let seen: { request: string } | null = null;
    const tool = createWatchCreateTool({
      port: fakePort({
        create: async (_caller, input) => {
          seen = { request: input.request };
          return makeResult();
        },
      }),
    });

    const result = await tool.invoke(
      { request: "when a message mentions a delayed delivery" },
      CTX,
    );

    // The compiler names the watch — the tool has no `name` argument to
    // forward, so the port only ever sees the request.
    expect(seen).toEqual({ request: "when a message mentions a delayed delivery" });
    expect(result.kind).toBe("watch.upserted");
    if (result.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(result.action).toBe("created");
    expect(result.watchId).toBe("trg_watch");
    expect(result.enabled).toBe(true);
    // The interpretation is what lets the agent iterate in-conversation.
    expect(result.interpretation).toBe("New document mentioning a delivery delay");
  });

  it("falls back to the interpretation for the card caption, and honours an explicit summary", async () => {
    const tool = createWatchCreateTool({
      port: fakePort({ create: async () => makeResult() }),
    });

    const implicit = await tool.invoke({ request: "anything" }, CTX);
    if (implicit.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(implicit.summary).toBe("New document mentioning a delivery delay");

    const explicit = await tool.invoke(
      { request: "anything", summary: "Pings you about late parcels" },
      CTX,
    );
    if (explicit.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(explicit.summary).toBe("Pings you about late parcels");
  });

  it("passes the notify reaction through and relays delivery warnings", async () => {
    let seenNotify: unknown;
    const tool = createWatchCreateTool({
      port: fakePort({
        create: async (_caller, input) => {
          seenNotify = input.notify;
          return makeResult({ warnings: ["push delivery is not configured"] });
        },
      }),
    });
    const result = await tool.invoke(
      {
        request: "anything",
        notify: { title: "Parcel update", body: "{{batch_size}} update(s)" },
      },
      CTX,
    );
    expect(seenNotify).toEqual({ title: "Parcel update", body: "{{batch_size}} update(s)" });
    if (result.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(result.warnings).toEqual(["push delivery is not configured"]);
  });

  it("omits `warnings` entirely when the gateway reported none", async () => {
    const tool = createWatchCreateTool({ port: fakePort({ create: async () => makeResult() }) });
    const result = await tool.invoke({ request: "anything" }, CTX);
    if (result.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(result.warnings).toBeUndefined();
  });

  it("surfaces an uncompilable condition under the compiler's own code", async () => {
    const tool = createWatchCreateTool({
      port: fakePort({
        create: async () => {
          throw new WatchPortError({
            reason: "uncompilable",
            code: "not_a_condition",
            message: "That is not something that happens.",
          });
        },
      }),
    });
    const result = await tool.invoke({ request: "when nobody messages me for a week" }, CTX);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("not_a_condition");
    expect(result.message).toBe("That is not something that happens.");
  });

  it("surfaces an unavailable compiler distinctly, so the agent doesn't rephrase", async () => {
    const tool = createWatchCreateTool({
      port: fakePort({
        create: async () => {
          throw new WatchPortError({
            reason: "compiler_unavailable",
            message: "no background model is assigned",
          });
        },
      }),
    });
    const result = await tool.invoke({ request: "anything" }, CTX);
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("compiler_unavailable");
  });

  it("surfaces a timed-out compile under its own code, distinct from a refusal", async () => {
    // A refusal is settled — the agent must rephrase. A timeout is the
    // opposite: nothing about the request was wrong, so collapsing it into
    // `uncompilable` would send the agent hunting for different words on a
    // request that would likely compile if it just tried again.
    const tool = createWatchCreateTool({
      port: fakePort({
        create: async () => {
          throw new WatchPortError({
            reason: "timed_out",
            message: "the compiler did not finish in the time it was given",
          });
        },
      }),
    });
    const result = await tool.invoke({ request: "anything" }, CTX);
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("timed_out");
    expect(result.code).not.toBe("uncompilable");
  });

  it("rejects a spec-shaped argument — this tool takes prose, never a TriggerSpec", async () => {
    const tool = createWatchCreateTool({ port: fakePort({}) });
    const result = await tool.invoke(
      {
        request: "anything",
        spec: { kind: "match", on: { source: "document", where: {} } },
      },
      CTX,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("invalid_args");
  });

  it("rejects a missing request", async () => {
    const tool = createWatchCreateTool({ port: fakePort({}) });
    const result = await tool.invoke({}, CTX);
    expect(result.kind).toBe("error");
  });
});

describe("watch_update tool", () => {
  it("recompiles an existing watch, keeps its id, and reports `updated`", async () => {
    let seen: unknown;
    const tool = createWatchUpdateTool({
      port: fakePort({
        update: async (_caller, input) => {
          seen = input;
          return makeResult({
            action: "updated",
            watchId: input.watchId,
            interpretation: "New or changed document mentioning a refund",
          });
        },
      }),
    });
    const result = await tool.invoke(
      { watchId: "trg_watch", request: "when something mentions a refund" },
      CTX,
    );
    // No `name` in the call — a rewrite is a full replacement of the
    // condition, never a rename.
    expect(seen).toEqual({ watchId: "trg_watch", request: "when something mentions a refund" });
    if (result.kind !== "watch.upserted") throw new Error("unexpected kind");
    expect(result.action).toBe("updated");
    // The id an earlier turn learned still resolves after the rewrite.
    expect(result.watchId).toBe("trg_watch");
    expect(result.interpretation).toBe("New or changed document mentioning a refund");
  });

  it("maps a not-manageable target to a stable code, carrying the port's reason", async () => {
    const tool = createWatchUpdateTool({
      port: fakePort({
        update: async () => {
          throw new WatchPortError({
            reason: "not_manageable",
            watchId: "trg_shadow",
            message:
              "trg_shadow records without notifying — a rewrite here would add a push nobody asked for",
          });
        },
      }),
    });
    const result = await tool.invoke({ watchId: "trg_shadow", request: "anything" }, CTX);
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("not_manageable");
    expect(result.message).toBe(
      "trg_shadow records without notifying — a rewrite here would add a push nobody asked for",
    );
  });

  it("rejects a missing watchId", async () => {
    const tool = createWatchUpdateTool({ port: fakePort({}) });
    const result = await tool.invoke({ request: "anything" }, CTX);
    expect(result.kind).toBe("error");
  });
});

describe("watch_delete tool", () => {
  it("removes the watch and reports it structurally, with no card", async () => {
    // A card announcing something that is gone would read as something that
    // still is — the transcript already shows the call that removed it.
    let removedId: string | undefined;
    const tool = createWatchDeleteTool({
      port: fakePort({
        remove: async (_caller, watchId) => {
          removedId = watchId;
        },
      }),
    });
    const result = await tool.invoke({ watchId: "trg_watch" }, CTX);
    expect(removedId).toBe("trg_watch");
    expect(result).toEqual({
      kind: "structured",
      resultType: "watch.removed",
      data: { watchId: "trg_watch" },
    });
  });

  it("maps a not-found target to its own code", async () => {
    const tool = createWatchDeleteTool({
      port: fakePort({
        remove: async () => {
          throw new WatchPortError({ reason: "not_found", watchId: "trg_gone" });
        },
      }),
    });
    const result = await tool.invoke({ watchId: "trg_gone" }, CTX);
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("not_found");
  });

  it("rejects a missing watchId", async () => {
    const tool = createWatchDeleteTool({ port: fakePort({}) });
    const result = await tool.invoke({}, CTX);
    expect(result.kind).toBe("error");
  });
});

describe("watches_list tool", () => {
  it("returns the port's entries verbatim under the `watches.listed` kind", async () => {
    const entries: WatchPortEntry[] = [
      makeEntry({ watchId: "trg_1", name: "Delivery alerts" }),
      makeEntry({
        watchId: "trg_2",
        name: "Refund watch",
        manageable: false,
        firedCount: 3,
        lastFiredAt: "2026-03-04T10:00:00.000Z",
      }),
    ];
    const tool = createWatchesListTool({ port: fakePort({ list: async () => entries }) });

    const result = await tool.invoke({}, CTX);

    expect(result).toEqual({ kind: "watches.listed", watches: entries });
  });
});

describe("watch_get tool", () => {
  it("returns the full record under the `watch.fetched` kind, firings included", async () => {
    const detail = makeDetail({
      watchId: "trg_1",
      firings: [{ firedAt: "2026-03-04T10:00:00.000Z", payload: { evidence: "d1" } }],
    });
    const tool = createWatchGetTool({ port: fakePort({ get: async () => detail }) });

    const result = await tool.invoke({ watchId: "trg_1" }, CTX);

    expect(result).toEqual({ kind: "watch.fetched", watch: detail });
  });

  it("returns a not_found error result rather than throwing when the watch is absent", async () => {
    // 'Is my watch working?' starts from an id the agent already holds. A
    // stale or hidden one must come back as an ordinary tool error the model
    // can react to and relay, not an unhandled rejection that aborts the turn.
    const tool = createWatchGetTool({ port: fakePort({ get: async () => null }) });

    const result = await tool.invoke({ watchId: "trg_gone" }, CTX);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("not_found");
    expect(result.message).toContain("trg_gone");
  });

  it("rejects a missing watchId", async () => {
    const tool = createWatchGetTool({ port: fakePort({}) });
    const result = await tool.invoke({}, CTX);
    expect(result.kind).toBe("error");
  });
});

describe("watch_probe tool", () => {
  const PROBE: WatchPortProbe = {
    events: 240,
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-08T00:00:00.000Z",
    firings: 0,
    judgeGated: true,
    nodes: [
      {
        nodeId: "mail",
        evaluated: 240,
        matched: 0,
        wouldAsk: 0,
        diagnostics: ["its lexical arm matches the event title only"],
        samples: [{ seq: 41, transition: "ignored", detail: "no lexical term matched" }],
      },
    ],
  };

  it("passes the port's counts through so the agent can say what it found", async () => {
    let asked: string | null = null;
    const tool = createWatchProbeTool({
      port: fakePort({
        probe: async (_caller, watchId) => {
          asked = watchId;
          return PROBE;
        },
      }),
    });

    const result = await tool.invoke({ watchId: "trg_1" }, CTX);

    expect(asked).toBe("trg_1");
    expect(result.kind).toBe("watch.probed");
    if (result.kind !== "watch.probed") throw new Error("unexpected kind");
    // A zero is only readable against its denominator and its window, so all
    // three have to survive the hop into the transcript.
    expect(result.events).toBe(240);
    expect(result.from).toBe("2026-03-01T00:00:00.000Z");
    expect(result.nodes[0]).toMatchObject({ nodeId: "mail", evaluated: 240, matched: 0 });
    // And the reason, without which "0" is discouraging rather than useful.
    expect(result.nodes[0]?.diagnostics).toEqual(["its lexical arm matches the event title only"]);
    // A judged node means the firing count is structurally zero; saying so is
    // what stops the agent reporting a working watch as broken.
    expect(result.judgeGated).toBe(true);
  });

  it("turns a port rejection into an error result rather than aborting the turn", async () => {
    const tool = createWatchProbeTool({
      port: fakePort({
        probe: async () => {
          throw new WatchPortError({ reason: "not_found", watchId: "trg_gone" });
        },
      }),
    });

    const result = await tool.invoke({ watchId: "trg_gone" }, CTX);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unexpected kind");
    expect(result.code).toBe("not_found");
  });

  it("rejects a missing watchId", async () => {
    const tool = createWatchProbeTool({ port: fakePort({}) });
    const result = await tool.invoke({}, CTX);
    expect(result.kind).toBe("error");
  });
});
