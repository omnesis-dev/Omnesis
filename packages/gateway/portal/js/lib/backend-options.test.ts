// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import {
  buildModelPickerOptions,
  buildAddBackendOptions,
  isAnthropicConfigured,
  catalogProviderForBackend,
} from "./backend-options.js";

const PRESETS = [
  { id: "openai", name: "OpenAI", defaultUrl: "https://api.openai.com/v1" },
  { id: "groq", name: "Groq", defaultUrl: "https://api.groq.com/openai/v1" },
];

function overview(partial: Record<string, unknown> = {}) {
  return {
    presets: PRESETS,
    catalog: [
      { kind: "gguf", id: "nomic", roles: ["embed"] },
      { kind: "gguf", id: "qwen", roles: ["agent"] },
      { kind: "anthropic-api", id: "claude-sonnet-5", roles: ["agent"] },
      { kind: "anthropic-api", id: "claude-fable-5", roles: ["agent"] },
    ],
    inference: { backends: {} },
    ...partial,
  };
}

describe("buildModelPickerOptions", () => {
  it("keeps a custom backend key for selection while using its catalog serving-provider logo", () => {
    const data = overview({
      inference: { backends: { "custom-host": { type: "http", status: "ok", modelRoles: { "gpt-example": ["agent"] } } } },
      modelControls: { "custom-host/gpt-example": { providerId: "openai", source: "models.dev" } },
    });
    expect(catalogProviderForBackend(data, "custom-host")).toBe("openai");
    expect(buildModelPickerOptions(data, "agent")).toContainEqual(expect.objectContaining({
      kind: "custom", id: "custom-host", logoProviderId: "openai",
    }));
  });

  it("embedder: Local (has GGUF) + presets + add-custom, no Anthropic (no embed anthropic entry)", () => {
    const opts = buildModelPickerOptions(overview(), "embedder");
    const kinds = opts.map((o: { kind: string }) => o.kind);
    expect(kinds).toEqual(["local", "preset", "preset", "add-custom"]);
  });

  it("agent: Local + presets + Anthropic (has agent anthropic entry) + add-custom", () => {
    const opts = buildModelPickerOptions(overview(), "agent");
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "local",
      "preset",
      "preset",
      "anthropic",
      "add-custom",
    ]);
    expect(opts.find((o: { kind: string }) => o.kind === "anthropic")).toMatchObject({
      count: 2,
    });
  });

  it("agent: includes Codex when the gateway exposes a Codex catalog", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {},
          codex: {
            type: "codex",
            configured: true,
            status: "ok",
            loggedIn: true,
            models: ["gpt-example-a", "gpt-example-b"],
            modelRoles: {
              "gpt-example-a": ["agent", "background-agent"],
              "gpt-example-b": ["agent", "background-agent"],
            },
          },
        },
      }),
      "agent",
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "local",
      "preset",
      "preset",
      "codex",
      "anthropic",
      "add-custom",
    ]);
    expect(opts.find((o: { kind: string }) => o.kind === "codex")).toMatchObject({
      configured: true,
      fitCount: 2,
      loggedIn: true,
    });
  });

  it("privacy reviewer uses agent-class catalog entries and its independent backend role", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {},
          codex: {
            type: "codex",
            configured: true,
            status: "ok",
            loggedIn: true,
            models: ["review-model"],
            modelRoles: { "review-model": ["privacy-reviewer"] },
          },
        },
      }),
      "privacy-reviewer",
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "local",
      "preset",
      "preset",
      "codex",
      "anthropic",
      "add-custom",
    ]);
  });

  it("background-agent offers Codex; non-chat capabilities do not", () => {
    const base = overview({
      inference: {
        backends: {},
        codex: {
          type: "codex",
          configured: true,
          status: "ok",
          loggedIn: true,
          models: ["gpt-example-a"],
          modelRoles: { "gpt-example-a": ["agent", "background-agent"] },
        },
      },
    });
    expect(buildModelPickerOptions(base, "background-agent").map((o: { kind: string }) => o.kind)).toContain("codex");
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {},
          codex: {
            type: "codex",
            configured: true,
            status: "ok",
            loggedIn: true,
            models: ["gpt-example-a"],
            modelRoles: { "gpt-example-a": ["agent", "background-agent"] },
          },
        },
      }),
      "embedder",
    );
    expect(opts.map((o: { kind: string }) => o.kind)).not.toContain("codex");
  });

  it("Watch judge offers Codex when advertised by the gateway", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {
            custom: {
              type: "http",
              status: "ok",
              modelRoles: { "short-judge": ["watch-judge"] },
            },
          },
          codex: {
            type: "codex",
            configured: true,
            status: "ok",
            loggedIn: true,
            models: ["gpt-example-a"],
            modelRoles: { "gpt-example-a": ["agent", "background-agent", "watch-judge"] },
          },
        },
      }),
      "watch-judge",
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "local",
      "preset",
      "preset",
      "custom",
      "codex",
      "anthropic",
      "add-custom",
    ]);
    expect(opts.find((o: { kind: string }) => o.kind === "custom").fitCount).toBe(1);
  });

  it("Watch judge does not offer Responses-only HTTP backends", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {
            chat: {
              type: "http",
              status: "ok",
              protocol: "chat-completions",
              modelRoles: { judge: ["watch-judge"] },
            },
            responses: {
              type: "http",
              status: "ok",
              protocol: "responses",
              modelRoles: { judge: ["watch-judge"] },
            },
          },
        },
      }),
      "watch-judge",
    );
    expect(opts.some((option: { id?: string }) => option.id === "chat")).toBe(true);
    expect(opts.some((option: { id?: string }) => option.id === "responses")).toBe(false);
  });

  it.each(["privacy-reviewer", "entailment-verifier", "brief-judge", "ocr"])("offers advertised Codex models for %s", (role: string) => {
    const opts = buildModelPickerOptions(overview({ inference: { codex: {
      type: "codex", configured: true, status: "ok", loggedIn: true,
      models: ["gpt-example-a"], modelRoles: { "gpt-example-a": [role] },
    } } }), role);
    expect(opts.find((o: { kind: string }) => o.kind === "codex")).toMatchObject({ configured: true, fitCount: 1 });
  });

  it("agent: does not offer Codex as a model source after the Codex backend is removed", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {},
          codex: {
            type: "codex",
            configured: false,
            status: "unreachable",
            loggedIn: false,
            models: [],
          },
        },
      }),
      "agent",
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "local",
      "preset",
      "preset",
      "anthropic",
      "add-custom",
    ]);
  });

  it("ocr: no catalog role → no Local, no Anthropic; just presets + add-custom", () => {
    const opts = buildModelPickerOptions(overview(), "ocr");
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual(["preset", "preset", "add-custom"]);
  });

  it("a configured preset reports role-fit model count; an unconfigured one is not configured", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {
            openai: {
              type: "http",
              status: "ok",
              modelRoles: { "text-embedding-3-small": ["embedder"], "gpt-4o": ["agent"] },
            },
          },
        },
      }),
      "embedder",
    );
    const openai = opts.find((o: { id?: string }) => o.id === "openai");
    const groq = opts.find((o: { id?: string }) => o.id === "groq");
    expect(openai).toMatchObject({ configured: true, fitCount: 1 });
    expect(groq).toMatchObject({ configured: false, fitCount: 0 });
  });

  it("existing custom (non-preset) HTTP backends each get their own card", () => {
    const opts = buildModelPickerOptions(
      overview({
        inference: {
          backends: {
            "my-vllm": { type: "http", status: "ok", modelRoles: { "bge-m3": ["embedder"] } },
          },
        },
      }),
      "embedder",
    );
    const custom = opts.find((o: { kind: string }) => o.kind === "custom");
    expect(custom).toMatchObject({ kind: "custom", id: "my-vllm", configured: true, fitCount: 1 });
  });
});

