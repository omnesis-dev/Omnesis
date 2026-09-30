// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Maildir source's mark: Lucide's `inbox` glyph (ISC-licensed, see
 * `TRADEMARKS.md`), tinted and embedded as a data URI so the manifest is
 * self-contained. A Maildir is a storage format, not a product, so there is
 * no brand mark to use.
 */

import type { SourceIcon } from "@omnesis/source-sdk";

const INBOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#14B8A6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;

export const maildirIcon: SourceIcon = {
  sfSymbol: "tray.full.fill",
  color: "#14B8A6",
  bgColor: "#0F2A28",
  imageDataUri: `data:image/svg+xml;base64,${Buffer.from(INBOX_SVG).toString("base64")}`,
};
