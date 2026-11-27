// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The on-disk layout of the speaker-grouping eval, shared by the script that
 * separates the recordings and the script that scores groupings.
 *
 * Everything lives outside the repository, under `~/.cache/omnesis-speaker-eval`
 * (or `OMNESIS_SPEAKER_EVAL_DATA`): the downloaded audio and reference RTTMs
 * under `raw/`, the pinned voice models under `models/`, and one cached
 * separation per recording under `separated/` — the voice windows on the
 * recording's timeline, their vectors, and the reference speaker turns.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DatasetName = "voxconverse" | "ami";

/** One reference speaker turn, ms from the recording's start. */
export interface Turn {
  speaker: string;
  startMs: number;
  endMs: number;
}

/** One voice window the production separator found, on the recording's timeline. */
export interface CachedWindow {
  startMs: number;
  endMs: number;
  /** Index of the device-like chunk the window came from. */
  chunk: number;
}

/** A recording separated once by the production pipeline. */
export interface SeparatedRecording {
  id: string;
  dataset: DatasetName;
  durationMs: number;
  chunks: { startMs: number; endMs: number }[];
  windows: CachedWindow[];
  /** Vector dimension; the vectors are in `<id>.f32`, window order. */
  dim: number;
  reference: Turn[];
  /** Wall time the separation took, for the record. */
  separateMs: number;
}

/** A recording loaded for scoring: the cache plus its vectors. */
export interface LoadedRecording extends SeparatedRecording {
  vectors: Float32Array[];
}

export function defaultDataDir(): string {
  return process.env.OMNESIS_SPEAKER_EVAL_DATA ?? join(homedir(), ".cache", "omnesis-speaker-eval");
}

/** `cache` names the separation cache, so a changed separator can keep the old one beside it. */
export const paths = (dataDir: string, cache = "separated") => ({
  raw: (dataset: DatasetName) => join(dataDir, "raw", dataset),
  models: join(dataDir, "models"),
  separated: join(dataDir, cache),
  manifest: join(dataDir, cache, "manifest.json"),
});

/** Parse an RTTM file into turns, sorted by start. */
export function parseRttm(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "SPEAKER" || f.length < 8) continue;
    const start = Number(f[3]);
    const dur = Number(f[4]);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
    turns.push({
      speaker: f[7]!,
      startMs: Math.round(start * 1000),
      endMs: Math.round((start + dur) * 1000),
    });
  }
  return turns.sort((a, b) => a.startMs - b.startMs);
}

/** Total reference talk per speaker, ms (overlaps count for each speaker). */
export function talkPerSpeaker(turns: readonly Turn[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of turns) out.set(t.speaker, (out.get(t.speaker) ?? 0) + (t.endMs - t.startMs));
  return out;
}

/** Stretches of at least `minMs` where no reference speaker talks. */
export function referenceGaps(
  turns: readonly Turn[],
  durationMs: number,
  minMs: number,
): { startMs: number; endMs: number }[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const t of sorted) {
    if (t.startMs - cursor >= minMs) gaps.push({ startMs: cursor, endMs: t.startMs });
    cursor = Math.max(cursor, t.endMs);
  }
  if (durationMs - cursor >= minMs) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

export function writeSeparated(
  dir: string,
  rec: SeparatedRecording,
  vectors: Float32Array[],
): void {
  const packed = new Float32Array(vectors.length * rec.dim);
  vectors.forEach((v, i) => packed.set(v, i * rec.dim));
  writeFileSync(join(dir, `${rec.id}.f32`), Buffer.from(packed.buffer));
  writeFileSync(join(dir, `${rec.id}.json`), `${JSON.stringify(rec)}\n`);
}

export function hasSeparated(dir: string, id: string): boolean {
  return existsSync(join(dir, `${id}.json`)) && existsSync(join(dir, `${id}.f32`));
}

export function loadSeparated(dir: string, id: string): LoadedRecording {
  const rec = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as SeparatedRecording;
  const buf = readFileSync(join(dir, `${id}.f32`));
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const vectors = rec.windows.map((_, i) => all.slice(i * rec.dim, (i + 1) * rec.dim));
  return { ...rec, vectors };
}

/** The first `limitMs` of a recording: windows ending by then, turns clipped to it. */
export function truncate(rec: LoadedRecording, limitMs: number): LoadedRecording {
  const keep = rec.windows.map((w) => w.endMs <= limitMs);
  return {
    ...rec,
    id: `${rec.id}@${Math.round(limitMs / 60_000)}m`,
    durationMs: Math.min(rec.durationMs, limitMs),
    chunks: rec.chunks.filter((c) => c.endMs <= limitMs),
    windows: rec.windows.filter((_, i) => keep[i]),
    vectors: rec.vectors.filter((_, i) => keep[i]),
    reference: rec.reference
      .filter((t) => t.startMs < limitMs)
      .map((t) => ({ ...t, endMs: Math.min(t.endMs, limitMs) })),
  };
}
