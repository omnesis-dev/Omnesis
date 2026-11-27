// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run speaker-eval:prepare` — download the public recordings, replay them
 * through the production voice separation, and cache what grouping needs.
 *
 * For each recording: decode to 16 kHz mono, cut it into device-like chunks
 * (`chunking.ts`), send every chunk through the real `LocalVoiceSeparator`
 * (which spawns the production voice worker: pyannote segmentation for turn
 * boundaries, `voiceWindows`, ERes2Net vectors), and store the windows on the
 * recording's timeline with their vectors and the reference turns. Separation
 * is the expensive step and runs once per recording; grouping candidates are
 * scored from the cache by `run.ts`.
 *
 * Data, all CC BY 4.0, pinned to commits:
 *  - VoxConverse dev: audio from the `diarizers-community/voxconverse` Hugging
 *    Face mirror (the Oxford download requires a login), reference RTTMs from
 *    `joonson/voxconverse`. Recordings with 2 to 4 reference speakers and at
 *    least five minutes are eligible; a deterministic sample is taken.
 *  - AMI test meetings, single distant microphone `Array1-01`, from the AMI
 *    mirror, reference RTTMs from `pyannote/AMI-diarization-setup`
 *    (only_words).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  EMBEDDING_MODEL,
  SEGMENTATION_MODEL,
} from "@omnesis/gateway/src/recordings/voices/loader.js";
import { LocalVoiceSeparator } from "@omnesis/gateway/src/recordings/voices/local-voice-separator.js";
import { startDownload } from "@omnesis/gateway/src/models/downloader.js";

import { deviceChunks, frameEnergy } from "./chunking.js";
import {
  defaultDataDir,
  hasSeparated,
  parseRttm,
  paths,
  referenceGaps,
  talkPerSpeaker,
  writeSeparated,
  type CachedWindow,
  type DatasetName,
  type Turn,
} from "./dataset.js";

const VOX_HF = "https://huggingface.co/datasets/diarizers-community/voxconverse/resolve";
const VOX_HF_REVISION = "3acfa1b45ca4b7419aee999d67d94c617f9c9d47";
const VOX_SHARDS = 5;
const VOX_RTTM =
  "https://raw.githubusercontent.com/joonson/voxconverse/24bf60be297701cd7e4ef18550c6d390c1b87365/dev";
const AMI_AUDIO = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus";
const AMI_RTTM =
  "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/67c2d539286e89f68952d5dcf83912bd9f01dfae/only_words/rttms/test";
const AMI_TEST = [
  "IS1009a",
  "IS1009b",
  "IS1009c",
  "IS1009d",
  "ES2004a",
  "ES2004b",
  "ES2004c",
  "ES2004d",
  "TS3003a",
  "TS3003b",
  "TS3003c",
  "TS3003d",
  "EN2002a",
  "EN2002b",
  "EN2002c",
  "EN2002d",
];

/** Gaps between reference turns at least this long count as a silence to cut in. */
const SILENCE_MS = 250;

const USAGE =
  "usage: speaker-eval:prepare -- [--data-dir <dir>] [--cache separated] [--vox-count 25] [--ami IS1009a,…] [--concurrency 7] [--only id,…]";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function fetchRetry(url: string, attempts = 30): Promise<Response> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok) return res;
      last = new Error(`${res.status} ${url}`);
      // The AMI mirror answers 503 under load; anything else is final.
      if (res.status !== 503 && res.status !== 429 && res.status < 500) throw last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function download(url: string, path: string): Promise<void> {
  if (existsSync(path)) return;
  const res = await fetchRetry(url);
  const tmp = `${path}.part`;
  writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()));
  renameSync(tmp, path);
}

async function ensureModels(dir: string): Promise<{ segmentation: string; embedding: string }> {
  for (const model of [SEGMENTATION_MODEL, EMBEDDING_MODEL]) {
    const p = join(dir, model.filename);
    if (existsSync(p) && statSync(p).size === model.sizeBytes) continue;
    say(`Downloading ${model.filename}`);
    await startDownload(model, { modelsDir: dir, onProgress: () => {} }).done;
  }
  return {
    segmentation: join(dir, SEGMENTATION_MODEL.filename),
    embedding: join(dir, EMBEDDING_MODEL.filename),
  };
}

interface Source {
  id: string;
  dataset: DatasetName;
  audio: string;
  reference: Turn[];
}

