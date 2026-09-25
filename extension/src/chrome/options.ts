// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { initOptions } from "./options-page.js";

/** Options entry: hands the real options document and `chrome` to the controller. */
document.addEventListener("DOMContentLoaded", () => initOptions(document, chrome));
