// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Isolated Whisper worker subprocess. Loads the whisper.cpp model once (the
 * `smart-whisper` native binding) and serves transcription requests over a
 * length-prefixed stdio protocol (see `whisper-worker-protocol.ts`).
 *
 * It runs in its OWN process so a native whisper.cpp segfault — which is
 * process-wide and cannot be contained by a Node worker_thread — kills only
 * this child, not the gateway. The supervisor (`whisper-transcriber.ts`)
 * observes the non-zero/signal exit, fails the in-flight request as null, and
 * respawns on the next call.
 *
 * Usage: <node|npx tsx> whisper-worker.ts <modelPath> <gpu:0|1> <offloadSeconds>
 * Protocol:
 *   - stdin:  length-prefixed request frames (JSON header + PCM Float32 tail).
 *   - stdout: length-prefixed JSON frames — one `ready` after the model loads,
 *             then a `result` or `error` per request id.
 *   - stderr: structured logger output.
 */

export {}; // top-level await needs this to be a module

import { createLogger } from "@omnesis/core";
import {
  FrameDecoder,
  encodeFrame,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";

const log = createLogger("gateway:transcribe:whisper-worker");

const SMART_WHISPER_SPECIFIER = "smart-whisper";

interface WhisperSegment {
  text: string;
  lang?: string;
  confidence?: number;
}
interface WhisperTask {
  result: Promise<WhisperSegment[]>;
}
interface WhisperInstance {
  transcribe(pcm: Float32Array, params?: Record<string, unknown>): Promise<WhisperTask>;
  free(): Promise<void>;
}
interface SmartWhisperModule {
  Whisper: new (file: string, config?: { offload?: number; gpu?: boolean }) => WhisperInstance;
}

function send(msg: WhisperWorkerMessage): void {
  process.stdout.write(encodeFrame(msg));
}

const modelPath = process.argv[2];
const gpu = process.argv[3] === "1";
const offloadSeconds = Number(process.argv[4]);

if (!modelPath || !Number.isFinite(offloadSeconds)) {
  log.error(`Whisper worker: missing/invalid args (modelPath, gpu, offloadSeconds)`);
  process.exit(2);
}

// Load the model once. A failure here (missing native dep, bad model file) is
// fatal for the worker: exit non-zero so the supervisor reports the call null
// and the loader's availability probe surfaces the deeper cause.
const mod = (await import(SMART_WHISPER_SPECIFIER)) as SmartWhisperModule;
const whisper = new mod.Whisper(modelPath, { gpu, offload: offloadSeconds });
log.info(`Loaded Whisper model ${modelPath} (gpu=${gpu})`);
send({ type: "ready" });

// Requests arrive serialized from the supervisor (the service runs one at a
// time), so a single in-flight transcription is enough — no queue needed.
async function handleRequest(header: WhisperRequestHeader, pcm: Float32Array): Promise<void> {
  const durationSec = pcm.length / 16_000;
  try {
    const task = await whisper.transcribe(pcm, { language: header.language, format: "detail" });
    const segments = await task.result;
    const text = segments
      .map((s) => s.text)
      .join("")
      .trim();
    const language = segments[0]?.lang;
    send({ type: "result", id: header.id, text, language, durationSec });
  } catch (err) {
    send({ type: "error", id: header.id, error: err instanceof Error ? err.message : String(err) });
  }
}

const decoder = new FrameDecoder((rawHeader, tail) => {
  const header = rawHeader as WhisperRequestHeader;
  if (header?.type !== "request") return;
  // Copy the PCM out of the shared decode buffer into an aligned Float32Array;
  // `tail` is a zero-copy view that the next chunk would overwrite.
  const aligned = new ArrayBuffer(tail.byteLength - (tail.byteLength % 4));
  Buffer.from(tail.buffer, tail.byteOffset, aligned.byteLength).copy(Buffer.from(aligned));
  void handleRequest(header, new Float32Array(aligned));
});

process.stdin.on("data", (chunk: Buffer) => decoder.push(chunk));
// When the parent closes our stdin (dispose / respawn), exit cleanly.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
