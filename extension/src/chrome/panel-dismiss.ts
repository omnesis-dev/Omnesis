// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface PanelDismissApi {
  windows: { getCurrent(): Promise<{ id?: number }> };
  sidePanel: { close?: (options: { windowId?: number; tabId?: number }) => Promise<void> };
}

/** Dismiss this window's native panel without disabling either feature or losing its draft. */
export function initPanelDismiss(
  document: Document,
  api: PanelDismissApi,
  closeWindow: () => void,
  beforeDismiss?: () => Promise<void>,
  scope?: { windowId?: number; tabId?: number },
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  function dismiss(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      if (beforeDismiss) await beforeDismiss();
      try {
        const close = api.sidePanel.close;
        if (typeof close !== "function") closeWindow();
        else {
          const current =
            scope?.windowId === undefined ? await api.windows.getCurrent() : { id: scope.windowId };
          if (current.id === undefined) closeWindow();
          else
            await close.call(
              api.sidePanel,
              scope?.tabId === undefined ? { windowId: current.id } : { tabId: scope.tabId },
            );
        }
      } catch {
        closeWindow();
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    void dismiss().catch(() => undefined);
  });
  return dismiss;
}
