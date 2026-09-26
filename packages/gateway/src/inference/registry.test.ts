// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dns from "node:dns/promises";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { LogLevel, makeConfigSecretRef, setLogLevel, writeConfigSecretSync } from "@omnesis/core";
import { InferenceRegistry } from "./registry.js";
import type { LookupAddress } from "node:dns";
import type { BackendStatus, CatalogEntry, Manifest } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

// This suite intentionally drives many probe FAILURES, each emitting a WARN log.
// Under the fork pool, that flood of console output can still be mid-RPC when the
// worker tears down — surfacing as `EnvironmentTeardownError: Closing rpc while
// "onUserConsoleLog" was pending`, an unhandled rejection that reddens the whole
// unit lane even though every test passes. Silence WARN-and-below here (the suite
// asserts on probe RESULTS, never on log output) so teardown is quiet.
beforeAll(() => setLogLevel(LogLevel.ERROR));
afterAll(() => setLogLevel(LogLevel.INFO));

let modelsDir: string;
let configDir: string;
let manifest: Manifest;

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), "omnesis-registry-models-"));
  configDir = mkdtempSync(join(tmpdir(), "omnesis-registry-config-"));
  manifest = { version: 1, models: [] };
});

afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function makeRegistry(opts?: {
  hasAnthropicApiKey?: boolean;
  getCatalogEntry?: (id: string) => CatalogEntry | undefined;
  getAnthropicStatus?: () => BackendStatus | undefined;
}): InferenceRegistry {
  return new InferenceRegistry({
    modelsDir,
    configDir,
    manifest: () => manifest,
    hasAnthropicApiKey: () => opts?.hasAnthropicApiKey ?? false,
    getCatalogEntry: opts?.getCatalogEntry,
    getAnthropicStatus: opts?.getAnthropicStatus,
  });
}

function installGguf(filename: string, id?: string): void {
  writeFileSync(join(modelsDir, filename), "fake-gguf");
  manifest = {
    ...manifest,
    models: [
      ...manifest.models,
      {
        id: id ?? filename.replace(/\.gguf$/i, ""),
        filename,
        sizeBytes: 8,
        sha256: "0".repeat(64),
        downloadedAt: new Date().toISOString(),
      },
    ],
  };
}

// ── resolve() ────────────────────────────────────────────────────────

