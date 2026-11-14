// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { modelListUrls, probeDecisionBackend } from "./decision-tools.js";

describe("modelListUrls", () => {
  it("tries /api/tags, then a models listing beside the endpoint", () => {
    expect(modelListUrls("http://127.0.0.1:11435/v1/systemone")).toEqual([
      "http://127.0.0.1:11435/api/tags",
      "http://127.0.0.1:11435/v1/models",
    ]);
    expect(modelListUrls("http://192.0.2.5:8000/inference/v1/decisions/")).toEqual([
      "http://192.0.2.5:8000/api/tags",
      "http://192.0.2.5:8000/inference/v1/models",
    ]);
    expect(modelListUrls("not a url")).toEqual([]);
  });
});

describe("probeDecisionBackend", () => {
  it("lists an Ollama-style server's installed models", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        models: [{ name: "kev:latest" }, { name: "laya:en" }, { model: "d1:latest" }],
      }),
    ) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:11435/v1/systemone" },
      false,
      fetchFn,
    );
    expect(result).toEqual({
      ok: true,
      listed: true,
      models: ["d1:latest", "kev:latest", "laya:en"],
    });
  });

  it("falls back to an OpenAI-style listing, sending the key", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("x-api-key") });
      if (String(url).endsWith("/api/tags")) return new Response("", { status: 404 });
      return Response.json({ data: [{ id: "drex-9b" }] });
    }) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:8000/v1/systemone", auth: "x-api-key", apiKey: "k" },
      false,
      fetchFn,
    );
    expect(result).toEqual({ ok: true, listed: true, models: ["drex-9b"] });
    expect(seen.map((s) => s.auth)).toEqual(["k", "k"]);
  });

  it("does not ask a hosted provider or another wire format", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    for (const cfg of [
      { preset: "openrouter", url: "https://openrouter.ai/api/v1/systemone" },
      { url: "https://api.openai.com/v1/decisions", protocol: "openai-decisions" as const },
    ]) {
      expect(await probeDecisionBackend(cfg, true, fetchFn)).toEqual({
        ok: true,
        models: [],
        listed: false,
      });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("says when nothing answers", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await probeDecisionBackend(
      { url: "http://127.0.0.1:11435/v1/systemone" },
      false,
      fetchFn,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Could not reach http://127.0.0.1:11435/v1/systemone");
  });
});
