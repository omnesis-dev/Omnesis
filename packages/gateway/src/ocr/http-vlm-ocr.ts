// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OCR via an OpenAI-compatible vision endpoint — the path for a self-hosted
 * vision-language model served by vLLM or llama.cpp's `llama-server` (e.g.
 * dots.ocr, DeepSeek-OCR, PaddleOCR-VL, Qwen-VL). The image is sent inline as a
 * base64 data URL on a single `chat/completions` turn; the model's reply is the
 * recognized text.
 *
 * The assignment names an HTTP backend declared in `inference.backends`.
 * Non-loopback inference requires the operator's explicit remote-inference
 * opt-in, the same policy applied to the separate Codex OCR adapter.
 *
 * Stateless per call: there's no model to load or free, so `dispose` is a no-op.
 */

import { createLogger, fetchWithInferenceUrlPolicy, retryRateLimitedRequest } from "@omnesis/core";
import type { OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr:http");

/** Request the model to transcribe verbatim, no commentary or fences. */
export const OCR_PROMPT =
  "Transcribe all text in this image exactly as it appears, preserving the " +
  "reading order and line breaks. Output only the transcribed text — no " +
  "commentary, no labels, no markdown code fences. If the image contains no " +
  "readable text, output nothing.";

/** Cap generated tokens so a hallucinating model can't run away on a noisy image. */
const MAX_OCR_TOKENS = 4096;

/** Injectable for tests; defaults to global fetch. */
export type FetchFn = typeof fetch;

export interface HttpVlmOcrOptions {
  /** Base URL of the OpenAI-compatible backend (without a trailing `/v1`). */
  url: string;
  /** Served model id to call. */
  model: string;
  /** Bearer token for the backend, when one is configured. */
  apiKey?: string;
  /** Injectable for tests. */
  fetchFn?: FetchFn;
  /** Permit non-loopback HTTP inference. Defaults off. */
  allowRemoteInference?: boolean;
  /** Per-request timeout. Vision generation on a big page can be slow. */
  timeoutMs?: number;
}

/**
 * The text of a reply given as a layout — a JSON array of regions, each with
 * its `text`, in reading order — or the reply itself when it is not one.
 *
 * Document-layout models such as dots.ocr are trained to answer this way and
 * sometimes do despite the prompt. Stored as it came, the index would hold
 * the coordinates and category names instead of the text. Regions without
 * text, such as pictures, contribute nothing. A layout cut off by the token
 * cap is not valid JSON; the text of its complete regions is kept.
 */
export function layoutReplyText(reply: string): string {
  if (!reply.startsWith("[")) return reply;
  let regions: unknown;
  try {
    regions = JSON.parse(reply);
  } catch {
    return /^\[\s*\{\s*"bbox"/.test(reply) ? truncatedLayoutText(reply) : reply;
  }
  if (!Array.isArray(regions) || regions.length === 0) return reply;
  const isRegion = (r: unknown): r is { text?: unknown } =>
    typeof r === "object" && r !== null && !Array.isArray(r) && ("bbox" in r || "category" in r);
  if (!regions.every(isRegion)) return reply;
  return regions
    .map((r) => (typeof r.text === "string" ? r.text.trim() : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function truncatedLayoutText(reply: string): string {
  const texts: string[] = [];
  for (const match of reply.matchAll(/"text":\s*("(?:[^"\\]|\\.)*")/g)) {
    const text = (JSON.parse(match[1]!) as string).trim();
    if (text.length > 0) texts.push(text);
  }
  return texts.join("\n\n");
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class HttpVlmOcr implements OcrCapability {
  readonly name: string;
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchFn: FetchFn;
  private readonly allowRemoteInference: boolean;
  private readonly timeoutMs: number;

  constructor(opts: HttpVlmOcrOptions) {
    this.endpoint = `${opts.url.replace(/\/+$/, "")}/v1/chat/completions`;
    this.model = opts.model;
    this.modelId = opts.model;
    this.name = `vlm-ocr:${opts.model}`;
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async recognize(
    image: Uint8Array,
    mimeType: string,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<OcrResult> {
    const dataUrl = `data:${mimeType || "image/png"};base64,${Buffer.from(image).toString("base64")}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: this.model,
      temperature: 0,
      max_tokens: MAX_OCR_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const deadline = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await retryRateLimitedRequest(
      () =>
        fetchWithInferenceUrlPolicy(
          this.endpoint,
          { method: "POST", headers, body, signal: deadline },
          { allowRemoteInference: this.allowRemoteInference, fetchFn: this.fetchFn },
        ),
      {
        signal: deadline,
        onRetry: ({ attempt, delayMs }) =>
          log.warn(
            `vision request rate-limited for model=${this.model}; ` +
              `retrying attempt ${attempt} after ${delayMs}ms`,
          ),
      },
    );

    if (!res.ok) {
      // Drain the upstream body to release the connection, but never retain or
      // surface it: a backend can echo the submitted image or extracted corpus
      // text in an error response.
      await res.text().catch(() => "");
      // 429/502/503/504 mean the backend (or a proxy in front of it) is
      // rate-limited, unavailable, or timed out — genuinely transient. Throw
      // so the route surfaces a 5xx
      // and the collector retries the page with its cursor un-advanced, rather
      // than dropping a file that would OCR cleanly once the backend recovers.
      //A transport-level failure (connection refused/reset, timeout)
      // rejects `fetch` above and propagates the same way.
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        throw new Error(`vision backend ${this.model} unavailable (HTTP ${res.status})`);
      }
      // Any other non-2xx — a 4xx, or a 500 the model returned AFTER receiving
      // the request — is a per-image dead end: the backend is reachable but
      // can't turn THIS input into text (an unsupported/corrupt/undecodable
      // image such as SVG/HEIC, a too-long input, or a model preprocessing
      // error like PIL's `UnidentifiedImageError`). Return no text so the
      // attachment is left un-OCR'd and the sync moves on. Throwing here would
      // surface as a 500 the collector treats as transient and retry FOREVER on
      // a permanently-bad file — stalling the whole source (the OneDrive case).
      log.warn(
        `vision backend ${this.model} could not OCR an image (HTTP ${res.status}, ${mimeType})`,
      );
      return { text: "" };
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const text = layoutReplyText((json.choices?.[0]?.message?.content ?? "").trim());
    log.debug(
      `OCR via ${this.model}: ${image.byteLength} bytes (${mimeType}) → ${text.length} chars`,
    );
    return { text };
  }

  async dispose(): Promise<void> {}
}
