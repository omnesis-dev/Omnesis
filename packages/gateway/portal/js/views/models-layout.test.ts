// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityGrid } from "./models.js";

describe("models landing layout", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("renders one capability grid with a separate backend action", async () => {
    const onConfigureBackends = vi.fn();
    const capabilities = [
      { role: "embedder", title: "Embedder", description: "Indexes meaning.", icon: "binary", section: "core" },
      { role: "transcriber", title: "Transcriber", description: "Transcribes audio.", icon: "mic", section: "core" },
      { role: "agent", title: "Agent", description: "Answers questions.", icon: "bot", section: "cognition" },
    ];

    await act(async () => {
      render(h(CapabilityGrid, {
        overview: {
          capabilities,
          inference: { assignments: {} },
          assignmentDisplays: {},
        },
        onConfigureBackends,
      }), host);
    });

    expect(host.querySelectorAll(".cap-grid")).toHaveLength(1);
    expect(host.querySelectorAll(".cap-card")).toHaveLength(capabilities.length);
    expect(
      [...host.querySelectorAll(".cap-card-title")].map((node) => node.textContent?.trim()),
    ).toEqual(["Embedder", "Transcriber", "Agent"]);
    expect(host.querySelector(".cap-section-title")).toBeNull();

    const button = host.querySelector(".models-configure-backends") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Configure backends");
    button.click();
    expect(onConfigureBackends).toHaveBeenCalledOnce();
  });

  it("shows the saved model-native behavior on a configured capability card", async () => {
    await act(async () => {
      render(h(CapabilityGrid, {
        overview: {
          capabilities: [{ role: "agent", title: "Agent", description: "Answers questions.", icon: "bot", section: "cognition" }],
          inference: { assignments: { agent: { kind: "http", available: true } } },
          assignmentDisplays: { agent: { providerId: "openai", modelName: "Example model", providerLabel: "OpenAI" } },
          modelSettings: { agent: { assignment: "openai/example-model", values: { reasoningEnabled: true, reasoningEffort: "high" } } },
          modelControls: { "openai/example-model": { source: "models.dev", reasoning: true, controls: [{ key: "reasoningEffort", type: "enum", values: ["low", "high"] }] } },
        },
        onConfigureBackends: vi.fn(),
      }), host);
    });
    expect(host.querySelector(".cap-card-behavior")?.textContent).toBe("Reasoning on · Effort high");
  });

  it("shows provider-native behavior for a Codex assignment", async () => {
    await act(async () => {
      render(h(CapabilityGrid, {
        overview: {
          capabilities: [{ role: "agent", title: "Agent", description: "Answers questions.", icon: "bot", section: "cognition" }],
          inference: { assignments: { agent: { kind: "codex", available: true } } },
          assignmentDisplays: { agent: { providerId: "codex", modelName: "codex-example-model", providerLabel: "Codex" } },
          modelSettings: { agent: { assignment: "codex/gpt-example", values: { reasoningEffort: "high" } } },
          modelControls: { "codex/gpt-example": { source: "provider", reasoning: true, controls: [{ key: "reasoningEffort", type: "enum", values: ["low", "high"] }] } },
        },
        onConfigureBackends: vi.fn(),
      }), host);
    });
    expect(host.querySelector(".cap-card-behavior")?.textContent).toBe("Effort high");
  });
});
