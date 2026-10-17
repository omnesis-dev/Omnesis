// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain-JavaScript portal module.
import { decisionAuditPurposes, decisionAuditQuery } from "./knowledge-decision-audit.js";
it("offers every judgement purpose the gateway records, after an unfiltered choice", () => {
  expect(decisionAuditPurposes.map(([value]: [string, string]) => value)).toEqual([
    "", "discovery", "impact", "review", "urgency", "worth-gate", "record-check", "task-check",
    "observation-salience", "mention-worth", "find-route",
  ]);
});
it("passes purpose and page cursor to the server without a client-only page filter", () => {
  expect(decisionAuditQuery("review", { limit: 20, cursor: "next" })).toEqual({ purpose: "review", limit: 20, cursor: "next" });
  expect(decisionAuditQuery("", { limit: 20 })).toEqual({ limit: 20 });
});
