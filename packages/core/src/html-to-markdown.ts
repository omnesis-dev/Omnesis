// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lazyRequire } from "./lazy-require.js";
import type TurndownService from "turndown";

// Turndown and its DOM implementation load on the first conversion, not with
// `@omnesis/core` (see `lazy-require.ts`).
const loadTurndown = lazyRequire<typeof TurndownService>(import.meta.url, "turndown");
let turndown: TurndownService | undefined;

function converter(): TurndownService {
  if (!turndown) {
    const Turndown = loadTurndown();
    turndown = new Turndown({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
    });
    turndown.remove(["script", "style", "head"]);
  }
  return turndown;
}

export function htmlToMarkdown(html: string): string {
  return converter().turndown(html);
}
