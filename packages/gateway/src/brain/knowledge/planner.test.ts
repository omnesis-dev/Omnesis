// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  boundKnowledgeReview,
  expandMaintenanceFrontier,
  MaintenancePlanLimitError,
  planMaintenanceGroups,
  scheduleKnowledgeChange,
  type MaintenanceSeed,
} from "./planner.js";

const limits = { maxSeeds: 20, maxVisitedPerSeed: 30 };
const seed = (
  id: string,
  targets: string[],
  overrides: Partial<MaintenanceSeed> = {},
): MaintenanceSeed => ({
  id,
  revision: "v1",
  changedAt: 100,
  dueAt: 1000,
  tier: "routine",
  targets,
  ...overrides,
});

describe("maintenance coordination", () => {
  it("reads only the reachable neighborhood through an indexed reader", () => {
    const visited: string[] = [];
    const groups = planMaintenanceGroups(
      [seed("event", ["a"])],
      (id) => {
        visited.push(id);
        return id === "a" ? ["b"] : id === "b" ? ["root"] : ["never"];
      },
      new Set(["root"]),
      limits,
    );
    expect(visited).toEqual(["a", "b"]);
    expect(groups[0]!.nodes).toEqual(["a", "b"]);
    expect(groups[0]!.aggregates).toEqual(["root"]);
    expect(() =>
      planMaintenanceGroups([seed("event", ["a"])], () => ["b", "c", "d"], new Set(), {
        maxSeeds: 1,
        maxVisitedPerSeed: 2,
      }),
    ).toThrow(MaintenancePlanLimitError);
  });

  it("keeps independent projects separate despite their shared root and navigation cycle", () => {
    const groups = planMaintenanceGroups(
      [seed("a", ["project-a"]), seed("b", ["project-b"])],
      [
        { input: "project-a", dependent: "root" },
        { input: "project-b", dependent: "root" },
        { input: "root", dependent: "project-a" },
      ],
      new Set(["root"]),
      limits,
    );
    expect(groups.map((group) => group.nodes)).toEqual([["project-a"], ["project-b"]]);
    expect(groups.map((group) => group.aggregates)).toEqual([["root"], ["root"]]);
  });

  it("combines transitive overlapping regions and promotes pending routine inputs", () => {
    const groups = planMaintenanceGroups(
      [
        seed("a", ["a"], { tier: "immediate", dueAt: 100 }),
        seed("b", ["b"]),
        seed("c", ["c"]),
        seed("unrelated", ["d"]),
      ],
      [
        { input: "a", dependent: "ab" },
        { input: "b", dependent: "ab" },
        { input: "b", dependent: "bc" },
        { input: "c", dependent: "bc" },
      ],
      new Set(),
      limits,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.seeds.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(groups[0]).toMatchObject({ tier: "immediate", dueAt: 100 });
    expect(groups[1]!.seeds[0]!.id).toBe("unrelated");
  });

  it("coordinates repeated evidence revisions even when discovery found no node yet", () => {
    const groups = planMaintenanceGroups(
      [
        seed("same", [], { revision: "v1" }),
        seed("same", [], { revision: "v2" }),
        seed("other", []),
      ],
      [],
      new Set(),
      limits,
    );
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.seeds[0]!.id === "same")!.seeds).toHaveLength(2);
  });

  it("bounds cyclic regions without marking truncated work complete", () => {
    const arcs = [
      { input: "a", dependent: "b" },
      { input: "b", dependent: "a" },
    ];
    expect(planMaintenanceGroups([seed("a", ["a"])], arcs, new Set(), limits)[0]!.nodes).toEqual([
      "a",
      "b",
    ]);
    expect(() =>
      planMaintenanceGroups([seed("a", ["a"])], arcs, new Set(), {
        ...limits,
        maxVisitedPerSeed: 1,
      }),
    ).toThrow(MaintenancePlanLimitError);
    expect(() =>
      planMaintenanceGroups([seed("a", []), seed("b", [])], [], new Set(), {
        ...limits,
        maxSeeds: 1,
      }),
    ).toThrow(MaintenancePlanLimitError);
  });

  it("stops skipped and unchanged paths while another changed parent still reaches a shared child", () => {
    expect(
      expandMaintenanceFrontier(
        [
          { id: "a", outcome: "skipped" },
          { id: "b", outcome: "unchanged" },
          { id: "c", outcome: "changed" },
        ],
        [
          { input: "a", dependent: "a-child" },
          { input: "b", dependent: "b-child" },
          { input: "a", dependent: "shared" },
          { input: "c", dependent: "shared" },
          { input: "c", dependent: "root" },
        ],
        new Set(["root"]),
      ),
    ).toEqual({ nodes: ["shared"], aggregates: ["root"] });
  });
});

describe("bounded maintenance scheduling", () => {
  const policy = {
    immediateThreshold: 0.8,
    soonThreshold: 0.4,
    soonDelayMs: 100,
    routineDelayMs: 600,
  };
  it("routes model scores and fails conservatively when no decision is available", () => {
    expect(scheduleKnowledgeChange(0.9, 10, policy)).toEqual({ tier: "immediate", dueAt: 10 });
    expect(scheduleKnowledgeChange(0.5, 10, policy)).toEqual({ tier: "soon", dueAt: 110 });
    expect(scheduleKnowledgeChange(0.1, 10, policy)).toEqual({ tier: "routine", dueAt: 610 });
    expect(scheduleKnowledgeChange(null, 10, policy)).toEqual({ tier: "soon", dueAt: 110 });
    expect(scheduleKnowledgeChange(Number.NaN, 10, policy)).toEqual({ tier: "soon", dueAt: 110 });
    expect(scheduleKnowledgeChange(0.1, 10, policy, true)).toEqual({
      tier: "immediate",
      dueAt: 10,
    });
  });

  it("limits repeated deferral by meaningful verification time and upcoming checkpoints", () => {
    const review = {
      now: 100,
      lastVerifiedAt: 10,
      createdAt: 0,
      proposedAt: 9999,
      checkpointAt: null,
      maxIntervalMs: 200,
      checkpointLeadMs: 20,
    };
    expect(boundKnowledgeReview(review)).toBe(210);
    expect(boundKnowledgeReview({ ...review, checkpointAt: 160 })).toBe(140);
    expect(boundKnowledgeReview({ ...review, proposedAt: null })).toBe(210);
    expect(boundKnowledgeReview({ ...review, lastVerifiedAt: null })).toBe(200);
    expect(boundKnowledgeReview({ ...review, checkpointAt: 90 })).toBe(100);
  });
});
