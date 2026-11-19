// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { partnerState, waitForPartner, waitForPartners } from "./partner.mjs";

const job = (name, status, conclusion = null) => ({ name, status, conclusion });
const PARTNER = "T1 tailnet collector";

/** A fake clock and a job listing that changes over time. */
function scripted(steps) {
  let t = 0;
  let i = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    list: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

describe("partnerState", () => {
  it("finds the partner by name prefix among the run's jobs", () => {
    const jobs = [
      job("T1 tailnet gateway (ubuntu-24.04)", "in_progress"),
      job("T1 tailnet collector (macos-15)", "queued"),
      job("T2 tailnet collector (macos-26)", "in_progress"),
    ];
    expect(partnerState(jobs, PARTNER)).toMatchObject({
      state: "waiting",
      job: { name: "T1 tailnet collector (macos-15)" },
    });
    expect(partnerState(jobs, "T2 tailnet collector")).toMatchObject({ state: "running" });
    expect(partnerState(jobs, "T3")).toEqual({ state: "absent" });
  });

  it("treats every pre-runner status as waiting and completed as ended", () => {
    for (const status of ["queued", "waiting", "pending", "requested"]) {
      expect(partnerState([job("T1 tailnet collector (x)", status)], PARTNER).state).toBe(
        "waiting",
      );
    }
    expect(
      partnerState([job("T1 tailnet collector (x)", "completed", "cancelled")], PARTNER).state,
    ).toBe("ended");
  });
});

describe("waitForPartner", () => {
  it("waits through a long queue until the partner runs", async () => {
    const queued = [job("T1 tailnet collector (macos-15)", "queued")];
    const clock = scripted([
      queued,
      queued,
      queued,
      [job("T1 tailnet collector (macos-15)", "in_progress")],
    ]);
    const lines = [];
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 4 * 3600_000,
      intervalMs: 3600_000,
      log: (l) => lines.push(l),
    });
    expect(result.state).toBe("running");
    expect(clock.now()).toBe(3 * 3600_000);
    // One line per change, not per poll.
    expect(lines).toEqual(['partner "T1 tailnet collector": waiting (queued)']);
  });

  it("returns at once when the partner already ended", async () => {
    const clock = scripted([[job("T1 tailnet collector (macos-15)", "completed", "failure")]]);
    const result = await waitForPartner(PARTNER, { ...clock, timeoutMs: 3600_000 });
    expect(result).toMatchObject({ state: "ended", job: { conclusion: "failure" } });
    expect(clock.now()).toBe(0);
  });

  it("gives up at the deadline with the partner still queued", async () => {
    const clock = scripted([[job("T1 tailnet collector (macos-15)", "queued")]]);
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 90_000,
      intervalMs: 30_000,
    });
    expect(result).toMatchObject({ state: "waiting", timedOut: true });
    expect(clock.now()).toBe(90_000);
  });

  it("retries a failed read of the API instead of judging the partner by it", async () => {
    const clock = scripted([
      new Error("HTTP 502"),
      [job("T1 tailnet collector (macos-15)", "in_progress")],
    ]);
    const lines = [];
    const result = await waitForPartner(PARTNER, {
      ...clock,
      timeoutMs: 3600_000,
      log: (l) => lines.push(l),
    });
    expect(result.state).toBe("running");
    expect(lines[0]).toMatch(/unknown — HTTP 502/);
  });
});

describe("waitForPartners", () => {
  const COLLECTORS = ["T1 tailnet collector", "T2 tailnet collector", "T3 tailnet collector"];
  const t1 = (status, conclusion) => job("T1 tailnet collector (macos-15)", status, conclusion);
  const t2 = (status, conclusion) => job("T2 tailnet collector (macos-26)", status, conclusion);
  const t3 = (status, conclusion) => job("T3 tailnet collector (macos-15)", status, conclusion);

  it("waits until every partner has had a runner, running or already over", async () => {
    const clock = scripted([
      [],
      [t1("queued"), t2("in_progress"), t3("queued")],
      [t1("queued"), t2("completed", "success"), t3("in_progress")],
      [t1("in_progress"), t2("completed", "success"), t3("in_progress")],
    ]);
    const lines = [];
    const result = await waitForPartners(COLLECTORS, {
      ...clock,
      timeoutMs: 4 * 3600_000,
      intervalMs: 60_000,
      log: (l) => lines.push(l),
    });
    expect(result.timedOut).toBe(false);
    expect(result.partners.map((p) => p.state)).toEqual(["running", "ended", "running"]);
    expect(clock.now()).toBe(3 * 60_000);
    // Jobs not listed yet are waited for, not taken as gone.
    expect(lines.slice(0, 3)).toEqual(COLLECTORS.map((p) => `partner "${p}": absent`));
  });

  it("gives up at the deadline, naming the partner that never got a runner", async () => {
    const clock = scripted([[t1("queued"), t2("in_progress"), t3("in_progress")]]);
    const result = await waitForPartners(COLLECTORS, {
      ...clock,
      timeoutMs: 4 * 3600_000,
      intervalMs: 60_000,
    });
    expect(result.timedOut).toBe(true);
    expect(clock.now()).toBe(4 * 3600_000);
    expect(result.partners.filter((p) => p.state === "waiting").map((p) => p.prefix)).toEqual([
      "T1 tailnet collector",
    ]);
  });

  it("retries a failed read of the API for every partner", async () => {
    const clock = scripted([
      new Error("HTTP 502"),
      [t1("in_progress"), t2("in_progress"), t3("completed", "cancelled")],
    ]);
    const lines = [];
    const result = await waitForPartners(COLLECTORS, {
      ...clock,
      timeoutMs: 3600_000,
      log: (l) => lines.push(l),
    });
    expect(result.timedOut).toBe(false);
    expect(lines.filter((l) => l.includes("unknown — HTTP 502"))).toHaveLength(3);
  });
});

