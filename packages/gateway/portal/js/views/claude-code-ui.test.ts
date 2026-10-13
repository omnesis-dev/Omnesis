// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelsOverview: vi.fn(), getSystemInfo: vi.fn(), getCodexRuntimeUpdate: vi.fn(), getRecentModels: vi.fn(),
  refreshClaudeCodeBackend: vi.fn(), removeClaudeCodeBackend: vi.fn(), patchAdminConfig: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));

import { ClaudeCodeConfigModal, claudeCodeAccountLabel, claudeCodeState } from "./model-config.js";
import { ModelsView, claudeCodeBackendRow } from "./models.js";

const ready = {
  type: "claude-code",
  installed: true,
  status: "ok",
  loggedIn: true,
  account: { authMethod: "claude.ai", subscriptionType: "max" },
  runtime: { command: "claude", version: "2.1.300", supported: true },
  models: ["sonnet", "opus", "haiku"],
  modelDetails: [
    { id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" },
    { id: "opus", name: "Opus", description: "Most capable" },
    { id: "haiku", name: "Haiku" },
  ],
  modelRoles: { sonnet: ["agent", "background-agent"], opus: ["agent"], haiku: ["background-agent"] },
};
const signedOut = { type: "claude-code", installed: true, status: "unreachable", loggedIn: false, runtime: { command: "claude", version: "2.1.300", supported: true }, models: [], reason: "Claude Code is not signed in. Run `claude auth login` on the gateway host." };
const missing = { type: "claude-code", installed: false, status: "unreachable", loggedIn: false, models: [], reason: "spawn claude ENOENT" };

const overviewWith = (claudeCode, assignments = {}) => ({
  capabilities: [
    { role: "agent", title: "Agent", description: "Answers questions.", icon: "bot" },
    { role: "background-agent", title: "Background agent", description: "Works in the background.", icon: "bot" },
  ],
  catalog: [], installed: [], presets: [],
  inference: { allowRemoteInference: true, backends: {}, assignments, claudeCode },
});

describe("Claude Code portal UI", () => {
  let host, originalDocument, originalWindow;
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (text) => buttons().find((entry) => entry.textContent.trim() === text);
  const click = async (target) => {
    const el = typeof target === "string" ? button(target) : target;
    expect(el, String(target)).toBeTruthy();
    await act(async () => { el.dispatchEvent(new window.Event("click", { bubbles: false })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  beforeEach(() => {
    originalDocument = globalThis.document; originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    api.getSystemInfo.mockReset().mockResolvedValue({});
    api.getCodexRuntimeUpdate.mockReset().mockResolvedValue({ plan: { state: "up-to-date" } });
    api.getRecentModels.mockReset().mockResolvedValue({ entries: [] });
    api.refreshClaudeCodeBackend.mockReset().mockResolvedValue(ready);
    api.removeClaudeCodeBackend.mockReset().mockResolvedValue({ ok: true, clearedAssignments: ["agent"] });
    api.patchAdminConfig.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("labels the plan and picks the pane for each state", () => {
    expect(claudeCodeAccountLabel({ subscriptionType: "max" })).toBe("Claude Max");
    expect(claudeCodeAccountLabel({ authMethod: "oauth_token" })).toBe("long-lived token");
    expect(claudeCodeAccountLabel(undefined)).toBeNull();
    expect(claudeCodeState(ready)).toBe("ready");
    expect(claudeCodeState({ ...missing, status: "probing" })).toBe("checking");
    expect(claudeCodeState(missing)).toBe("not-installed");
    expect(claudeCodeState(signedOut)).toBe("signed-out");
    expect(
      claudeCodeState({ ...signedOut, runtime: { command: "claude", version: "2.0.0", supported: false } }),
    ).toBe("outdated");
    expect(claudeCodeState({ ...ready, status: "unreachable", models: [] })).toBe("unavailable");
  });

  it("asks for `claude update` when the installed CLI is too old", async () => {
    const outdated = { ...signedOut, runtime: { command: "claude", version: "2.0.0", supported: false } };
    await act(async () => render(h(ClaudeCodeConfigModal, { overview: overviewWith(outdated), onRefresh: vi.fn() }), host));
    expect(host.textContent).toContain("Claude Code 2.0.0 is too old for Omnesis");
    expect(host.querySelector('button[aria-label="Copy update command"]')?.parentElement?.textContent).toContain("claude update");
  });

  it("shows the sign-in command and a check, never a login flow, when signed out", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRefresh = vi.fn().mockResolvedValue(true);
    await act(async () => render(h(ClaudeCodeConfigModal, { overview: overviewWith(signedOut), onRefresh }), host));
    expect(host.textContent).toContain("Claude Code is not signed in");
    expect(host.textContent).toContain("never sees, stores or relays your Claude credentials");
    expect(button("Login")).toBeUndefined();
    const copy = host.querySelector('button[aria-label="Copy sign-in command"]');
    expect(copy?.parentElement?.textContent).toContain("claude auth login");
    await click(copy);
    expect(writeText).toHaveBeenCalledWith("claude auth login");
    await click("Check again");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("explains how to install Claude Code when the CLI is missing", async () => {
    await act(async () => render(h(ClaudeCodeConfigModal, { overview: overviewWith(missing), onRefresh: vi.fn() }), host));
    expect(host.textContent).toContain("Claude Code is not installed on the gateway host");
    expect(host.querySelector('a[href="https://claude.com/claude-code"]')).toBeTruthy();
    expect(host.textContent).toContain("spawn claude ENOENT");
  });

  it("shows the connected CLI and switches one role's model", async () => {
    const onSwitchModel = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn();
    await act(async () => render(h(ClaudeCodeConfigModal, {
      overview: overviewWith(ready, { agent: { kind: "claude-code", model: "sonnet" } }),
      onRefresh: vi.fn(), onSwitchModel, onRemove,
    }), host));
    expect(host.textContent).toContain("Signed in with Claude Max");
    expect(host.textContent).toContain("CLI 2.1.300");
    expect(host.textContent).toContain("currently claude-sonnet-5");
    await click("Remove");
    expect(onRemove).toHaveBeenCalledOnce();
    await click(host.querySelector('button[aria-label="Switch Agent model"]'));
    expect(host.textContent).toContain("Choose a Claude Code model for Agent");
    expect(host.textContent).toContain("Current for Agent");
    expect(host.textContent).not.toContain("Haiku");
    await click("Use for Agent");
    expect(onSwitchModel).toHaveBeenCalledExactlyOnceWith("agent", "opus");
    expect(host.querySelector(".cli-switch-result")?.textContent).toContain("Agent now uses opus.");
  });

  it("offers no Remove when no capability uses Claude Code", async () => {
    await act(async () => render(h(ClaudeCodeConfigModal, { overview: overviewWith(ready), onRefresh: vi.fn(), onRemove: vi.fn() }), host));
    expect(button("Remove")).toBeUndefined();
  });

  it("lists Claude Code as a backend once signed in or while a capability uses it", () => {
    expect(claudeCodeBackendRow(overviewWith(ready))).toBe(ready);
    expect(claudeCodeBackendRow(overviewWith(signedOut))).toBeNull();
    expect(claudeCodeBackendRow(overviewWith(missing))).toBeNull();
    expect(claudeCodeBackendRow(overviewWith(signedOut, { agent: { kind: "claude-code", model: "sonnet", available: false } }))).toBe(signedOut);
    expect(claudeCodeBackendRow(overviewWith(undefined))).toBeNull();
  });

  it("stops using Claude Code from the Backends list after confirmation", async () => {
    api.getModelsOverview.mockReset().mockResolvedValue(overviewWith(ready, { agent: { kind: "claude-code", model: "sonnet" } }));
    await act(async () => { render(h(ModelsView, { section: "backends" }), host); });
    await act(async () => { await Promise.resolve(); });
    const row = [...host.querySelectorAll(".backend-item")].find((item) => item.textContent.includes("Claude Code"));
    expect(row?.textContent).toContain("Signed in (Claude Max)");
    await click([...row.querySelectorAll("button")].find((entry) => entry.textContent.trim() === "Remove"));
    expect(host.textContent).toContain("Claude Code itself stays signed in.");
    expect(api.removeClaudeCodeBackend).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll(".confirm-modal-backdrop button")].find((entry) => entry.textContent.trim() === "Remove");
    await click(confirm);
    expect(api.removeClaudeCodeBackend).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Stopped using Claude Code for 1 capability.");
  });

  it("refreshes Claude Code from the Backends list", async () => {
    api.getModelsOverview.mockReset().mockResolvedValue(overviewWith(ready));
    await act(async () => { render(h(ModelsView, { section: "backends" }), host); });
    await act(async () => { await Promise.resolve(); });
    await click("Refresh model list");
    expect(api.refreshClaudeCodeBackend).toHaveBeenCalledOnce();
  });
});