describe("InferenceRegistry.resolve", () => {
  // ── String assignment → local GGUF ──────────────────────────────

  it("resolves a catalog id string as a local GGUF when the file exists", () => {
    const reg = makeRegistry();
    installGguf("nomic-embed-text-v1.5.Q8_0.gguf");
    reg.loadConfig(configWithAssignments({ embedder: "nomic-embed-text-v1.5.Q8_0" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.catalogId).toBe("nomic-embed-text-v1.5.Q8_0");
    expect(res.available).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.embedDim).toBe(768);
    expect(res.catalogEntry).toBeDefined();
  });

  // ── .gguf suffix normalizes to catalog id ───────────────────────

  it("resolves a .gguf filename by normalizing to the catalog entry", () => {
    const reg = makeRegistry();
    installGguf("nomic-embed-text-v1.5.Q8_0.gguf");
    reg.loadConfig(configWithAssignments({ embedder: "nomic-embed-text-v1.5.Q8_0.gguf" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.catalogId).toBe("nomic-embed-text-v1.5.Q8_0");
    expect(res.available).toBe(true);
  });

  // ── anthropic/ prefix ───────────────────────────────────────────

  it("resolves an anthropic/ prefixed string as Anthropic with API key", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(
      configWithAssignments(
        { "privacy-reviewer": "anthropic/claude-haiku-4-5-20251001" },
        { allowRemoteInference: true },
      ),
    );

    const res = reg.resolve("privacy-reviewer");
    expect(res.kind).toBe("anthropic");
    if (res.kind !== "anthropic") throw new Error("expected anthropic");
    expect(res.catalogId).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(res.apiModelId).toBe("claude-haiku-4-5-20251001");
    expect(res.available).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("attaches live catalog metadata to a dynamically discovered Anthropic model", () => {
    const dynamicEntry: CatalogEntry = {
      kind: "anthropic-api",
      id: "anthropic/claude-sonnet-5",
      apiModelId: "claude-sonnet-5",
      name: "Claude Sonnet 5 (Anthropic API)",
      roles: ["agent"],
      author: "Anthropic",
      license: "Anthropic Commercial Terms",
      description: "Dynamic test model.",
      contextLength: 1_000_000,
      adaptiveThinking: true,
    };
    const reg = makeRegistry({
      hasAnthropicApiKey: true,
      getCatalogEntry: (id) => (id === dynamicEntry.id ? dynamicEntry : undefined),
    });
    reg.loadConfig(
      configWithAssignments({ agent: dynamicEntry.id }, { allowRemoteInference: true }),
    );

    const resolved = reg.resolve("agent");
    expect(resolved.kind).toBe("anthropic");
    if (resolved.kind !== "anthropic") throw new Error("expected anthropic");
    expect(resolved.catalogEntry).toEqual(dynamicEntry);
  });

  it("resolves Anthropic as unavailable when API key is missing", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: false });
    reg.loadConfig(
      configWithAssignments(
        { "privacy-reviewer": "anthropic/claude-haiku-4-5-20251001" },
        { allowRemoteInference: true },
      ),
    );

    const res = reg.resolve("privacy-reviewer");
    expect(res.kind).toBe("anthropic");
    if (res.kind !== "anthropic") throw new Error("expected anthropic");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/API key/i);
  });

  // ── HTTP backend (backend/model string) ─────────────────────────

  it("resolves a backend/model string as HTTP when the backend is OK", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          myserver: {
            type: "http",
            url: "http://localhost:8000",
            modelLimits: {
              "my-model": {
                maxInputTokens: 24_000,
                contextWindowTokens: 32_000,
                maxOutputTokens: 8_000,
              },
            },
            agentTimeoutMs: 345_000,
          },
        },
        assignments: {
          embedder: "myserver/my-model",
        },
      },
    });
    simulateBackendOk(reg, "myserver", ["my-model"]);

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.backendKey).toBe("myserver");
    expect(res.model).toBe("my-model");
    expect(res.available).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.modelLimits).toEqual({
      maxInputTokens: 24_000,
      contextWindowTokens: 32_000,
      maxOutputTokens: 8_000,
    });
    expect(res.agentTimeoutMs).toBe(345_000);
  });

  it("auto-selects the single discovered model when backend/model suffix is empty", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          myserver: {
            type: "http",
            url: "http://localhost:8000",
            modelLimits: {
              "the-only-model": { contextWindowTokens: 64_000, maxOutputTokens: 4_000 },
            },
          },
        },
        assignments: {
          embedder: "myserver/",
        },
      },
    });
    simulateBackendOk(reg, "myserver", ["the-only-model"]);

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.model).toBe("the-only-model");
    expect(res.available).toBe(true);
    expect(res.modelLimits).toEqual({
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_000,
    });
  });

  it("does not infer or borrow token limits for an unmatched HTTP model id", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          myserver: {
            type: "http",
            url: "http://localhost:8000",
            modelLimits: {
              "model-a": { contextWindowTokens: 32_000 },
            },
          },
        },
        assignments: { agent: "myserver/model-b" },
      },
    });
    simulateBackendOk(reg, "myserver", ["model-a", "model-b"]);

    const res = reg.resolve("agent");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.model).toBe("model-b");
    expect(res.modelLimits).toBeUndefined();
  });

  it("is unavailable when model is empty and backend serves multiple models", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { myserver: { type: "http", url: "http://localhost:8000" } },
        assignments: {
          embedder: "myserver/",
        },
      },
    });
    simulateBackendOk(reg, "myserver", ["model-a", "model-b"]);

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/multiple models/i);
  });

  // ── local/ prefix ──────────────────────────────────────────────

  it("resolves a local/ prefixed string as a local GGUF", () => {
    const reg = makeRegistry();
    installGguf("nomic-embed-text-v1.5.Q8_0.gguf");
    reg.loadConfig(configWithAssignments({ embedder: "local/nomic-embed-text-v1.5.Q8_0" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.catalogId).toBe("nomic-embed-text-v1.5.Q8_0");
    expect(res.available).toBe(true);
  });

  // ── replay ─────────────────────────────────────────────────────

  it("resolves 'replay' as replay kind", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: "replay" }));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("replay");
  });

  it("resolves 'replay/fixture-name' as replay with fixture", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: "replay/my-fixture" }));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("replay");
    if (res.kind !== "replay") throw new Error("expected replay");
    expect(res.fixture).toBe("my-fixture");
  });

  // ── agent role ─────────────────────────────────────────────────

  it("resolves undefined for agent as disabled (no catalog default)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("disabled");
  });

  it("resolves agent with anthropic assignment", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(configWithAssignments({ agent: "anthropic/claude-sonnet-4-6" }));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("anthropic");
    if (res.kind !== "anthropic") throw new Error("expected anthropic");
    expect(res.apiModelId).toBe("claude-sonnet-4-6");
    expect(res.available).toBe(true);
  });

  it("resolves privacy-reviewer independently with an Anthropic assignment", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(
      configWithAssignments(
        {
          agent: "anthropic/claude-haiku-4-5-20251001",
          "privacy-reviewer": "anthropic/claude-sonnet-4-6",
        },
        { allowRemoteInference: true },
      ),
    );

    const reviewer = reg.resolve("privacy-reviewer");
    expect(reviewer.kind).toBe("anthropic");
    if (reviewer.kind !== "anthropic") throw new Error("expected anthropic");
    expect(reviewer.apiModelId).toBe("claude-sonnet-4-6");
    expect(reviewer.available).toBe(true);

    const agent = reg.resolve("agent");
    expect(agent.kind).toBe("anthropic");
    if (agent.kind !== "anthropic") throw new Error("expected anthropic");
    expect(agent.apiModelId).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves codex/<model> for the main agent without any experimental flag", () => {
    withExperimentalEnv(undefined, () => {
      const reg = makeRegistry();
      reg.loadConfig(
        configWithAssignments({ agent: "codex/gpt-5.4" }, { allowRemoteInference: true }),
      );

      const res = reg.resolve("agent");
      expect(res.kind).toBe("codex");
      if (res.kind !== "codex") throw new Error("expected codex");
      expect(res.model).toBe("gpt-5.4");
      expect(res.available).toBe(true);
      expect(res.reason).toBeUndefined();
    });
  });

  it("resolves codex/<model> for the main agent when experimental mode is enabled", () => {
    withExperimentalEnv("1", () => {
      const reg = makeRegistry();
      reg.loadConfig(
        configWithAssignments({ agent: "codex/gpt-5.4" }, { allowRemoteInference: true }),
      );

      const res = reg.resolve("agent");
      expect(res.kind).toBe("codex");
      if (res.kind !== "codex") throw new Error("expected codex");
      expect(res.model).toBe("gpt-5.4");
      expect(res.available).toBe(true);
      expect(res.reason).toBeUndefined();
    });
  });

  it("resolves codex/<model> for reviewer/background-agent/watch-judge and rejects embeddings", () => {
    withExperimentalEnv("1", () => {
      const reg = makeRegistry();
      reg.loadConfig(
        configWithAssignments({
          "privacy-reviewer": "codex/gpt-5.4",
          "background-agent": "codex/gpt-5.4",
          "watch-judge": "codex/gpt-5.4",
          embedder: "codex/gpt-5.4",
        }),
      );

      const reviewer = reg.resolve("privacy-reviewer");
      expect(reviewer.kind).toBe("codex");
      if (reviewer.kind !== "codex") throw new Error("expected codex");
      expect(reviewer.available).toBe(true);

      const background = reg.resolve("background-agent");
      expect(background.kind).toBe("codex");
      if (background.kind !== "codex") throw new Error("expected codex");
      expect(background.available).toBe(true);

      const watchJudge = reg.resolve("watch-judge");
      expect(watchJudge.kind).toBe("codex");
      if (watchJudge.kind !== "codex") throw new Error("expected codex");
      expect(watchJudge.available).toBe(true);

      const embedder = reg.resolve("embedder");
      expect(embedder.kind).toBe("codex");
      if (embedder.kind !== "codex") throw new Error("expected codex");
      expect(embedder.available).toBe(false);
      expect(embedder.reason).toMatch(/embedding vectors/i);
    });
  });

  it.each([
    "agent",
    "privacy-reviewer",
    "background-agent",
    "watch-judge",
    "entailment-verifier",
    "brief-judge",
    "ocr",
  ] as const)("supports Codex for %s and preserves remote-inference policy", (role) => {
    const reg = makeRegistry();
    reg.loadConfig(
      configWithAssignments({ [role]: "codex/gpt-5.4" }, { allowRemoteInference: true }),
    );
    expect(reg.resolve(role)).toMatchObject({
      kind: "codex",
      available: true,
      allowRemoteInference: true,
    });
    reg.loadConfig(configWithAssignments({ [role]: "codex/gpt-5.4" }));
    expect(reg.resolve(role)).toMatchObject({ kind: "codex", allowRemoteInference: false });
  });

  it("rejects Replay and Responses-only HTTP assignments for Watch judging", () => {
    withExperimentalEnv("1", () => {
      const replay = makeRegistry();
      replay.loadConfig(configWithAssignments({ "watch-judge": "replay/fictional.jsonl" }));
      expect(replay.resolve("watch-judge")).toMatchObject({
        kind: "unresolved",
        reason: expect.stringMatching(/Replay cannot serve/i),
      });

      const responses = makeRegistry();
      responses.loadConfig({
        inference: {
          assignments: { "watch-judge": "responses-api/fictional-model" },
          backends: {
            "responses-api": {
              type: "http",
              url: "https://example.com/v1",
              protocol: "responses",
            },
          },
        },
      });
      expect(responses.resolve("watch-judge")).toMatchObject({
        kind: "unresolved",
        reason: expect.stringMatching(/Responses-only/i),
      });
      expect(responses.configHealth().degradedRoles).toEqual([
        expect.objectContaining({ role: "watch-judge" }),
      ]);
      expect(responses.getOverview().backends["responses-api"]?.protocol).toBe("responses");
    });
  });

  // ── entailment-verifier ──────────────────────────────────────────

  it("resolves entailment-verifier as disabled when unset (never auto-assigned)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));
    expect(reg.resolve("entailment-verifier").kind).toBe("disabled");
  });

  it("resolves an http entailment-verifier assignment like any capability role", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { judge: { url: "http://127.0.0.1:9999" } },
        assignments: { "entailment-verifier": "judge/tiny-judge-model" },
      },
    } as OmnesisConfig);
    const res = reg.resolve("entailment-verifier");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.backendKey).toBe("judge");
    expect(res.model).toBe("tiny-judge-model");
  });

  it("requires an explicit codex model id", () => {
    withExperimentalEnv("1", () => {
      const reg = makeRegistry();
      reg.loadConfig(configWithAssignments({ agent: "codex/" }));

      const res = reg.resolve("agent");
      expect(res.kind).toBe("codex");
      if (res.kind !== "codex") throw new Error("expected codex");
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/include a model id/i);
    });
  });

  // ── cloud-egress gating (inference.allowRemoteInference) ────────────

  it("blocks an anthropic assignment when remote inference is off", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(configWithAssignments({ agent: "anthropic/claude-sonnet-4-6" }));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("anthropic");
    if (res.kind !== "anthropic") throw new Error("expected anthropic");
    expect(res.allowRemoteInference).toBe(false);
    expect(res.reason).toMatch(/allowRemoteInference/);
  });

  it("permits an anthropic assignment when remote inference is on", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(
      configWithAssignments(
        { agent: "anthropic/claude-sonnet-4-6" },
        { allowRemoteInference: true },
      ),
    );

    const res = reg.resolve("agent");
    if (res.kind !== "anthropic") throw new Error("expected anthropic");
    expect(res.allowRemoteInference).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("blocks a codex assignment when remote inference is off", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: "codex/gpt-5.4" }));

    const res = reg.resolve("agent");
    if (res.kind !== "codex") throw new Error("expected codex");
    expect(res.allowRemoteInference).toBe(false);
    expect(res.reason).toMatch(/allowRemoteInference/);
  });

  it("flags a remote-off cloud agent as a degraded role for /status", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(configWithAssignments({ agent: "anthropic/claude-sonnet-4-6" }));

    const degraded = reg.degradedAssignments();
    expect(degraded.some((d) => d.role === "agent" && /allowRemoteInference/.test(d.reason))).toBe(
      true,
    );
  });

  it("does not flag a remote-on cloud agent as degraded", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(
      configWithAssignments(
        { agent: "anthropic/claude-sonnet-4-6" },
        { allowRemoteInference: true },
      ),
    );

    expect(reg.degradedAssignments().some((d) => d.role === "agent")).toBe(false);
  });

  it("does not egress-flag a cloud assignment on a local-only role (e.g. embedder)", () => {
    // embedder/ocr/transcriber reject cloud backends regardless of the
    // flag, so a nonsensical cloud assignment there is not an egress problem —
    // "enable remote inference" would be non-actionable advice.
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig(configWithAssignments({ embedder: "anthropic/claude-haiku-4-5-20251001" }));

    expect(reg.degradedAssignments().some((d) => d.role === "embedder")).toBe(false);
  });

  // ── transcriber role ───────────────────────────────────────────

  it("resolves undefined for transcriber as disabled (no catalog default)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));

    expect(reg.resolve("transcriber").kind).toBe("disabled");
  });

  it("resolves an assigned local Whisper model when the file exists", () => {
    const reg = makeRegistry();
    installGguf("ggml-small.bin", "whisper-small");
    reg.loadConfig(configWithAssignments({ transcriber: "local/whisper-small" }));

    const res = reg.resolve("transcriber");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.catalogId).toBe("whisper-small");
    expect(res.available).toBe(true);
    expect(res.modelPath).toMatch(/ggml-small\.bin$/);
  });

  it("resolves an assigned Whisper model as unavailable when not installed", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ transcriber: "local/whisper-small" }));

    const res = reg.resolve("transcriber");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.available).toBe(false);
  });

  it("resolves transcriber = replay as the replay backend", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ transcriber: "replay" }));

    expect(reg.resolve("transcriber").kind).toBe("replay");
  });

  // ── ocr role ───────────────────────────────────────────────────

  it("resolves undefined for ocr as disabled (no catalog default)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));

    expect(reg.resolve("ocr").kind).toBe("disabled");
  });

  it("resolves the built-in native OCR runtimes to local with a nativeRuntime", () => {
    const reg = makeRegistry();
    for (const runtime of ["apple-vision", "tesseract", "gguf"] as const) {
      reg.loadConfig(configWithAssignments({ ocr: runtime }));
      const res = reg.resolve("ocr");
      expect(res.kind).toBe("local");
      if (res.kind !== "local") throw new Error("expected local");
      expect(res.nativeRuntime).toBe(runtime);
      expect(res.modelPath).toBe("");
    }
  });

  it("apple-vision OCR availability tracks the gateway platform", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ ocr: "apple-vision" }));
    const res = reg.resolve("ocr");
    if (res.kind !== "local") throw new Error("expected local");
    // Reported available only on macOS; tesseract/gguf are reported available
    // and the OCR loader is authoritative for those.
    expect(res.available).toBe(process.platform === "darwin");
  });

  it("resolves an ocr backend/model string as HTTP (a self-hosted vision server)", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { vllm: { type: "http", url: "http://localhost:8000" } },
        assignments: { ocr: "vllm/dots.ocr" },
      },
    } as OmnesisConfig);

    const res = reg.resolve("ocr");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.backendKey).toBe("vllm");
    expect(res.model).toBe("dots.ocr");
  });

  it("resolves ocr = replay as the replay backend", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ ocr: "replay" }));

    expect(reg.resolve("ocr").kind).toBe("replay");
  });

  // ── unknown backend prefix ─────────────────────────────────────

  it("resolves an unknown backend prefix as unresolved", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: "no-such-backend/model" }));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("unresolved");
    if (res.kind !== "unresolved") throw new Error("expected unresolved");
    expect(res.reason).toMatch(/Unknown backend/i);
  });

  // ── null → disabled ─────────────────────────────────────────────

  it("resolves null as disabled", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ embedder: null }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("disabled");
  });

  // ── undefined / omitted → catalog default ───────────────────────

  it("resolves undefined as the catalog default for the role", () => {
    const reg = makeRegistry();
    // Install the recommended embedder so it is available
    installGguf("nomic-embed-text-v1.5.Q8_0.gguf");
    reg.loadConfig(configWithAssignments({}));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    // The default embed model is the recommended one: nomic
    expect(res.catalogId).toBe("nomic-embed-text-v1.5.Q8_0");
    expect(res.available).toBe(true);
  });

  it("resolves undefined for agent as disabled (no catalog default)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));

    const res = reg.resolve("agent");
    expect(res.kind).toBe("disabled");
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it("resolves an unknown catalog id as local but unavailable", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ embedder: "totally-unknown-model" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.catalogId).toBe("totally-unknown-model");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not found/i);
    expect(res.catalogEntry).toBeUndefined();
  });

  it("resolves a known catalog id as unavailable when the model file is missing", () => {
    const reg = makeRegistry();
    // Don't install the file — just configure the assignment
    reg.loadConfig(configWithAssignments({ embedder: "nomic-embed-text-v1.5.Q8_0" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
    if (res.kind !== "local") throw new Error("expected local");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not found/i);
    // Catalog entry is still populated even when the file is missing
    expect(res.catalogEntry).toBeDefined();
  });

  it("resolves an unknown HTTP backend key as unresolved", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ embedder: "no-such-backend/x" }));

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("unresolved");
    if (res.kind !== "unresolved") throw new Error("expected unresolved");
    expect(res.reason).toMatch(/Unknown backend/i);
  });

  it("resolves HTTP backend as unavailable when the backend is unreachable", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { myserver: { type: "http", url: "http://localhost:9999" } },
        assignments: {
          embedder: "myserver/m",
        },
      },
    });

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("http");
    if (res.kind !== "http") throw new Error("expected http");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/probing/i);
  });
});

