// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_PROVIDER_PRESETS } from "@omnesis/core";
import { ModelsDevDecisionCatalog } from "./models-dev-decisions.js";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-md-decisions-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function catalog(models: Record<string, Record<string, unknown>>, extraProviders = 2) {
  const out: Record<string, unknown> = {
    openrouter: { name: "OpenRouter", models },
  };
  for (let i = 0; i < extraProviders; i += 1) {
    out[`p${i}`] = {
      name: `P${i}`,
      models: Object.fromEntries(
        Array.from({ length: 5 }, (_, j) => [`m${j}`, { type: "decision" }]),
      ),
    };
  }
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

describe("ModelsDevDecisionCatalog", () => {
  it("reads the bundled snapshot, which lists OpenRouter's decision models", () => {
    const md = new ModelsDevDecisionCatalog({ configDir, fetcher: vi.fn() });
    const openrouter = md.models("openrouter");
    expect(openrouter.size).toBeGreaterThan(10);
    expect(openrouter.get("liquid/d1")).toMatchObject({
      source: "models.dev",
      contextTokens: 65536,
    });
  });

  it("puts the preset's models first, with models.dev facts, then the rest of the catalog", () => {
    const md = new ModelsDevDecisionCatalog({
      configDir,
      bundled: catalog({
        "liquid/d1.1": { type: "decision", limit: { context: 65536 }, cost: { input: 0.02 } },
        "zeta/x": { type: "decision" },
        "alpha/y": { type: "decision", limit: { context: 0 } },
        "chat/model": { type: "chat" },
      }),
      fetcher: vi.fn(),
    });
    const presets = md.presets();
    expect(presets.map((p) => p.id)).toEqual(DECISION_PROVIDER_PRESETS.map((p) => p.id));
    const openrouter = presets.find((p) => p.id === "openrouter")!;
    const ids = openrouter.models.map((m) => m.id);
    expect(ids.slice(0, openrouter.suggestedModels.length)).toEqual([
      ...openrouter.suggestedModels,
    ]);
    expect(ids.slice(openrouter.suggestedModels.length)).toEqual(["alpha/y", "zeta/x"]);
    expect(openrouter.models.find((m) => m.id === "liquid/d1.1")).toEqual({
      id: "liquid/d1.1",
      contextTokens: 65536,
      inputCostPerMillion: 0.02,
      source: "preset",
    });
    expect(openrouter.models.find((m) => m.id === "alpha/y")).toEqual({
      id: "alpha/y",
      source: "models.dev",
    });
    const ollaya = presets.find((p) => p.id === "ollaya")!;
    expect(ollaya.models.every((m) => m.source === "preset")).toBe(true);
  });

  it("refreshes once a day, keeps an ETag, and caches the copy", async () => {
    let now = 10 * DAY;
    const fresh = catalog({ "new/model": { type: "decision" } });
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("If-None-Match");
      if (etag === '"v1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify(fresh), { headers: { etag: '"v1"' } });
    }) as unknown as typeof fetch;
    const md = new ModelsDevDecisionCatalog({
      configDir,
      bundled: catalog({}),
      bundledFetchedAt: 0,
      fetcher,
      now: () => now,
    });
    await md.refreshIfStale();
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toBe(
      "https://models.dev/api.json?type=decision",
    );
    expect(md.models("openrouter").has("new/model")).toBe(true);
    await md.refreshIfStale();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += DAY + 1;
    await md.refreshIfStale();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(configDir, "models-dev", "decision.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(configDir, "models-dev", "decision-state.json"), "utf8")),
    ).toMatchObject({ etag: '"v1"' });

    // A new process starts from the cached copy.
    const reloaded = new ModelsDevDecisionCatalog({
      configDir,
      bundled: catalog({}),
      bundledFetchedAt: 0,
      fetcher: vi.fn(),
      now: () => now,
    });
    expect(reloaded.models("openrouter").has("new/model")).toBe(true);
  });

  it("keeps the last good copy when a refresh fails or comes back truncated", async () => {
    const good = catalog({ "kept/model": { type: "decision" } });
    for (const response of [
      new Response("nope", { status: 500 }),
      new Response(JSON.stringify(catalog({}, 0))),
      new Response("{not json"),
    ]) {
      const md = new ModelsDevDecisionCatalog({
        configDir,
        bundled: good,
        bundledFetchedAt: 0,
        fetcher: vi.fn(async () => response) as unknown as typeof fetch,
        now: () => 5 * DAY,
      });
      await md.refreshIfStale();
      expect(md.models("openrouter").has("kept/model")).toBe(true);
    }
  });
});
