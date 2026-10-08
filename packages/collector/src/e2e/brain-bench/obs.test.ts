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
  test("restarts a first-page read when the run list changes during the query", async () => {
    const stale = Object.assign(new Error("stale page"), {
      status: 409,
      body: JSON.stringify({ code: "STALE_PAGE_CURSOR" }),
    });
    const gatewayJson = vi
      .fn()
      .mockRejectedValueOnce(stale)
      .mockRejectedValueOnce(stale)
      .mockResolvedValue({ items: [], pageInfo: { hasMore: false } });
    const obs = new BrainObs({ gatewayJson } as unknown as SyntheticE2EHarness);

    await expect(obs.runs({ kind: "data" })).resolves.toEqual({
      items: [],
      pageInfo: { hasMore: false },
    });
    expect(gatewayJson).toHaveBeenCalledTimes(3);
  });

  test("does not retry an unrelated conflict", async () => {
    const conflict = Object.assign(new Error("other conflict"), {
      status: 409,
      body: JSON.stringify({ code: "OTHER_CONFLICT" }),
    });
    const gatewayJson = vi.fn().mockRejectedValue(conflict);
    const obs = new BrainObs({ gatewayJson } as unknown as SyntheticE2EHarness);

    await expect(obs.runs()).rejects.toBe(conflict);
    expect(gatewayJson).toHaveBeenCalledOnce();
  });

  test("bounds retries when the run list never stabilizes", async () => {
    const stale = Object.assign(new Error("stale page"), {
      status: 409,
      body: JSON.stringify({ code: "STALE_PAGE_CURSOR" }),
    });
    const gatewayJson = vi.fn().mockRejectedValue(stale);
    const obs = new BrainObs({ gatewayJson } as unknown as SyntheticE2EHarness);

    await expect(obs.runs()).rejects.toBe(stale);
    expect(gatewayJson).toHaveBeenCalledTimes(6);
  });
});