// ── loadConfig ───────────────────────────────────────────────────────

describe("InferenceRegistry.loadConfig", () => {
  it("parses backends and assignments from config", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:8000" },
        },
        assignments: {
          embedder: "vllm/my-embed",
          "privacy-reviewer": "anthropic/claude-haiku-4-5-20251001",
          transcriber: null,
          agent: "replay",
        },
      },
    });

    simulateBackendOk(reg, "vllm", ["my-embed"]);
    expect(reg.resolve("embedder").kind).toBe("http");
    expect(reg.resolve("privacy-reviewer").kind).toBe("anthropic");
    expect(reg.resolve("transcriber").kind).toBe("disabled");
    expect(reg.resolve("agent").kind).toBe("replay");
  });

  it("handles empty inference block gracefully", () => {
    const reg = makeRegistry();
    reg.loadConfig({});

    // embedder has a catalog default (nomic) — resolves as local (unavailable since file is missing)
    expect(reg.resolve("embedder").kind).toBe("local");
    // agent, transcriber, ocr have no defaults — disabled when omitted
    expect(reg.resolve("agent").kind).toBe("disabled");
    expect(reg.resolve("transcriber").kind).toBe("disabled");
    expect(reg.resolve("ocr").kind).toBe("disabled");
  });

  it("handles missing inference.backends gracefully", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        assignments: { embedder: "nomic-embed-text-v1.5.Q8_0" },
      },
    });

    const res = reg.resolve("embedder");
    expect(res.kind).toBe("local");
  });

  it("handles missing inference.assignments gracefully", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { vllm: { type: "http", url: "http://localhost:8000" } },
      },
    });

    // Embedder falls back to catalog default
    expect(reg.resolve("embedder").kind).toBe("local");
  });

  it("re-probes when only the apiKey changes for the same url", async () => {
    // A backend that first probed unreachable because of a wrong key must
    // re-probe (and recover) once the key is corrected, even though the url
    // is unchanged — reachability depends on the Authorization header.
    const reg = makeRegistry();

    // First probe fails on a bad key. Track the in-flight re-probe so the
    // assertion observes the status loadConfig schedules, not a manual probe.
    const probeSpy = vi.spyOn(reg, "probeBackends");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer right-key") {
        return new Response(JSON.stringify({ data: [{ id: "the-model" }] }), { status: 200 });
      }
      return new Response("unauthorized", { status: 401 });
    };

    try {
      reg.loadConfig({
        inference: {
          backends: {
            openai: { type: "http", url: "http://localhost:18080", apiKey: "wrong-key" },
          },
        },
      });
      await Promise.all(probeSpy.mock.results.map((r) => r.value));
      expect(reg.getOverview().backends["openai"].status).toBe("unreachable");

      // Correct the key only — same url. The re-probe must fire and recover.
      reg.loadConfig({
        inference: {
          backends: {
            openai: { type: "http", url: "http://localhost:18080", apiKey: "right-key" },
          },
        },
      });
      await Promise.all(probeSpy.mock.results.map((r) => r.value));

      expect(reg.getOverview().backends["openai"].status).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
      probeSpy.mockRestore();
    }
  });
});

