// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ModelBehaviorValues, ModelControls, ModelControlKey } from "@omnesis/core/models";

export type ReasoningWireProtocol = "chat-completions" | "responses";

/** Prefer Responses only for OpenAI's own endpoint when an effort is saved. */
export function preferredReasoningWireProtocol(
  baseUrl: string,
  controls: ModelControls | undefined,
  values: ModelBehaviorValues | undefined,
): ReasoningWireProtocol | undefined {
  if (controls?.providerId !== "openai" || values?.reasoningEffort === undefined) {
    return undefined;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com" ? "responses" : undefined;
  } catch {
    return undefined;
  }
}

/** The catalog's option is offered in pickers only when Omnesis can send it. */
export function supportsModelReasoningControl(
  providerId: string,
  key: ModelControlKey,
  protocol: ReasoningWireProtocol,
  controls?: ModelControls,
): boolean {
  if (protocol === "responses") {
    return (
      (providerId === "openai" && key === "reasoningEffort") ||
      (providerId === "deepseek" && (key === "reasoningEnabled" || key === "reasoningEffort"))
    );
  }
  switch (providerId) {
    case "openai":
    case "groq":
    case "mistral":
    case "cerebras":
      return key === "reasoningEffort";
    case "deepseek":
    case "togetherai":
      return key === "reasoningEnabled" || key === "reasoningEffort";
    case "moonshotai":
      return key === "reasoningEnabled";
    case "google":
      if (key === "reasoningEnabled") {
        // Gemini 2.5 Flash/Lite expose both toggle and budget in Models.dev.
        // Gemma 4 exposes a toggle without a verified API request field.
        return (
          controls?.controls.some((control) => control.key === "reasoningBudgetTokens") === true
        );
      }
      return key === "reasoningEffort" || key === "reasoningBudgetTokens";
    case "openrouter":
    case "nvidia":
      return (
        key === "reasoningEnabled" || key === "reasoningEffort" || key === "reasoningBudgetTokens"
      );
    default:
      return false;
  }
}

/**
 * Models.dev says which controls a serving model offers, but does not encode
 * the provider's HTTP request shape. This narrow adapter supplies that missing
 * wire mapping. An explicitly saved value must never be silently ignored.
 */
export function modelReasoningRequestFields(
  controls: ModelControls | undefined,
  values: ModelBehaviorValues | undefined,
  protocol: ReasoningWireProtocol,
): Record<string, unknown> {
  if (!values || Object.keys(values).length === 0) return {};
  if (!controls || controls.source !== "models.dev") {
    throw new Error("The selected model has no verified reasoning controls in Models.dev.");
  }

  const advertised = new Map(controls.controls.map((control) => [control.key, control]));
  for (const [key, value] of Object.entries(values)) {
    const descriptor = advertised.get(key as keyof ModelBehaviorValues);
    if (!descriptor || value === undefined) {
      throw new Error(`The selected model does not advertise ${key}.`);
    }
    if (
      !supportsModelReasoningControl(
        controls.providerId,
        key as ModelControlKey,
        protocol,
        controls,
      )
    ) {
      throw new Error(
        `${key} has no supported ${protocol} request field for ${controls.providerId}.`,
      );
    }
    if (descriptor.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean.`);
    }
    if (
      descriptor.type === "enum" &&
      (typeof value !== "string" || !descriptor.values?.includes(value))
    ) {
      throw new Error(`${key} is not an advertised effort level.`);
    }
    if (
      descriptor.type === "integer" &&
      (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < (descriptor.min ?? 0) ||
        (descriptor.max !== undefined && value > descriptor.max))
    ) {
      throw new Error(`${key} is outside the advertised token-budget range.`);
    }
    if (descriptor.exclusiveWith?.some((excluded) => values[excluded] !== undefined)) {
      throw new Error(
        `${key} cannot be combined with the selected model's other reasoning controls.`,
      );
    }
  }

  const {
    reasoningEnabled: enabled,
    reasoningEffort: effort,
    reasoningBudgetTokens: budget,
  } = values;
  const provider = controls.providerId;
  if (enabled === false && (effort !== undefined || budget !== undefined)) {
    throw new Error(
      "Reasoning cannot be disabled while an effort level or token budget is also selected.",
    );
  }

  if (protocol === "responses") {
    if (budget !== undefined) {
      throw new Error(
        `The ${provider} Responses API has no verified reasoning token-budget field.`,
      );
    }
    if (enabled !== undefined && effort !== undefined) {
      throw new Error(
        "The Responses API accepts either a reasoning toggle or effort override, not both.",
      );
    }
    if (provider === "openai" || provider === "deepseek") {
      if (effort !== undefined) return { reasoning: { effort } };
      if (enabled !== undefined) return { reasoning: { effort: enabled ? "high" : "none" } };
      return {};
    }
    throw new Error(`The ${provider} Responses API reasoning fields are not verified.`);
  }

  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "cerebras":
      if (enabled !== undefined || budget !== undefined) {
        throw new Error(`The ${provider} chat API has no verified toggle or token-budget field.`);
      }
      return effort === undefined ? {} : { reasoning_effort: effort };

    case "deepseek":
      if (budget !== undefined)
        throw new Error("DeepSeek does not expose a reasoning token-budget field.");
      return {
        ...(enabled === undefined ? {} : { thinking: { type: enabled ? "enabled" : "disabled" } }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      };

    case "google":
      if ([enabled, effort, budget].filter((value) => value !== undefined).length > 1) {
        throw new Error(
          "Google accepts one thinking toggle, effort, or budget override at a time.",
        );
      }
      if (budget !== undefined)
        return { extra_body: { google: { thinking_config: { thinking_budget: budget } } } };
      if (enabled !== undefined)
        return {
          extra_body: { google: { thinking_config: { thinking_budget: enabled ? -1 : 0 } } },
        };
      return effort === undefined ? {} : { reasoning_effort: effort };

    case "openrouter": {
      if (effort !== undefined && budget !== undefined) {
        throw new Error("OpenRouter accepts either reasoning effort or max tokens, not both.");
      }
      const reasoning: Record<string, unknown> = {};
      if (enabled !== undefined) reasoning.enabled = enabled;
      if (effort !== undefined) reasoning.effort = effort;
      if (budget !== undefined) reasoning.max_tokens = budget;
      return { reasoning };
    }

    case "togetherai":
      if (budget !== undefined)
        throw new Error("Together AI has no verified reasoning token-budget field.");
      return {
        ...(enabled === undefined ? {} : { reasoning: { enabled } }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      };

    case "moonshotai":
      if (budget !== undefined)
        throw new Error("Moonshot AI has no verified reasoning token-budget field.");
      return enabled === undefined ? {} : { thinking: { type: enabled ? "enabled" : "disabled" } };

    case "nvidia": {
      const chatTemplate: Record<string, unknown> = {};
      if (enabled !== undefined) chatTemplate.enable_thinking = enabled;
      if (budget !== undefined) chatTemplate.reasoning_budget = budget;
      return {
        ...(Object.keys(chatTemplate).length === 0 ? {} : { chat_template_kwargs: chatTemplate }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      };
    }

    default:
      throw new Error(`Reasoning request fields for ${provider} are not verified.`);
  }
}
