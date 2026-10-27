// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Transcription through an OpenAI-compatible `POST /v1/audio/transcriptions`
 * endpoint. This is how a transcriber runs on a GPU the gateway process cannot
 * use itself: whisper.cpp's `whisper-server` built for CUDA or Vulkan, vLLM
 * serving a Whisper model, speaches / faster-whisper-server, or a hosted API.
 *
 * The audio is decoded to 16 kHz mono PCM first and sent as a WAV file, the
 * one format every such server accepts, whatever container the source used.
 * A recording longer than ten minutes is sent as consecutive chunks that each
 * fit a 25 MB upload limit, and their transcripts are joined.
 *
 * The assignment names an HTTP backend declared in `inference.backends`. Every
 * request goes through the inference URL policy: a loopback backend works by
 * default, and any other address needs `inference.allowRemoteInference`.
 * Personal vocabulary hints are sent only to a loopback backend; a backend on
 * another machine transcribes without them.
 *
 * Stateless per call: the server owns the model, so `dispose` is a no-op.
 */

import { randomUUID } from "node:crypto";
import {
  assertInferenceUrlAllowed,
  createLogger,
  fetchAllowingSlowResponse,
  fetchWithInferenceUrlPolicy,
  normalizeApiPathPrefix,
  retryRateLimitedRequest,
} from "@omnesis/core";
import { PCM_SAMPLE_RATE, decodeToPcm16kMono, type AudioDecoder } from "./audio-decode.js";
import { computeTranscriptionTimeoutMs } from "./deadline.js";
import { adaptTranscriptionVocabulary } from "./vocabulary-adapter.js";
import type {
  TranscribeCapability,
  TranscriptionResult,
  TranscriptionVocabulary,
} from "@omnesis/core";

const log = createLogger("gateway:transcribe:http");

export interface HttpTranscriberOptions {
  /** Base URL of the OpenAI-compatible backend, without the API path prefix. */
  url: string;
  /** API path prefix (`/v1` when unset). */
  apiPathPrefix?: string;
  /** Served model id to call. */
  model: string;
  /** Bearer token for the backend, when one is configured. */
  apiKey?: string;
  /** Permit non-loopback HTTP inference. Defaults off. */
  allowRemoteInference?: boolean;
  /** Injectable for tests; defaults to a fetch with no built-in response deadline. */
  fetchFn?: typeof fetch;
  /** Injectable audio decoder (tests). */
  decodeAudio?: AudioDecoder;
}

interface TranscriptionResponse {
  text?: unknown;
  language?: unknown;
}

export class HttpTranscriber implements TranscribeCapability {
  readonly vocabularyRuntime = "openai-prompt" as const;
  readonly name: string;
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly allowRemoteInference: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly decodeAudio: AudioDecoder;

  constructor(opts: HttpTranscriberOptions) {
    this.endpoint = `${opts.url.replace(/\/+$/, "")}${normalizeApiPathPrefix(opts.apiPathPrefix)}/audio/transcriptions`;
    this.model = opts.model;
    this.modelId = opts.model;
    this.name = `http-transcriber:${opts.model}`;
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.fetchFn = opts.fetchFn ?? fetchAllowingSlowResponse;
    this.decodeAudio = opts.decodeAudio ?? ((bytes) => decodeToPcm16kMono(bytes));
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: Parameters<TranscribeCapability["transcribe"]>[2],
  ): Promise<TranscriptionResult> {
    const pcm = await this.decodeAudio(audio, mimeType);
    const durationSec = pcm.length / PCM_SAMPLE_RATE;
    // A container with no samples has no speech to send; a server would
    // refuse the empty file and the recording would be retried forever.
    if (pcm.length === 0) return { text: "", durationSec: 0 };

    const fields: Array<[string, string]> = [
      ["model", this.model],
      ["response_format", "json"],
      ["temperature", "0"],
    ];
    if (opts?.language && opts.language !== "auto") fields.push(["language", opts.language]);
    const prompt = opts?.vocabulary
      ? await this.vocabularyPrompt(opts.vocabulary, opts.maxPromptTokens)
      : undefined;
    if (prompt) fields.push(["prompt", prompt]);

    const timeout = AbortSignal.timeout(
      computeTranscriptionTimeoutMs(durationSec, opts?.minTimeoutMs),
    );
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const texts: string[] = [];
    let language: string | undefined;
    for (const chunk of splitPcm(pcm)) {
      const part = await this.transcribeChunk(chunk, fields, signal);
      if (part.text) texts.push(part.text);
      language ??= part.language;
    }
    const text = texts.join(" ");
    log.debug(
      `Transcribed ${durationSec.toFixed(1)}s of audio via ${this.model} → ${text.length} chars`,
    );
    return { text, ...(language ? { language } : {}), durationSec };
  }

