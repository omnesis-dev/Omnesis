// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain-JavaScript portal module.
import { decisionAuditPurposes, decisionAuditQuery, LegacyDecisionAuditCard } from "./knowledge-decision-audit.js";
it("offers every knowledge judgement purpose, including pre-run review timing", () => {
  expect(decisionAuditPurposes.map(([value]: [string, string]) => value)).toEqual(["", "discovery", "impact", "review", "urgency", "worth-gate", "record-check"]);
});
it("passes purpose and page cursor to the server without a client-only page filter", () => {
  expect(decisionAuditQuery("review", { limit: 20, cursor: "next" })).toEqual({ purpose: "review", limit: 20, cursor: "next" });
  expect(decisionAuditQuery("", { limit: 20 })).toEqual({ limit: 20 });
});

it("keeps pruned-run judgements inspectable without inventing a transcript link", () => {
  const tree = LegacyDecisionAuditCard({ decision: { id: "fixture-decision", purpose: "worth-gate", score: 2, threshold: 1, createdAt: 1700000000000, runId: "removed-run", runAvailable: false, reusedFrom: "prior-decision" } });
  const texts: string[] = [], links: string[] = [];
  function visit(value: any): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value == null || typeof value === "boolean") return;
    if (typeof value !== "object") { texts.push(String(value)); return; }
    if (typeof value.type === "function") return; // The lazy inspector owns hooks and is mounted in browser coverage.
    if (value.props?.href) links.push(value.props.href);
    visit(value.props?.children);
  }
  visit(tree);
  expect(texts.join("")).toContain("scale 0–3");
  expect(texts.join("")).toContain("no model call was made");
  expect(texts.join("")).toContain("No longer retained");
  expect(links).toEqual([]);
});
