// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { applyMergePatch, validateConfig } from "./config-schema.js";

const OLLAYA = {
  type: "http",
  preset: "ollaya",
  decision: { url: "http://127.0.0.1:11435/v1/systemone" },
};
function errors(inference: unknown): string[] {
  const result = validateConfig({ inference });
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

/** A backend whose decision block is `decision`. */
const withDecision = (decision: Record<string, unknown>) => ({
  backends: { ollaya: { ...OLLAYA, decision: { ...OLLAYA.decision, ...decision } } },
});

describe("validateConfig — backends with a decision API", () => {
  test("accepts every field a backend's decision API can carry", () => {
    expect(
      errors({
        allowRemoteInference: true,
        backends: {
          ollaya: {
            ...OLLAYA,
            decision: OLLAYA.decision,
          },
          fireworks: {
            type: "http",
            preset: "fireworks",
            url: "https://api.fireworks.ai/inference",
            apiKeySecret: "config-secret:inference.backend.ZmlyZXdvcmtz.apiKey.abc123",
            decision: { url: "https://api.fireworks.ai/inference/v1/systemone" },
          },
          foundry: {
            type: "http",
            preset: "azure-foundry",
            apiKeySecret: "config-secret:inference.backend.Zm91bmRyeQ.apiKey.abc123",
            decision: {
              url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
              auth: "api-key",
              keyRequired: true,
              maxConcurrency: 2,
              timeoutMs: 60_000,
            },
          },
          clef: {
            type: "http",
            decision: {
              url: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
              protocol: "workers-ai",
            },
          },
          luna: {
            type: "http",
            url: "https://api.openai.com",
            apiKey: "sk",
            decision: { url: "https://api.openai.com/v1/decisions", protocol: "openai-decisions" },
          },
          glide: {
            type: "http",
            decision: {
              url: "https://api.fastino.ai/v1/systemone",
              auth: "x-api-key",
              scoreField: "expected_level",
            },
          },
        },
        assignments: { decision: "ollaya/kev", agent: "fireworks/accounts/fireworks/models/x" },
      }),
    ).toEqual([]);
  });

  test("still accepts a chat-only backend with a url and no decision API", () => {
    expect(errors({ backends: { vllm: { type: "http", url: "http://127.0.0.1:8000" } } })).toEqual(
      [],
    );
  });

  test("needs a url or a decision API", () => {
    expect(errors({ backends: { empty: { type: "http", preset: "fireworks" } } })).toEqual([
      expect.stringContaining("A backend needs a url, a decision endpoint, or both"),
    ]);
  });

  test("keeps the backend name rules", () => {
    expect(errors({ backends: { local: OLLAYA } }).join()).toContain("/inference/backends/local");
    expect(errors({ backends: { "a/b": OLLAYA } }).join()).toContain("/inference/backends/a~1b");
  });

  test("refuses a decision API on a backend named typesafe, the built-in slot's prefix", () => {
    expect(errors({ backends: { typesafe: OLLAYA } }).join()).toContain(
      'A backend named "typesafe" cannot serve decision models',
    );
    // A chat backend of that name, which older versions accepted, still validates.
    expect(
      errors({ backends: { typesafe: { type: "http", url: "http://127.0.0.1:8000" } } }),
    ).toEqual([]);
  });

  test.each([
    [{ protocol: "chat-completions" }],
    [{ auth: "basic" }],
    [{ url: "not a url" }],
    [{ maxConcurrency: 0 }],
    [{ scoreField: "argmax" }],
    [{ apiKey: "sk-in-the-wrong-place" }],
    [{ unknown: true }],
  ])("refuses an invalid decision API (%#)", (decision) => {
    expect(errors(withDecision(decision))).not.toEqual([]);
  });

  test("refuses a decision API with no url", () => {
    expect(
      errors({ backends: { ollaya: { type: "http", decision: { protocol: "systemone" } } } }),
    ).not.toEqual([]);
  });

  test("refuses a calibration, which a decision API does not carry", () => {
    expect(errors(withDecision({ calibration: { kev: { points: [[0.5, 0.36]] } } }))).not.toEqual(
      [],
    );
  });

  test("a merge patch adds and removes a backend's decision API without touching the rest", () => {
    const chat = {
      inference: {
        backends: {
          fireworks: {
            type: "http",
            url: "https://api.fireworks.ai/inference",
            apiKeySecret: "config-secret:inference.backend.ZmlyZXdvcmtz.apiKey.abc123",
          },
        },
      },
    };
    const enabled = applyMergePatch(chat, {
      inference: {
        backends: {
          fireworks: { decision: { url: "https://api.fireworks.ai/inference/v1/systemone" } },
        },
      },
    }) as typeof chat;
    expect(validateConfig(enabled).ok).toBe(true);
    expect(enabled.inference.backends.fireworks).toMatchObject(chat.inference.backends.fireworks);

    const disabled = applyMergePatch(enabled, {
      inference: { backends: { fireworks: { decision: null } } },
    });
    expect(disabled).toEqual(chat);
    expect(validateConfig(disabled).ok).toBe(true);

    // Removing the decision API from a decision-only backend leaves it invalid.
    const onlyDecision = { inference: { backends: { ollaya: OLLAYA } } };
    expect(
      validateConfig(
        applyMergePatch(onlyDecision, { inference: { backends: { ollaya: { decision: null } } } }),
      ).ok,
    ).toBe(false);
  });
});
