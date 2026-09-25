// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ordering guarantee of `omnesis update --fleet`, asserted where it is
 * decided. Every effect is injected, so what these tests watch is the exact
 * sequence a real run performs.
 */

import { describe, expect, test } from "vitest";
import {
  FleetUpdateRefused,
  fleetUpdateSucceeded,
  RECONNECT_POLL_MS,
  RECONNECT_WAIT_MS,
  RESTART_GRACE_MS,
  RESULT_WAIT_MS,
  runFleetUpdate,
  type FleetUpdateDeps,
} from "./fleet.js";
import type { FleetUpdateEntry } from "@omnesis/core";

interface Harness {
  deps: FleetUpdateDeps;
  calls: string[];
  lines: string[];
  commanded: string[][];
  /** Milliseconds the fake clock advanced through `sleep`. */
  elapsed(): number;
}

function harness(
  overrides: Partial<FleetUpdateDeps>,
  opts: {
    served?: string;
    /** What the gateway serves before the host update; defaults to `served`. */
    servedBefore?: string;
    landed?: string | null;
    devices?: FleetUpdateEntry[];
    /**
     * The devices each plan read returns, in order; the last one repeats.
     * The first entry is the read taken before the host update.
     */
    plans?: FleetUpdateEntry[][];
    approve?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const commanded: string[][] = [];
  const served = opts.served ?? "0.5.0";
  const servedBefore = opts.servedBefore ?? served;
  const plans = opts.plans ?? [opts.devices ?? []];
  let planReads = 0;
  let clock = 0;
  const deps: FleetUpdateDeps = {
    updateHost: async () => {
      calls.push("updateHost");
    },
    servedVersion: async () => {
      calls.push("servedVersion");
      return calls.includes("updateHost") ? served : servedBefore;
    },
    hostVersion: () => (opts.landed === undefined ? served : opts.landed),
    plan: async () => {
      calls.push("plan");
      const devices = plans[Math.min(planReads, plans.length - 1)] ?? [];
      planReads += 1;
      return { targetVersion: served, devices };
    },
    command: async (ids) => {
      calls.push("command");
      commanded.push(ids);
      // Answered as already settled, so these tests stop at the fan-out;
      // the results wait has tests of its own below.
      return ids.map((id) => ({ id, name: id, state: "current" }));
    },
    approve: async () => opts.approve !== false,
    log: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => {
      calls.push("sleep");
      clock += ms;
    },
    ...overrides,
  };
  return { deps, calls, lines, commanded, elapsed: () => clock };
}

const behindCollector: FleetUpdateEntry = {
  id: "dev-1",
  name: "workstation",
  kind: "collector",
  version: "0.4.0",
  online: true,
  disposition: { kind: "update" },
  desiredVersion: null,
  updateState: null,
  updateDetail: null,
};

const behindAgent: FleetUpdateEntry = {
  ...behindCollector,
  id: "dev-2",
  name: "studio-harness",
  kind: "agent",
};

const offline = (device: FleetUpdateEntry): FleetUpdateEntry => ({ ...device, online: false });

describe("runFleetUpdate", () => {
  test("an exact-commit fleet update requires the restarted gateway to attest the commit", async () => {
    const commit = "a".repeat(40);
    const h = harness(
      {
        hostCommit: () => commit,
        plan: async () => ({
          targetVersion: "0.5.0",
          targetCommit: commit,
          devices: [behindCollector],
        }),
      },
      { devices: [behindCollector] },
    );

    await runFleetUpdate(h.deps);

    expect(h.commanded).toEqual([["dev-1"]]);
    expect(h.lines.join("\n")).toContain("commit aaaaaaaaaaaa");
  });

  test("an exact-commit fleet update refuses a plan for another checkout", async () => {
    const commit = "a".repeat(40);
    const h = harness(
      {
        hostCommit: () => commit,
        plan: async () => ({
          targetVersion: "0.5.0",
          targetCommit: "b".repeat(40),
          devices: [behindCollector],
        }),
      },
      { devices: [behindCollector] },
    );

    await expect(runFleetUpdate(h.deps)).rejects.toBeInstanceOf(FleetUpdateRefused);
    expect(h.commanded).toEqual([]);
  });

  test("the host updates and the gateway proves itself healthy before any device is commanded", async () => {
    const h = harness({}, { devices: [behindCollector] });
    await runFleetUpdate(h.deps);
    expect(h.calls).toEqual([
      "servedVersion",
      "plan",
      "updateHost",
      "servedVersion",
      "plan",
      "command",
    ]);
    expect(h.commanded).toEqual([["dev-1"]]);
  });

  test("a host update that throws stops before anything is asked of a device", async () => {
    const h = harness(
      {
        updateHost: async () => {
          throw new Error("build failed");
        },
      },
      { devices: [behindCollector] },
    );
    await expect(runFleetUpdate(h.deps)).rejects.toThrow("build failed");
    // Only the pre-update snapshot read the gateway; nothing after the throw did.
    expect(h.calls).toEqual(["servedVersion", "plan"]);
  });

  test("a gateway still serving the previous build refuses the fan-out", async () => {
    // The updater could not restart the gateway — no service manager, a
    // hardened unit, a daemon started by hand — so new code sits on disk
    // while the old build answers. Commanding devices from here would send
    // them past the gateway that serves them.
    const h = harness({}, { served: "0.4.0", landed: "0.5.0", devices: [behindCollector] });
    await expect(runFleetUpdate(h.deps)).rejects.toBeInstanceOf(FleetUpdateRefused);
    expect(h.calls).toEqual(["servedVersion", "plan", "updateHost", "servedVersion"]);
  });

  test("a gateway planning a target it does not serve refuses too", async () => {
    const h = harness(
      {
        plan: async () => ({ targetVersion: "0.6.0", devices: [behindCollector] }),
      },
      { served: "0.5.0", landed: "0.5.0" },
    );
    await expect(runFleetUpdate(h.deps)).rejects.toBeInstanceOf(FleetUpdateRefused);
    expect(h.commanded).toEqual([]);
  });

  test("`--edge` leaves the served-version check to the gateway's own target", async () => {
    // A branch build has no release number to compare, so the check is
    // skipped rather than failed — the gateway's target still has to match
    // what it serves.
    const h = harness({}, { landed: null, served: "0.5.0", devices: [behindCollector] });
    await runFleetUpdate(h.deps);
    expect(h.commanded).toEqual([["dev-1"]]);
  });

  test("each target is confirmed on its own, and a decline commands nothing", async () => {
    const h = harness({}, { devices: [behindCollector], approve: false });
    await runFleetUpdate(h.deps);
    expect(h.calls).not.toContain("command");
    expect(h.lines.join("\n")).toContain("Skipped workstation");
  });

  test("a device the gateway will not command is named, not silently dropped", async () => {
    const h = harness(
      {},
      {
        devices: [
          {
            ...behindCollector,
            id: "phone",
            name: "pocket",
            kind: "ios",
            disposition: {
              kind: "refused",
              code: "store-managed",
              reason: "Update the app on the device.",
            },
          },
        ],
      },
    );
    await runFleetUpdate(h.deps);
    expect(h.lines.join("\n")).toContain("pocket (ios): not commanded — Update the app");
    expect(h.commanded).toEqual([]);
  });

  test("an offline device is shown as one that takes the command on reconnect", async () => {
    const h = harness({}, { devices: [offline(behindCollector)] });
    await runFleetUpdate(h.deps);
    expect(h.lines.join("\n")).toContain("offline, sent on reconnect");
    expect(h.commanded).toEqual([["dev-1"]]);
  });

  test("a fleet with nothing behind says so and asks nothing", async () => {
    const h = harness(
      {},
      {
        devices: [{ ...behindCollector, version: "0.5.0", disposition: { kind: "current" } }],
      },
    );
    await runFleetUpdate(h.deps);
    expect(h.lines.join("\n")).toContain("No device needs updating.");
    expect(h.commanded).toEqual([]);
  });
});

describe("runFleetUpdate after a gateway restart", () => {
  test("devices connected before the restart are waited for, so none is reported offline", async () => {
    const h = harness(
      {},
      {
        servedBefore: "0.4.0",
        served: "0.5.0",
        plans: [
          [behindCollector, behindAgent],
          [offline(behindCollector), offline(behindAgent)],
          [behindCollector, offline(behindAgent)],
          [behindCollector, behindAgent],
        ],
      },
    );
    await runFleetUpdate(h.deps);
    const output = h.lines.join("\n");
    expect(h.lines[0]).toBe("Waiting for 2 devices to reconnect after the gateway restart…");
    expect(output).not.toContain("offline");
    expect(output).not.toContain("Not reconnected");
    expect(h.elapsed()).toBe(2 * RECONNECT_POLL_MS);
    expect(h.commanded).toEqual([["dev-1", "dev-2"]]);
  });

  test("the wait is bounded, and a device that never returns is named and planned as offline", async () => {
    const h = harness(
      {},
      {
        servedBefore: "0.4.0",
        served: "0.5.0",
        plans: [
          [behindCollector, behindAgent],
          [offline(behindCollector), offline(behindAgent)],
          [behindCollector, offline(behindAgent)],
        ],
      },
    );
    await runFleetUpdate(h.deps);
    expect(h.elapsed()).toBe(RECONNECT_WAIT_MS);
    expect(h.lines).toContain("Not reconnected after 90s: studio-harness.");
    expect(h.lines).toContain("  workstation (collector): 0.4.0 → 0.5.0");
    expect(h.lines).toContain(
      "  studio-harness (agent): 0.4.0 → 0.5.0 — offline, sent on reconnect",
    );
    expect(h.commanded).toEqual([["dev-1", "dev-2"]]);
  });

  test("a plan read that fails mid-wait is retried rather than ending the wait", async () => {
    let reads = 0;
    const h = harness(
      {
        plan: async () => {
          reads += 1;
          if (reads === 2) throw new Error("gateway still warming up");
          const devices = reads === 1 || reads >= 3 ? [behindCollector] : [];
          return { targetVersion: "0.5.0", devices };
        },
      },
      { servedBefore: "0.4.0", served: "0.5.0" },
    );
    await runFleetUpdate(h.deps);
    expect(h.elapsed()).toBe(RECONNECT_POLL_MS);
    expect(h.lines.join("\n")).not.toContain("offline");
  });

  test("with no daemon connected before the update there is nothing to wait for", async () => {
    const phone: FleetUpdateEntry = {
      ...behindCollector,
      id: "phone",
      name: "pocket",
      kind: "android",
      disposition: { kind: "refused", code: "store-managed", reason: "Update the app." },
    };
    const h = harness(
      {},
      {
        servedBefore: "0.4.0",
        served: "0.5.0",
        plans: [[offline(behindCollector), phone], [offline(behindCollector)]],
      },
    );
    await runFleetUpdate(h.deps);
    expect(h.calls).not.toContain("sleep");
    expect(h.lines.join("\n")).not.toContain("Waiting for");
    expect(h.lines.join("\n")).toContain("offline, sent on reconnect");
  });

  test("a gateway that did not restart is not waited for", async () => {
    // The host was already on the served build, so no connection dropped;
    // a device offline now was offline before the command ran.
    const h = harness(
      {},
      { served: "0.5.0", plans: [[behindCollector], [offline(behindCollector)]] },
    );
    await runFleetUpdate(h.deps);
    expect(h.calls).not.toContain("sleep");
    expect(h.lines.join("\n")).not.toContain("Waiting for");
    expect(h.lines.join("\n")).toContain("offline, sent on reconnect");
  });

  test("a pre-update snapshot that fails lets the run proceed without waiting", async () => {
    // A gateway too old to serve the plan, or not answering before the host
    // update, gives nothing to compare against.
    let reads = 0;
    const h = harness(
      {
        plan: async () => {
          reads += 1;
          if (reads === 1) throw new Error("Gateway 404 /admin/fleet/update");
          return { targetVersion: "0.5.0", devices: [offline(behindCollector)] };
        },
      },
      { servedBefore: "0.4.0", served: "0.5.0" },
    );
    await runFleetUpdate(h.deps);
    expect(h.calls).not.toContain("sleep");
    expect(h.lines.join("\n")).not.toContain("Waiting for");
    expect(h.commanded).toEqual([["dev-1"]]);
  });
});

describe("runFleetUpdate after an exact-commit update", () => {
  test("waits for reconnects although the served version is unchanged", async () => {
    const commit = "c".repeat(40);
    let reads = 0;
    const h = harness(
      {
        hostCommit: () => commit,
        plan: async () => {
          reads += 1;
          // Before the update, then right after the restart, then reconnected.
          const devices = reads === 2 ? [offline(behindCollector)] : [behindCollector];
          return { targetVersion: "0.5.0", targetCommit: commit, devices };
        },
      },
      { servedBefore: "0.5.0", served: "0.5.0" },
    );
    await runFleetUpdate(h.deps);
    expect(h.lines.join("\n")).toContain("Waiting for 1 device to reconnect");
    expect(h.lines.join("\n")).not.toContain("offline");
    expect(h.commanded).toEqual([["dev-1"]]);
  });
});

describe("runFleetUpdate snapshot before an exact-commit update", () => {
  test("reads the connected devices from the release plan, which the old gateway serves", async () => {
    const commit = "d".repeat(40);
    let updated = false;
    let commitReads = 0;
    const h = harness(
      {
        hostCommit: () => commit,
        updateHost: async () => {
          updated = true;
        },
        // The gateway refuses to plan a commit it is not running yet.
        plan: async () => {
          if (!updated) throw new Error("the gateway is not running that commit");
          commitReads += 1;
          const devices = commitReads === 1 ? [offline(behindCollector)] : [behindCollector];
          return { targetVersion: "0.5.0", targetCommit: commit, devices };
        },
        connectedPlan: async () => ({ targetVersion: "0.5.0", devices: [behindCollector] }),
      },
      { servedBefore: "0.5.0", served: "0.5.0" },
    );
    await runFleetUpdate(h.deps);
    expect(h.lines.join("\n")).toContain("Waiting for 1 device to reconnect");
    expect(h.lines.join("\n")).not.toContain("offline");
    expect(h.commanded).toEqual([["dev-1"]]);
  });
});

describe("runFleetUpdate results", () => {
  const dispatchAll: Partial<FleetUpdateDeps> = {
    command: async (ids) => ids.map((id) => ({ id, name: id, state: "dispatched" })),
  };
  const settled = (
    device: FleetUpdateEntry,
    change: Partial<FleetUpdateEntry>,
  ): FleetUpdateEntry => ({ ...device, ...change });

  test("waits for every dispatched device and succeeds when each reaches the target", async () => {
    const h = harness(dispatchAll, {
      plans: [
        [behindCollector, behindAgent],
        [behindCollector, behindAgent],
        [settled(behindCollector, { updateState: "installed" }), behindAgent],
        [
          settled(behindCollector, { version: "0.5.0", disposition: { kind: "current" } }),
          settled(behindAgent, {
            updateState: "restart-pending",
            updateDetail: "Restart the harness.",
          }),
        ],
      ],
    });
    const summary = await runFleetUpdate(h.deps);
    expect(summary.updated).toEqual(["dev-1"]);
    expect(summary.restartPending).toEqual(["dev-2"]);
    expect(fleetUpdateSucceeded(summary)).toBe(true);
    expect(h.lines).toContain("  dev-1: updated");
    expect(h.lines).toContain("  dev-2: restart pending — Restart the harness.");
    // Settled only once the grace for a late restart ran out.
    expect(h.elapsed()).toBeGreaterThanOrEqual(RESTART_GRACE_MS);
  });

  test("a harness that reports a restart pending and then restarts anyway counts as updated", async () => {
    const pending = settled(behindAgent, {
      updateState: "restart-pending",
      updateDetail: "Plugin installed; restart owed: example-harness gateway restart",
    });
    const h = harness(dispatchAll, {
      plans: [
        [behindAgent],
        [behindAgent],
        [pending],
        [pending],
        [settled(behindAgent, { version: "0.5.0", disposition: { kind: "current" } })],
      ],
    });
    const summary = await runFleetUpdate(h.deps);
    expect(summary.updated).toEqual(["dev-2"]);
    expect(summary.restartPending).toEqual([]);
    expect(h.lines.join("\n")).not.toContain("restart pending");
  });

  test("a device that refuses on its own host is reported as failed with its reason", async () => {
    const refusal =
      "v0.5.0 is not a forward update from the last completed source build. Re-run with --allow-rewind only if moving back is intentional.";
    const h = harness(dispatchAll, {
      plans: [
        [behindCollector],
        [behindCollector],
        [settled(behindCollector, { updateState: "failed", updateDetail: refusal })],
      ],
    });
    const summary = await runFleetUpdate(h.deps);
    expect(summary.failed).toEqual([{ name: "dev-1", detail: refusal }]);
    expect(fleetUpdateSucceeded(summary)).toBe(false);
    expect(h.lines).toContain(`  dev-1: failed — ${refusal}`);
  });

  test("a device that never answers is named once the wait runs out, and fails the run", async () => {
    const h = harness(dispatchAll, { plans: [[behindCollector]] });
    const summary = await runFleetUpdate(h.deps);
    expect(summary.unanswered).toEqual(["dev-1"]);
    expect(fleetUpdateSucceeded(summary)).toBe(false);
    expect(h.elapsed()).toBe(RESULT_WAIT_MS);
    expect(h.lines).toContain("  dev-1: no result after 45 minutes");
  });

  test("an immediate refusal and an offline device need no wait", async () => {
    const h = harness(
      {
        command: async () => [
          { id: "dev-1", name: "dev-1", state: "failed", detail: "An update is already running." },
          { id: "dev-2", name: "dev-2", state: "pending", detail: "Offline." },
        ],
      },
      { plans: [[behindCollector, behindAgent]] },
    );
    const summary = await runFleetUpdate(h.deps);
    expect(summary.failed).toEqual([{ name: "dev-1", detail: "An update is already running." }]);
    expect(summary.pending).toEqual(["dev-2"]);
    expect(h.elapsed()).toBe(0);
  });
});
