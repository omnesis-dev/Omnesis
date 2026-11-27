// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cut a long recording into chunks the way a recording device sends them:
 * about `targetMs` long on average, never longer than `maxMs`, cut in a
 * silence. Voice separation runs per chunk in production, so a speaker turn
 * is cut wherever a chunk ends; replaying that is the point of the cut.
 *
 * A silence is a stretch where no reference speaker talks (the device cuts on
 * its own voice-activity detector, which the reference stands in for). The
 * cut is the silence nearest the target within `slackMs` of it; without one,
 * the quietest 50 ms frame in that range — the pause between two words that a
 * device's detector would take — so that chunks average the target length
 * even through long monologues.
 */

export interface Span {
  startMs: number;
  endMs: number;
}

export interface ChunkOptions {
  targetMs: number;
  minMs: number;
  maxMs: number;
  /** How far from the target a cut may fall. */
  slackMs: number;
}

export const DEVICE_CHUNKS: ChunkOptions = {
  targetMs: 18_000,
  minMs: 6_000,
  maxMs: 60_000,
  slackMs: 6_000,
};

/** Frame length of `frameEnergy`. */
export const ENERGY_FRAME_MS = 50;

/** Mean square of each 50 ms frame of 16 kHz PCM. */
export function frameEnergy(pcm: Float32Array, sampleRate = 16_000): Float32Array {
  const frame = Math.round((sampleRate * ENERGY_FRAME_MS) / 1000);
  const out = new Float32Array(Math.ceil(pcm.length / frame));
  for (let f = 0; f < out.length; f += 1) {
    let s = 0;
    const end = Math.min(pcm.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i += 1) s += pcm[i]! * pcm[i]!;
    out[f] = s / Math.max(1, end - f * frame);
  }
  return out;
}

export function deviceChunks(
  durationMs: number,
  silences: readonly Span[],
  energy: Float32Array,
  opts: ChunkOptions = DEVICE_CHUNKS,
): Span[] {
  const cuts = silences.map((s) => Math.round((s.startMs + s.endMs) / 2)).sort((a, b) => a - b);
  const chunks: Span[] = [];
  let start = 0;
  while (durationMs - start > opts.maxMs || durationMs - start > opts.targetMs + opts.minMs) {
    const goal = start + opts.targetMs;
    const lo = Math.max(start + opts.minMs, goal - opts.slackMs);
    const hi = Math.min(start + opts.maxMs, goal + opts.slackMs, durationMs - opts.minMs);
    let cut = -1;
    for (const c of cuts) {
      if (c < lo || c > hi) continue;
      if (cut < 0 || Math.abs(c - goal) < Math.abs(cut - goal)) cut = c;
    }
    if (cut < 0) cut = quietest(energy, lo, hi);
    chunks.push({ startMs: start, endMs: cut });
    start = cut;
  }
  if (durationMs > start) chunks.push({ startMs: start, endMs: durationMs });
  return chunks;
}

/** Middle of the quietest frame between `lo` and `hi` ms. */
function quietest(energy: Float32Array, lo: number, hi: number): number {
  const a = Math.max(0, Math.floor(lo / ENERGY_FRAME_MS));
  const b = Math.min(energy.length - 1, Math.floor(hi / ENERGY_FRAME_MS));
  let best = a;
  for (let f = a; f <= b; f += 1) if (energy[f]! < energy[best]!) best = f;
  return Math.min(hi, Math.max(lo, best * ENERGY_FRAME_MS + ENERGY_FRAME_MS / 2));
}
