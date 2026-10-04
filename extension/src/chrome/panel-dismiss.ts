// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface PanelDismissApi {
  windows: { getCurrent(): Promise<{ id?: number }> };
  sidePanel: { close?: (options: { windowId: number }) => Promise<void> };
}

/** Dismiss this window's native panel without disabling either feature or losing its draft. */
export function initPanelDismiss(
  document: Document,
  api: PanelDismissApi,
  closeWindow: () => void,
  beforeDismiss?: () => Promise<void>,
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
          const current = await api.windows.getCurrent();
          if (current.id === undefined) closeWindow();
          else await close.call(api.sidePanel, { windowId: current.id });
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
