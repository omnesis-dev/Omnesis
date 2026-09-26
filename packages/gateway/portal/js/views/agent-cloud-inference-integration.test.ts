// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal view from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentClient: vi.fn(), getAgentModel: vi.fn(), patchAdminConfig: vi.fn(),
}));
vi.mock("../lib/agent-client.js", () => ({ createAgentClient: mocks.createAgentClient }));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()),
  getAgentModel: mocks.getAgentModel, patchAdminConfig: mocks.patchAdminConfig,
}));
import { AgentView } from "./agent.js";

describe("Agent landing after cloud inference recovery", () => {
  let host, originalDocument, originalWindow;
  afterEach(() => {
    if (host) render(null, host);
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });

  it("creates a fresh ready session after consent without sending a message", async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true, value: { pathname: "/portal/agent", href: "https://localhost/portal/agent" },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    vi.stubGlobal("Event", parsed.window.Event);
    vi.stubGlobal("CustomEvent", parsed.window.CustomEvent);
    host = parsed.document.querySelector("#root");

    let completeSession;
    const client = {
      getConfig: vi.fn().mockResolvedValueOnce({ enabled: false, backend: "codex", disabledCode: "remote_inference_disabled" })
        .mockResolvedValue({ enabled: true, backend: "codex" }),
      createSession: vi.fn(() => new Promise((resolve) => { completeSession = resolve; })),
      listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
      onEvent: vi.fn(() => () => {}), onResync: vi.fn(() => () => {}),
      send: vi.fn(), close: vi.fn(),
    };
    mocks.createAgentClient.mockReturnValue(client);
    mocks.getAgentModel.mockResolvedValue({ configured: true, modelName: "Example model", providerLabel: "OpenAI" });
    mocks.patchAdminConfig.mockResolvedValue({ ok: true });

    await act(async () => { render(h(AgentView, {}), host); });
    await vi.waitFor(() => expect(host.textContent).toContain("Cloud inference is disabled"));
    expect(client.createSession).not.toHaveBeenCalled();
    const click = async (label) => {
      const target = [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === label);
      expect(target, label).toBeTruthy();
      await act(async () => { target.click(); });
    };
    await click("Enable cloud inference…");
    await click("Enable cloud inference");
    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(host.querySelector("textarea").disabled).toBe(true);
    await act(async () => { completeSession({ sessionId: "ready-session", model: "example-model", backend: "codex" }); });
    await vi.waitFor(() => {
      expect(host.querySelector("textarea"), host.textContent).not.toBeNull();
      expect(host.querySelector("textarea").disabled).toBe(false);
    });
    expect(client.onEvent).toHaveBeenCalledWith("ready-session", expect.any(Function), expect.any(Object));
    expect(client.getConfig).toHaveBeenCalledTimes(2);
    expect(client.send).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Cloud inference is disabled");
  });
});
