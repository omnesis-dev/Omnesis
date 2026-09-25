// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Screen Time is a system feature, not a third-party brand we'd want to
 * advertise with the official iOS/macOS icon. Apple's brand guidelines
 * forbid that anyway. Instead this package owns its own glyph — the
 * Lucide `hourglass` SVG (ISC-licensed, see `TRADEMARKS.md`) tinted to
 * Apple's purple system accent.
 */
const HOURGLASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5856D6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>`;

const screenTimeIconDataUri = `data:image/svg+xml;base64,${Buffer.from(HOURGLASS_SVG).toString("base64")}`;

export const screenTimeIcon: SourceIcon = {
  sfSymbol: "hourglass",
  color: "#5856D6",
  bgColor: "#1B1A2E",
  imageDataUri: screenTimeIconDataUri,
};