// ── getOverview ──────────────────────────────────────────────────────

describe("InferenceRegistry.getOverview", () => {
  it("returns the local backend by default", () => {
    const reg = makeRegistry();
    reg.loadConfig({});

    const overview = reg.getOverview();
    expect(overview.backends["local"]).toEqual({ type: "local", status: "ok" });
  });

  it("includes the Anthropic backend when the API key is present", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: true });
    reg.loadConfig({});

    const overview = reg.getOverview();
    expect(overview.backends["anthropic"]).toEqual({
      type: "anthropic",
      status: "ok",
      hasApiKey: true,
    });
  });

  it("surfaces the live Anthropic discovery status", () => {
    const reg = makeRegistry({
      hasAnthropicApiKey: true,
      getAnthropicStatus: () => ({
        type: "anthropic",
        status: "unreachable",
        hasApiKey: true,
        models: ["claude-sonnet-5"],
        reason: "temporary outage",
      }),
    });
    reg.loadConfig({});

    expect(reg.getOverview().backends["anthropic"]).toEqual({
      type: "anthropic",
      status: "unreachable",
      hasApiKey: true,
      models: ["claude-sonnet-5"],
      reason: "temporary outage",
    });
  });

  it("omits the Anthropic backend when there is no API key", () => {
    const reg = makeRegistry({ hasAnthropicApiKey: false });
    reg.loadConfig({});

    const overview = reg.getOverview();
    expect(overview.backends["anthropic"]).toBeUndefined();
  });

  it("includes HTTP backend statuses", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:8000" },
        },
      },
    });

    const overview = reg.getOverview();
    expect(overview.backends["vllm"]).toBeDefined();
    expect(overview.backends["vllm"].type).toBe("http");
    expect(overview.backends["vllm"].url).toBe("http://localhost:8000");
  });

  it("returns resolved assignments for every role, including transcriber", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ "background-agent": null }));

    const overview = reg.getOverview();
    expect(overview.assignments.embedder).toBeDefined();
    expect(overview.assignments["background-agent"]).toBeDefined();
    expect(overview.assignments["background-agent"].kind).toBe("disabled");
    expect(overview.assignments["watch-judge"]).toBeDefined();
    expect(overview.assignments["watch-judge"].kind).toBe("disabled");
    expect(overview.assignments.agent).toBeDefined();
    expect(overview.assignments.agent.kind).toBe("disabled");
    expect(overview.assignments["privacy-reviewer"]).toBeDefined();
    expect(overview.assignments["privacy-reviewer"].kind).toBe("disabled");
    expect(overview.assignments.transcriber).toBeDefined();
    expect(overview.assignments.transcriber.kind).toBe("disabled");
    expect(overview.assignments.ocr).toBeDefined();
    expect(overview.assignments.ocr.kind).toBe("disabled");
  });

  it("surfaces no model suggestions before a backend has probed", () => {
    // Without a successful probe there is no live `/models` list, and presets
    // carry no hardcoded ids — so the portal shows nothing rather than a
    // potentially stale suggestion.
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { openai: { type: "http", url: "http://localhost:18086" } },
      },
    });

    expect(reg.getOverview().backends["openai"].modelRoles ?? {}).toEqual({});
  });

  it("uses live probed models only", async () => {
    // The live `/models` list is the sole source of model suggestions.
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { openai: { type: "http", url: "http://localhost:55555" } },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "my-custom-llm" }] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      await reg.probeBackends();
      const roles = reg.getOverview().backends["openai"].modelRoles ?? {};
      // Live models are classified.
      expect(roles["my-custom-llm"]).toEqual([
        "agent",
        "privacy-reviewer",
        "background-agent",
        "watch-judge",
        "entailment-verifier",
        "brief-judge",
      ]);
      expect(roles["gpt-4o"]).toEqual([
        "agent",
        "privacy-reviewer",
        "background-agent",
        "watch-judge",
        "entailment-verifier",
        "brief-judge",
      ]);
      // Anything not served by the live probe is absent.
      expect(roles["text-embedding-3-small"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces no suggestions when a backend has not probed OK", () => {
    // Without a successful probe (no key, unreachable), there are no
    // suggestions to show.
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { openai: { type: "http", url: "http://localhost:55555" } },
      },
    });
    // No probe run → status is "probing"; modelRoles is empty.
    expect(reg.getOverview().backends["openai"].modelRoles ?? {}).toEqual({});
  });
});

// ── probeBackends ────────────────────────────────────────────────────

