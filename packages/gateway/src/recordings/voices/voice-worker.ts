// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Voice separation worker subprocess. Loads the sherpa-onnx speaker models
 * once, then serves `separate` (a clip's voice windows and their vectors) and
 * `group` (vectors to speakers) requests framed over stdio. Spawned and
 * supervised by `local-voice-separator.ts`.
 *
 * Usage: node [--import <tsx loader>] voice-worker.ts <segmentationModel> <embeddingModel>
 */

import { createLogger } from "@omnesis/core";

import {
  encodeFrame,
  FrameDecoder,
  type VoiceRequestHeader,
  type VoiceWorkerMessage,
} from "./voice-worker-protocol.js";
import { groupVoices, unpackVectors, voiceWindows } from "./voices.js";

const log = createLogger("gateway:recordings:voice-worker");

const SHERPA_SPECIFIER = "sherpa-onnx-node";
const SAMPLE_RATE = 16_000;
const THREADS = 2;

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}
interface SherpaModule {
  OfflineSpeakerDiarization: new (config: unknown) => {
    process(samples: Float32Array): { start: number; end: number; speaker: number }[];
  };
  SpeakerEmbeddingExtractor: new (config: unknown) => {
    createStream(): SherpaStream;
    compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array;
  };
}

function send(msg: VoiceWorkerMessage): void {
  process.stdout.write(encodeFrame(msg));
}

const [segmentationModel, embeddingModel] = process.argv.slice(2);
if (!segmentationModel || !embeddingModel) {
  log.error("Voice worker: missing model paths");
  process.exit(2);
}

const imported = (await import(SHERPA_SPECIFIER)) as SherpaModule & { default?: SherpaModule };
const sherpa = imported.default ?? imported;
const diarization = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: segmentationModel }, numThreads: THREADS },
  embedding: { model: embeddingModel, numThreads: THREADS },
  // Only its turn boundaries are used; speakers are grouped across the session.
  clustering: { numClusters: -1, threshold: 0.5 },
  minDurationOn: 0.3,
  minDurationOff: 0.5,
});
const extractor = new sherpa.SpeakerEmbeddingExtractor({
  model: embeddingModel,
  numThreads: THREADS,
});
log.info(`Loaded voice models ${segmentationModel}, ${embeddingModel}`);
send({ type: "ready" });

function separate(pcm: Float32Array): VoiceWorkerMessage & { type: "result" } {
  const turns = diarization.process(pcm).map((t) => ({
    startMs: Math.round(t.start * 1000),
    endMs: Math.round(t.end * 1000),
  }));
  const windows = voiceWindows(turns);
  const vectors = windows.map((w) => {
    const stream = extractor.createStream();
    stream.acceptWaveform({
      sampleRate: SAMPLE_RATE,
      samples: pcm.subarray(
        Math.floor((w.startMs / 1000) * SAMPLE_RATE),
        Math.floor((w.endMs / 1000) * SAMPLE_RATE),
      ),
    });
    stream.inputFinished();
    return Array.from(extractor.compute(stream, false));
  });
  return { type: "result", id: 0, windows, vectors };
}

function handle(header: VoiceRequestHeader, tail: Float32Array): void {
  try {
    if (header.op === "separate") {
      send({ ...separate(tail), id: header.id });
    } else {
      const vectors = unpackVectors(new Uint8Array(tail.buffer), header.count ?? 0);
      send({ type: "result", id: header.id, labels: groupVoices(vectors, header.threshold) });
    }
  } catch (err) {
    send({ type: "error", id: header.id, error: err instanceof Error ? err.message : String(err) });
  }
}

const decoder = new FrameDecoder((rawHeader, tail) => {
  const header = rawHeader as VoiceRequestHeader;
  if (header?.type !== "request") return;
  // Copy out of the shared decode buffer into an aligned Float32Array.
  const aligned = new ArrayBuffer(tail.byteLength - (tail.byteLength % 4));
  Buffer.from(tail.buffer, tail.byteOffset, aligned.byteLength).copy(Buffer.from(aligned));
  handle(header, new Float32Array(aligned));
});

process.stdin.on("data", (chunk: Buffer) => decoder.push(chunk));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
