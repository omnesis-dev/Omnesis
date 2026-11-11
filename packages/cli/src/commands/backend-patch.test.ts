// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { applyMergePatch, validateConfig } from "@omnesis/config";
import {
  backendServes,
  buildBackendAddPatch,
  buildDecisionDisablePatch,
  buildDecisionEnablePatch,
  describeCalibration,
  parseParams,
} from "./backend-patch.js";

const backendOf = (patch: { inference: Record<string, unknown> }, name: string) =>
  (patch.inference.backends as Record<string, Record<string, unknown>>)[name];

describe("buildBackendAddPatch", () => {
  it("adds both APIs of a preset that has a decision API, with one key", () => {
    const { patch, url, decisionUrl } = buildBackendAddPatch({
      name: "fireworks",
      apiKey: "fw-key",
      allowRemote: true,
    });
    expect(patch).toEqual({
      inference: {
        allowRemoteInference: true,
        backends: {
          fireworks: {
            type: "http",
            preset: "fireworks",
            url: "https://api.fireworks.ai/inference",
            apiKey: "fw-key",
            decision: {
              url: "https://api.fireworks.ai/inference/v1/systemone",
              protocol: "systemone",
              auth: "bearer",
            },
          },
        },
      },
    });
    expect(url).toBe("https://api.fireworks.ai/inference");
    expect(decisionUrl).toBe("https://api.fireworks.ai/inference/v1/systemone");
    expect(validateConfig(patch).ok).toBe(true);
    expect(
      backendOf(buildBackendAddPatch({ name: "openai", apiKey: "k" }).patch, "openai")!.decision,
    ).toEqual({
      url: "https://api.openai.com/v1/decisions",
      protocol: "openai-decisions",
      auth: "bearer",
    });
  });

  it("adds a chat-only preset as before, with its path prefix", () => {
    expect(backendOf(buildBackendAddPatch({ name: "google" }).patch, "google")).toEqual({
      type: "http",
      preset: "google",
      url: "https://generativelanguage.googleapis.com",
      apiPathPrefix: "/v1beta/openai",
    });
  });

  it("adds a decision-only preset with no OpenAI-compatible URL", () => {
    const local = buildBackendAddPatch({ name: "box", presetId: "ollaya" });
    expect(backendOf(local.patch, "box")).toEqual({
      type: "http",
      preset: "ollaya",
      decision: {
        url: "http://127.0.0.1:11435/v1/systemone",
        protocol: "systemone",
        auth: "bearer",
      },
    });
    expect(local.url).toBeUndefined();
    const cf = buildBackendAddPatch({
      name: "clef",
      presetId: "cloudflare",
      params: { account: "abc123" },
      apiKey: "cf-token",
    });
    expect(backendOf(cf.patch, "clef")).toEqual({
      type: "http",
      preset: "cloudflare",
      apiKey: "cf-token",
      decision: {
        url: "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run",
        protocol: "workers-ai",
        auth: "bearer",
      },
    });
    expect(backendOf(buildBackendAddPatch({ name: "fastino" }).patch, "fastino")!.decision).toEqual(
      {
        url: "https://api.fastino.ai/v1/systemone",
        protocol: "systemone",
        auth: "x-api-key",
        scoreField: "expected_level",
      },
    );
    expect(validateConfig(cf.patch).ok).toBe(true);
  });

  it("adds a server no preset describes from its URLs", () => {
    expect(
      backendOf(
        buildBackendAddPatch({ name: "h2o", decisionUrl: "http://192.0.2.7:8000/v1/systemone" })
          .patch,
        "h2o",
      ),
    ).toEqual({ type: "http", decision: { url: "http://192.0.2.7:8000/v1/systemone" } });
    expect(
      backendOf(
        buildBackendAddPatch({
          name: "lab",
          url: "http://192.0.2.7:8000",
          decisionUrl: "http://192.0.2.7:8001/v1/systemone",
        }).patch,
        "lab",
      ),
    ).toEqual({
      type: "http",
      url: "http://192.0.2.7:8000",
      decision: { url: "http://192.0.2.7:8001/v1/systemone" },
    });
  });

  it("still adds a chat backend named typesafe, which older versions accepted", () => {
    expect(
      backendOf(
        buildBackendAddPatch({ name: "typesafe", url: "http://127.0.0.1:8000" }).patch,
        "typesafe",
      ),
    ).toEqual({ type: "http", url: "http://127.0.0.1:8000" });
  });

  it.each([
    [{ name: "local" }, "is reserved"],
    [{ name: "a/b", url: "http://x" }, "is reserved"],
    [{ name: "mine" }, "is not a known preset"],
    [{ name: "mine", presetId: "nope" }, 'Unknown preset "nope"'],
    [{ name: "tsafe", presetId: "typesafe" }, "TypeSafe is built in"],
    [{ name: "typesafe" }, "is not a known preset"],
    [{ name: "typesafe", decisionUrl: "http://192.0.2.7/v1/systemone" }, "pick another name"],
    [{ name: "clef", presetId: "cloudflare" }, "needs your account id"],
    [{ name: "mine", url: "not a url" }, "is not a URL"],
    [{ name: "mine", decisionUrl: "not a url" }, "is not a URL"],
  ])("explains what is wrong (%#)", (input, message) => {
    expect(() => buildBackendAddPatch(input)).toThrow(message);
  });
});