describe("InferenceRegistry.probeBackends", () => {
  it("sets status to ok and discovers models on a successful probe", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:55555" },
        },
      },
    });

    // Mock fetch for the probe
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      await reg.probeBackends();
      const overview = reg.getOverview();
      expect(overview.backends["vllm"].status).toBe("ok");
      expect(overview.backends["vllm"].models).toEqual(["model-a", "model-b"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies probed served models into modelRoles by purpose", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:55555" },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "nomic-embed-text" }, { id: "qwen3-8b" }] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    try {
      await reg.probeBackends();
      const roles = reg.getOverview().backends["vllm"].modelRoles ?? {};
      expect(roles["nomic-embed-text"]).toEqual(["embedder"]);
      expect(roles["qwen3-8b"]).toEqual([
        "agent",
        "privacy-reviewer",
        "background-agent",
        "watch-judge",
        "entailment-verifier",
        "brief-judge",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses verified modalities and tool calling to prune unsuitable text suggestions", async () => {
    const reg = new InferenceRegistry({
      modelsDir: "/tmp/omnesis-model-roles-test",
      configDir: "/tmp/omnesis-model-roles-test",
      manifest: () => ({ version: 1, models: [] }),
      hasAnthropicApiKey: () => false,
      getModelControls: (_backend, model) => ({
        providerId: "example",
        source: "models.dev",
        reasoning: false,
        controls: [],
        modalities:
          model === "picture-maker"
            ? { input: ["text"], output: ["image"] }
            : { input: ["text"], output: ["text"] },
        toolCall: model !== "text-only-judge",
        logoUrl: "/model-logos/example.svg",
      }),
    });
    reg.loadConfig({
      inference: { backends: { example: { type: "http", url: "http://localhost:55555" } } },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "picture-maker" }, { id: "text-only-judge" }, { id: "unknown-model" }],
        }),
        { status: 200 },
      );
    try {
      await reg.probeBackends();
      const roles = reg.getOverview().backends.example.modelRoles ?? {};
      expect(roles["picture-maker"]).toEqual([]);
      expect(roles["text-only-judge"]).not.toContain("agent");
      expect(roles["text-only-judge"]).toContain("brief-judge");
      expect(roles["unknown-model"]).toContain("agent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sets status to reachable (not unreachable) when the host answers but /models fails", async () => {
    // Fireworks' /v1/models returns HTTP 500 for accounts without dedicated
    // deployments, yet the backend serves inference fine. The host answered,
    // so it's reachable — only the model list is unavailable.
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:55555" },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("error", { status: 500 });

    try {
      await reg.probeBackends();
      const overview = reg.getOverview();
      expect(overview.backends["vllm"].status).toBe("reachable");
      expect(overview.backends["vllm"].reason).toBe("HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps status unreachable on an auth failure (401/403) so a bad key is loud", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:55555", apiKey: "bad" },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });

    try {
      await reg.probeBackends();
      const overview = reg.getOverview();
      expect(overview.backends["vllm"].status).toBe("unreachable");
      expect(overview.backends["vllm"].reason).toBe("HTTP 403");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves a reachable backend's explicitly-assigned model as available", async () => {
    // A backend whose /models couldn't be listed is still usable when the
    // assignment names a model id — auto-discovery is off, inference isn't.
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { fireworks: { type: "http", url: "http://localhost:55555" } },
        assignments: { agent: "fireworks/accounts/fireworks/models/deepseek-v4-flash" },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("error", { status: 500 });

    try {
      await reg.probeBackends();
      const res = reg.resolve("agent");
      expect(res.kind).toBe("http");
      if (res.kind !== "http") throw new Error("expected http");
      expect(res.available).toBe(true);
      expect(res.model).toBe("accounts/fireworks/models/deepseek-v4-flash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sets status to unreachable on a network error", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:55555" },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Connection refused");
    };

    try {
      await reg.probeBackends();
      const overview = reg.getOverview();
      expect(overview.backends["vllm"].status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── probeBackend (single) ────────────────────────────────────────────

describe("InferenceRegistry.probeBackend", () => {
  it("refuses non-loopback backend URLs by default before fetch", async () => {
    const reg = makeRegistry();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      reg.loadConfig({
        inference: {
          assignments: { agent: "remote/example-model" },
          backends: {
            remote: { type: "http", url: "https://203.0.113.10" },
          },
        },
      });
      const result = await reg.probeBackend("remote");
      expect(result.status).toBe("unreachable");
      expect(result.reason).toMatch(/allowRemoteInference=true/);
      expect(reg.resolve("agent")).toMatchObject({
        kind: "http",
        available: false,
        reasonCode: "remote_inference_disabled",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows non-loopback backend URLs only after explicit remote opt-in", async () => {
    const reg = makeRegistry();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: [{ id: "remote-model" }] }))),
      );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      reg.loadConfig({
        inference: {
          allowRemoteInference: true,
          backends: {
            remote: { type: "http", url: "https://203.0.113.10" },
          },
        },
      });
      const result = await reg.probeBackend("remote");
      expect(result.status).toBe("ok");
      expect(result.models).toEqual(["remote-model"]);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://203.0.113.10/v1/models");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the backend's API key and returns ok + discovered models", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          openai: { type: "http", url: "http://localhost:18080", apiKey: "sk-test-123" },
        },
      },
    });

    let sentAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      sentAuth = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 });
    };

    try {
      const result = await reg.probeBackend("openai");
      expect(sentAuth).toBe("Bearer sk-test-123");
      expect(result.status).toBe("ok");
      expect(result.models).toEqual(["gpt-x"]);
      expect(reg.getOverview().backends["openai"].status).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns unreachable with a reason on a non-OK HTTP response", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          openai: { type: "http", url: "http://localhost:18080", apiKey: "sk-bad" },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 401 });

    try {
      const result = await reg.probeBackend("openai");
      expect(result.status).toBe("unreachable");
      expect(result.reason).toBe("HTTP 401");
      expect(reg.getOverview().backends["openai"].status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns unreachable for an unknown backend without probing", async () => {
    const reg = makeRegistry();
    reg.loadConfig({});

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("", { status: 200 });
    };

    try {
      const result = await reg.probeBackend("nonexistent");
      expect(result.status).toBe("unreachable");
      expect(result.reason).toContain("nonexistent");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── getBackendApiKey ────────────────────────────────────────────────

describe("InferenceRegistry.getBackendApiKey", () => {
  it("applies saved native behavior only while the exact Codex assignment is active", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: { agent: "codex/gpt-5.4" },
        modelSettings: {
          agent: { assignment: "codex/gpt-5.4", values: { reasoningEffort: "high" } },
        },
      },
    });
    expect(reg.resolve("agent")).toMatchObject({
      kind: "codex",
      model: "gpt-5.4",
      modelBehavior: { reasoningEffort: "high" },
    });

    reg.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: { agent: "codex/gpt-5.5" },
        modelSettings: {
          agent: { assignment: "codex/gpt-5.4", values: { reasoningEffort: "high" } },
        },
      },
    });
    expect(reg.resolve("agent")).not.toHaveProperty("modelBehavior");
  });

  it("applies saved native behavior only while the exact HTTP assignment is active", () => {
    const facts = {
      providerId: "openai",
      source: "models.dev" as const,
      reasoning: true,
      controls: [
        {
          key: "reasoningEffort" as const,
          type: "enum" as const,
          label: "Reasoning effort",
          values: ["low", "high"],
        },
      ],
      logoUrl: "/model-logos/openai.svg",
    };
    const reg = new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => false,
      getModelControls: () => facts,
    });
    reg.loadConfig({
      inference: {
        backends: { openai: { type: "http", url: "http://localhost:18086", model: "gpt-example" } },
        assignments: { agent: "openai/gpt-example" },
        modelSettings: {
          agent: { assignment: "openai/gpt-example", values: { reasoningEffort: "high" } },
        },
      },
    });
    expect(reg.resolve("agent")).toMatchObject({
      kind: "http",
      modelControls: facts,
      modelBehavior: { reasoningEffort: "high" },
    });
    reg.loadConfig({
      inference: {
        backends: { openai: { type: "http", url: "http://localhost:18086", model: "other-model" } },
        assignments: { agent: "openai/other-model" },
        modelSettings: {
          agent: { assignment: "openai/gpt-example", values: { reasoningEffort: "high" } },
        },
      },
    });
    const switched = reg.resolve("agent");
    expect(switched.kind).toBe("http");
    if (switched.kind !== "http") throw new Error("expected HTTP assignment");
    expect(switched.modelBehavior).toBeUndefined();
  });

  it("returns the apiKey for a backend that has one", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          openai: { type: "http", url: "http://localhost:18086", apiKey: "sk-test-123" },
        },
      },
    });

    expect(reg.getBackendApiKey("openai")).toBe("sk-test-123");
  });

  it("resolves apiKeySecret references for HTTP backends", () => {
    const ref = writeConfigSecretSync("inference.backend.openai.apiKey", "sk-secret-ref", {
      backend: "file",
      configDir,
    });
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          openai: { type: "http", url: "http://localhost:18086", apiKeySecret: ref },
        },
      },
    });

    expect(reg.getBackendApiKey("openai")).toBe("sk-secret-ref");
    expect(reg.getOverview().backends["openai"].hasApiKey).toBe(true);
  });

  it("marks backends with unreadable apiKeySecret references unavailable", async () => {
    const ref = makeConfigSecretRef("inference.backend.openai.missing");
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          openai: { type: "http", url: "http://localhost:18086", apiKeySecret: ref },
        },
        assignments: { embedder: "openai/text-embedding-3-small" },
      },
    });

    const status = reg.getOverview().backends["openai"];
    expect(status.status).toBe("unreachable");
    expect(status.reason).toMatch(/missing or unreadable/);
    expect(reg.getBackendApiKey("openai")).toBeUndefined();

    const resolved = reg.resolve("embedder");
    expect(resolved.kind).toBe("http");
    if (resolved.kind !== "http") throw new Error("expected http");
    expect(resolved.available).toBe(false);
    expect(resolved.reason).toMatch(/missing or unreadable/);

    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const probe = await reg.probeBackend("openai");
      expect(probe.status).toBe("unreachable");
      expect(probe.reason).toMatch(/missing or unreadable/);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns undefined for a backend without an apiKey", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          vllm: { type: "http", url: "http://localhost:8000" },
        },
      },
    });

    expect(reg.getBackendApiKey("vllm")).toBeUndefined();
  });

  it("returns undefined for a non-existent backend", () => {
    const reg = makeRegistry();
    reg.loadConfig({});

    expect(reg.getBackendApiKey("nonexistent")).toBeUndefined();
  });

  it("exposes hasApiKey in the overview backend status", () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          withkey: { type: "http", url: "http://localhost:18081", apiKey: "sk-key" },
          nokey: { type: "http", url: "http://localhost:8000" },
        },
      },
    });

    const overview = reg.getOverview();
    expect(overview.backends["withkey"].hasApiKey).toBe(true);
    expect(overview.backends["nokey"].hasApiKey).toBe(false);
  });
});

