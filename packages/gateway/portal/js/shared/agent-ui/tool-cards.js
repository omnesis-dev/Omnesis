// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The glyph each tool card leads with, by the icon its table entry names. */

import { html } from "htm/preact";
import { knowledgeIconGlyphs } from "../../lib/knowledge-icon-glyphs.js";
import {
  SEARCH_GLYPH,
  DOC_GLYPH,
  SQL_GLYPH,
  TRAIL_GLYPH,
  PEOPLE_GLYPH,
  LINK_GLYPH,
  LOOP_GLYPH,
  OBSERVATION_GLYPH,
  CALENDAR_GLYPH,
  CLOCK_GLYPH,
  MEMORY_GLYPH,
  NOTES_GLYPH,
  TASK_GLYPH,
  BOLT_GLYPH,
} from "./glyphs.js";
import { toolCard } from "./tool-card-table.js";

/** The product's wiki-page glyph, the one its knowledge views draw. */
export const WIKI_GLYPH = html`<svg
  width="11"
  height="11"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  dangerouslySetInnerHTML=${{ __html: knowledgeIconGlyphs.wiki }}
/>`;

export const TOOL_ICON_GLYPHS = Object.freeze({
  search: SEARCH_GLYPH,
  document: DOC_GLYPH,
  wiki: WIKI_GLYPH,
  sql: SQL_GLYPH,
  trail: TRAIL_GLYPH,
  people: PEOPLE_GLYPH,
  link: LINK_GLYPH,
  loop: LOOP_GLYPH,
  observation: OBSERVATION_GLYPH,
  date: CALENDAR_GLYPH,
  schedule: CLOCK_GLYPH,
  memory: MEMORY_GLYPH,
  notes: NOTES_GLYPH,
  task: TASK_GLYPH,
  watch: BOLT_GLYPH,
});

export function toolCardGlyph(tool) {
  const icon = toolCard(tool)?.icon;
  return icon ? TOOL_ICON_GLYPHS[icon] : DOC_GLYPH;
}