describe("buildDecisionEnablePatch", () => {
  const existing = {
    inference: {
      backends: {
        fireworks: {
          type: "http",
          preset: "fireworks",
          url: "https://api.fireworks.ai/inference",
          apiKeySecret: "config-secret:inference.backend.x.apiKey.y",
        },
      },
    },
  };

  it("adds the preset's decision API to an existing backend without asking for its key", () => {
    const { patch, url } = buildDecisionEnablePatch({
      backend: "fireworks",
      backendPreset: "fireworks",
      model: "accounts/fireworks/models/rune",
    });
    expect(patch).toEqual({
      inference: {
        backends: {
          fireworks: {
            decision: {
              url: "https://api.fireworks.ai/inference/v1/systemone",
              protocol: "systemone",
              auth: "bearer",
            },
          },
        },
        assignments: { decision: "fireworks/accounts/fireworks/models/rune" },
      },
    });
    expect(url).toBe("https://api.fireworks.ai/inference/v1/systemone");
    const merged = applyMergePatch(existing, patch) as typeof existing;
    expect(merged.inference.backends.fireworks).toMatchObject(
      existing.inference.backends.fireworks,
    );
    expect(validateConfig(merged).ok).toBe(true);
  });

  it("finds the preset by the backend's name, or takes one or a URL explicitly", () => {
    expect(buildDecisionEnablePatch({ backend: "openrouter" }).url).toBe(
      "https://openrouter.ai/api/v1/systemone",
    );
    expect(
      backendOf(buildDecisionEnablePatch({ backend: "or", presetId: "openrouter" }).patch, "or"),
    ).toMatchObject({ preset: "openrouter" });
    expect(
      backendOf(
        buildDecisionEnablePatch({ backend: "vllm", decisionUrl: "http://192.0.2.7/v1/systemone" })
          .patch,
        "vllm",
      ),
    ).toEqual({ decision: { url: "http://192.0.2.7/v1/systemone" } });
  });

  it.each([
    [{ backend: "groq", backendPreset: "groq" }, "give the decision endpoint with --url"],
    [{ backend: "vllm" }, "give the decision endpoint with --url"],
    [{ backend: "x", presetId: "nope" }, 'Unknown preset "nope"'],
    [{ backend: "typesafe" }, "cannot serve decision models"],
  ])("explains what is wrong (%#)", (input, message) => {
    expect(() => buildDecisionEnablePatch(input)).toThrow(message);
  });
});

describe("buildDecisionDisablePatch", () => {
  it("removes only the decision API, and the assignment when it used it", () => {
    expect(
      buildDecisionDisablePatch({ backend: "fireworks", servesChat: true, decisionAssigned: true }),
    ).toEqual({
      inference: {
        backends: { fireworks: { decision: null } },
        assignments: { decision: null },
      },
    });
    expect(
      buildDecisionDisablePatch({
        backend: "fireworks",
        servesChat: true,
        decisionAssigned: false,
      }),
    ).toEqual({ inference: { backends: { fireworks: { decision: null } } } });
  });

  it("sends a decision-only backend to `backend remove`", () => {
    expect(() =>
      buildDecisionDisablePatch({ backend: "box", servesChat: false, decisionAssigned: false }),
    ).toThrow('remove it with "omnesis backend remove box"');
  });
});

describe("backendServes", () => {
  it("names the APIs a backend serves", () => {
    expect(backendServes({ url: "https://x", decision: {} })).toBe("openai+decision");
    expect(backendServes({ decision: {} })).toBe("decision");
    expect(backendServes({ url: "https://x" })).toBe("openai");
  });
});

describe("parseParams", () => {
  it("reads one or many key=value flags", () => {
    expect(parseParams("account=abc")).toEqual({ account: "abc" });
    expect(parseParams(["a=1", "b = x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(parseParams(undefined)).toEqual({});
    expect(() => parseParams("account")).toThrow("key=value");
  });
});

describe("describeCalibration", () => {
  it("says whether thresholds fit, and by how much calibration helped", () => {
    expect(describeCalibration(undefined)).toContain("not calibrated");
    expect(
      describeCalibration({
        points: [
          [0, 0],
          [1, 1],
        ],
        reference: "jev-worth/email-worth-v1/jev-1.13.0",
        fittedAt: "2026-11-10T18:00:00.000Z",
        agreement: 0.914,
        agreementBefore: 0.62,
      }),
    ).toBe("calibrated 2026-11-10: agrees with Jev on 91% of the reference emails (was 62%)");
    expect(
      describeCalibration({
        points: [[0.5, 0.36]],
        reference: "jev-worth/email-worth-v1/jev-1.13.0",
        fittedAt: "2026-11-10T18:00:00.000Z",
        keeps: 0.95,
        keepsBefore: 0.99,
        skips: 0.64,
        skipsBefore: 0.21,
      }),
    ).toBe(
      "calibrated 2026-11-10: keeps 95% of the reference emails Jev keeps and skips 64% of those it skips (was 99% and 21%)",
    );
  });
});
