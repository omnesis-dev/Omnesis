// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { initNotesEditPanel } from "./notes-edit-panel.js";
import { initFindPanel } from "./find-panel.js";
import { initNotesPanel } from "./notes-panel.js";
import { initPanelDismiss } from "./panel-dismiss.js";

document.addEventListener("DOMContentLoaded", () => {
  let flushNotes: () => Promise<void> = async () => {};
  let flushEdits: () => Promise<void> = async () => {};
  const dismiss = initPanelDismiss(
    document,
    chrome,
    () => window.close(),
    async () => {
      await Promise.all([flushNotes(), flushEdits()]);
    },
  );
  const notes = initNotesPanel(document, chrome, dismiss);
  flushNotes = notes.flush;
  flushEdits = initNotesEditPanel(document, chrome, dismiss, notes.show, notes.flush);
  initFindPanel(document, chrome, dismiss);
});
