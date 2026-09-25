// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { startContentScript } from "./content-script.js";

/**
 * Content-script entry: hands the real page to the glue in `content-script.ts`.
 * Chrome injects this bundle into every HTTPS page once host access is granted.
 */
startContentScript({
  document,
  window,
  location,
  chrome,
  MutationObserver,
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
});

export {};
