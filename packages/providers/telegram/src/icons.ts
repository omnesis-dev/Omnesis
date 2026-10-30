// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Telegram source's mark: a plain paper plane drawn for Omnesis, not
 * Telegram's logo. The API terms (§2.4) reserve the logo, so the glyph is
 * generic, carries no circle, and is embedded as a data URI so the manifest is
 * self-contained. See `TRADEMARKS.md`.
 */

import type { SourceIcon } from "@omnesis/source-sdk";

const ACCENT = "#2AABEE";

const PAPER_PLANE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
  `<path fill="${ACCENT}" d="M2.6 11.1 20.4 3.7c.9-.4 1.8.4 1.6 1.3l-3.2 15c-.2 1-1.3 1.4-2.1.8` +
  `l-4.6-3.4-2.4 2.3c-.4.4-1.1.1-1.1-.5v-3.6l8-7.3-9.8 6.1-4.2-1.4c-.9-.3-.9-1.6 0-1.9Z"/></svg>`;

export const telegramIconDataUri = `data:image/svg+xml;base64,${Buffer.from(PAPER_PLANE_SVG).toString("base64")}`;

export const telegramIcon: SourceIcon = {
  sfSymbol: "paperplane.fill",
  color: ACCENT,
  bgColor: "#0F2230",
  imageDataUri: telegramIconDataUri,
};
