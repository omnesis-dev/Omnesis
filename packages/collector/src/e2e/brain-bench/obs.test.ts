// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { BrainObs } from "./obs.js";
import type { SyntheticE2EHarness } from "../synth-harness.js";

describe("BrainObs runs", () => {
  test("finds actual successful maintenance runs without a per-document datum alias", async () => {
    const obs = new BrainObs({} as SyntheticE2EHarness);
    vi.spyOn(obs, "runs").mockResolvedValue({
      items: [{ id: "batch" }, { id: "refused" }],
    } as Awaited<ReturnType<BrainObs["runs"]>>);
    vi.spyOn(obs, "executedTools").mockImplementation(async (id) => [
      {
        tool: "knowledge_discovery_complete",
        args: { id: "source:document" },
        result:
          id === "batch"
            ? { kind: "structured", data: {} }
            : { kind: "error", code: "revision_conflict" },
      },
    ]);
    expect((await obs.runsForSource("document")).map((run) => run.id)).toEqual(["batch"]);
    expect(await obs.runsForSource("other")).toEqual([]);
  });
  test("an organization cohort's completion of a member is not its interpretation", async () => {
    const obs = new BrainObs({} as SyntheticE2EHarness);
    vi.spyOn(obs, "runs").mockResolvedValue({
      items: [{ id: "cohort" }, { id: "interpretation" }],
    } as Awaited<ReturnType<BrainObs["runs"]>>);
    const frontier = (sourceIds?: string[]) => ({
      tool: "knowledge_next_frontier",
      args: {},
      result: {
        kind: "structured",
        data: { items: [], ...(sourceIds ? { organization: { sourceIds } } : {}) },
      },
    });
    const complete = {
      tool: "knowledge_discovery_complete",
      args: { id: "source:document" },
      result: { kind: "structured", data: {} },
    };
    vi.spyOn(obs, "executedTools").mockImplementation(async (id) =>
      id === "cohort" ? [frontier(["document"]), complete] : [frontier(), complete],
    );
    expect((await obs.runsForSource("document")).map((run) => run.id)).toEqual([
      "cohort",
      "interpretation",
    ]);
    expect((await obs.interpretationForSource("document")).id).toBe("interpretation");
  });
  test.each([{ phases: [] }, { phases: ["organization"] }])(
    "explicit non-interpretation phases %j do not select a standalone review",
    async ({ phases }) => {
      const obs = new BrainObs({} as SyntheticE2EHarness);
      vi.spyOn(obs, "runs").mockResolvedValue({
        items: [{ id: "review" }, { id: "interpretation" }],
      } as Awaited<ReturnType<BrainObs["runs"]>>);
      vi.spyOn(obs, "executedTools").mockImplementation(async (id) => [
        {
          tool: "knowledge_discovery_complete",
          args: {
            id: "source:document",
            phases: id === "review" ? phases : ["interpretation"],
          },
          result: { kind: "structured", data: {} },
        },
      ]);
      expect((await obs.runsForSource("document")).map((run) => run.id)).toEqual([
        "review",
        "interpretation",
      ]);
      expect((await obs.interpretationForSource("document")).id).toBe("interpretation");
    },
  );

  test("explicit interpretation phases take precedence over cohort membership", async () => {
    const obs = new BrainObs({} as SyntheticE2EHarness);
    vi.spyOn(obs, "runs").mockResolvedValue({
      items: [{ id: "joint-interpretation" }],
    } as Awaited<ReturnType<BrainObs["runs"]>>);
    vi.spyOn(obs, "executedTools").mockResolvedValue([
      {
        tool: "knowledge_next_frontier",
        args: {},
        result: {
          kind: "structured",
          data: { items: [], organization: { sourceIds: ["document"] } },
        },
      },
      {
        tool: "knowledge_discovery_complete",
        args: { id: "source:document", phases: ["interpretation"] },
        result: { kind: "structured", data: {} },
      },
    ]);
    expect((await obs.interpretationForSource("document")).id).toBe("joint-interpretation");
  });
});
