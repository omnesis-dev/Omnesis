// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Hot-linked at runtime — Notion's apple-touch-icon (512x512 PNG) on
 * the official notion.so CDN, served with HSTS and permissive CORS.
 * See `TRADEMARKS.md` for usage notes.
 */
const notionIconUrl = "https://www.notion.so/images/logo-ios.png";

// Notion's brand is monochrome. Accent stays neutral light so it reads
// on dark-mode UI; bg is a near-neutral wash that hints at the brand
// without yelling.
export const notionIcon: SourceIcon = {
  sfSymbol: "doc.text.fill",
  color: "#E0E0E0",
  bgColor: "#1F1F1F",
  url: notionIconUrl,
};

export const notionDatabaseIcon: SourceIcon = {
  sfSymbol: "tablecells.fill",
  color: "#E0E0E0",
  bgColor: "#1F1F1F",
  url: notionIconUrl,
};
