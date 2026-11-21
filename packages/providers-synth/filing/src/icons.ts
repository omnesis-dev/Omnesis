// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/** A two-drawer cabinet, drawn for this source. */
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8E6E53" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 12h16"/><path d="M10 7.5h4"/><path d="M10 16.5h4"/></svg>';

export const filingIcon: SourceIcon = {
  sfSymbol: "archivebox",
  color: "#8E6E53",
  imageDataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
};
