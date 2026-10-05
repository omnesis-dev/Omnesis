// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const features: Partial<Record<"notes", boolean | undefined>> = {};
export function registerPanelFeature(feature: "notes"): void {
  features[feature] = undefined;
  installPanelConnections();
}
let lane: Promise<unknown> = Promise.resolve();

/** The native panel serves Tell Omnesis, including cold worker gestures. */
export function setPanelFeature(feature: "notes", enabled: boolean): Promise<void> {
  features[feature] = enabled;
  const task = lane.then(async () => {
    if (Object.values(features).some((value) => value === true))
      await chrome.sidePanel.setOptions({ enabled: true, path: "notes.html" });
    else if (Object.values(features).every((value) => value === false))
      await chrome.sidePanel.setOptions({ enabled: false, path: "notes.html" });
  });
  lane = task.catch(() => undefined);
  return task;
}

export const PANEL_PORT = "omnesis-panel";
type PanelFeature = "notes";
const panels = new Map<
  number,
  { port: chrome.runtime.Port; feature?: PanelFeature; visible: boolean; tabId?: number }
>();
const scopes = new Map<number, { tabId?: number; visible: boolean }>();
let installed = false;
function installPanelConnections(): void {
  if (installed || !chrome.runtime.onConnect) return;
  installed = true;
  chrome.sidePanel.onOpened?.addListener((info) => {
    if (info.path !== "notes.html") return;
    scopes.set(info.windowId, { tabId: info.tabId, visible: true });
    const panel = panels.get(info.windowId);
    if (panel) {
      panel.visible = true;
      panel.tabId = info.tabId;
      panel.port.postMessage({ type: "scope", windowId: info.windowId, tabId: info.tabId });
    }
  });
  chrome.sidePanel.onClosed?.addListener((info) => {
    if (info.path !== "notes.html") return;
    scopes.set(info.windowId, { tabId: info.tabId, visible: false });
    const panel = panels.get(info.windowId);
    if (panel) panel.visible = false;
  });
  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    if (
      port.name !== PANEL_PORT ||
      !sender ||
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("notes.html") ||
      !sender.documentId
    )
      return;
    let feature: PanelFeature | undefined;
    let visible = true;
    let windowId: number | undefined;
    let disconnected = false;
    port.onMessage.addListener((message) => {
      const value = message as { feature?: unknown; visible?: unknown } | null;
      if (value?.feature !== "notes") return;
      feature = value.feature;
      visible = value.visible === true;
      const panel = windowId === undefined ? undefined : panels.get(windowId);
      if (panel?.port === port && windowId !== undefined) {
        panel.feature = feature;
        panel.visible = visible && scopes.get(windowId)?.visible !== false;
      }
    });
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (windowId !== undefined && panels.get(windowId)?.port === port) panels.delete(windowId);
    });
    // A notes.html browser tab must never be mistaken for the native side panel.
    void chrome.runtime
      .getContexts({ documentIds: [sender.documentId], contextTypes: ["SIDE_PANEL"] })
      .then((contexts) => {
        if (disconnected || contexts.length !== 1) return;
        windowId = contexts[0]!.windowId;
        const scope = scopes.get(windowId);
        panels.set(windowId, {
          port,
          feature,
          visible: visible && scope?.visible !== false,
          tabId: scope?.tabId,
        });
        port.postMessage({ type: "scope", windowId, tabId: scope?.tabId });
      })
      .catch(() => undefined);
  });
}

/** A live native page owns visibility; closing it always goes through its durable-write flush. */
export function togglePanelShortcut(feature: PanelFeature, tab: chrome.tabs.Tab): boolean {
  if (tab.windowId === undefined) return false;
  const panel = panels.get(tab.windowId);
  if (
    !panel?.visible ||
    panel.feature !== feature ||
    (panel.tabId !== undefined && panel.tabId !== tab.id)
  )
    return false;
  panel.port.postMessage({ type: "dismiss" });
  return true;
}

export function connectPanelPage(
  document: Document,
  dismiss: () => Promise<void>,
  scope: { windowId?: number; tabId?: number },
): void {
  let port: chrome.runtime.Port;
  let stopped = false;
  const feature: PanelFeature = "notes";
  const report = () => {
    if (stopped) return;
    try {
      port.postMessage({ feature, visible: document.visibilityState !== "hidden" });
    } catch {
      // A disconnected worker reconnects below; an updated extension retires this page.
    }
  };
  function connect(): void {
    if (stopped) return;
    try {
      port = chrome.runtime.connect({ name: PANEL_PORT });
    } catch {
      stopped = true;
      return;
    }
    port.onMessage.addListener((message) => {
      const value = message as { type?: unknown; windowId?: number; tabId?: number };
      if (value.type === "dismiss") void dismiss().catch(() => undefined);
      else if (value.type === "scope") {
        scope.windowId = value.windowId;
        scope.tabId = value.tabId;
      }
    });
    port.onDisconnect.addListener(() => {
      if (!stopped) queueMicrotask(connect);
    });
    report();
  }
  connect();
  document.addEventListener("visibilitychange", report);
  globalThis.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      port.disconnect();
    },
    { once: true },
  );
}
