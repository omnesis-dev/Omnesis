// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { EntailmentVerifierService } from "./entailment-service.js";
import type { ChatBackend } from "@omnesis/agent";

test("Codex entailment reports usage and revokes a cached verifier when cloud egress is disabled", async () => {
  let allowRemoteInference = true;
  const backend: ChatBackend = {
    name: "codex",
    model: "example-model",
    async *runTurn(input) {
      const ids = { sessionId: input.sessionId, messageId: input.messageId };
      yield { type: "agent.text.delta", payload: { ...ids, delta: "NEUTRAL" } };
      yield {
        type: "agent.message.end",
        payload: { ...ids, stopReason: "end_turn", usage: { inputTokens: 31, outputTokens: 2 } },
      };
    },
  };
  const createBackend = vi.fn().mockReturnValue(backend);
  const recordUsage = vi.fn();
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model: "example-model",
      available: true,
      allowRemoteInference,
    }),
    deps: {
      configDir: "/unused",
      getPromptStyle: () => "judge",
      codexRuntimeService: { createBackend },
      recordUsage,
    },
  });
  const verifier = await service.get();
  expect(
    await verifier!.verify({ claim: "The task finished", evidence: "The task was planned" }),
  ).toMatchObject({ label: "neutral" });
  expect(recordUsage).toHaveBeenCalledWith({
    promptTokens: 31,
    completionTokens: 2,
    modelId: "example-model",
  });
  allowRemoteInference = false;
  await expect(verifier!.verify({ claim: "A", evidence: "B" })).rejects.toThrow("unavailable");
  expect(await service.get()).toBeNull();
  expect(createBackend).toHaveBeenCalledTimes(1);
  allowRemoteInference = true;
  expect(await service.get()).not.toBeNull();
  expect(createBackend).toHaveBeenCalledTimes(2);
  await service.dispose();
});
