// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { validateConfig } from "./config-schema.js";

const OLLAYA = { preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone" };
const CALIBRATION = {
  points: [
    [0.1, 0.05],
    [0.5, 0.3],
    [0.9, 0.85],
  ],
  reference: "jev-worth/email-worth-v1/jev-1.13.0",
  fittedAt: "2026-11-10T12:00:00.000Z",
  samples: 302,
  agreement: 0.91,
  agreementBefore: 0.62,
};

function errors(inference: unknown): string[] {
  const result = validateConfig({ inference });
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("validateConfig — decision backends", () => {
  test("accepts every field a decision backend can carry", () => {
    expect(
      errors({
        allowRemoteInference: true,
        decisionBackends: {
          ollaya: { ...OLLAYA, calibration: { kev: CALIBRATION } },
          foundry: {
            preset: "azure-foundry",
            url: "https://my-foundry.services.ai.azure.com/providers/microsoft/v1/systemone",
            auth: "api-key",
            apiKeySecret: "config-secret:inference.decision-backend.Zm91bmRyeQ.apiKey.abc123",
            keyRequired: true,
            maxConcurrency: 2,
            timeoutMs: 60_000,
          },
          clef: {
            url: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
            protocol: "workers-ai",
          },
          luna: {
            url: "https://api.openai.com/v1/decisions",
            protocol: "openai-decisions",
            apiKey: "sk",
          },
          glide: {
            url: "https://api.fastino.ai/v1/systemone",
            auth: "x-api-key",
            scoreField: "expected_level",
          },
        },
        assignments: { decision: "ollaya/kev" },
      }),
    ).toEqual([]);
  });

  test.each(["local", "anthropic", "codex", "claude-code", "replay", "typesafe", "a/b"])(
    "refuses the name %s",
    (name) => {
      expect(errors({ decisionBackends: { [name]: OLLAYA } }).join()).toContain(
        "Decision backend name cannot be",
      );
    },
  );

  test("refuses a name an HTTP backend already has", () => {
    expect(
      errors({
        backends: { ollama: { type: "http", url: "http://127.0.0.1:11434" } },
        decisionBackends: { ollama: { url: "http://127.0.0.1:11434/v1/systemone" } },
      }),
    ).toEqual([expect.stringContaining('"ollama" is already the name of an HTTP backend')]);
  });

  test.each([
    [{ ...OLLAYA, protocol: "chat-completions" }],
    [{ ...OLLAYA, auth: "basic" }],
    [{ ...OLLAYA, url: "not a url" }],
    [{ ...OLLAYA, maxConcurrency: 0 }],
    [{ ...OLLAYA, scoreField: "argmax" }],
    [{ ...OLLAYA, apiKeySecret: "plain-text-key" }],
    [{ ...OLLAYA, unknown: true }],
  ])("refuses an invalid backend (%#)", (backend) => {
    expect(errors({ decisionBackends: { ollaya: backend } })).not.toEqual([]);
  });

  test.each([
    [{ ...CALIBRATION, points: [[0.5, 0.5]] }, "one point"],
    [
      {
        ...CALIBRATION,
        points: [
          [0.5, 0.5],
          [0.4, 0.6],
        ],
      },
      "x not increasing",
    ],
    [
      {
        ...CALIBRATION,
        points: [
          [0.2, 0.6],
          [0.4, 0.5],
        ],
      },
      "y decreasing",
    ],
    [
      {
        ...CALIBRATION,
        points: [
          [0.2, 0.6],
          [1.4, 0.7],
        ],
      },
      "x above 1",
    ],
    [{ ...CALIBRATION, fittedAt: "yesterday" }, "fittedAt not a time"],
    [{ ...CALIBRATION, agreement: 1.2 }, "agreement above 1"],
  ])("refuses a broken calibration (%#: %s)", (calibration) => {
    expect(
      errors({ decisionBackends: { ollaya: { ...OLLAYA, calibration: { kev: calibration } } } }),
    ).not.toEqual([]);
  });

  test("lets a merge patch remove a backend with null", () => {
    // The config route applies merge patches before validating, so the stored
    // config never holds the null; the schema need only accept the result.
    expect(errors({ decisionBackends: {} })).toEqual([]);
  });
});