// The scheduled run's tailnet collectors queue a minute behind its other Mac
// jobs, and hosted macOS runners go out roughly in queue order. These pin the
// ordering that keeps the paired jobs ahead of the unpaired ones.
describe("install-e2e Mac job ordering", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/install-e2e.yml", import.meta.url), "utf8"),
  );
  const seat = workflow.jobs["tailnet-seated"];
  /** A job's `if`, evaluated as the Actions expression it is. */
  const selected = (id, { event, lanes, cancelled = false }) => {
    const condition = String(workflow.jobs[id].if).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    return runInNewContext(condition, {
      github: { event_name: event },
      inputs: { lanes },
      cancelled: () => cancelled,
    });
  };
  // Every job that asks for a macOS runner, apart from the collectors
  // themselves and the Intel diagnosis, which only a dispatch of its own lane
  // runs, so it never shares a run with the tailnet lanes.
  const unpairedMac = Object.entries(workflow.jobs)
    .filter(([id, job]) => {
      if (id === "tailnet-collector" || id === "vector-compat") return false;
      return (
        JSON.stringify(job).includes("macos") || String(job.uses).includes("installer-coverage")
      );
    })
    .map(([id]) => id);

  it("waits for every collector of the paired matrix, without the tailnet credential", () => {
    expect(seat.needs).toBe("tailnet-fixture");
    expect(seat.environment).toBeUndefined();
    expect(seat.permissions).toEqual({ actions: "read", contents: "read" });
    const step = seat.steps.find((s) => String(s.run ?? "").includes("partner.mjs seated"));
    const lanes = workflow.jobs["tailnet-collector"].strategy.matrix.include.map((r) => r.lane);
    expect(step.env.PARTNERS.split(",")).toEqual(lanes.map((l) => `${l} tailnet collector`));
    // As long as the gateways wait for their partners, no longer.
    const gatewayWait = workflow.jobs["tailnet-gateway"].steps.find((s) =>
      String(s.run ?? "").includes("partner.mjs wait"),
    ).run;
    const timeout = (run) => Number(/--timeout (\d+)/.exec(run)?.[1]);
    expect(timeout(step.run)).toBe(timeout(gatewayWait));
  });

  it("holds every other Mac job of the run behind it", () => {
    expect(unpairedMac.sort()).toEqual(
      [
        "collector-service-node",
        "docker-host-mac",
        "installer-coverage",
        "lockfile-upgrade",
        "single-host",
        "uninstall",
      ].sort(),
    );
    for (const id of unpairedMac) expect(workflow.jobs[id].needs, id).toBe("tailnet-seated");
  });

  it("still runs those jobs when the seat job is skipped or fails, but not when cancelled", () => {
    // `needs` alone would skip them whenever the tailnet chain is skipped, as
    // on every pull request and push; !cancelled() keeps them independent of it.
    for (const id of unpairedMac) {
      expect(workflow.jobs[id].if, id).toMatch(/^\$\{\{ !cancelled\(\) && \(.*\) \}\}$/);
      expect(selected(id, { event: "schedule" }), id).toBe(true);
      expect(selected(id, { event: "schedule", cancelled: true }), id).toBe(false);
    }
    for (const id of ["single-host", "uninstall", "lockfile-upgrade"]) {
      expect(selected(id, { event: "pull_request" }), id).toBe(true);
      expect(selected(id, { event: "push" }), id).toBe(true);
      expect(selected(id, { event: "workflow_dispatch", lanes: "single-host" }), id).toBe(true);
      expect(selected(id, { event: "workflow_dispatch", lanes: "tailnet" }), id).toBe(false);
    }
    expect(selected("docker-host-mac", { event: "workflow_dispatch", lanes: "docker" })).toBe(true);
    expect(selected("docker-host-mac", { event: "pull_request" })).toBe(false);
    expect(selected("collector-service-node", { event: "pull_request" })).toBe(false);
  });
});
