// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { getActivePriority, runWithPriority } from "../priority.js";
import { createOwnershipRepairTask } from "./ownership-repair-task.js";
import type { OwnershipRepairTick } from "./table-manager.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { TaskContext } from "../scheduler/types.js";

const context = {} as TaskContext;

function tick(attributed: number, tables = attributed > 0 ? 1 : 0): OwnershipRepairTick {
  return { tables, attributed, pending: attributed > 0 ? 1 : 0, skipped: 0 };
}

function harness(ticks: (OwnershipRepairTick | Error)[]) {
  const seen: (string | null)[] = [];
  const repairPendingOwnership = vi.fn((): Promise<OwnershipRepairTick> => {
    seen.push(getActivePriority());
    const next = ticks.shift();
    if (next === undefined) return Promise.reject(new Error("no scripted tick left"));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  const log = createLogger("test");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const info = vi.spyOn(log, "info").mockImplementation(() => {});
  const scheduler = {
    snapshot: () => ({ perTask: [] }),
    getLastTickInfo: () => undefined,
  } as unknown as Scheduler;
  const bundle = createOwnershipRepairTask(
    { analyticsDb: { repairPendingOwnership }, log, activePeriodMs: 5, idlePeriodMs: 50 },
    scheduler,
  );
  return { ...bundle, repairPendingOwnership, warn, info, seen };
}

async function runOnce(h: ReturnType<typeof harness>) {
  const outcome = await h.task.run(undefined, context);
  if (outcome.kind !== "done") throw new Error("the repair never yields");
  return outcome.value;
}

describe("analytics ownership repair task", () => {
  test("stays on the active cadence while a pass labels rows, idles once none does", async () => {
    const h = harness([tick(1000), tick(200), tick(0)]);
    expect(h.task.periodMs).toBe(5);
    expect(h.task.idlePeriodMs).toBe(50);
    expect(await runOnce(h)).toEqual({ idle: false });
    expect(await runOnce(h)).toEqual({ idle: false });
    expect(await runOnce(h)).toEqual({ idle: true });
    expect(h.task.isIdle!({ idle: true })).toBe(true);
  });

  test("reports a drain once, when it completes, rather than once per batch", async () => {
    const h = harness([tick(1000), tick(200), tick(0), tick(0)]);
    for (let i = 0; i < 4; i += 1) await runOnce(h);
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining("1200 legacy analytics rows"));
  });

  test("a pending table nothing can attribute does not keep the repair busy", async () => {
    const h = harness([{ tables: 1, attributed: 0, pending: 1, skipped: 0 }]);
    expect(await runOnce(h)).toEqual({ idle: true });
    expect(h.info).not.toHaveBeenCalled();
    expect(h.job.observe()).toMatchObject({
      progress: { kind: "scan", itemsCheckedLastSweep: 1, itemsAffectedLastSweep: 0 },
    });
  });

  test("runs as background work even when kicked from a user request", async () => {
    const h = harness([tick(0)]);
    await runWithPriority("user", () => runOnce(h));
    expect(h.seen).toEqual(["background"]);
    expect(h.task.priority).toBe("background");
  });

  test("a failed pass is logged and retried on the active cadence", async () => {
    const h = harness([new Error("writer unavailable")]);
    expect(await runOnce(h)).toEqual({ idle: false });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("writer unavailable"));
  });

  test("registers as an infra job under the task's name", () => {
    const h = harness([]);
    expect(h.job.id).toBe("analytics.ownershipRepair");
    expect(h.job.category).toBe("infra");
  });
});
