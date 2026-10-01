// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway dictation: the gate that decides whether the mobile
 * apps send Tell Omnesis voice notes' audio to this gateway. The notes
 * themselves are handled by `voice-notes/`.
 */

export {
  dictationFeatureStatus,
  dictationOptedIn,
  inactiveDictationStatus,
} from "./feature-gate.js";
export type { DictationFeatureStatus } from "./feature-gate.js";
