// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function setup(native = true) {
  vi.resetModules();
  let connect!: (port: chrome.runtime.Port) => void;
  let opened!: (info: { windowId: number; tabId?: number; path: string }) => void;
  let closed!: typeof opened;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
      onConnect: {
        addListener: (listener: typeof connect) => {
          connect = listener;
        },
      },
      getContexts: vi.fn(async () => (native ? [{ windowId: 10, tabId: -1 }] : [])),
    },
    sidePanel: {
      onOpened: {
        addListener: (listener: typeof opened) => {
          opened = listener;
        },
      },
      onClosed: {
        addListener: (listener: typeof closed) => {
          closed = listener;
        },
      },
    },
  });
  const surface = await import("./panel-surface.js");
  surface.registerPanelFeature("notes");
  let message!: (value: unknown) => void;
  let disconnect!: () => void;
  const port = {
    name: surface.PANEL_PORT,
    sender: {
      id: "fixture-extension",
      documentId: "fixture-document",
      url: "chrome-extension://fixture-extension/notes.html",
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener: typeof message) => {
        message = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: typeof disconnect) => {
        disconnect = listener;
      },
    },
  };
  connect(port);
  message({ feature: "notes", visible: true });
  await Promise.resolve();
  return { surface, port, message, disconnect, opened, closed };
}

describe("native shortcut toggle", () => {
  it("closes Tell only in its own native window and ignores retired Find reports", async () => {
    const p = await setup();
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(true);
    expect(p.port.postMessage).toHaveBeenLastCalledWith({ type: "dismiss" });
    expect(p.surface.togglePanelShortcut("notes", { id: 2, windowId: 20 })).toBe(false);
    p.message({ feature: "find", visible: true });
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(true);
  });

  it("forgets manual closure/disconnection and tracks tab-specific scope", async () => {
    const p = await setup();
    p.closed({ path: "notes.html", windowId: 10 });
    p.message({ feature: "notes", visible: true });
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(false);
    p.opened({ path: "notes.html", windowId: 10, tabId: 2 });
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(false);
    expect(p.surface.togglePanelShortcut("notes", { id: 2, windowId: 10 })).toBe(true);
    expect(p.port.postMessage).toHaveBeenCalledWith({ type: "scope", windowId: 10, tabId: 2 });
    p.disconnect();
    expect(p.surface.togglePanelShortcut("notes", { id: 2, windowId: 10 })).toBe(false);
  });

  it("restores live visibility on cold worker connection without a persisted boolean", async () => {
    const p = await setup();
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(true);
  });

  it("does not treat notes.html opened in a browser tab as a native panel", async () => {
    const p = await setup(false);
    expect(p.surface.togglePanelShortcut("notes", { id: 1, windowId: 10 })).toBe(false);
  });
});

it("reconnects the live panel after worker eviction and routes toggle through durable dismiss", async () => {
  vi.resetModules();
  const listeners: Array<{ message?: (value: unknown) => void; disconnect?: () => void }> = [];
  const reports: unknown[] = [];
  const connect = vi.fn(() => {
    const listener: (typeof listeners)[number] = {};
    listeners.push(listener);
    return {
      postMessage: (message: unknown) => reports.push(message),
      disconnect: vi.fn(),
      onMessage: {
        addListener: (callback: (value: unknown) => void) => {
          listener.message = callback;
        },
      },
      onDisconnect: {
        addListener: (callback: () => void) => {
          listener.disconnect = callback;
        },
      },
    };
  });
  vi.stubGlobal("chrome", {
    runtime: { connect },
    storage: {
      local: { get: async () => ({ "omnesis.panel.view.v1": "find" }) },
      onChanged: { addListener: vi.fn() },
    },
  });
  vi.stubGlobal("addEventListener", vi.fn());
  const { connectPanelPage } = await import("./panel-surface.js");
  const dismiss = vi.fn().mockResolvedValue(undefined);
  const scope: { windowId?: number; tabId?: number } = {};
  connectPanelPage(
    { visibilityState: "visible", addEventListener: vi.fn() } as unknown as Document,
    dismiss,
    scope,
  );
  await Promise.resolve();
  expect(reports).toContainEqual({ feature: "notes", visible: true });
  listeners[0]!.disconnect!();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledTimes(2);
  listeners[1]!.message!({ type: "scope", windowId: 10, tabId: 7 });
  listeners[1]!.message!({ type: "dismiss" });
  expect(scope).toEqual({ windowId: 10, tabId: 7 });
  expect(dismiss).toHaveBeenCalledOnce();
});
