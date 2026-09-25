// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic transcriber for tests, demos, and synthetic universes.
 *
 * It treats the "audio" bytes as UTF-8 text and returns them verbatim as the
 * transcript — so a synthetic source can ship a voice note whose bytes ARE the
 * intended transcript, and the whole pipeline (download → /inference/transcribe
 * → transcript injected into the document → indexed → searchable) is exercised
 * end-to-end without a real Whisper model or any native dependency.
 *
 * Resolved from `inference.assignments.transcriber = "replay"` — the same
 * replay mechanism the agent uses for scripted fixtures.
 */

import type { TranscribeCapability, TranscriptionResult } from "@omnesis/core";

export class SyntheticTranscriber implements TranscribeCapability {
  readonly name = "synthetic-transcriber";
  readonly modelId = "replay";

  // eslint-disable-next-line @typescript-eslint/require-await
  async transcribe(
    audio: Uint8Array,
    _mimeType: string,
    opts?: { language?: string },
  ): Promise<TranscriptionResult> {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(audio).trim();
    // Echo the language hint when given (defaulting to English) so tests can
    // verify the hint flows collector → gateway → capability end-to-end.
    return { text, language: opts?.language ?? "en" };
  }

  async dispose(): Promise<void> {}
}
