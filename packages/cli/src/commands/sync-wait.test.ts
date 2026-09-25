// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  applyObservations,
  initWaitStates,
  allResolved,
  markTimedOut,
  isOverallSuccess,
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
