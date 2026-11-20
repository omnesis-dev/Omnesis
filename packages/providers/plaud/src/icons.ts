// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * A generic Lucide `audio-lines` glyph (ISC-licensed, see `TRADEMARKS.md`),
 * not Plaud's own mark: the source uses an unofficial API and makes no claim
 * to Plaud's branding. Tinted a neutral slate; bg is a dimmed wash of the same
 * hue for dark-mode surfaces. The SF Symbol is iOS's instant-render fallback.
 */
const AUDIO_LINES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4B5563" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>`;

export const plaudIcon: SourceIcon = {
  sfSymbol: "waveform",
  color: "#4B5563",
  bgColor: "#1F2937",
  imageDataUri: `data:image/svg+xml;base64,${Buffer.from(AUDIO_LINES_SVG).toString("base64")}`,
};
