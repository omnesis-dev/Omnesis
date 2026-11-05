// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  applyObservations,
  initWaitStates,
  allResolved,
  markTimedOut,
  isOverallSuccess,
  MAX_CONSECUTIVE_FETCH_FAILURES,
  waitForSyncCompletion,
  type SyncStatusObservation,
} from "./sync-wait.js";

describe("applyObservations — race guard", () => {
  test("a stale terminal seen BEFORE syncing is not accepted (keeps waiting)", () => {
    const states = initWaitStates(["gmail:user@example.com"]);
    // Immediately after triggering, the source still reports its PRIOR result.
    applyObservations(states, [{ sourceId: "gmail:user@example.com", state: "synced" }]);
    const st = states.get("gmail:user@example.com")!;
    expect(st.observedSyncing).toBe(false);
    expect(st.outcome).toBeUndefined();
    expect(allResolved(states)).toBe(false);
  });

  test("a stale idle seen BEFORE syncing is not accepted", () => {
    const states = initWaitStates(["chrome:device-1"]);
    applyObservations(states, [{ sourceId: "chrome:device-1", state: "idle" }]);
    expect(states.get("chrome:device-1")!.outcome).toBeUndefined();
  });

  test("a stale error seen BEFORE syncing is not accepted (old failure)", () => {
    const states = initWaitStates(["chrome:device-1"]);
    applyObservations(states, [
      { sourceId: "chrome:device-1", state: "error", errorMessage: "old failure" },
    ]);
    expect(states.get("chrome:device-1")!.outcome).toBeUndefined();
  });

  test("terminal accepted only AFTER a syncing transition is observed", () => {
    const states = initWaitStates(["gmail:user@example.com"]);
    // 1) prior terminal — ignored
    applyObservations(states, [{ sourceId: "gmail:user@example.com", state: "synced" }]);
    expect(states.get("gmail:user@example.com")!.outcome).toBeUndefined();
    // 2) collector picks up the trigger
    applyObservations(states, [{ sourceId: "gmail:user@example.com", state: "syncing" }]);
    expect(states.get("gmail:user@example.com")!.observedSyncing).toBe(true);
    expect(states.get("gmail:user@example.com")!.outcome).toBeUndefined();
    // 3) the real cycle finishes
    applyObservations(states, [{ sourceId: "gmail:user@example.com", state: "synced" }]);
    expect(states.get("gmail:user@example.com")!.outcome).toBe("success");
    expect(allResolved(states)).toBe(true);
  });
});

