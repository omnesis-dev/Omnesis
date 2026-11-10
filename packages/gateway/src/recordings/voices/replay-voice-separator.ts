// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic voice separator for tests and synthetic universes, the voice
 * counterpart of the synthetic transcriber. Audio that is a JSON transcript
 * script, `{"segments":[{"startMs","endMs","text","voice"}]}`, yields one
 * voice window per segment whose vector stands for its `voice` name, so the
 * same name is grouped into the same speaker; any other audio has no voices.
 */

import { groupVoices, type SeparatedVoices, type VoiceSeparator } from "./voices.js";

const DIM = 32;

export class ReplayVoiceSeparator implements VoiceSeparator {
  readonly name = "replay";

  async separate(audio: Uint8Array): Promise<SeparatedVoices> {
    const text = new TextDecoder().decode(audio).trim();
    if (!text.startsWith('{"segments"')) return { windows: [], vectors: [] };
    let segments: unknown;
    try {
      segments = (JSON.parse(text) as { segments?: unknown }).segments;
    } catch {
      return { windows: [], vectors: [] };
    }
    const out: SeparatedVoices = { windows: [], vectors: [] };
    for (const s of Array.isArray(segments) ? segments : []) {
      const { startMs, endMs, voice } = s as Record<string, unknown>;
      if (typeof startMs !== "number" || typeof endMs !== "number" || typeof voice !== "string") {
        continue;
      }
      out.windows.push({ startMs, endMs });
      out.vectors.push(voiceVector(voice));
    }
    return Promise.resolve(out);
  }

  group(vectors: readonly Float32Array[]): Promise<number[]> {
    return Promise.resolve(groupVoices(vectors));
  }

  async dispose(): Promise<void> {}
}

/** An axis per voice name: equal names are identical, different ones orthogonal. */
function voiceVector(voice: string): Float32Array {
  let hash = 0;
  for (const ch of voice) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const v = new Float32Array(DIM);
  v[hash % DIM] = 1;
  return v;
}
