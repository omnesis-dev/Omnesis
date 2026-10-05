// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { initNotesEditPanel } from "./notes-edit-panel.js";
import { initFindPanel } from "./find-panel.js";
import { initNotesPanel } from "./notes-panel.js";
import { connectPanelPage } from "./panel-surface.js";
import { initPanelDismiss } from "./panel-dismiss.js";

document.addEventListener("DOMContentLoaded", () => {
  if (location.pathname === "/find.html") {
    const params = new URL(location.href).searchParams;
    const mode = params.get("mode");
    initFindPanel(document, chrome, {
      initialQuery: params.get("q") ?? undefined,
      initialMode: mode === "direct" || mode === "agentic" ? mode : null,
    });
    return;
  }
  let flushNotes: () => Promise<void> = async () => {};
  let flushEdits: () => Promise<void> = async () => {};
  const scope: { windowId?: number; tabId?: number } = {};
  const dismiss = initPanelDismiss(
    document,
    chrome,
    () => window.close(),
    async () => {
      await Promise.all([flushNotes(), flushEdits()]);
    },
    scope,
  );
  const notes = initNotesPanel(document, chrome, dismiss);
  flushNotes = notes.flush;
  flushEdits = initNotesEditPanel(document, chrome, dismiss, notes.show, notes.flush);
  connectPanelPage(document, dismiss, scope);
});