describe("applyObservations — terminal classification", () => {
  function resolvedFrom(state: SyncStatusObservation["state"], errorMessage?: string) {
    const states = initWaitStates(["s:1"]);
    applyObservations(states, [{ sourceId: "s:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "s:1", state, errorMessage }]);
    return states.get("s:1")!;
  }

  test("synced → success", () => {
    expect(resolvedFrom("synced").outcome).toBe("success");
  });

  test("error → error (terminal, not success), carries message", () => {
    const st = resolvedFrom("error", "boom");
    expect(st.outcome).toBe("error");
    expect(st.message).toBe("boom");
  });

  test("needs-auth is terminal-not-success", () => {
    expect(resolvedFrom("needs-auth").outcome).toBe("needs-auth");
  });

  test("rate-limited is terminal-not-success", () => {
    expect(resolvedFrom("rate-limited").outcome).toBe("rate-limited");
  });

  test("paused mid-wait is terminal-not-success", () => {
    expect(resolvedFrom("paused").outcome).toBe("paused");
  });

  test("idle AFTER syncing is treated as still-settling (keeps waiting)", () => {
    const states = initWaitStates(["s:1"]);
    applyObservations(states, [{ sourceId: "s:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "s:1", state: "idle" }]);
    expect(states.get("s:1")!.outcome).toBeUndefined();
  });
});

describe("applyObservations — robustness", () => {
  test("a source missing from a poll keeps its current state", () => {
    const states = initWaitStates(["a:1", "b:2"]);
    applyObservations(states, [{ sourceId: "a:1", state: "syncing" }]);
    // b:2 absent this poll — must not crash or resolve.
    expect(states.get("b:2")!.outcome).toBeUndefined();
    expect(states.get("a:1")!.observedSyncing).toBe(true);
  });

  test("already-resolved sources are not re-evaluated", () => {
    const states = initWaitStates(["a:1"]);
    applyObservations(states, [{ sourceId: "a:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "a:1", state: "synced" }]);
    // A later spurious error must not flip a settled success.
    applyObservations(states, [{ sourceId: "a:1", state: "error", errorMessage: "late" }]);
    expect(states.get("a:1")!.outcome).toBe("success");
  });
});

describe("markTimedOut + isOverallSuccess", () => {
  test("unresolved sources become timeouts and break overall success", () => {
    const states = initWaitStates(["a:1", "b:2"]);
    applyObservations(states, [{ sourceId: "a:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "a:1", state: "synced" }]);
    // b:2 never started.
    const timedOut = markTimedOut(states);
    expect(timedOut).toEqual(["b:2"]);
    expect(states.get("b:2")!.outcome).toBe("timeout");
    expect(isOverallSuccess(states)).toBe(false);
  });

  test("all-success ⇒ overall success", () => {
    const states = initWaitStates(["a:1"]);
    applyObservations(states, [{ sourceId: "a:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "a:1", state: "synced" }]);
    expect(isOverallSuccess(states)).toBe(true);
  });
});

describe("waitForSyncCompletion — loop with injected clock/sleep/feed", () => {
  /** Build deps that replay a scripted sequence of status snapshots, advancing
   *  a fake clock on each sleep so the deadline logic is exercised. */
  function harness(
    feed: SyncStatusObservation[][],
    opts: { pollIntervalMs: number; startMs?: number },
  ) {
    let clock = opts.startMs ?? 0;
    let idx = 0;
    return {
      fetched: () => idx,
      deps: {
        fetchStatus: () => {
          const snap = feed[Math.min(idx, feed.length - 1)] ?? [];
          idx++;
          return Promise.resolve(snap);
        },
        now: () => clock,
        sleep: (ms: number) => {
          clock += ms;
          return Promise.resolve();
        },
      },
    };
  }

  test("resolves on a real sync cycle (stale → syncing → synced)", async () => {
    const { deps } = harness(
      [
        [{ sourceId: "s:1", state: "synced" }], // stale prior result
        [{ sourceId: "s:1", state: "syncing" }],
        [{ sourceId: "s:1", state: "synced" }],
      ],
      { pollIntervalMs: 1000 },
    );
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], timeoutMs: 60_000, pollIntervalMs: 1000 },
      deps,
    );
    expect(states.get("s:1")!.outcome).toBe("success");
    expect(isOverallSuccess(states)).toBe(true);
  });

  test.each([null, "2026-01-01T00:00:00.000Z"])(
    "accepts a newer completion before the first poll (baseline %s)",
    async (lastSyncAt) => {
      const { deps, fetched } = harness(
        [
          [
            {
              sourceId: "s:1",
              state: "synced",
              lastSyncAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        ],
        { pollIntervalMs: 1000 },
      );
      const states = await waitForSyncCompletion(
        {
          sourceIds: ["s:1"],
          baseline: [{ sourceId: "s:1", state: "syncing", lastSyncAt }],
          timeoutMs: 5000,
          pollIntervalMs: 1000,
        },
        deps,
      );
      expect(isOverallSuccess(states)).toBe(true);
      expect(fetched()).toBe(1);
      expect(states.get("s:1")?.observedSyncing).toBe(false);
    },
  );

  test("accepts a fast newly triggered cycle after a stale first poll", async () => {
    const initial = {
      sourceId: "s:1",
      state: "synced" as const,
      lastSyncAt: "2026-01-01T00:00:00.000Z",
    };
    const { deps, fetched } = harness(
      [[initial], [{ ...initial, lastSyncAt: "2026-01-01T00:00:01.000Z" }]],
      { pollIntervalMs: 1000 },
    );
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], baseline: [initial], timeoutMs: 5000, pollIntervalMs: 1000 },
      deps,
    );
    expect(isOverallSuccess(states)).toBe(true);
    expect(fetched()).toBe(2);
  });

  test.each([
    { initial: "2026-01-01T00:00:01.000Z", current: "2026-01-01T00:00:01.000Z" },
    { initial: "2026-01-01T00:00:01.000Z", current: "2026-01-01T00:00:00.000Z" },
    { initial: "invalid", current: "2026-01-01T00:00:01.000Z" },
    { initial: null, current: "invalid" },
    { initial: undefined, current: "2026-01-01T00:00:01.000Z" },
    { initial: "2026-01-01T00:00:00.000Z", current: null },
    { initial: "2026-01-01T00:00:00.000Z", current: undefined },
  ])(
    "rejects unchanged, older, or unavailable completion evidence ($initial → $current)",
    async ({ initial, current }) => {
      const { deps } = harness([[{ sourceId: "s:1", state: "synced", lastSyncAt: current }]], {
        pollIntervalMs: 1000,
      });
      const states = await waitForSyncCompletion(
        {
          sourceIds: ["s:1"],
          baseline: [{ sourceId: "s:1", state: "synced", lastSyncAt: initial }],
          timeoutMs: 5000,
          pollIntervalMs: 1000,
        },
        deps,
      );
      expect(states.get("s:1")?.outcome).toBe("timeout");
    },
  );

  test("completion evidence belongs only to its source", () => {
    const states = initWaitStates(
      ["a:1", "b:2"],
      [{ sourceId: "a:1", state: "synced", lastSyncAt: null }],
    );
    applyObservations(
      states,
      ["a:1", "b:2"].map((sourceId) => ({
        sourceId,
        state: "synced",
        lastSyncAt: "2026-01-01T00:00:01.000Z",
      })),
    );
    expect(states.get("a:1")?.outcome).toBe("success");
    expect(states.get("b:2")?.outcome).toBeUndefined();
  });

  test.each(["error", "needs-auth", "rate-limited", "paused", "idle", "syncing"] as const)(
    "a newer timestamp does not turn %s into success",
    (state) => {
      const states = initWaitStates(
        ["s:1"],
        [{ sourceId: "s:1", state: "synced", lastSyncAt: null }],
      );
      applyObservations(states, [
        { sourceId: "s:1", state, lastSyncAt: "2026-01-01T00:00:01.000Z" },
      ]);
      expect(states.get("s:1")?.outcome).toBeUndefined();
    },
  );

  /** A refused connect, as Node's fetch reports one. */
  const refused = () =>
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
  const isTransient = (err: unknown) => err instanceof TypeError;

  test("a poll that cannot connect is polled again, and the sync it waits on still lands", async () => {
    const { deps } = harness(
      [[{ sourceId: "s:1", state: "syncing" }], [{ sourceId: "s:1", state: "synced" }]],
      { pollIntervalMs: 1000 },
    );
    let polls = 0;
    const fetchStatus = () => (++polls === 2 ? Promise.reject(refused()) : deps.fetchStatus());
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], timeoutMs: 60_000, pollIntervalMs: 1000 },
      { ...deps, fetchStatus, isTransient },
    );
    expect(states.get("s:1")!.outcome).toBe("success");
    expect(polls).toBe(3);
  });

  test("a gateway unreachable for several polls in a row ends the wait with that error", async () => {
    const { deps } = harness([[{ sourceId: "s:1", state: "syncing" }]], { pollIntervalMs: 1000 });
    let polls = 0;
    const fetchStatus = () => {
      polls++;
      return Promise.reject(refused());
    };
    await expect(
      waitForSyncCompletion(
        { sourceIds: ["s:1"], timeoutMs: 60_000, pollIntervalMs: 1000 },
        { ...deps, fetchStatus, isTransient },
      ),
    ).rejects.toThrow("fetch failed");
    expect(polls).toBe(MAX_CONSECUTIVE_FETCH_FAILURES);
  });

  test("a failure that is not a connection fault ends the wait at once", async () => {
    const { deps } = harness([[{ sourceId: "s:1", state: "syncing" }]], { pollIntervalMs: 1000 });
    let polls = 0;
    const fetchStatus = () => {
      polls++;
      return Promise.reject(new Error("HTTP 500"));
    };
    await expect(
      waitForSyncCompletion(
        { sourceIds: ["s:1"], timeoutMs: 60_000, pollIntervalMs: 1000 },
        { ...deps, fetchStatus, isTransient },
      ),
    ).rejects.toThrow("HTTP 500");
    expect(polls).toBe(1);
  });

  test("times out when a source never starts syncing (race guard holds)", async () => {
    // The feed only ever shows the stale terminal — never `syncing`. Without
    // the race guard this would false-PASS on poll 1.
    const { deps } = harness([[{ sourceId: "s:1", state: "synced" }]], { pollIntervalMs: 1000 });
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], timeoutMs: 5_000, pollIntervalMs: 1000 },
      deps,
    );
    expect(states.get("s:1")!.outcome).toBe("timeout");
    expect(states.get("s:1")!.observedSyncing).toBe(false);
    expect(isOverallSuccess(states)).toBe(false);
  });

  test("a needs-auth terminal ends the wait as not-success", async () => {
    const { deps } = harness(
      [
        [{ sourceId: "s:1", state: "syncing" }],
        [{ sourceId: "s:1", state: "needs-auth", errorMessage: "token revoked" }],
      ],
      { pollIntervalMs: 1000 },
    );
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], timeoutMs: 60_000, pollIntervalMs: 1000 },
      deps,
    );
    expect(states.get("s:1")!.outcome).toBe("needs-auth");
    expect(isOverallSuccess(states)).toBe(false);
  });

  test("waits for ALL sources before resolving", async () => {
    const { deps } = harness(
      [
        [
          { sourceId: "a:1", state: "syncing" },
          { sourceId: "b:2", state: "syncing" },
        ],
        [
          { sourceId: "a:1", state: "synced" },
          { sourceId: "b:2", state: "syncing" },
        ],
        [
          { sourceId: "a:1", state: "synced" },
          { sourceId: "b:2", state: "synced" },
        ],
      ],
      { pollIntervalMs: 1000 },
    );
    const states = await waitForSyncCompletion(
      { sourceIds: ["a:1", "b:2"], timeoutMs: 60_000, pollIntervalMs: 1000 },
      deps,
    );
    expect(states.get("a:1")!.outcome).toBe("success");
    expect(states.get("b:2")!.outcome).toBe("success");
  });
});

// `deriveDisplayStatus` returns its advisory overlays INSTEAD of `synced`, so a
// wait that recognised only `synced` would spin to its timeout on a source that
// synced perfectly well. Both overlays must resolve as success.
describe("applyObservations — advisory states resolve as success", () => {
  function resolvedAfterSyncing(state: SyncStatusObservation["state"]) {
    const states = initWaitStates(["s:1"]);
    applyObservations(states, [{ sourceId: "s:1", state: "syncing" }]);
    applyObservations(states, [{ sourceId: "s:1", state }]);
    return states.get("s:1")!;
  }

  test("a source whose local feed went stale still counts as a successful sync", () => {
    expect(resolvedAfterSyncing("stale").outcome).toBe("success");
  });

  test("a source with a lapsing credential still counts as a successful sync", () => {
    expect(resolvedAfterSyncing("auth-expiring").outcome).toBe("success");
  });

  test("an overall wait succeeds when every source ended on an advisory state", () => {
    const states = initWaitStates(["s:1", "s:2"]);
    applyObservations(states, [
      { sourceId: "s:1", state: "syncing" },
      { sourceId: "s:2", state: "syncing" },
    ]);
    applyObservations(states, [
      { sourceId: "s:1", state: "stale" },
      { sourceId: "s:2", state: "auth-expiring" },
    ]);
    expect(allResolved(states)).toBe(true);
    expect(isOverallSuccess(states)).toBe(true);
  });
});

describe("applyObservations — mobile permission overlays are terminal but not successful", () => {
  test.each(["permission-degraded", "background-access-missing", "unavailable"] as const)(
    "classifies %s without waiting to timeout",
    (state) => {
      const states = initWaitStates(["s:1"]);
      applyObservations(states, [{ sourceId: "s:1", state: "syncing" }]);
      applyObservations(states, [{ sourceId: "s:1", state }]);
      expect(states.get("s:1")?.outcome).toBe(state);
      expect(allResolved(states)).toBe(true);
      expect(isOverallSuccess(states)).toBe(false);
    },
  );
});

describe("applyObservations — a run that finished between polls", () => {
  const T0 = "2026-03-14T09:00:00.000Z";
  const T1 = "2026-03-14T09:00:04.250Z";
  const baseline = (over: Partial<SyncStatusObservation> = {}): SyncStatusObservation[] => [
    { sourceId: "s:1", state: "synced", lastSyncAt: T0, ...over },
  ];

  test("a later lastSyncAt resolves success though no poll saw syncing", () => {
    // The collector was already syncing when the trigger came (it skipped it),
    // and that run finished before the first poll.
    const st = initWaitStates(["s:1"], baseline());
    applyObservations(st, [{ sourceId: "s:1", state: "synced", lastSyncAt: T1 }]);
    expect(st.get("s:1")!.outcome).toBe("success");
    expect(st.get("s:1")!.observedSyncing).toBe(false);
  });

  test("the baseline's own lastSyncAt is still the prior result", () => {
    const st = initWaitStates(["s:1"], baseline());
    applyObservations(st, [{ sourceId: "s:1", state: "synced", lastSyncAt: T0 }]);
    expect(st.get("s:1")!.outcome).toBeUndefined();
  });

  test("a source that had never synced resolves on its first lastSyncAt", () => {
    const st = initWaitStates(["s:1"], baseline({ state: "idle", lastSyncAt: null }));
    applyObservations(st, [{ sourceId: "s:1", state: "synced", lastSyncAt: T1 }]);
    expect(st.get("s:1")!.outcome).toBe("success");
  });

  test("a new erroredAt resolves the failure; the baseline's old error does not", () => {
    const old = initWaitStates(["s:1"], baseline({ state: "error", erroredAt: T0 }));
    applyObservations(old, [{ sourceId: "s:1", state: "error", erroredAt: T0 }]);
    expect(old.get("s:1")!.outcome).toBeUndefined();

    const fresh = initWaitStates(["s:1"], baseline({ state: "error", erroredAt: T0 }));
    applyObservations(fresh, [
      { sourceId: "s:1", state: "error", erroredAt: T1, errorMessage: "provider said no" },
    ]);
    expect(fresh.get("s:1")!.outcome).toBe("error");
    expect(fresh.get("s:1")!.message).toBe("provider said no");
  });

  test.each([
    { before: T0, after: "invalid" },
    { before: "invalid", after: T1 },
    { before: undefined, after: "invalid" },
  ])(
    "invalid error timestamps do not prove a new failure ($before → $after)",
    ({ before, after }) => {
      const states = initWaitStates(["s:1"], baseline({ state: "error", erroredAt: before }));
      applyObservations(states, [{ sourceId: "s:1", state: "error", erroredAt: after }]);
      expect(states.get("s:1")?.outcome).toBeUndefined();
    },
  );

  test("without a baseline only an observed syncing arms the guard", () => {
    const st = initWaitStates(["s:1"]);
    applyObservations(st, [{ sourceId: "s:1", state: "synced", lastSyncAt: T1 }]);
    expect(st.get("s:1")!.outcome).toBeUndefined();
  });

  test("the loop ends at once on a run that finished before its first poll", async () => {
    let polls = 0;
    const states = await waitForSyncCompletion(
      { sourceIds: ["s:1"], timeoutMs: 300_000, pollIntervalMs: 1000, baseline: baseline() },
      {
        fetchStatus: () => {
          polls++;
          return Promise.resolve([{ sourceId: "s:1", state: "synced", lastSyncAt: T1 }]);
        },
        now: () => 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(states.get("s:1")!.outcome).toBe("success");
    expect(polls).toBe(1);
  });
});
