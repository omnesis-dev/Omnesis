// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Hot-linked at runtime — Granola's apple-touch-icon (180x180 PNG, the
 * spiral-G brand mark) on the official granola.ai site, served with HSTS
 * and permissive CORS. See `TRADEMARKS.md` for usage notes.
 *
 * The SF Symbol is iOS's instant-render fallback: Granola's product is AI
 * meeting transcription, so a waveform-with-mic glyph reads it at a glance.
 * Colours match the brand mark's yellow-green; bg is a dimmed wash of the
 * same hue for dark-mode surfaces.
 */
export const granolaIcon: SourceIcon = {
  sfSymbol: "waveform.and.mic",
  color: "#B2C248",
  bgColor: "#23270F",
  url: "https://www.granola.ai/favicon/apple-touch-icon.png",
};
