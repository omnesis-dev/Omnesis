// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public surface of the omnesis-notes built-in source. See `wiring.ts`
 * for the boot-time entry point.
 */

export {
  OMNESIS_NOTES_PROVIDER_ID,
  OMNESIS_NOTES_SOURCE_ID,
  OMNESIS_NOTES_LABEL,
  OMNESIS_NOTES_ACCENT_COLOR,
  OMNESIS_NOTES_BG_COLOR,
  seedOmnesisNotesSourceMeta,
} from "./source-meta.js";
export {
  bootOmnesisNotes,
  type OmnesisNotesBootDeps,
  type OmnesisNotesRuntime,
  type CaptureNoteInput,
} from "./wiring.js";
export {
  NotesDayUpserter,
  DEFAULT_DEBOUNCE_MS,
  buildNotesDayDocument,
  type NotesDayUpserterDeps,
} from "./upsert.js";
export { renderNotesDay, type RenderedNotesDay } from "./render.js";
export { dayKeyFor, localHourMinute, DAY_KEY_RE } from "./day.js";
// The `note_entries` CRUD functions stay module-scoped (`./storage.js`):
// their consumers (schema setup, writer handlers, the write gates) import
// them directly. Only the row type is part of the public surface.
export { type NoteEntry } from "./storage.js";
