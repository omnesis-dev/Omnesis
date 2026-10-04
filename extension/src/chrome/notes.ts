// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { initFindPanel } from "./find-panel.js";
import { initNotesPanel } from "./notes-panel.js";

document.addEventListener("DOMContentLoaded", () => {
  initNotesPanel(document, chrome);
  initFindPanel(document, chrome);
});