  private async transcribeChunk(
    pcm: Float32Array,
    fields: ReadonlyArray<readonly [string, string]>,
    signal: AbortSignal,
  ): Promise<{ text: string; language?: string }> {
    const { body, contentType } = encodeMultipart(fields, {
      name: "file",
      filename: "audio.wav",
      contentType: "audio/wav",
      data: encodeWav(pcm),
    });
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await retryRateLimitedRequest(
      () =>
        fetchWithInferenceUrlPolicy(
          this.endpoint,
          { method: "POST", headers, body, signal },
          { allowRemoteInference: this.allowRemoteInference, fetchFn: this.fetchFn },
        ),
      {
        signal,
        onRetry: ({ attempt, delayMs }) =>
          log.warn(
            `transcription rate-limited for model=${this.model}; retrying attempt ${attempt} after ${delayMs}ms`,
          ),
      },
    );

    if (!res.ok) {
      // Drain the body without keeping it: a backend can echo the request,
      // and the request is the user's speech. Every refusal is retried on a
      // later sync — the audio decoded cleanly and fits the upload limit, so a
      // refusal points at the backend (a wrong model id, an overloaded
      // server), not at this recording.
      await res.text().catch(() => "");
      throw new Error(`transcription backend ${this.model} refused the audio (HTTP ${res.status})`);
    }
    const json = (await res.json()) as TranscriptionResponse;
    if (typeof json.text !== "string") {
      throw new Error(`transcription backend ${this.model} returned no text`);
    }
    const parsed = parseTranscriptText(json.text);
    const language = typeof json.language === "string" ? json.language : parsed.language;
    return { text: parsed.text, ...(language ? { language } : {}) };
  }

  /** Personal vocabulary stays on the machine: only a loopback backend gets it. */
  private async vocabularyPrompt(
    vocabulary: TranscriptionVocabulary,
    maxPromptTokens: number | undefined,
  ): Promise<string | undefined> {
    try {
      await assertInferenceUrlAllowed(this.endpoint, { allowRemoteInference: false });
    } catch {
      return undefined;
    }
    return adaptTranscriptionVocabulary(vocabulary, {
      runtime: this.vocabularyRuntime,
      maxPromptTokens,
    })?.initial_prompt;
  }

  async dispose(): Promise<void> {}
}

/**
 * Longest audio sent in one request. Ten minutes of 16 kHz 16-bit WAV is
 * 19.2 MB, under the 25 MB upload limit OpenAI and vLLM apply.
 */
export const MAX_CHUNK_SAMPLES = 600 * PCM_SAMPLE_RATE;
/** How far back from a chunk's limit to look for a quiet place to split. */
const SPLIT_SEARCH_SAMPLES = 10 * PCM_SAMPLE_RATE;
/** 20 ms frames: short enough to land in the gap between two words. */
const SPLIT_FRAME_SAMPLES = 320;

/**
 * Split PCM into chunks of at most `MAX_CHUNK_SAMPLES`, each ending at the
 * quietest 20 ms frame in its last ten seconds so a split rarely cuts a word.
 */
export function splitPcm(pcm: Float32Array): Float32Array[] {
  const chunks: Float32Array[] = [];
  let start = 0;
  while (pcm.length - start > MAX_CHUNK_SAMPLES) {
    const limit = start + MAX_CHUNK_SAMPLES;
    let split = limit;
    let quietest = Infinity;
    for (
      let frame = limit - SPLIT_SEARCH_SAMPLES;
      frame + SPLIT_FRAME_SAMPLES <= limit;
      frame += SPLIT_FRAME_SAMPLES
    ) {
      let energy = 0;
      for (let i = frame; i < frame + SPLIT_FRAME_SAMPLES; i += 1) energy += pcm[i]! * pcm[i]!;
      if (energy < quietest) {
        quietest = energy;
        split = frame + SPLIT_FRAME_SAMPLES / 2;
      }
    }
    chunks.push(pcm.subarray(start, split));
    start = split;
  }
  chunks.push(pcm.subarray(start));
  return chunks;
}

/**
 * Qwen3-ASR answers with its detected language ahead of the words, as
 * `language English<asr_text>the words`, and a server that passes the model's
 * output through (Ollama, llama-server) puts that whole string in `text`. Keep
 * the words; the language is useful when the server reported none.
 */
const QWEN3_ASR_PREFIX = /^\s*language\s+([A-Za-z-]+)\s*<asr_text>/;

/** The transcript's words, and a language the model wrote ahead of them. */
export function parseTranscriptText(raw: string): { text: string; language?: string } {
  const match = QWEN3_ASR_PREFIX.exec(raw);
  if (!match) return { text: raw.trim() };
  return {
    text: raw.slice(match[0].length).trim(),
    language: languageCodeFromName(match[1]!),
  };
}

/** ISO-639-1 code for the language names Qwen3-ASR writes, or the name itself. */
function languageCodeFromName(name: string): string {
  const key = name.toLowerCase();
  const code: Record<string, string> = {
    english: "en",
    chinese: "zh",
    mandarin: "zh",
    cantonese: "yue",
    french: "fr",
    german: "de",
    spanish: "es",
    italian: "it",
    portuguese: "pt",
    japanese: "ja",
    korean: "ko",
    russian: "ru",
    arabic: "ar",
    dutch: "nl",
    polish: "pl",
    turkish: "tr",
    vietnamese: "vi",
    thai: "th",
    indonesian: "id",
    hindi: "hi",
    ukrainian: "uk",
    swedish: "sv",
    danish: "da",
    norwegian: "no",
    finnish: "fi",
    czech: "cs",
    greek: "el",
    hebrew: "he",
    hungarian: "hu",
    romanian: "ro",
    malay: "ms",
  };
  return code[key] ?? key;
}

/** 16-bit little-endian mono WAV for 16 kHz float PCM in [-1, 1]. */
export function encodeWav(pcm: Float32Array): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  buf.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[i]!));
    buf.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), 44 + i * 2);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** A `multipart/form-data` body: text fields followed by one file part. */
export function encodeMultipart(
  fields: ReadonlyArray<readonly [string, string]>,
  file: { name: string; filename: string; contentType: string; data: Uint8Array },
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `omnesis-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );
  const body = Buffer.concat(parts);
  return {
    body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
