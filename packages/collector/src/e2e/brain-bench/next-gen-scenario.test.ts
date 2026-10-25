// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { loadNextGenScenario, nextGenScenarioSchema } from "./next-gen-scenario.js";

describe("next generation scenario corpus", () => {
  it("contains progressive change, late history, deletion and suppressed resurrection", () => {
    const scenario = loadNextGenScenario();
    const revisions = scenario.steps.flatMap((step) =>
      step.operations.filter((op) => op.kind === "upsert" && op.content !== undefined),
    );
    expect(revisions.length).toBeGreaterThan(0);
    expect(scenario.steps.some((step) => step.operations.some((op) => op.kind === "delete"))).toBe(
      true,
    );
    expect(
      scenario.steps.some((step) =>
        step.operations.some((op) => op.kind === "upsert" && op.expectAbsent),
      ),
    ).toBe(true);
    const late = scenario.steps.find((step) => step.id === "late-historic-evidence")!;
    expect(scenario.documents[late.operations[0]!.document]!.createdMinute).toBeLessThan(-24 * 60);
    expect(scenario.steps.at(-1)!.minute).toBeGreaterThan(6 * 60);
  });

  it("rejects timelines that hide identity mistakes and impossible source timestamps", () => {
    const original = loadNextGenScenario();
    const duplicate = structuredClone(original);
    duplicate.documents["camera-loan"]!.externalId = duplicate.documents["party-plan"]!.externalId;
    expect(nextGenScenarioSchema.safeParse(duplicate).success).toBe(false);
    const backwards = structuredClone(original);
    backwards.steps[2]!.minute = 0;
    expect(nextGenScenarioSchema.safeParse(backwards).success).toBe(false);
    const future = structuredClone(original);
    future.documents["party-plan"]!.createdMinute = 1;
    expect(nextGenScenarioSchema.safeParse(future).success).toBe(false);
  });

  it("requires a real prior privacy deletion for a suppressed restoration expectation", () => {
    const scenario = loadNextGenScenario();
    scenario.steps = scenario.steps.filter((step) => step.id !== "privacy-delete");
    expect(nextGenScenarioSchema.safeParse(scenario).success).toBe(false);
  });
});
