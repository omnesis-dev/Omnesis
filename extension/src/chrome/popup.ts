// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { initPopup } from "./popup-page.js";

/** Popup entry: hands the real popup document and `chrome` to the controller. */
document.addEventListener("DOMContentLoaded", () => initPopup(document, chrome));
