// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/** Native source-owned Lucide map-pin glyph (ISC; see THIRD_PARTY_NOTICES.md). */
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF9F0A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';

export const coreLocationVisitsIcon: SourceIcon = {
  sfSymbol: "location.fill",
  color: "#FF9F0A",
  imageDataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
};
