// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import {
  fitCandidateDecisions,
  fitKnowledgeFrontierItem,
  knowledgeFrontierPreflight,
} from "./engine-frontier.js";
import { ROOT_NAVIGATION_RECOVERY_TASK } from "./navigation-recovery.js";

it("fits candidate obligations into the complete frontier budget without discarding durable input", () => {
  const decisions = Array.from({ length: 20 }, (_, i) => ({
    id: `${i}`.padEnd(256, "x"),
    revision: 123,
  }));
  const input = {
    batchId: "batch",
    done: false,
    items: [],
    candidateDecisions: decisions,
    organization: {
      id: "cohort",
      inputFingerprint: "fingerprint",
      sourceIds: ["source"],
      readyToComplete: true,
    },
  };
  const fitted = fitCandidateDecisions(input, 4096);
  expect(
    JSON.stringify({ kind: "structured", resultType: "knowledge_next_frontier", data: fitted })
      .length,
  ).toBeLessThanOrEqual(4096);
  expect(fitted.candidateDecisions!.length).toBeGreaterThan(0);
  expect(fitted.candidateDecisions!.length).toBeLessThan(20);
  expect(fitted.candidateDecisions).toEqual(decisions.slice(0, fitted.candidateDecisions!.length));
  expect(input.candidateDecisions).toHaveLength(20);
  expect(knowledgeFrontierPreflight({ ...fitted, organization: undefined })).toBe("continue");
});

it("keeps complete recovery pointers within a compact frontier budget", () => {
  const candidates = Array.from({ length: 32 }, (_, i) => ({
    id: `wiki_${i}`.padEnd(256, "x"),
    title: "\u0001".repeat(200),
    revision: 9,
  }));
  const item = {
    id: "root_overview",
    inputFingerprint: "fingerprint",
    inputVersions: { large: "x".repeat(6000) },
    pendingClaimIds: ["scope"],
    depth: 0,
    maintenanceGoal: "root_orientation" as const,
    maintenanceTask: ROOT_NAVIGATION_RECOVERY_TASK,
    recoverableNavigation: { candidates, incomplete: false },
  };
  const result = fitKnowledgeFrontierItem(item, 3500, true)!;
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(3500);
  expect(result.fetchRequired).toBeDefined();
  expect(result.recoverableNavigation?.incomplete).toBe(true);
  expect(result.recoverableNavigation!.candidates.length).toBeGreaterThan(0);
  expect(result.recoverableNavigation!.candidates.length).toBeLessThan(candidates.length);
  expect(result.recoverableNavigation!.candidates).toEqual(
    candidates.slice(0, result.recoverableNavigation!.candidates.length),
  );
  expect(item.recoverableNavigation.candidates).toHaveLength(32);
});