describe("buildAddBackendOptions", () => {
  it("is presets + anthropic + add-custom, with configured flags, no Local", () => {
    const opts = buildAddBackendOptions(
      overview({ inference: { backends: { openai: { type: "http", status: "ok" }, anthropic: { status: "ok" } } } }),
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual(["preset", "preset", "anthropic", "add-custom"]);
    expect(opts.find((o: { id?: string }) => o.id === "openai")).toMatchObject({ configured: true });
    expect(opts.find((o: { id?: string }) => o.id === "groq")).toMatchObject({ configured: false });
    expect(opts.find((o: { kind: string }) => o.kind === "anthropic")).toMatchObject({ configured: true });
  });

  it("includes Codex as a built-in backend when exposed by the gateway", () => {
    const opts = buildAddBackendOptions(
      overview({
        inference: {
          backends: {},
          codex: {
            type: "codex",
            configured: false,
            status: "unreachable",
            loggedIn: false,
            models: [],
            reason: "Codex is not logged in.",
          },
        },
      }),
    );
    expect(opts.map((o: { kind: string }) => o.kind)).toEqual([
      "preset",
      "preset",
      "anthropic",
      "codex",
      "add-custom",
    ]);
    expect(opts.find((o: { kind: string }) => o.kind === "codex")).toMatchObject({
      configured: false,
      loggedIn: false,
      status: "unreachable",
    });
  });
});

describe("isAnthropicConfigured", () => {
  it("recognizes an effective environment key even when discovery is unavailable", () => {
    expect(
      isAnthropicConfigured({
        anthropic: {
          type: "anthropic",
          status: "unreachable",
          hasApiKey: true,
        },
      }),
    ).toBe(true);
  });
});
