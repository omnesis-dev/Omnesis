// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

export const OBSERVATION_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </svg>
`;
export const CLOCK_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2.2 1.6" />
  </svg>
`;

// Static (non-animated, non-dismissing) twin of the ephemeral tool cards.
// Historical/debug renders use it so rolling cards cannot animate away and
// leave bare text.
export const SEARCH_GLYPH = html`
  <svg
    width="10"
    height="10"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
`;
export const DOC_GLYPH = html`
  <svg
    width="10"
    height="10"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
    <path d="M6 8h4 M6 11h4" />
  </svg>
`;
export const SQL_GLYPH = html`
  <svg
    width="10"
    height="10"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.5h12 M2 9.5h12 M6 3v10 M10 3v10" />
  </svg>
`;
// Three dots connected by a path — pairs with the "Trace connections"
// label and mirrors `point.3.connected.trianglepath.dotted` used as
// the Timeline-empty glyph on iOS.
export const TRAIL_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="3.5" cy="4" r="1.5" />
    <circle cx="12.5" cy="4" r="1.5" />
    <circle cx="8" cy="12" r="1.5" />
    <path d="M4.8 5 7 10.7 M11.2 5 9 10.7" />
  </svg>
`;
export const BOLT_GLYPH = html`
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M9.5 1.5L3 9h4.2l-.7 5.5L13 7H8.8z" />
  </svg>
`;
export const PEOPLE_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="2.5" />
    <path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
    <circle cx="11" cy="5.5" r="2" />
    <path d="M10 9.2c2 .2 3.5 1.9 3.5 3.8" />
  </svg>
`;
export const LINK_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6.5 9.5L9.5 6.5" />
    <path d="M7.5 4.5L9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5" />
    <path d="M8.5 11.5L7 13a2.8 2.8 0 0 1-4-4l1.5-1.5" />
  </svg>
`;
export const LOOP_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8a5 5 0 0 1 8.6-3.5L13 6" />
    <path d="M13 3.5V6h-2.5" />
    <path d="M13 8a5 5 0 0 1-8.6 3.5L3 10" />
    <path d="M3 12.5V10h2.5" />
  </svg>
`;
export const CALENDAR_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 7h11 M5.5 2v3 M10.5 2v3" />
  </svg>
`;
export const MEMORY_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M8 3.2a2.4 2.4 0 0 0-4.6.9A2.4 2.4 0 0 0 2.6 8.6 2.4 2.4 0 0 0 5 12.8a2.4 2.4 0 0 0 3 .4z" />
    <path d="M8 3.2a2.4 2.4 0 0 1 4.6.9 2.4 2.4 0 0 1 .8 4.5 2.4 2.4 0 0 1-2.4 4.2 2.4 2.4 0 0 1-3 .4" />
  </svg>
`;
export const NOTES_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 2.5h10v7L9.5 13H3z" />
    <path d="M9.5 13V9.5H13 M5.5 5.5h5 M5.5 8h3" />
  </svg>
`;
export const TASK_GLYPH = html`
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 4.2l1.2 1.2L6 3.1 M2.5 9.2l1.2 1.2L6 8.1" />
    <path d="M8.5 4.5h5 M8.5 9.5h5 M8.5 13h5" />
  </svg>
`;
