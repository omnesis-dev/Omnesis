// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsDevCatalog, validateProviderSvg } from "./models-dev-catalog.js";
import type { InferenceOverview } from "@omnesis/core";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), "omnesis-models-dev-test-"));
  dirs.push(path);
  return path;
};

const BUNDLED = {
  google: {
    name: "Google",
    models: {
      "gemini-example": {
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 2048 }],
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  deepseek: {
    name: "DeepSeek",
    models: {
      "deepseek-example": {
        reasoning: true,
        interleaved: { field: "reasoning_content" },
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
      "deepseek-no-replay-example": {
        reasoning: true,
        interleaved: true,
        reasoning_options: [{ type: "toggle" }],
      },
      "deepseek-future-field-example": {
        reasoning: true,
        interleaved: { field: "future_reasoning_field" },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  togetherai: { name: "Together AI", models: {} },
  openai: { name: "OpenAI", models: {} },
  openrouter: {
    name: "OpenRouter",
    models: {
      "minimax/example": {
        reasoning: true,
        interleaved: { field: "reasoning_details" },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  "ollama-cloud": { name: "example.com", models: {} },
  nvidia: {
    name: "NVIDIA",
    models: {
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "budget_tokens", min: -1, max: 32768 },
          { type: "future_reasoning_knob", value: "native" },
        ],
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
    },
  },
};

const inference = {
  backends: {
    google: { type: "http", status: "ok", models: ["models/gemini-example", "models/new-unknown"] },
    deepseek: { type: "http", status: "ok", models: ["deepseek-example"] },
    nvidia: {
      type: "http",
      status: "ok",
      models: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
    },
  },
  assignments: {
    agent: {
      role: "agent",
      kind: "http",
      backendKey: "google",
      url: "https://example.com",
      model: "models/gemini-example",
      allowRemoteInference: true,
      available: true,
    },
  },
} as unknown as InferenceOverview;

describe("Models.dev gateway catalog", () => {
  it("uses Codex's live provider catalog for native reasoning efforts", () => {
    const service = new ModelsDevCatalog({
      configDir: dir(),
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
    });
    const codexInference = {
      backends: {},
      codex: {
        type: "codex",
        configured: true,
        status: "ok",
        loggedIn: true,
        models: ["gpt-example-frontier"],
        modelDetails: [
          {
            id: "gpt-example-frontier",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
          },
        ],
      },
      assignments: {
        agent: {
          role: "agent",
          kind: "codex",
          model: "gpt-example-frontier",
          allowRemoteInference: true,
          available: true,
        },
      },
    } as unknown as InferenceOverview;

    expect(service.controlsFor("codex/gpt-example-frontier", codexInference)).toMatchObject({
      providerId: "openai",
      source: "provider",
      controls: [
        {
          key: "reasoningEffort",
          type: "enum",
          values: ["low", "medium", "high", "xhigh"],
        },
      ],
    });
    expect(() =>
      service.validateValues(
        "codex/gpt-example-frontier",
        { reasoningEffort: "xhigh" },
        codexInference,
      ),
    ).not.toThrow();
    expect(() =>
      service.validateValues(
        "codex/gpt-example-frontier",
        { reasoningEffort: "max" },
        codexInference,
      ),
    ).toThrow(/advertised effort values/);
  });

  it("does not confuse inherited object names with exact provider or model IDs", async () => {
    const service = new ModelsDevCatalog({
      configDir: dir(),
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
    });
    expect(service.providerId("constructor")).toBeNull();
    expect(service.providerId("toString")).toBeNull();
    expect(service.controlsForBackend("constructor", "example").source).toBe("unknown");
    expect(service.model("deepseek", "constructor")).toBeNull();
    await expect(service.logo("constructor")).rejects.toThrow(/unknown/);
  });

  it("retains the bundled snapshot instead of trusting a truncated local cache", () => {
    const path = dir();
    mkdirSync(join(path, "models-dev"));
    writeFileSync(
      join(path, "models-dev", "api.json"),
      JSON.stringify({ deepseek: BUNDLED.deepseek }),
    );
    writeFileSync(
      join(path, "models-dev", "state.json"),
      JSON.stringify({ checkedAt: Date.now() + 60_000 }),
    );
    const service = new ModelsDevCatalog({
      configDir: path,
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
      minProviderCount: 2,
      minModelCount: 1,
    });
    expect(service.model("google", "gemini-example")?.reasoning).toBe(true);
  });

  it("keeps model pickers available when the local catalog cache cannot be written", async () => {
    const blocked = join(dir(), "not-a-directory");
    writeFileSync(blocked, "blocked");
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...BUNDLED,
            google: {
              name: "Google",
              models: {
                ...BUNDLED.google.models,
                "new-example": {
                  reasoning: false,
                  modalities: { input: ["text"], output: ["text"] },
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    const service = new ModelsDevCatalog({
      configDir: blocked,
      bundled: BUNDLED,
      bundledFetchedAt: 0,
      fetcher,
      minProviderCount: 1,
      minModelCount: 1,
    });
    await expect(service.refreshIfStale()).resolves.toBeUndefined();
    expect(service.model("google", "new-example")?.reasoning).toBe(false);
  });

  it("retains NVIDIA's no-enforcement budget sentinel without losing model facts", () => {
    const service = new ModelsDevCatalog({
      configDir: dir(),
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
    });
    const assignment = "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
    const facts = service.controlsForBackend(
      "nvidia",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    );
    expect(facts.source).toBe("models.dev");
    expect(facts.modalities?.input).toContain("image");
    expect(facts.controls).toContainEqual({
      key: "reasoningBudgetTokens",
      type: "integer",
      label: "Reasoning token budget",
      min: -1,
      max: 32768,
    });
    expect(() =>
      service.validateValues(assignment, { reasoningBudgetTokens: -1 }, inference),
    ).not.toThrow();
    expect(() =>
      service.validateValues(assignment, { reasoningBudgetTokens: -2 }, inference),
    ).toThrow(/bounds/);
  });

  it("keeps exact host controls, normalizes only Google's prefix, and leaves unknown IDs selectable", () => {
    const service = new ModelsDevCatalog({
      configDir: dir(),
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
    });
    const view = service.overview(inference, {
      inference: {
        assignments: { agent: "google/models/gemini-example" },
        entailment: { promptStyle: "judge" },
      },
    });
    expect(view.modelControls["google/models/gemini-example"]?.source).toBe("models.dev");
    expect(view.modelControls["google/models/gemini-example"]?.controls).toEqual([
      {
        key: "reasoningEnabled",
        type: "boolean",
        label: "Reasoning",
        exclusiveWith: ["reasoningBudgetTokens"],
      },
      {
        key: "reasoningBudgetTokens",
        type: "integer",
        label: "Reasoning token budget",
        min: 0,
        max: 2048,
        exclusiveWith: ["reasoningEnabled"],
      },
    ]);
    expect(() =>
      service.validateValues("google/models/gemini-example", { reasoningEnabled: true }, inference),
    ).not.toThrow();
    expect(() =>
      service.validateValues(
        "google/models/gemini-example",
        { reasoningEnabled: true, reasoningBudgetTokens: 1024 },
        inference,
      ),
    ).toThrow(/cannot be combined/);
    expect(view.modelControls["google/models/new-unknown"]?.source).toBe("unknown");
    expect(view.modelControls["google/models/new-unknown"]?.controls).toEqual([]);
    expect(view.modelSettings.agent).toEqual({
      assignment: "google/models/gemini-example",
      values: {},
    });
    expect(service.controlsFor("deepseek/deepseek-example", inference).controls[1]?.values).toEqual(
      ["low", "high", "max"],
    );
    expect(service.providerId("together")).toBe("togetherai");
  });

  it("reports the exact catalog replay field for each known model", () => {
    const service = new ModelsDevCatalog({ configDir: dir(), bundled: BUNDLED });
    expect(
      service.controlsForBackend("deepseek", "deepseek-example").interleavedReasoningField,
    ).toBe("reasoning_content");
    expect(
      service.controlsForBackend("openrouter", "minimax/example").interleavedReasoningField,
    ).toBe("reasoning_details");
    expect(
      service.controlsForBackend("deepseek", "deepseek-no-replay-example")
        .interleavedReasoningField,
    ).toBeUndefined();
    expect(
      service.controlsForBackend("deepseek", "new-unknown").interleavedReasoningField,
    ).toBeUndefined();
    const future = service.controlsForBackend("deepseek", "deepseek-future-field-example");
    expect(future.interleavedReasoningField).toBeUndefined();
    expect(future.source).toBe("models.dev");
    expect(future.modalities?.input).toEqual(["text"]);
  });

  it("honors an explicitly disabled assignment while inference still reports its previous HTTP model", () => {
    const service = new ModelsDevCatalog({
      configDir: dir(),
      bundled: BUNDLED,
      bundledFetchedAt: Date.now(),
    });
    const view = service.overview(inference, {
      inference: {
        assignments: { agent: null },
        entailment: { promptStyle: "judge" },
        modelSettings: {
          agent: { assignment: "google/models/gemini-example", values: { reasoningEnabled: true } },
        },
      },
    });
    expect(view.modelSettings.agent).toEqual({ assignment: null, values: {} });
  });

  it("validates saved values against the selected host/model, including budget bounds", () => {
    const service = new ModelsDevCatalog({ configDir: dir(), bundled: BUNDLED });
    expect(() =>
      service.validateValues(
        "google/models/gemini-example",
        { reasoningBudgetTokens: 0 },
        inference,
      ),
    ).not.toThrow();
    expect(() =>
      service.validateValues(
        "google/models/gemini-example",
        { reasoningBudgetTokens: 2049 },
        inference,
      ),
    ).toThrow(/bounds/);
    expect(() =>
      service.validateValues("deepseek/deepseek-example", { reasoningEffort: "medium" }, inference),
    ).toThrow(/effort values/);
    expect(() =>
      service.validateValues("google/models/new-unknown", { reasoningEnabled: true }, inference),
    ).toThrow(/not configurable/);
  });

  it("refreshes once across simultaneous picker reads and reuses the gateway-local snapshot", async () => {
    const path = dir();
    let now = 2 * 24 * 60 * 60 * 1000;
    const UPDATED = {
      ...BUNDLED,
      deepseek: {
        name: "DeepSeek",
        models: {
          "deepseek-example": BUNDLED.deepseek.models["deepseek-example"],
          "new-model": {
            reasoning: false,
            reasoning_options: [],
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(UPDATED), { status: 200, headers: { etag: '"catalog-2"' } }),
    );
    const service = new ModelsDevCatalog({
      configDir: path,
      bundled: BUNDLED,
      bundledFetchedAt: 0,
      now: () => now,
      fetcher,
      minProviderCount: 1,
      minModelCount: 1,
    });
    await Promise.all([service.refreshIfStale(), service.refreshIfStale()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(service.model("deepseek", "new-model")?.reasoning).toBe(false);
    now += 23 * 60 * 60 * 1000;
    await service.refreshIfStale();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const restored = new ModelsDevCatalog({
      configDir: path,
      bundled: BUNDLED,
      bundledFetchedAt: 0,
      now: () => now,
      fetcher,
      minProviderCount: 1,
      minModelCount: 1,
    });
    expect(restored.model("deepseek", "new-model")?.reasoning).toBe(false);
    expect(JSON.parse(readFileSync(join(path, "models-dev", "state.json"), "utf8")).etag).toBe(
      '"catalog-2"',
    );
  });

  it("fetches a passive provider SVG once, rejects active content and never constructs a URL from unknown IDs", async () => {
    const path = dir();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M1 1h2v2H1z"/></svg>';
    const fetcher = vi.fn(
      async (_input: Parameters<typeof fetch>[0]) => new Response(svg, { status: 200 }),
    );
    const service = new ModelsDevCatalog({ configDir: path, bundled: BUNDLED, fetcher });
    await Promise.all([service.logo("together"), service.logo("together")]);
    await service.logo("togetherai");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://models.dev/logos/togetherai.svg");
    await service.logo("ollama");
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://models.dev/logos/ollama-cloud.svg");
    await expect(service.logo("unknown-provider")).rejects.toThrow(/unknown/);
    expect(() => validateProviderSvg(Buffer.from("<svg><script>alert(1)</script></svg>"))).toThrow(
      /active/,
    );
    expect(() =>
      validateProviderSvg(
        Buffer.from('<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>'),
      ),
    ).toThrow(/active/);
  });

  it("bounds simultaneous outbound logo fetches across different public provider IDs", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1h2v2H1z"/></svg>';
    const responses: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    const service = new ModelsDevCatalog({ configDir: dir(), bundled: BUNDLED, fetcher });
    const logos = ["google", "deepseek", "togetherai", "openai", "ollama", "nvidia"].map((id) =>
      service.logo(id),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    responses.shift()!(new Response(svg, { status: 200 }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    responses.shift()!(new Response(svg, { status: 200 }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    for (const resolve of responses) resolve(new Response(svg, { status: 200 }));
    await expect(Promise.all(logos)).resolves.toHaveLength(6);
  });

  it("serves a validated logo from memory when its local cache cannot be written", async () => {
    const blocked = join(dir(), "not-a-directory");
    writeFileSync(blocked, "blocked");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1h2v2H1z"/></svg>';
    const fetcher = vi.fn(async () => new Response(svg, { status: 200 }));
    const service = new ModelsDevCatalog({ configDir: blocked, bundled: BUNDLED, fetcher });
    await expect(service.logo("openai")).resolves.toEqual(Buffer.from(svg));
    await expect(service.logo("openai")).resolves.toEqual(Buffer.from(svg));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
