// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { decideFindRoute } from "./decision.js";
import type { DecisionCapability, DecisionRequest } from "@omnesis/core";

function capability(route = "agentic", reason = "calculation"): DecisionCapability {
  return {
    modelId: "replay",
    dispose() {},
    decide: vi.fn().mockResolvedValue({
      model: "replay",
      answers: {
        route: { type: "choice", choice: route, confidence: 0.93 },
        reason: { type: "choice", choice: reason },
      },
    }),
  };
}

describe("Find routing", () => {
  it("keeps ordinary retrieval available when no decision role is enabled", async () => {
    const result = await decideFindRoute(
      { text: "ownership tutorial" },
      () => null,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ mode: "direct", status: "not_configured" });
    expect(result.model).toBeUndefined();
  });

  it("uses the configured typed decision and sends only query context", async () => {
    const model = capability();
    const result = await decideFindRoute(
      { text: "my longest run", timeZone: "Europe/London" },
      () => model,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      mode: "agentic",
      status: "decided",
      model: "replay",
      confidence: 0.93,
    });
    const request = vi.mocked(model.decide).mock.calls[0]![0] as DecisionRequest;
    expect(request.state).toEqual({ query: "my longest run", timeZone: "Europe/London" });
    expect(request.questions.route?.type).toBe("choice");
  });

  it("resolves changed assignments on every request", async () => {
    const assigned = vi
      .fn<() => DecisionCapability | null>()
      .mockReturnValueOnce(capability("direct", "content"))
      .mockReturnValueOnce(capability());
    const input = { text: "find a page" };
    const signal = new AbortController().signal;
    expect((await decideFindRoute(input, assigned, signal)).mode).toBe("direct");
    expect((await decideFindRoute(input, assigned, signal)).mode).toBe("agentic");
  });

  it.each([capability("invented"), capability("agentic", "invented")])(
    "does not invent a route from malformed model output",
    async (model) => {
      expect(
        await decideFindRoute({ text: "find an item" }, () => model, new AbortController().signal),
      ).toMatchObject({ mode: "direct", status: "unavailable" });
    },
  );

  it("falls back to the index when the decision service fails", async () => {
    const model = capability();
    vi.mocked(model.decide).mockRejectedValue(new Error("unavailable"));
    expect(
      await decideFindRoute({ text: "find an item" }, () => model, new AbortController().signal),
    ).toMatchObject({ mode: "direct", status: "unavailable" });
  });

  it("cancellation does not turn into an unwanted fallback search", async () => {
    const controller = new AbortController();
    const model = capability();
    vi.mocked(model.decide).mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      decideFindRoute({ text: "cancel this" }, () => model, controller.signal),
    ).rejects.toThrow();
  });

  it("records billed decisions even when their route is malformed", async () => {
    const model = capability("invented");
    const response = await model.decide({ state: {}, questions: {} });
    vi.mocked(model.decide).mockResolvedValue({ ...response, inputTokens: 37 });
    const recordSpend = vi.fn().mockResolvedValue(undefined);
    const result = await decideFindRoute(
      { text: "find an item" },
      () => model,
      new AbortController().signal,
      recordSpend,
    );
    expect(result.status).toBe("unavailable");
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith("replay", 37);
  });

  it("keeps the chosen route if spend recording fails", async () => {
    const model = capability();
    const response = await model.decide({ state: {}, questions: {} });
    vi.mocked(model.decide).mockResolvedValue({ ...response, inputTokens: 19 });
    const result = await decideFindRoute(
      { text: "my longest run" },
      () => model,
      new AbortController().signal,
      vi.fn().mockRejectedValue(new Error("write unavailable")),
    );
    expect(result).toMatchObject({ mode: "agentic", status: "decided" });
  });

  it("does not describe an agentic decision as sufficient ordinary matching", async () => {
    expect(
      await decideFindRoute(
        { text: "find an item" },
        () => capability("agentic", "content"),
        new AbortController().signal,
      ),
    ).toMatchObject({
      mode: "agentic",
      reason: "The decision model selected research to find the requested destination.",
    });
  });
});
