// SPDX-License-Identifier: AGPL-3.0-or-later

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexConfigModal, CodexRuntimePanel, ModelConfigModal, codexRuntimeUpdatePresentation } from "./model-config.js";

const overview = {
  capabilities: [{ role: "background-agent", title: "Background agent" }],
  inference: {
    assignments: {
      "background-agent": { kind: "codex", model: "gpt-5.5" },
    },
    codex: {
      runtime: { source: "managed", packageVersion: "0.142.4", version: "0.142.4" },
    },
  },
};

const plan = {
  state: "update-available",
  action: "update",
  currentVersion: "0.142.4",
  targetVersion: "0.151.0",
  canUpdate: true,
  preservesLogin: true,
  preservesAssignments: true,
  requiresGatewayRestart: false,
};

describe("Codex runtime update UI", () => {
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
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it("maps each plan state to the intended action", () => {
    expect(codexRuntimeUpdatePresentation({ plan })).toMatchObject({ label: "Update available", action: "update" });
    expect(codexRuntimeUpdatePresentation({ plan: { ...plan, state: "repair-needed", action: "repair" } })).toMatchObject({ label: "Repair needed", action: "repair" });
    expect(codexRuntimeUpdatePresentation({ plan: { ...plan, state: "up-to-date", action: "none" } })).toMatchObject({ label: "Up to date", action: null });
    expect(codexRuntimeUpdatePresentation({ plan: { ...plan, state: "externally-managed", action: "external" } })).toMatchObject({ label: "Managed externally", action: null });
  });

  it("offers the managed update with installed and tested versions", async () => {
    const onUpdate = vi.fn();
    await act(async () => render(h(CodexRuntimePanel, { overview, update: { plan, operation: null }, onUpdate }), host));
    expect(host.textContent).toContain("Installed 0.142.4");
    expect(host.textContent).toContain("Tested 0.151.0");
    const button = host.querySelector("button") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Update runtime");
    button.click();
    expect(onUpdate).toHaveBeenCalledWith("update");
  });

  it("never offers an Omnesis update for an external override", async () => {
    const externalOverview = {
      ...overview,
      inference: { ...overview.inference, codex: { runtime: { source: "override", command: "/opt/codex", version: "0.150.0" } } },
    };
    const external = { ...plan, state: "externally-managed", action: "external", canUpdate: false };
    await act(async () => render(h(CodexRuntimePanel, { overview: externalOverview, update: { plan: external, operation: null } }), host));
    expect(host.textContent).toContain("Update it outside Omnesis, then restart the gateway.");
    expect(host.textContent).toContain("/opt/codex");
    expect(host.textContent).not.toContain("Tested 0.151.0");
    expect(host.querySelector("button")).toBeNull();
  });

  it("reports draining turns after the safely cancellable phases", async () => {
    const onCancel = vi.fn();
    const operation = { id: "op-1", state: "waiting-for-turns", toVersion: "0.151.0", activeTurns: 2, startedAt: new Date().toISOString() };
    await act(async () => render(h(CodexRuntimePanel, { overview, update: { plan, operation }, onCancel }), host));
    expect(host.textContent).toContain("Waiting for active Codex work to finish");
    expect(host.textContent).toContain("2 active turns remaining");
    expect(host.querySelector("button")).toBeNull();
  });

  it("allows cancellation while the runtime download is still safe to stop", async () => {
    const onCancel = vi.fn();
    const operation = { id: "op-1", state: "downloading", toVersion: "0.151.0", activeTurns: 0, startedAt: new Date().toISOString() };
    await act(async () => render(h(CodexRuntimePanel, { overview, update: { plan, operation }, onCancel }), host));
    (host.querySelector("button") as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows new models and makes switching an explicit operator action", async () => {
    const onSwitchRole = vi.fn();
    const operation = { id: "op-1", state: "complete", toVersion: "0.151.0", activeTurns: 0, startedAt: new Date().toISOString(), newModels: ["gpt-5.6-luna", "gpt-5.6-terra"] };
    await act(async () => render(h(CodexRuntimePanel, { overview, update: { plan: { ...plan, state: "up-to-date", action: "none" }, operation }, onSwitchRole }), host));
    expect(host.textContent).toContain("Codex updated to 0.151.0");
    expect(host.textContent).toContain("gpt-5.6-luna, gpt-5.6-terra");
    expect(host.textContent).toContain("Background agent currently uses gpt-5.5");
    (host.querySelector("button") as HTMLButtonElement).click();
    expect(onSwitchRole).toHaveBeenCalledWith("background-agent");
  });

  it("states that a rolled-back update kept the previous runtime", async () => {
    const operation = { id: "op-1", state: "rolled-back", toVersion: "0.151.0", activeTurns: 0, startedAt: new Date().toISOString(), reason: "Runtime probe failed." };
    await act(async () => render(h(CodexRuntimePanel, { overview, update: { plan, operation } }), host));
    expect(host.textContent).toContain("Update failed; the previous runtime is still active.");
    expect(host.textContent).toContain("Runtime probe failed.");
  });

  it("keeps the selected capability explicit while switching a Codex model", async () => {
    const agentTitle = ["Omnesis", "agent"].join(" ");
    const backgroundTitle = ["Background", "agent"].join(" ");
    const dualOverview = {
      ...overview,
      capabilities: [
        { role: "agent", title: agentTitle },
        { role: "background-agent", title: backgroundTitle },
      ],
      inference: {
        ...overview.inference,
        assignments: {
          agent: { kind: "codex", model: "gpt-5.5" },
          "background-agent": { kind: "codex", model: "gpt-5.5" },
        },
        codex: {
          ...overview.inference.codex,
          configured: true,
          status: "ok",
          loggedIn: true,
          models: ["gpt-5.5", "gpt-5.6-luna"],
          modelRoles: {
            "gpt-5.5": ["agent", "background-agent"],
            "gpt-5.6-luna": ["agent", "background-agent"],
          },
        },
      },
    };
    const runtimeUpdate = {
      plan: { ...plan, state: "up-to-date", action: "none" },
      operation: {
        id: "op-1",
        state: "complete",
        toVersion: "0.151.0",
        newModels: ["gpt-5.6-luna"],
      },
    };
    let finishSwitch: (ok: boolean) => void = () => {};
    const onSwitchModel = vi.fn().mockReturnValue(new Promise((resolve) => {
      finishSwitch = resolve;
    }));

    await act(async () => render(h(CodexConfigModal, {
      overview: dualOverview,
      runtimeUpdate,
      onClose: vi.fn(),
      onSwitchModel,
    }), host));

    (host.querySelector(`button[aria-label="Switch ${backgroundTitle} model"]`) as HTMLButtonElement).click();
    await act(async () => {});
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(`Choose a Codex model for ${backgroundTitle}`);
    expect(host.textContent).toContain(`Only ${backgroundTitle} will change. Current model: gpt-5.5.`);
    expect(host.textContent).toContain(`Current for ${backgroundTitle}`);
    expect(host.textContent).toContain(`Use for ${backgroundTitle}`);
    expect(host.textContent).not.toContain(`Use for ${agentTitle}`);

    const useLuna = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === `Use for ${backgroundTitle}`);
    await act(async () => {
      useLuna?.click();
      await Promise.resolve();
    });
    expect(onSwitchModel).toHaveBeenCalledWith("background-agent", "gpt-5.6-luna");
    expect(host.textContent).toContain("Switching…");
    expect((host.querySelector(`button[aria-label="Switch ${agentTitle} model"]`) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finishSwitch(true);
      await Promise.resolve();
    });
    expect(host.textContent).toContain(`${backgroundTitle} now uses gpt-5.6-luna.`);
    expect(host.textContent).toContain("No other capability was changed.");
  });

  it("selects an advertised Codex model for the brief judge", async () => {
    const judgeTitle = ["Brief", "Judge"].join(" ");
    const judgeOverview = {
      ...overview,
      capabilities: [{ role: "brief-judge", title: judgeTitle }],
      presets: [],
      catalog: [],
      inference: {
        ...overview.inference,
        backends: {},
        codex: { ...overview.inference.codex, configured: true, loggedIn: true, status: "ok", models: ["fixture-judge"], modelRoles: { "fixture-judge": ["brief-judge"] } },
      },
    };
    const onPickCodex = vi.fn();
    await act(async () => render(h(ModelConfigModal, {
      role: "brief-judge",
      capTitle: judgeTitle,
      onPickCodex,
      overview: judgeOverview,
      sys: {},
      onClose: vi.fn(),
    }), host));
    expect(host.textContent).not.toContain("Codex is unavailable");
    const codex = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Codex"));
    expect(codex).toBeDefined();
    await act(async () => codex?.click());
    expect(host.textContent).toContain("fixture-judge");
    const use = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === `Use for ${judgeTitle}`);
    expect(use).toBeDefined();
    await act(async () => use?.click());
    expect(onPickCodex).toHaveBeenCalledWith("fixture-judge");
  });
});
