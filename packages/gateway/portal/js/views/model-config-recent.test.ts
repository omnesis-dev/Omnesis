// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelConfigModal, classifyRecentApply, isUsableRecentEntry } from "./model-config.js";
import { getRecentModels } from "../api.js";

vi.mock("../api.js", () => ({
  getRecentModels: vi.fn(),
}));

const overview = {
  capabilities: [{ role: "agent", title: "Agent" }],
  catalog: [],
  presets: [],
  inference: {
    assignments: {},
    backends: {},
  },
};

const ENTRIES = [
  {
    assignment: "openai/gpt-4o",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelName: "gpt-4o",
    apply: { type: "assign", value: "openai/gpt-4o" },
  },
  {
    assignment: "codex/gpt-5.4",
    providerId: "codex",
    providerLabel: "Codex",
    modelName: "gpt-5.4",
    apply: { type: "assign", value: "codex/gpt-5.4" },
  },
];

function renderModal(props = {}) {
  return h(ModelConfigModal, {
    role: "agent",
    capTitle: "Agent",
    overview,
    sys: null,
    onClose: () => {},
    onAddHttp: () => {},
    onPickHttp: () => {},
    onPickLocal: () => {},
    onPickAnthropic: () => {},
    onPickCodex: () => {},
    onPickRecent: () => {},
    onStartCodexLogin: () => {},
    onCancelCodexLogin: () => {},
    onRefreshCodex: () => {},
    onCodexRuntimeUpdate: () => {},
    onCancelCodexRuntimeUpdate: () => {},
    onDismissCodexRuntimeResult: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onCancelDownload: () => {},
    ...props,
  });
}

describe("ModelConfigModal Recently used section", () => {
  let host;
  let originalDocument;
  let originalWindow;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    vi.mocked(getRecentModels).mockReset();
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it("lists recent models above the backend grid with a Use button each", async () => {
    vi.mocked(getRecentModels).mockResolvedValue({ capability: "agent", entries: ENTRIES });
    const onPickRecent = vi.fn();
    await act(async () => render(renderModal({ onPickRecent }), host));
    // Flush the mocked fetch's continuations so the section renders.
    await act(async () => {
      await vi.mocked(getRecentModels).mock.results[0].value;
    });

    expect(getRecentModels).toHaveBeenCalledWith("agent");
    expect(host.textContent).toContain("Recently used");
    expect(host.textContent).toContain("gpt-4o");
    expect(host.textContent).toContain("gpt-5.4");

    const section = host.querySelector(".recent-models");
    expect(section).toBeTruthy();
    // Flat rows, not cards.
    expect(section.querySelector(".backend-opt")).toBeNull();
    const buttons = Array.from(section.querySelectorAll("button")).filter(
      (b) => b.textContent.trim() === "Use",
    );
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    expect(onPickRecent).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it("hides the section entirely when there are no recent models", async () => {
    vi.mocked(getRecentModels).mockResolvedValue({ capability: "agent", entries: [] });
    await act(async () => render(renderModal(), host));

    expect(host.textContent).not.toContain("Recently used");
    expect(host.querySelector(".recent-models")).toBeNull();
    // The backend grid still renders (the "+ custom" affordance).
    expect(host.textContent).toContain("Custom HTTP backend");
  });

  it("hides the section when the fetch fails", async () => {
    vi.mocked(getRecentModels).mockRejectedValue(new Error("offline"));
    await act(async () => render(renderModal(), host));

    expect(host.querySelector(".recent-models")).toBeNull();
    expect(host.textContent).toContain("Custom HTTP backend");
  });

  it("hides the section when every entry is malformed", async () => {
    vi.mocked(getRecentModels).mockResolvedValue({
      capability: "agent",
      entries: [{ assignment: "x/y" }, { assignment: "z", apply: { type: "bogus" } }],
    });
    await act(async () => render(renderModal(), host));
    await act(async () => {
      await vi.mocked(getRecentModels).mock.results[0].value;
    });

    expect(host.querySelector(".recent-models")).toBeNull();
  });
});

describe("classifyRecentApply", () => {
  const catalog = [{ id: "northstar-chat-1b", name: "Northstar Chat" }];

  it("resolves an activate entry to its catalog entry and server role", () => {
    expect(
      classifyRecentApply(
        { apply: { type: "activate", catalogId: "northstar-chat-1b", catalogRole: "agent" } },
        catalog,
      ),
    ).toEqual({ kind: "activate", entry: catalog[0], catalogRole: "agent" });
  });

  it("errors when the catalog entry is gone", () => {
    expect(
      classifyRecentApply(
        { apply: { type: "activate", catalogId: "retired", catalogRole: "agent" } },
        catalog,
      ),
    ).toEqual({
      kind: "error",
      message: "Model retired is no longer in the catalog.",
    });
  });

  it("splits backend/model values for the HTTP flow", () => {
    expect(classifyRecentApply({ apply: { type: "assign", value: "openai/gpt-4o" } }, catalog)).toEqual(
      { kind: "assignHttp", backendKey: "openai", model: "gpt-4o" },
    );
  });

  it("assigns bare values directly", () => {
    expect(classifyRecentApply({ apply: { type: "assign", value: "replay" } }, catalog)).toEqual({
      kind: "assignRaw",
      value: "replay",
    });
    expect(classifyRecentApply({ assignment: "apple-vision" }, catalog)).toEqual({
      kind: "assignRaw",
      value: "apple-vision",
    });
  });

  it("errors when there is no usable value", () => {
    expect(classifyRecentApply({ apply: { type: "assign" } }, catalog)).toEqual({
      kind: "error",
      message: "That recent model is no longer available.",
    });
    expect(classifyRecentApply({}, catalog)).toEqual({
      kind: "error",
      message: "That recent model is no longer available.",
    });
  });
});

describe("isUsableRecentEntry", () => {
  it("keeps complete activate and assign entries, drops the rest", () => {
    expect(isUsableRecentEntry({ apply: { type: "activate", catalogId: "x", catalogRole: "agent" } })).toBe(
      true,
    );
    expect(isUsableRecentEntry({ apply: { type: "assign", value: "a/b" } })).toBe(true);
    expect(isUsableRecentEntry({ apply: { type: "activate" } })).toBe(false);
    expect(isUsableRecentEntry({ apply: { type: "assign" } })).toBe(false);
    expect(isUsableRecentEntry({ apply: { type: "bogus", value: "a/b" } })).toBe(false);
    expect(isUsableRecentEntry({ assignment: "a/b" })).toBe(false);
    expect(isUsableRecentEntry(null)).toBe(false);
  });
});
