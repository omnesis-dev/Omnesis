// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway dictation (experimental): the mobile apps send the audio they record
 * and the gateway's transcriber returns the text. The gate lives here; the
 * route is `http/routes/dictation.ts`; the transcription itself is the shared
 * `TranscribeService`, on its interactive lane.
 */

export {
  dictationFeatureStatus,
  dictationOptedIn,
  inactiveDictationStatus,
} from "./feature-gate.js";
export type { DictationFeatureStatus } from "./feature-gate.js";
