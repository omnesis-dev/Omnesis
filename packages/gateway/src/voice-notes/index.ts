// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Voice notes (experimental): Tell Omnesis captures that arrive with their
 * audio, saved at once and transcribed afterwards by the gateway's
 * transcriber. The route is `http/routes/voice-notes.ts`; the gate that
 * decides whether devices send audio at all is `dictation/`.
 */

export {
  VoiceNoteService,
  TRANSCRIBING_PLACEHOLDER,
  UNTRANSCRIBED_TEXT,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
} from "./service.js";
export type { VoiceNoteInput, VoiceNoteServiceDeps } from "./service.js";