/** A stable pseudo-random order, the same on every machine. */
function hashOrder(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function voxconverse(dataDir: string, count: number): Promise<Source[]> {
  const raw = paths(dataDir).raw("voxconverse");
  mkdirSync(join(raw, "rttm"), { recursive: true });
  mkdirSync(join(raw, "wav"), { recursive: true });
  const shards: string[] = [];
  for (let i = 0; i < VOX_SHARDS; i += 1) {
    const name = `dev-0000${i}-of-0000${VOX_SHARDS}.parquet`;
    const p = join(raw, name);
    if (!existsSync(p)) say(`Downloading VoxConverse ${name}`);
    await download(`${VOX_HF}/${VOX_HF_REVISION}/data/${name}`, p);
    shards.push(p);
  }
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const list = shards.map((s) => `'${s}'`).join(", ");
  const ids = (
    await conn.runAndReadAll(`SELECT audio.path AS path FROM read_parquet([${list}]) ORDER BY 1`)
  )
    .getRowObjects()
    .map((r) => String(r.path).replace(/\.wav$/, ""));

  const eligible: Source[] = [];
  for (const id of ids) {
    const rttm = join(raw, "rttm", `${id}.rttm`);
    await download(`${VOX_RTTM}/${id}.rttm`, rttm);
    const reference = parseRttm(readFileSync(rttm, "utf8"));
    const speakers = talkPerSpeaker(reference).size;
    const end = Math.max(0, ...reference.map((t) => t.endMs));
    if (speakers < 2 || speakers > 4 || end < 5 * 60_000) continue;
    eligible.push({ id, dataset: "voxconverse", audio: join(raw, "wav", `${id}.wav`), reference });
  }
  const chosen = eligible
    .sort((a, b) => hashOrder(a.id).localeCompare(hashOrder(b.id)))
    .slice(0, count);
  say(
    `VoxConverse dev: ${ids.length} recordings, ${eligible.length} eligible, ${chosen.length} taken`,
  );
  for (const s of chosen) {
    if (existsSync(s.audio)) continue;
    const rows = (
      await conn.runAndReadAll(
        `SELECT audio.bytes AS bytes FROM read_parquet([${list}]) WHERE audio.path = '${s.id}.wav'`,
      )
    ).getRows();
    const blob = rows[0]?.[0] as { bytes: Uint8Array } | undefined;
    if (!blob) throw new Error(`VoxConverse ${s.id}: audio missing from the mirror`);
    writeFileSync(`${s.audio}.part`, blob.bytes);
    renameSync(`${s.audio}.part`, s.audio);
  }
  conn.closeSync();
  return chosen;
}

async function ami(dataDir: string, meetings: string[]): Promise<Source[]> {
  const raw = paths(dataDir).raw("ami");
  mkdirSync(raw, { recursive: true });
  const out: Source[] = [];
  for (const m of meetings) {
    const rttm = join(raw, `${m}.rttm`);
    const audio = join(raw, `${m}.Array1-01.wav`);
    await download(`${AMI_RTTM}/${m}.rttm`, rttm);
    if (!existsSync(audio)) say(`Downloading AMI ${m}`);
    await download(`${AMI_AUDIO}/${m}/audio/${m}.Array1-01.wav`, audio);
    out.push({ id: m, dataset: "ami", audio, reference: parseRttm(readFileSync(rttm, "utf8")) });
  }
  return out;
}

/** 16 kHz mono float PCM of an audio file, through ffmpeg. */
function decode(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-v",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "-",
    ]);
    const parts: Buffer[] = [];
    proc.stdout.on("data", (b: Buffer) => parts.push(b));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code} on ${path}`));
      const buf = Buffer.concat(parts);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice());
    });
  });
}

async function separateOne(
  separator: LocalVoiceSeparator,
  source: Source,
  outDir: string,
): Promise<void> {
  const started = Date.now();
  const pcm = await decode(source.audio);
  const durationMs = Math.floor(pcm.length / 16);
  const chunks = deviceChunks(
    durationMs,
    referenceGaps(source.reference, durationMs, SILENCE_MS),
    frameEnergy(pcm),
  );
  const windows: CachedWindow[] = [];
  const vectors: Float32Array[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const audio = pcm.slice(chunk.startMs * 16, chunk.endMs * 16);
    const result = await separator.separate(new Uint8Array(audio.buffer), "audio/x-pcm-f32");
    result.windows.forEach((w, i) => {
      windows.push({
        startMs: chunk.startMs + w.startMs,
        endMs: chunk.startMs + w.endMs,
        chunk: index,
      });
      vectors.push(result.vectors[i]!);
    });
  }
  const separateMs = Date.now() - started;
  writeSeparated(
    outDir,
    {
      id: source.id,
      dataset: source.dataset,
      durationMs,
      chunks,
      windows,
      dim: vectors[0]?.length ?? 0,
      reference: source.reference,
      separateMs,
    },
    vectors,
  );
  say(
    `${source.id}: ${(durationMs / 60_000).toFixed(1)} min, ${chunks.length} chunks, ${windows.length} windows in ${(separateMs / 1000).toFixed(0)} s`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      cache: { type: "string", default: "separated" },
      "vox-count": { type: "string", default: "25" },
      ami: { type: "string", default: AMI_TEST.join(",") },
      concurrency: { type: "string", default: "7" },
      only: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return say(USAGE);
  const dataDir = values["data-dir"] ?? defaultDataDir();
  const p = paths(dataDir, values.cache);
  mkdirSync(p.separated, { recursive: true });
  const models = await ensureModels(p.models);
  let sources = [
    ...(await voxconverse(dataDir, Number(values["vox-count"]))),
    ...(await ami(dataDir, values.ami ? values.ami.split(",").filter(Boolean) : [])),
  ];
  writeFileSync(
    p.manifest,
    `${JSON.stringify({ recordings: sources.map((s) => ({ id: s.id, dataset: s.dataset })) }, null, 2)}\n`,
  );
  if (values.only) {
    const only = new Set(values.only.split(","));
    sources = sources.filter((s) => only.has(s.id));
  }
  const todo = sources.filter((s) => !hasSeparated(p.separated, s.id));
  say(`${sources.length - todo.length} recordings already separated, ${todo.length} to go`);
  // Longest first, so the pool finishes together.
  todo.sort((a, b) => statSync(b.audio).size - statSync(a.audio).size);
  const lanes = Math.max(1, Number(values.concurrency));
  await Promise.all(
    Array.from({ length: Math.min(lanes, todo.length) }, async () => {
      const separator = new LocalVoiceSeparator({
        models,
        // Chunks are handed over already decoded: 16 kHz mono float PCM.
        decodeAudio: (bytes) =>
          Promise.resolve(
            new Float32Array(
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            ),
          ),
      });
      try {
        for (let s = todo.shift(); s; s = todo.shift())
          await separateOne(separator, s, p.separated);
      } finally {
        await separator.dispose();
      }
    }),
  );
  say("Done");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
