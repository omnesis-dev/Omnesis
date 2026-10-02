// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway dictation gate — the single answer to "may a mobile app send a
 * Tell Omnesis voice note's audio to this gateway for transcription?".
 *
 * Two levers, both required:
 *
 *   - **the operator's setting**, `inference.dictation.transcribeOnGateway`,
 *     on unless set to false;
 *   - **a runnable `transcriber`** — the same model that transcribes source
 *     voice notes, judged by `TranscribeService.readiness()`.
 *
 * The verdict is advertised verbatim as `dictation` on `GET /status`, and
 * `POST /notes/voice` enforces the same predicates. A client only sends audio
 * while `active` is true, and otherwise saves the phone's own transcript as a
 * plain note, so an old gateway (no field) and an inactive gateway look the
 * same to it.
 */

import { MAX_AUDIO_BYTES, type TranscriberReadiness } from "../transcribe/index.js";
import type { OmnesisConfig } from "@omnesis/config";

export interface DictationFeatureStatus {
  /** Surfaces may show the setting: the gateway supports voice-note transcription. */
  visible: boolean;
  /** The operator switched gateway dictation on. */
  enabled: boolean;
  /** A transcriber is assigned and can run. */
  modelAssigned: boolean;
  /** Clients should send dictation audio: enabled AND a runnable model. */
  active: boolean;
  /**
   * Why the transcriber cannot run, when it cannot. Absent while runnable.
   * Clients show it beside the setting so an operator who switched it on can
   * see why it has no effect.
   */
  reason?: string;
  /** Largest audio body the gateway accepts, in bytes. */
  maxAudioBytes: number;
}

/**
 * Whether the operator leaves gateway dictation on, read from the live config.
 * On unless explicitly switched off: with a transcriber assigned, sending Tell
 * Omnesis audio to it is the better default, and every path falls back to the
 * device's own transcript.
 */
export function dictationOptedIn(config: OmnesisConfig): boolean {
  return config.inference?.dictation?.transcribeOnGateway !== false;
}

/**
 * Compute the live verdict. Reads the config and the
 * transcriber's readiness fresh on every call, so a change takes effect on the
 * next `/status` poll or request without a restart.
 */
export function dictationFeatureStatus(deps: {
  transcriberReadiness: () => TranscriberReadiness;
  getConfig: () => OmnesisConfig;
}): DictationFeatureStatus {
  const readiness = deps.transcriberReadiness();
  const enabled = dictationOptedIn(deps.getConfig());
  return {
    visible: true,
    enabled,
    modelAssigned: readiness.runnable,
    active: enabled && readiness.runnable,
    ...(readiness.reason !== undefined ? { reason: readiness.reason } : {}),
    maxAudioBytes: MAX_AUDIO_BYTES,
  };
}

/** The verdict of a gateway built without the feature: nothing to show. */
export function inactiveDictationStatus(): DictationFeatureStatus {
  return {
    visible: false,
    enabled: false,
    modelAssigned: false,
    active: false,
    maxAudioBytes: MAX_AUDIO_BYTES,
  };
}
