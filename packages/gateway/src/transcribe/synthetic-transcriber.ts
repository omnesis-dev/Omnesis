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
 *
 * Audio that is a JSON script, `{"segments":[{"startMs","endMs","text"}]}`,
 * is transcribed into those timed segments, so tests of timed transcripts
 * (and of the replay voice separator, which reads the same script) can run
 * without a model.
 */

import type { TranscribeCapability, TranscriptionResult, TranscriptSegment } from "@omnesis/core";

export class SyntheticTranscriber implements TranscribeCapability {
  readonly name = "synthetic-transcriber";
  readonly modelId = "replay";

  // eslint-disable-next-line @typescript-eslint/require-await
  async transcribe(
    audio: Uint8Array,
    _mimeType: string,
    opts?: { language?: string; minTimeoutMs?: number },
  ): Promise<TranscriptionResult> {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(audio).trim();
    // Echo the language hint when given (defaulting to English) so tests can
    // verify the hint flows collector → gateway → capability end-to-end.
    const language = opts?.language ?? "en";
    const script = parseSegmentScript(text);
    if (script) {
      return { text: script.map((s) => s.text).join(" "), language, segments: script };
    }
    return { text, language };
  }

  async dispose(): Promise<void> {}
}

/** The timed segments of a JSON transcript script, or null when the text is not one. */
export function parseSegmentScript(text: string): TranscriptSegment[] | null {
  if (!text.startsWith('{"segments"')) return null;
  try {
    const parsed = JSON.parse(text) as { segments?: unknown };
    if (!Array.isArray(parsed.segments)) return null;
    return parsed.segments.map((s) => {
      const { startMs, endMs, text: words } = s as Record<string, unknown>;
      if (typeof startMs !== "number" || typeof endMs !== "number" || typeof words !== "string") {
        throw new Error("malformed segment");
      }
      return { startMs, endMs, text: words };
    });
  } catch {
    return null;
  }
}
