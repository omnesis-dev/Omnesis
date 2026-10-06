// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/** Native source-owned Lucide image glyph (ISC; see THIRD_PARTY_NOTICES.md). */
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0A84FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

export const photosIcon: SourceIcon = {
  sfSymbol: "photo",
  color: "#0A84FF",
  imageDataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
};
