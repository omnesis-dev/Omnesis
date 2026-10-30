// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { WatchRoutingService } from "./watch-routing.js";
import type { DecisionCapability } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

describe("Watch complication routing", () => {
  const backend = (choice: string): DecisionCapability => ({
    modelId: "test",
    decide: vi.fn(async () => ({
      model: "test",
      answers: { route: { type: "choice" as const, choice } },
    })),
    dispose() {},
  });
  it("defaults on only with a runnable model and responds to live config changes", async () => {
    let enabled: boolean | undefined = undefined;
    const model = backend("note");
    let decision: DecisionCapability | null = null;
    const service = new WatchRoutingService({
      getConfig: () =>
        ({ inference: { dictation: { useDecisionGateForWatch: enabled } } }) as OmnesisConfig,
      getDecision: () => decision,
    });
    expect(service.status()).toEqual({
      supported: true,
      enabled: true,
      active: false,
      completionNotifications: true,
    });
    decision = model;
    expect(service.status().active).toBe(true);
    expect(await service.route("Remember that the bicycle is at the workshop")).toBe("note");
    enabled = false;
    expect(service.status()).toEqual({
      supported: true,
      enabled: false,
      active: false,
      completionNotifications: true,
    });
    expect(await service.route("Where is my bicycle?")).toBe("ask");
    expect(model.decide).toHaveBeenCalledTimes(1);
  });
  it.each(["ask", "invalid"])("answers ambiguous or %s decisions through Ask", async (choice) => {
    const service = new WatchRoutingService({
      getConfig: () => undefined,
      getDecision: () => backend(choice),
    });
    expect(await service.route("A mixed question and note")).toBe("ask");
  });
  it("fails to Ask when the model fails, without returning model errors", async () => {
    const decision = backend("note");
    decision.decide = vi.fn(async () => {
      throw new Error("private backend detail");
    });
    const service = new WatchRoutingService({
      getConfig: () => undefined,
      getDecision: () => decision,
    });
    expect(await service.route("Please check my booking")).toBe("ask");
  });
});