// ── apiPathPrefix ────────────────────────────────────────────────────

describe("InferenceRegistry — apiPathPrefix", () => {
  // loadConfig fires a fire-and-forget probe. Stub both DNS and fetch so URL
  // normalization exercises the real address policy without external network
  // dependencies or probes still resolving after the fixture is restored.
  let savedFetch: typeof globalThis.fetch;
  let restoreLookup: () => void;
  let lastProbedUrl = "";
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    // The URL policy uses the all-addresses overload; retain that mock type.
    const resolver: {
      lookup(hostname: string, options: { all: true }): Promise<LookupAddress[]>;
    } = dns;
    const lookup = vi.spyOn(resolver, "lookup").mockImplementation((hostname) => {
      if (hostname === "localhost") return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
      if (hostname === "integrate.api.nvidia.com" || hostname === "api.groq.com") {
        return Promise.resolve([{ address: "203.0.113.10", family: 4 }]);
      }
      return Promise.reject(new Error(`Unexpected inference fixture hostname: ${hostname}`));
    });
    restoreLookup = () => lookup.mockRestore();
    lastProbedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      lastProbedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }), { status: 200 });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    restoreLookup();
  });

  it("probes the /models endpoint under a custom prefix", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          gemini: { type: "http", url: "http://localhost:18082", apiPathPrefix: "/v1beta/openai" },
        },
      },
    });
    await reg.probeBackends();
    expect(lastProbedUrl).toBe("http://localhost:18082/v1beta/openai/models");
  });

  it("carries apiPathPrefix onto the resolved http assignment and overview", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          gemini: { type: "http", url: "http://localhost:18082", apiPathPrefix: "/v1beta/openai" },
        },
        assignments: { agent: "gemini/gemini-2.5-flash" },
      },
    });
    await reg.probeBackends();
    const resolved = reg.resolve("agent");
    expect(resolved.kind).toBe("http");
    if (resolved.kind === "http") expect(resolved.apiPathPrefix).toBe("/v1beta/openai");
    expect(reg.getOverview().backends["gemini"].apiPathPrefix).toBe("/v1beta/openai");
  });

  it("heals a legacy Gemini backend whose URL still carries /v1beta/openai", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          // Saved before per-backend prefixes existed: version path baked in,
          // no explicit prefix.
          gemini: { type: "http", url: "http://localhost:18082/v1beta/openai" },
        },
        assignments: { agent: "gemini/gemini-2.5-flash" },
      },
    });
    await reg.probeBackends();
    const resolved = reg.resolve("agent");
    expect(resolved.kind).toBe("http");
    if (resolved.kind === "http") {
      expect(resolved.url).toBe("http://localhost:18082");
      expect(resolved.apiPathPrefix).toBe("/v1beta/openai");
    }
  });

  it("heals OpenAI SDK-style backend URLs whose URL already carries /v1", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          nvidia: { type: "http", url: "https://integrate.api.nvidia.com/v1" },
        },
        assignments: { agent: "nvidia/deepseek-ai/deepseek-v4-flash" },
        allowRemoteInference: true,
      },
    });
    await reg.probeBackends();
    const resolved = reg.resolve("agent");
    expect(resolved.kind).toBe("http");
    if (resolved.kind === "http") {
      expect(resolved.url).toBe("https://integrate.api.nvidia.com");
      expect(resolved.apiPathPrefix).toBe("/v1");
    }
    expect(lastProbedUrl).toBe("https://integrate.api.nvidia.com/v1/models");
  });

  it("preserves backend base paths when healing a trailing /v1", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: {
          groq: { type: "http", url: "https://api.groq.com/openai/v1" },
        },
        allowRemoteInference: true,
      },
    });
    await reg.probeBackends();
    expect(lastProbedUrl).toBe("https://api.groq.com/openai/v1/models");
    const overview = reg.getOverview().backends["groq"];
    expect(overview.url).toBe("https://api.groq.com/openai");
    expect(overview.apiPathPrefix).toBe("/v1");
  });

  it("still refuses remote inference without opt-in after resolving a fixture hostname", async () => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: {
        backends: { nvidia: { type: "http", url: "https://integrate.api.nvidia.com/v1" } },
      },
    });
    await reg.probeBackends();
    expect(lastProbedUrl).toBe("");
    expect(reg.getOverview().backends["nvidia"]).toMatchObject({
      status: "unreachable",
      reason: expect.stringContaining("allowRemoteInference=true"),
    });
  });

  it("re-probes when only the apiPathPrefix changes", async () => {
    const reg = makeRegistry();
    const base = { type: "http" as const, url: "http://localhost:18087" };
    reg.loadConfig({ inference: { backends: { b: { ...base, apiPathPrefix: "/v1" } } } });
    simulateBackendOk(reg, "b", ["m"]);
    expect(reg.getOverview().backends["b"].status).toBe("ok");

    // Changing only the prefix must invalidate the cached "ok" status (checked
    // synchronously, before the new probe resolves).
    reg.loadConfig({ inference: { backends: { b: { ...base, apiPathPrefix: "/v2" } } } });
    expect(reg.getOverview().backends["b"].status).toBe("probing");
    await reg.probeBackends();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function configWithAssignments(
  assignments: Record<string, unknown>,
  opts?: { allowRemoteInference?: boolean },
): OmnesisConfig {
  return {
    inference: {
      allowRemoteInference: opts?.allowRemoteInference,
      assignments: assignments as OmnesisConfig["inference"] extends
        | { assignments?: infer A }
        | undefined
        ? A
        : never,
    },
  };
}

function withExperimentalEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.OMNESIS_EXPERIMENTAL;
  try {
    if (value === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = value;
    fn();
  } finally {
    if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = previous;
  }
}

/**
 * Reach into the registry's private httpBackends map to simulate a
 * successful probe without making real HTTP calls. This keeps the
 * unit tests fast and deterministic.
 */
function simulateBackendOk(reg: InferenceRegistry, key: string, models: string[]): void {
  // Access the private map via bracket notation (test-only escape hatch)
  const backends = (
    reg as unknown as {
      httpBackends: Map<
        string,
        {
          config: { url: string };
          status: { type: string; url: string; status: string; models?: string[] };
        }
      >;
    }
  ).httpBackends;
  const entry = backends.get(key);
  if (!entry) throw new Error(`Backend "${key}" not found in registry`);
  entry.status = {
    type: "http",
    url: entry.config.url,
    status: "ok",
    models,
  };
}

// ── verifyModel() — behavioral capability probe ──────────────

describe("InferenceRegistry.verifyModel", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const jsonRes = (obj: unknown, status = 200): Response =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  /** Route POSTs by endpoint suffix; everything else (e.g. the /models probe) returns an empty list. */
  function routeFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      for (const [suffix, make] of Object.entries(routes)) {
        if (u.endsWith(suffix)) return make();
      }
      return jsonRes({ data: [] }); // /models probe and anything unrouted
    });
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    return fn;
  }

  const withBackend = (): InferenceRegistry => {
    const reg = makeRegistry();
    reg.loadConfig({
      inference: { backends: { vllm: { type: "http", url: "http://localhost:8000" } } },
    } as OmnesisConfig);
    return reg;
  };

  it("confirms an embedder when /embeddings returns a vector", async () => {
    routeFetch({ "/embeddings": () => jsonRes({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) });
    const v = await withBackend().verifyModel("vllm", "bge-small", "embedder");
    expect(v.supported).toBe(true);
    expect(v.detail).toMatch(/3-dim/);
  });

  it("rejects an embedder when /embeddings 404s (chat-only server)", async () => {
    routeFetch({ "/embeddings": () => jsonRes({ detail: "Not Found" }, 404) });
    const v = await withBackend().verifyModel("vllm", "qwen-chat", "embedder");
    expect(v.supported).toBe(false);
    expect(v.detail).toMatch(/404/);
  });

  it("confirms an agent via chat-completions", async () => {
    routeFetch({
      "/chat/completions": () => jsonRes({ choices: [{ message: { content: "ok" } }] }),
    });
    const v = await withBackend().verifyModel("vllm", "qwen-chat", "agent");
    expect(v.supported).toBe(true);
    expect(v.detail).toMatch(/chat-completions/);
  });

  it("confirms a privacy reviewer via chat-completions", async () => {
    routeFetch({
      "/chat/completions": () => jsonRes({ choices: [{ message: { content: "ok" } }] }),
    });
    const v = await withBackend().verifyModel("vllm", "qwen-chat", "privacy-reviewer");
    expect(v.supported).toBe(true);
    expect(v.detail).toMatch(/chat-completions/);
  });

  it("falls back to /responses for an agent-only model that 404s on chat-completions", async () => {
    routeFetch({
      "/chat/completions": () =>
        jsonRes({ error: { message: "This model is only supported in v1/responses." } }, 404),
      "/responses": () => jsonRes({ status: "completed", output: [] }),
    });
    const v = await withBackend().verifyModel("vllm", "o1-pro", "agent");
    expect(v.supported).toBe(true);
    expect(v.detail).toMatch(/Responses API/i);
  });

  it("confirms an entailment verifier via chat-completions (and never tries /responses)", async () => {
    const fn = routeFetch({
      "/chat/completions": () => jsonRes({ choices: [{ message: { content: "ok" } }] }),
    });
    const v = await withBackend().verifyModel("vllm", "qwen-chat", "entailment-verifier");
    expect(v.supported).toBe(true);
    // The /responses fallback is agent-only — the entailment verifier speaks
    // only chat-completions and must not reach for it.
    expect(fn.mock.calls.some((call) => String(call[0]).endsWith("/responses"))).toBe(false);
  });

  it("requires chat-completions for a Watch judge and never falls back to /responses", async () => {
    const fn = routeFetch({
      "/chat/completions": () =>
        jsonRes({ error: { message: "This model is only supported in v1/responses." } }, 404),
      "/responses": () => jsonRes({ status: "completed", output: [] }),
    });
    const v = await withBackend().verifyModel("vllm", "responses-only", "watch-judge");
    expect(v.supported).toBe(false);
    expect(fn.mock.calls.some((call) => String(call[0]).endsWith("/responses"))).toBe(false);
  });

  it("reports unsupported for roles that aren't behaviorally probed (transcriber/ocr)", async () => {
    routeFetch({});
    const reg = withBackend();
    for (const role of ["transcriber", "ocr"] as const) {
      const v = await reg.verifyModel("vllm", "whisper", role);
      expect(v.supported).toBe(false);
      expect(v.detail).toMatch(/not supported/i);
    }
  });

  it("invalidates the cache when the backend is removed", async () => {
    const fn = routeFetch({ "/embeddings": () => jsonRes({ data: [{ embedding: [0.1] }] }) });
    const reg = withBackend();
    await reg.verifyModel("vllm", "m", "embedder");
    reg.loadConfig({ inference: { backends: {} } } as OmnesisConfig); // drop the backend
    reg.loadConfig({
      inference: { backends: { vllm: { type: "http", url: "http://localhost:8000" } } },
    } as OmnesisConfig); // re-add
    await reg.verifyModel("vllm", "m", "embedder");
    const embedCalls = fn.mock.calls.filter((call) =>
      String(call[0]).endsWith("/embeddings"),
    ).length;
    expect(embedCalls).toBe(2); // verdict was dropped when the backend was removed
  });

  it("caches the verdict and re-probes only with force", async () => {
    const fn = routeFetch({ "/embeddings": () => jsonRes({ data: [{ embedding: [0.1] }] }) });
    const reg = withBackend();
    await reg.verifyModel("vllm", "m", "embedder");
    await reg.verifyModel("vllm", "m", "embedder");
    const embedCalls = () =>
      fn.mock.calls.filter((c) => String(c[0]).endsWith("/embeddings")).length;
    expect(embedCalls()).toBe(1); // second call served from cache
    await reg.verifyModel("vllm", "m", "embedder", { force: true });
    expect(embedCalls()).toBe(2);
  });

  it("invalidates the cache when the backend URL changes", async () => {
    const fn = routeFetch({ "/embeddings": () => jsonRes({ data: [{ embedding: [0.1] }] }) });
    const reg = withBackend();
    await reg.verifyModel("vllm", "m", "embedder");
    reg.loadConfig({
      inference: { backends: { vllm: { type: "http", url: "http://localhost:9999" } } },
    } as OmnesisConfig);
    await reg.verifyModel("vllm", "m", "embedder");
    const embedCalls = fn.mock.calls.filter((c) => String(c[0]).endsWith("/embeddings")).length;
    expect(embedCalls).toBe(2); // cache cleared → re-probed
  });

  it("reports unsupported for an unknown backend", async () => {
    const v = await makeRegistry().verifyModel("nope", "m", "embedder");
    expect(v.supported).toBe(false);
    expect(v.detail).toMatch(/unknown backend/i);
  });
});

