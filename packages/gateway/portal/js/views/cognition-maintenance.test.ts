// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// @ts-nocheck — portal components are plain JavaScript.
import { expect, it } from "vitest";
import { PendingWorkDetails, pendingWorkQuery } from "./knowledge-pending-details.js";
import { MaintenancePills, WaitingWork, decisionsForFrontierItem } from "./cognition-maintenance.js";

function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  if (value.type === PendingWorkDetails) return "";
  if (typeof value.type === "function") return text(value.type(value.props));
  return text(value.props?.children);
}
it("renders every recorded batch reason and its tier as separate pills", () => {
  const tree = MaintenancePills({ tier: "soon", reasons: ["change", "review", "change"] });
  const pills = [tree.props.children].flat(Infinity).filter(Boolean);
  expect(pills.map(text)).toEqual(["Soon", "Evidence changes", "Scheduled review"]);
  expect(pills.every((pill) => pill.props.class === "km-badge")).toBe(true);
});
it("presents pending input groups as a compact semantic table with readiness and eligibility", () => {
  const tree = WaitingWork({ status: { work: [{ status: "pending", reason: "review", tier: "soon", count: 4, readiness: "pending_content", nextDueAt: 1_700_000_000_000 }] } });
  const rendered = text(tree);
  expect(rendered).toContain("WorkInputsReadiness");
  expect(rendered).toContain("Awaiting content");
  expect(rendered).toContain("Eligible");
  expect(rendered).toContain("SoonScheduled review4");
});
it("does not invent a reason for historical batches without recorded work", () => {
  expect(text(MaintenancePills({ tier: "routine" }))).toBe("Routine");
});

it("preserves exact pending group scope and server pagination", () => {
  expect(pendingWorkQuery({ reason: "review", tier: "soon", readiness: null }, { limit: 20, cursor: "next" })).toEqual({ reason: "review", tier: "soon", limit: 20, cursor: "next" });
  expect(pendingWorkQuery({ reason: "change", tier: "routine", readiness: "pending_content" }, { limit: 20 })).toHaveProperty("readiness", "pending_content");
});
it("does not guess which repeated input version a judgement belongs to", () => {
  const first = { nodeId: "source:fixture", inputFingerprint: "v1" };
  const second = { nodeId: "source:fixture", inputFingerprint: "v2" };
  const decision = { nodeId: first.nodeId, inputFingerprint: "different-gate-fingerprint" };
  expect(decisionsForFrontierItem([decision], [first, second], first)).toEqual([]);
  expect(decisionsForFrontierItem([{ ...decision, inputFingerprint: "v1" }], [first, second], first)).toHaveLength(1);
  expect(decisionsForFrontierItem([decision], [first], first)).toEqual([decision]);
});
