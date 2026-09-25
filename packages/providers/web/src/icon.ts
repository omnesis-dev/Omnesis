// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * The Web Pages source owns its own glyph — the Lucide `globe` SVG
 * (MIT-licensed, see `TRADEMARKS.md`) tinted sky-blue.
 *
 * `web` owns pages captured by the browser extension. A globe reads as
 * "pages on the web" in every catalog surface.
 */
const ACCENT_COLOR = "#0EA5E9";
const BG_COLOR = "#0B2230";

const GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${ACCENT_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;

const webIconDataUri = `data:image/svg+xml;base64,${Buffer.from(GLOBE_SVG).toString("base64")}`;

export const webIcon: SourceIcon = {
  sfSymbol: "globe",
  color: ACCENT_COLOR,
  bgColor: BG_COLOR,
  imageDataUri: webIconDataUri,
};
