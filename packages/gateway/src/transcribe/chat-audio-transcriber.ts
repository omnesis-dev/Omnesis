// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Transcription through an OpenAI-compatible `POST /v1/chat/completions`
 * carrying the audio as an `input_audio` content part. This is how a speech
 * model reached only through a chat API transcribes: an audio language model
 * served by vLLM or llama-server, Ollama's chat API, OpenAI's audio chat
 * models.
 *
 * The audio is decoded to 16 kHz mono PCM and sent as base64 WAV in chunks
 * of about a minute: an audio language model is accurate over a short stretch
 * at a time (Qwen3-ASR's accuracy holds to about a minute and falls off by
 * two), so each chunk ends at a quiet moment and the transcripts are joined. The
 * model is asked for the words only; an answer in Qwen3-ASR's own
 * `language …<asr_text>` format is read the same way as on the transcription
 * API.
 *
 * Same policy as `HttpTranscriber`: the inference URL policy keeps the backend
 * on loopback unless remote inference is allowed, and personal vocabulary is
 * only mentioned to a loopback backend.
 */

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
import { chunkSamples, encodeWav, parseTranscriptText, splitPcm } from "./http-transcriber.js";
import { adaptTranscriptionVocabulary } from "./vocabulary-adapter.js";
import type {
  TranscribeCapability,
  TranscriptionResult,
  TranscriptionVocabulary,
} from "@omnesis/core";

const log = createLogger("gateway:transcribe:chat-audio");

/** A chat audio model takes about a minute at a time. */
export const DEFAULT_CHAT_AUDIO_CHUNK_SECONDS = 60;

/** What the model is asked, with the audio. Qwen3-ASR ignores it; a general audio model needs it. */
export const TRANSCRIBE_INSTRUCTION =
  "Transcribe the audio exactly as spoken, in its own language. Reply with the words only.";

export interface ChatAudioTranscriberOptions {
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
  /** Longest stretch of audio per request, in seconds (one minute when unset). */
  maxChunkSeconds?: number;
  /** Injectable for tests; defaults to a fetch with no built-in response deadline. */
  fetchFn?: typeof fetch;
  /** Injectable audio decoder (tests). */
  decodeAudio?: AudioDecoder;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** The JSON body of one chat request carrying `pcm` as WAV. */
export function chatAudioRequestBody(
  model: string,
  pcm: Float32Array,
  instruction: string,
): Record<string, unknown> {
  return {
    model,
    stream: false,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: Buffer.from(encodeWav(pcm)).toString("base64"), format: "wav" },
          },
          { type: "text", text: instruction },
        ],
      },
    ],
  };
}

/** The transcript a chat completion carries, or null when it carries none. */
export function transcriptFromChatCompletion(json: unknown): string | null {
  const content = (json as ChatCompletionResponse | null)?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  // A server may answer with content parts; the text parts are the transcript.
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
      .filter((text): text is string => typeof text === "string");
    return texts.length > 0 ? texts.join("") : null;
  }
  return null;
}

export class ChatAudioTranscriber implements TranscribeCapability {
  readonly vocabularyRuntime = "openai-prompt" as const;
  readonly name: string;
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly allowRemoteInference: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly decodeAudio: AudioDecoder;
  private readonly maxChunkSamples: number;

  constructor(opts: ChatAudioTranscriberOptions) {
    this.endpoint = `${opts.url.replace(/\/+$/, "")}${normalizeApiPathPrefix(opts.apiPathPrefix)}/chat/completions`;
    this.model = opts.model;
    this.modelId = opts.model;
    this.name = `chat-audio-transcriber:${opts.model}`;
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.fetchFn = opts.fetchFn ?? fetchAllowingSlowResponse;
    this.decodeAudio = opts.decodeAudio ?? ((bytes) => decodeToPcm16kMono(bytes));
    this.maxChunkSamples = chunkSamples(opts.maxChunkSeconds ?? DEFAULT_CHAT_AUDIO_CHUNK_SECONDS);
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: Parameters<TranscribeCapability["transcribe"]>[2],
  ): Promise<TranscriptionResult> {
    const pcm = await this.decodeAudio(audio, mimeType);
    const durationSec = pcm.length / PCM_SAMPLE_RATE;
    if (pcm.length === 0) return { text: "", durationSec: 0 };

    let instruction = TRANSCRIBE_INSTRUCTION;
    const hints = opts?.vocabulary
      ? await this.vocabularyHints(opts.vocabulary, opts.maxPromptTokens)
      : undefined;
    if (hints) instruction += ` Names and terms that may occur: ${hints}`;

    const timeout = AbortSignal.timeout(
      computeTranscriptionTimeoutMs(durationSec, opts?.minTimeoutMs),
    );
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const texts: string[] = [];
    let language: string | undefined;
    for (const chunk of splitPcm(pcm, this.maxChunkSamples)) {
      const part = await this.transcribeChunk(chunk, instruction, signal);
      if (part.text) texts.push(part.text);
      language ??= part.language;
    }
    const text = texts.join(" ");
    log.debug(
      `Transcribed ${durationSec.toFixed(1)}s of audio via chat ${this.model} → ${text.length} chars`,
    );
    return { text, ...(language ? { language } : {}), durationSec };
  }

  private async transcribeChunk(
    pcm: Float32Array,
    instruction: string,
    signal: AbortSignal,
  ): Promise<{ text: string; language?: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const body = JSON.stringify(chatAudioRequestBody(this.model, pcm, instruction));
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
            `chat transcription rate-limited for model=${this.model}; retrying attempt ${attempt} after ${delayMs}ms`,
          ),
      },
    );
    if (!res.ok) {
      // Drained unread: a backend can echo the request, which is the speech.
      await res.text().catch(() => "");
      throw new Error(
        `chat transcription backend ${this.model} refused the audio (HTTP ${res.status})`,
      );
    }
    const transcript = transcriptFromChatCompletion(await res.json());
    if (transcript === null) {
      throw new Error(`chat transcription backend ${this.model} returned no text`);
    }
    return parseTranscriptText(transcript);
  }

  /** Personal vocabulary stays on the machine: only a loopback backend hears of it. */
  private async vocabularyHints(
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
