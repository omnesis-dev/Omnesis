// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { CaptureRoutingService, CaptureRoutingUnavailableError } from "./capture-routing.js";
import { WatchRoutingService } from "./watch-routing.js";
import type { DecisionCapability } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

describe("phone capture routing", () => {
  const model = (): DecisionCapability => ({
    modelId: "test",
    decide: vi.fn(() =>
      Promise.resolve({
        model: "test",
        inputTokens: 24,
        answers: { route: { type: "choice" as const, choice: "note" } },
      }),
    ),
    dispose() {},
  });

  it("advertises manual actions without a model and applies live phone settings independently of Watch", async () => {
    let phoneEnabled: boolean | undefined = undefined;
    let decision: DecisionCapability | null = null;
    const deps = {
      getConfig: () =>
        ({
          inference: {
            dictation: {
              useDecisionGateForCapture: phoneEnabled,
              useDecisionGateForWatch: false,
            },
          },
        }) as OmnesisConfig,
      getDecision: () => decision,
    };
    const phone = new CaptureRoutingService(deps);
    const watch = new WatchRoutingService(deps);
    expect(phone.status()).toMatchObject({ supported: true, enabled: true, active: false });
    await expect(phone.route("Remember to water the plants")).rejects.toBeInstanceOf(
      CaptureRoutingUnavailableError,
    );
    decision = model();
    expect(phone.status().active).toBe(true);
    expect(watch.status().active).toBe(false);
    expect(await phone.route("Remember to water the plants")).toBe("note");
    phoneEnabled = false;
    expect(phone.status()).toMatchObject({ enabled: false, active: false });
    await expect(phone.route("Remember to water the plants")).rejects.toBeInstanceOf(
      CaptureRoutingUnavailableError,
    );
    expect(decision.decide).toHaveBeenCalledTimes(1);
  });

  it("accounts for successful classification without allowing accounting failures to change the route", async () => {
    const recordSpend = vi.fn(() => Promise.reject(new Error("unavailable")));
    const service = new CaptureRoutingService({
      getConfig: () => undefined,
      getDecision: model,
      recordSpend,
    });
    expect(await service.route("Remember to water the plants")).toBe("note");
    expect(recordSpend).toHaveBeenCalledWith("test", 24);
  });

  it("forwards cancellation to the classifier and exposes manual fallback when a decision fails", async () => {
    const decision = model();
    const decide: DecisionCapability["decide"] = (_request, options) => {
      expect(options?.signal?.aborted).toBe(true);
      return Promise.reject(new Error("private backend diagnostics"));
    };
    decision.decide = vi.fn(decide);
    const service = new CaptureRoutingService({
      getConfig: () => undefined,
      getDecision: () => decision,
    });
    await expect(
      service.route("Where is the plant guide?", AbortSignal.abort()),
    ).rejects.toBeInstanceOf(CaptureRoutingUnavailableError);
  });
});
