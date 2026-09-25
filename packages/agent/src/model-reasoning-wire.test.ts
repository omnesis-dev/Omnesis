// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  modelReasoningRequestFields,
  preferredReasoningWireProtocol,
  supportsModelReasoningControl,
} from "./model-reasoning-wire.js";
import { outputBudgetForSelectedReasoning } from "./http-output-budget.js";
import type { ModelControls, ModelBehaviorValues } from "@omnesis/core/models";

function controls(providerId: string, values: ModelBehaviorValues): ModelControls {
  return {
    providerId,
    source: "models.dev",
    reasoning: true,
    controls: [
      ...(values.reasoningEnabled === undefined
        ? []
        : [{ key: "reasoningEnabled" as const, type: "boolean" as const, label: "Reasoning" }]),
      ...(values.reasoningEffort === undefined
        ? []
        : [
            {
              key: "reasoningEffort" as const,
              type: "enum" as const,
              label: "Reasoning effort",
              values: [values.reasoningEffort],
            },
          ]),
      ...(values.reasoningBudgetTokens === undefined
        ? []
        : [
            {
              key: "reasoningBudgetTokens" as const,
              type: "integer" as const,
              label: "Reasoning budget",
            },
          ]),
    ],
    logoUrl: `/model-logos/${providerId}.svg`,
  };
}

describe("provider-native reasoning request fields", () => {
  it("prefers Responses only for saved OpenAI effort on the official endpoint", () => {
    const options = controls("openai", { reasoningEffort: "low" });
    expect(
      preferredReasoningWireProtocol("https://api.openai.com/v1", options, {
        reasoningEffort: "low",
      }),
    ).toBe("responses");
    expect(
      preferredReasoningWireProtocol("https://openai-compatible.example/v1", options, {
        reasoningEffort: "low",
      }),
    ).toBeUndefined();
    expect(preferredReasoningWireProtocol("https://api.openai.com", options, {})).toBeUndefined();
  });

  it.each([
    ["openai", { reasoningEffort: "xhigh" }, { reasoning_effort: "xhigh" }],
    ["groq", { reasoningEffort: "default" }, { reasoning_effort: "default" }],
    ["mistral", { reasoningEffort: "none" }, { reasoning_effort: "none" }],
    ["cerebras", { reasoningEffort: "low" }, { reasoning_effort: "low" }],
    [
      "deepseek",
      { reasoningEnabled: true, reasoningEffort: "low" },
      { thinking: { type: "enabled" }, reasoning_effort: "low" },
    ],
    [
      "google",
      { reasoningBudgetTokens: 4096 },
      { extra_body: { google: { thinking_config: { thinking_budget: 4096 } } } },
    ],
    [
      "openrouter",
      { reasoningEnabled: true, reasoningEffort: "high" },
      { reasoning: { enabled: true, effort: "high" } },
    ],
    ["togetherai", { reasoningEnabled: false }, { reasoning: { enabled: false } }],
    ["moonshotai", { reasoningEnabled: false }, { thinking: { type: "disabled" } }],
    ["nvidia", { reasoningEnabled: false }, { chat_template_kwargs: { enable_thinking: false } }],
    [
      "nvidia",
      { reasoningBudgetTokens: 2048 },
      { chat_template_kwargs: { reasoning_budget: 2048 } },
    ],
  ] as const)("encodes %s chat controls", (provider, values, expected) => {
    expect(
      modelReasoningRequestFields(controls(provider, values), values, "chat-completions"),
    ).toEqual(expected);
  });

  it("encodes Responses effort under the reasoning object", () => {
    const values = { reasoningEffort: "high" };
    expect(modelReasoningRequestFields(controls("openai", values), values, "responses")).toEqual({
      reasoning: { effort: "high" },
    });
  });

  it("sends NVIDIA's -1 no-enforcement sentinel without treating it as a positive token budget", () => {
    const values = { reasoningBudgetTokens: -1 };
    const model = controls("nvidia", values);
    model.controls[0]!.min = -1;
    model.controls[0]!.max = 32768;
    expect(modelReasoningRequestFields(model, values, "chat-completions")).toEqual({
      chat_template_kwargs: { reasoning_budget: -1 },
    });
    expect(outputBudgetForSelectedReasoning(4096, undefined, -1)).toBe(4096);
  });

  it("rejects an explicitly saved field that is not advertised", () => {
    const values = { reasoningEffort: "high" };
    expect(() =>
      modelReasoningRequestFields(controls("groq", {}), values, "chat-completions"),
    ).toThrow("does not advertise reasoningEffort");
  });

  it("refuses directly edited, mutually exclusive settings instead of silently dropping one", () => {
    const values = { reasoningEnabled: true, reasoningEffort: "high" };
    const model = controls("deepseek", values);
    model.controls[0]!.exclusiveWith = ["reasoningEffort"];
    model.controls[1]!.exclusiveWith = ["reasoningEnabled"];
    expect(() => modelReasoningRequestFields(model, values, "responses")).toThrow(
      /cannot be combined/,
    );
    const withoutDescriptors = controls("deepseek", values);
    expect(() => modelReasoningRequestFields(withoutDescriptors, values, "responses")).toThrow(
      /either a reasoning toggle or effort/,
    );
  });

  it("rejects a combination the host cannot send without changing either setting", () => {
    const values = { reasoningEffort: "high", reasoningBudgetTokens: 2000 };
    expect(() =>
      modelReasoningRequestFields(controls("openrouter", values), values, "chat-completions"),
    ).toThrow("either reasoning effort or max tokens");
  });

  it("rejects a catalog control lacking a documented wire shape", () => {
    const values = { reasoningEnabled: false };
    expect(() =>
      modelReasoningRequestFields(controls("google", values), values, "chat-completions"),
    ).toThrow("has no supported chat-completions request field");
  });

  it("rejects a contradictory disabled toggle and effort", () => {
    const values = { reasoningEnabled: false, reasoningEffort: "high" };
    expect(() =>
      modelReasoningRequestFields(controls("deepseek", values), values, "chat-completions"),
    ).toThrow("cannot be disabled while an effort level");
  });

  it("rejects Google's overlapping native thinking overrides without dropping either value", () => {
    const options = controls("google", { reasoningEnabled: true, reasoningBudgetTokens: 1024 });
    expect(() =>
      modelReasoningRequestFields(
        options,
        { reasoningEnabled: true, reasoningBudgetTokens: 1024 },
        "chat-completions",
      ),
    ).toThrow(/one thinking toggle, effort, or budget/);
  });

  it("does not offer catalog options without a verified provider wire field", () => {
    expect(supportsModelReasoningControl("google", "reasoningEnabled", "chat-completions")).toBe(
      false,
    );
    const flash = controls("google", { reasoningEnabled: true, reasoningBudgetTokens: 1024 });
    expect(
      supportsModelReasoningControl("google", "reasoningEnabled", "chat-completions", flash),
    ).toBe(true);
    expect(
      modelReasoningRequestFields(flash, { reasoningEnabled: false }, "chat-completions"),
    ).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: 0 } } } });
    expect(
      modelReasoningRequestFields(flash, { reasoningEnabled: true }, "chat-completions"),
    ).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: -1 } } } });
    expect(supportsModelReasoningControl("moonshotai", "reasoningEffort", "chat-completions")).toBe(
      false,
    );
    expect(supportsModelReasoningControl("meta", "reasoningEffort", "chat-completions")).toBe(
      false,
    );
    expect(supportsModelReasoningControl("openai", "reasoningEffort", "responses")).toBe(true);
  });
});
