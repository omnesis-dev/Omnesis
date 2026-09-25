// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createPlanTool, PlanStore } from "./plan.js";

const CTX = { sessionId: "S", messageId: "M" } as const;

describe("createPlanTool", () => {
  it("appends items on add and assigns monotonic ids", async () => {
    const tool = createPlanTool({ store: new PlanStore() });
    const r = await tool.invoke({ add: ["Search messages", "Check purchases"] }, CTX);
    expect(r.kind).toBe("plan.updated");
    if (r.kind !== "plan.updated") return;
    expect(r.items.map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(r.items.map((i) => i.label)).toEqual(["Search messages", "Check purchases"]);
  });

  it("computes status — first non-done is in_progress, rest pending", async () => {
    const tool = createPlanTool({ store: new PlanStore() });
    const r = await tool.invoke({ add: ["Search messages", "Check purchases", "Summarize"] }, CTX);
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    expect(r.items.map((i) => i.status)).toEqual(["in_progress", "pending", "pending"]);
  });

  it("complete marks an item done and promotes the next", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a", "b", "c"] }, CTX);
    const r = await tool.invoke({ complete: ["p1"] }, CTX);
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    expect(r.items.map((i) => i.status)).toEqual(["done", "in_progress", "pending"]);
  });

  it("preserves insertion order even when items complete out of sequence", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a", "b", "c"] }, CTX);
    const r = await tool.invoke({ complete: ["p2"] }, CTX);
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    expect(r.items.map((i) => i.id)).toEqual(["p1", "p2", "p3"]);
    expect(r.items.map((i) => i.status)).toEqual(["in_progress", "done", "pending"]);
  });

  it("supports add + complete in one call", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a"] }, CTX);
    const r = await tool.invoke({ add: ["b"], complete: ["p1"] }, CTX);
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    expect(r.items).toEqual([
      { id: "p1", label: "a", status: "done" },
      { id: "p2", label: "b", status: "in_progress" },
    ]);
  });

  it("silently ignores unknown complete ids", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a"] }, CTX);
    const r = await tool.invoke({ complete: ["p99", "p1"] }, CTX);
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    expect(r.items).toEqual([{ id: "p1", label: "a", status: "done" }]);
  });

  it("rejects an empty call (neither add nor complete)", async () => {
    const tool = createPlanTool({ store: new PlanStore() });
    const r = await tool.invoke({}, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("isolates state per (sessionId, messageId)", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a", "b"] }, { sessionId: "S1", messageId: "M1" });
    const r = await tool.invoke({ add: ["x"] }, { sessionId: "S1", messageId: "M2" });
    if (r.kind !== "plan.updated") throw new Error("expected plan.updated");
    // M2's plan starts fresh — `x` gets id `p1`, not `p3`.
    expect(r.items).toEqual([{ id: "p1", label: "x", status: "in_progress" }]);
  });

  it("forgetSession clears all per-message state for that session", async () => {
    const store = new PlanStore();
    const tool = createPlanTool({ store });
    await tool.invoke({ add: ["a"] }, { sessionId: "S1", messageId: "M1" });
    await tool.invoke({ add: ["b"] }, { sessionId: "S1", messageId: "M2" });
    await tool.invoke({ add: ["c"] }, { sessionId: "S2", messageId: "M1" });
    store.forgetSession("S1");
    expect(store.snapshot({ sessionId: "S1", messageId: "M1" })).toEqual([]);
    expect(store.snapshot({ sessionId: "S1", messageId: "M2" })).toEqual([]);
    expect(store.snapshot({ sessionId: "S2", messageId: "M1" })).toHaveLength(1);
  });

  it("summarize echoes +N / ✓N delta counts", () => {
    const tool = createPlanTool({ store: new PlanStore() });
    expect(tool.summarize?.({ add: ["a", "b"] })).toBe("+2");
    expect(tool.summarize?.({ complete: ["p1"] })).toBe("✓1");
    expect(tool.summarize?.({ add: ["a"], complete: ["p1", "p2"] })).toBe("+1 ✓2");
    expect(tool.summarize?.({})).toBeUndefined();
  });

  it("schema rejects empty add array", async () => {
    const tool = createPlanTool({ store: new PlanStore() });
    const r = await tool.invoke({ add: [] }, CTX);
    expect(r.kind).toBe("error");
  });

  it("schema rejects more than 8 items in a single add", async () => {
    const tool = createPlanTool({ store: new PlanStore() });
    const r = await tool.invoke({ add: Array.from({ length: 9 }, (_, i) => `item ${i}`) }, CTX);
    expect(r.kind).toBe("error");
  });
});
