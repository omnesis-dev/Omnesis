// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain JavaScript portal module.
import { summarizeMaintenance, batchStatusLabel } from "./knowledge-maintenance-model.js";

it("counts waiting inputs and assigned inputs separately from historical retries and completed work", () => {
  const waiting = { status: "pending", count: 1, nextDueAt: 400 };
  const assigned = { status: "batched", count: 2, nextDueAt: 100 };
  expect(summarizeMaintenance({
    work: [waiting, assigned, { status: "deferred", count: 2, nextDueAt: 50 }, { status: "completed", count: 29, nextDueAt: 1 }],
    cascades: { pending: 3 },
  })).toEqual({ waiting: 1, assigned: 2, cascades: 3, waitingGroups: [waiting], assignedGroups: [assigned], nextDueAt: 400 });
});

it("preserves held work as waiting and takes only known pending deadlines", () => {
  const state = summarizeMaintenance({ work: [
    { status: "pending", count: 2, readiness: "pending_content", nextDueAt: 300 },
    { status: "pending", count: 1, readiness: "derivation", nextDueAt: 200 },
    { status: "pending", count: 1, nextDueAt: null },
  ] });
  expect(state.waiting).toBe(4);
  expect(state.nextDueAt).toBe(200);
  expect(state.waitingGroups[0].readiness).toBe("pending_content");
});

it("reports no waiting work for settled history or absent status", () => {
  for (const status of [undefined, { work: [{ status: "deferred", count: 2 }, { status: "completed", count: 29 }] }]) {
    expect(summarizeMaintenance(status)).toEqual({ waiting: 0, assigned: 0, cascades: 0, waitingGroups: [], assignedGroups: [], nextDueAt: null });
  }
});

it("labels batch lifecycle without implying every batch is queued or actively running an agent", () => {
  expect(batchStatusLabel("pending")).toBe("Waiting to start");
  expect(batchStatusLabel("running")).toBe("In progress");
  expect(batchStatusLabel("completed")).toBe("Completed");
  expect(batchStatusLabel("abandoned")).toBe("Stopped");
});

it("combines reason and tier over all pending groups without counting unrelated cascade work", () => {
  const status = { work: [
    { status: "pending", reason: "review", tier: "soon", count: 3 },
    { status: "pending", reason: "review", tier: "routine", count: 5 },
    { status: "pending", reason: "change", tier: "soon", count: 7 },
    { status: "batched", reason: "review", tier: "soon", count: 2 },
  ], cascades: { pending: 9 } };
  expect(summarizeMaintenance(status, { reason: "review" }).waiting).toBe(8);
  expect(summarizeMaintenance(status, { tier: "soon" }).waiting).toBe(10);
  const both = summarizeMaintenance(status, { reason: "review", tier: "soon" });
  expect(both.waiting).toBe(3);
  expect(both.assigned).toBe(2);
  expect(both.cascades).toBe(0);
  expect(summarizeMaintenance(status).cascades).toBe(9);
});
