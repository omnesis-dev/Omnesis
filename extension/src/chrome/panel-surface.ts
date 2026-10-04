// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const PANEL_VIEW_KEY = "omnesis.panel.view.v1";
const features: Partial<Record<"notes" | "find", boolean | undefined>> = {};
export function registerPanelFeature(feature: "notes" | "find"): void {
  features[feature] = undefined;
}
let lane: Promise<unknown> = Promise.resolve();

/** One native panel serves independently authorized features, including cold worker gestures. */
export function setPanelFeature(feature: "notes" | "find", enabled: boolean): Promise<void> {
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

export function selectPanelView(view: "notes" | "find"): Promise<void> {
  return chrome.storage.local.set({ [PANEL_VIEW_KEY]: view });
}