// ── degradedAssignments() / configHealth() ───────────────────────────
//
// A degraded role is one whose assignment points at a model/backend that
// doesn't resolve (a typo / dangling reference). An intentionally-unset
// (null) or omitted role is a NORMAL state and must never be reported as
// degraded — the fail-loud-not-false-green distinction the gate enforces.

describe("InferenceRegistry.degradedAssignments / configHealth", () => {
  it("flags a role assigned to a non-existent backend as degraded, naming the role + reason", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: "missing-backend/example-model" }));

    const degraded = reg.degradedAssignments();
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.role).toBe("agent");
    expect(degraded[0]!.reason).toMatch(/missing-backend/);

    const health = reg.configHealth();
    expect(health.degradedRoles).toEqual(degraded);
    // lastConfigError names which role and why — not a generic "degraded".
    expect(health.lastConfigError).toMatch(/agent/);
    expect(health.lastConfigError).toMatch(/missing-backend/);
  });

  it("does NOT flag an intentionally-null role as degraded (normal state)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({ agent: null, transcriber: null }));

    expect(reg.degradedAssignments()).toEqual([]);
    const health = reg.configHealth();
    expect(health.degradedRoles).toEqual([]);
    expect(health.lastConfigError).toBeNull();
  });

  it("does NOT flag an omitted role as degraded (normal state)", () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAssignments({}));

    expect(reg.degradedAssignments()).toEqual([]);
    expect(reg.configHealth().lastConfigError).toBeNull();
  });

  it("reports an empty degradedRoles for a fully-healthy config", () => {
    const reg = makeRegistry();
    installGguf("nomic-embed-text-v1.5.Q8_0.gguf");
    reg.loadConfig(configWithAssignments({ embedder: "nomic-embed-text-v1.5.Q8_0" }));

    expect(reg.degradedAssignments()).toEqual([]);
    const health = reg.configHealth();
    expect(health.degradedRoles).toEqual([]);
    expect(health.lastConfigError).toBeNull();
  });

  it("reports every degraded role when several assignments are typo'd", () => {
    const reg = makeRegistry();
    reg.loadConfig(
      configWithAssignments({
        agent: "missing-backend/a",
        transcriber: "another-missing/b",
      }),
    );

    const roles = reg.degradedAssignments().map((d) => d.role);
    expect(roles).toContain("agent");
    expect(roles).toContain("transcriber");
    expect(reg.configHealth().lastConfigError).toMatch(/agent.*transcriber|transcriber.*agent/);
  });
});

