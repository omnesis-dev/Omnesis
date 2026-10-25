// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Display identity (icon, label, colors) of the wiki projections. The knowledge
 * mirror is gateway-internal — no collector ever reports it — so without this
 * boot-time seed every client that resolves a wiki page's icon through the
 * source meta (citations, document cards, chips) falls back to a placeholder.
 */

import { normalizeIcon } from "../../icon-normalizer.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { WIKI_GLYPH_PATHS } from "./wiki-glyph.js";
import type { WriteGate } from "../../write-gate.js";

export const KNOWLEDGE_SOURCE_LABEL = "Wiki";
/** Brand blue, shared with the other gateway-internal sources. */
const KNOWLEDGE_SOURCE_ACCENT_COLOR = "#1F6FEB";
const KNOWLEDGE_SOURCE_BG_COLOR = "#0D1117";

/** The wiki glyph, white on a brand-blue tile, as an SVG data URI. */
export function wikiSourceIconSvgDataUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64">` +
    `<rect width="24" height="24" rx="5" fill="${KNOWLEDGE_SOURCE_ACCENT_COLOR}"/>` +
    `<g transform="translate(3.6 3.6) scale(0.7)" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${WIKI_GLYPH_PATHS}</g>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Idempotent seed. `normalizeIcon` rasterizes the glyph to PNG, which every
 * client decodes; `setSourceMeta` COALESCEs each field, so repeated calls never
 * clobber state.
 */
export async function seedKnowledgeSourceMeta(writeGate: WriteGate): Promise<void> {
  const icon = (await normalizeIcon(wikiSourceIconSvgDataUri())) ?? undefined;
  await writeGate.setSourceMeta(KNOWLEDGE_SOURCE_ID, {
    icon,
    label: KNOWLEDGE_SOURCE_LABEL,
    bgColor: KNOWLEDGE_SOURCE_BG_COLOR,
    accentColor: KNOWLEDGE_SOURCE_ACCENT_COLOR,
  });
}