describe("reprobeUnavailable", () => {
  function configWithAgent() {
    return {
      inference: {
        backends: { deepseek: { type: "http" as const, url: "http://localhost:55571" } },
        assignments: { agent: "deepseek/m" },
      },
    };
  }

  it("recovers a backend that was unreachable at boot, without a restart", async () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAgent());

    const originalFetch = globalThis.fetch;
    let up = false;
    globalThis.fetch = async () => {
      if (!up) throw new Error("Connection refused");
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    };
    try {
      await reg.probeBackends(); // boot probe fails
      expect(reg.getOverview().backends["deepseek"].status).toBe("unreachable");
      expect(reg.resolve("agent").available).toBe(false);

      up = true; // network recovers
      const result = await reg.reprobeUnavailable(1_000_000);
      expect(result).toEqual({ down: 1, probed: 1, recovered: 1 });
      expect(reg.getOverview().backends["deepseek"].status).toBe("ok");
      expect(reg.resolve("agent").available).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("is a no-op when every backend is healthy", async () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAgent());
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    };
    try {
      await reg.probeBackends(); // boot probe succeeds → ok
      const before = calls;
      const result = await reg.reprobeUnavailable(1_000_000);
      expect(result).toEqual({ down: 0, probed: 0, recovered: 0 });
      expect(calls).toBe(before); // no re-probe fired
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("backs off a persistently-down backend exponentially (does not hammer)", async () => {
    const reg = makeRegistry();
    reg.loadConfig(configWithAgent());
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("Connection refused");
    };
    const backoff = { baseMs: 1000, maxMs: 8000 };
    try {
      await reg.probeBackends();
      const afterBoot = calls;

      // First tick at t=0: due (no prior state) → probes, fails, schedules +1000ms.
      expect((await reg.reprobeUnavailable(0, backoff)).probed).toBe(1);
      expect(calls).toBe(afterBoot + 1);

      // Still within the 1000ms window → skipped, no fetch.
      expect((await reg.reprobeUnavailable(500, backoff)).probed).toBe(0);
      expect(calls).toBe(afterBoot + 1);

      // Past the window → probes again, fails, next delay doubles to +2000ms.
      expect((await reg.reprobeUnavailable(1000, backoff)).probed).toBe(1);
      expect(calls).toBe(afterBoot + 2);

      // t=2000 is < 1000 + 2000 → still backing off.
      expect((await reg.reprobeUnavailable(2000, backoff)).probed).toBe(0);
      // t=3000 = 1000 + 2000 → eligible again.
      expect((await reg.reprobeUnavailable(3000, backoff)).probed).toBe(1);
      expect(reg.getOverview().backends["deepseek"].status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * A probe crosses the same event loop it is reporting on. When that loop is
 * starved the probe's own timers fire late and the resulting failure describes
 * the gateway rather than the provider. The failure this guards against is a
 * busy gateway switching off a backend that was answering fine.
 */
describe("a probe the gateway was too busy to run says so", () => {
  function configWithAgent() {
    return {
      inference: {
        backends: { deepseek: { type: "http" as const, url: "http://localhost:55571" } },
        assignments: { agent: "deepseek/m" },
      },
    };
  }

  /**
   * Block the loop long enough for the in-probe lag sampler to notice, the way
   * a synchronous full-table scan on an encrypted DB does. Stubbing a clock
   * would not do: the sampler measures timer delivery, which is the thing
   * under test.
   */
  function blockLoop(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* deliberately synchronous */
    }
  }

  /** A fetch that stalls the loop, then fails — the shape of a starved probe. */
  const starvingFetch = (async () => {
    await new Promise((r) => setTimeout(r, 300));
    blockLoop(2_600);
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as unknown as typeof fetch;

  /** A fetch that answers with one model, promptly. */
  const healthyFetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })) as typeof fetch;

  /**
   * Settle the registry on a healthy backend, including the background probe
   * `loadConfig` fires, before any starving stub is installed.
   */
  async function healthyRegistry() {
    const reg = makeRegistry();
    globalThis.fetch = healthyFetch;
    reg.loadConfig(configWithAgent());
    await reg.probeBackends();
    await new Promise((r) => setTimeout(r, 50));
    return reg;
  }

  it("holds a healthy backend's status instead of condemning it", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const reg = await healthyRegistry();
      expect(reg.getOverview().backends["deepseek"].status).toBe("ok");

      globalThis.fetch = starvingFetch;
      const outcome = await reg.probeBackend("deepseek");

      expect(outcome.inconclusive).toBe(true);
      expect(reg.getOverview().backends["deepseek"].status).toBe("ok");
      expect(reg.resolve("agent").available).toBe(true);
      // The row still lists its models, so the Test result and the row agree.
      expect(outcome.models).toEqual(["m"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still condemns a backend that failed while the gateway was responsive", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const reg = await healthyRegistry();
      globalThis.fetch = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as unknown as typeof fetch;
      const outcome = await reg.probeBackend("deepseek");
      expect(outcome.inconclusive).toBeUndefined();
      expect(outcome.status).toBe("unreachable");
      expect(reg.getOverview().backends["deepseek"].status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("condemns a slow refusal that ran long without starving the loop", async () => {
    // A DNS lookup that grinds takes as long as a starved probe. Only the loop
    // falling behind separates them, which is why elapsed time is not the test.
    const originalFetch = globalThis.fetch;
    try {
      const reg = await healthyRegistry();
      globalThis.fetch = (async () => {
        await new Promise((r) => setTimeout(r, 700));
        throw new Error("getaddrinfo ENOTFOUND api.example.com");
      }) as unknown as typeof fetch;
      const outcome = await reg.probeBackend("deepseek");
      expect(outcome.inconclusive).toBeUndefined();
      expect(outcome.status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops holding a stale verdict once the gateway has had enough chances", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const reg = await healthyRegistry();
      globalThis.fetch = starvingFetch;
      // Five holds are extended; the sixth probe reports what it actually saw,
      // so a dead backend behind a permanently busy gateway is still found.
      for (let i = 0; i < 5; i++) {
        expect((await reg.probeBackend("deepseek")).inconclusive).toBe(true);
      }
      const final = await reg.probeBackend("deepseek");
      expect(final.inconclusive).toBeUndefined();
      expect(final.status).toBe("unreachable");
      expect(reg.getOverview().backends["deepseek"].status).toBe("unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a conclusive probe clears the hold streak", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const reg = await healthyRegistry();
      globalThis.fetch = starvingFetch;
      expect((await reg.probeBackend("deepseek")).inconclusive).toBe(true);

      globalThis.fetch = healthyFetch;
      await reg.probeBackend("deepseek"); // conclusive → streak reset

      globalThis.fetch = starvingFetch;
      // Were the streak still running, the budget would be short by one.
      for (let i = 0; i < 5; i++) {
        expect((await reg.probeBackend("deepseek")).inconclusive).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let local congestion walk the backoff up to its cap", async () => {
    const originalFetch = globalThis.fetch;
    // The production ladder: a confirmed failure would defer the next probe by
    // a minute, so a re-probe 15s later is only possible if the inconclusive
    // result left the attempt count alone.
    const backoff = { baseMs: 60_000, maxMs: 900_000 };
    try {
      const reg = makeRegistry();
      globalThis.fetch = (async () => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch;
      reg.loadConfig(configWithAgent());
      await reg.probeBackends();
      await new Promise((r) => setTimeout(r, 50));
      expect(reg.getOverview().backends["deepseek"].status).toBe("unreachable");

      globalThis.fetch = starvingFetch;
      expect((await reg.reprobeUnavailable(0, backoff)).probed).toBe(1);
      expect((await reg.reprobeUnavailable(15_000, backoff)).probed).toBe(1);
      expect((await reg.reprobeUnavailable(30_000, backoff)).probed).toBe(1);
      // An inconclusive probe is never a recovery.
      expect((await reg.reprobeUnavailable(45_000, backoff)).recovered).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
