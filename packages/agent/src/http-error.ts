// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  rateLimitRetryDelayMs,
  sanitizeProviderFailureField,
  type AgentProviderFailureDetail,
} from "@omnesis/core";

import { CONTEXT_WINDOW_EXCEEDED_MESSAGE } from "./turn-outcome.js";

/** Explicit generation ceiling used when an HTTP model has no configured cap. */
export const DEFAULT_HTTP_MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_HTTP_CONTEXT_SAFETY_MARGIN_TOKENS = 256;

/** Structured, privacy-safe metadata decoded from an HTTP model error. */
export interface DecodedHttpError {
  status: number;
  type?: string;
  code?: string;
  param?: string;
  requestId?: string;
  bodyBytes: number;
  contentType: string;
  contextWindowExceeded: boolean;
  protocolMismatch: boolean;
  unsupportedOutputLimitField?: "max_tokens" | "max_completion_tokens";
  /** The server rejected a `thinking` block as a field it does not accept. */
  unsupportedThinkingField?: boolean;
  /** Safe for an `agent.error` event. Never includes the upstream body. */
  publicMessage: string;
  /** Sanitized provider timing hint retained only for operator-facing wording. */
  retryAfterMs?: number;
}

interface HttpErrorFields {
  status?: number;
  type?: string;
  code?: string;
  param?: string;
  message?: string;
  /** False only when the source was an unstructured raw HTTP body. */
  structured?: boolean;
}

const CONTEXT_ERROR_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "prompt_too_long",
  "input_too_long",
]);

/**
 * Decode a non-2xx response without allowing its body into logs, transcripts,
 * or client-visible errors. The private body message exists only long enough
 * to classify documented compatible-server error shapes.
 */
export async function decodeHttpError(response: Response): Promise<DecodedHttpError> {
  const body = await response.text().catch(() => "");
  const parsed = parseErrorEnvelope(body);
  const fields: HttpErrorFields = { status: response.status, ...parsed };
  const contextWindowExceeded = isContextWindowHttpError(fields);
  const protocolMismatch =
    response.status === 404 &&
    (/v1\/responses/i.test(parsed.message ?? "") ||
      /not (?:a )?chat model/i.test(parsed.message ?? ""));
  const unsupportedOutputLimitField = unsupportedOutputField(fields);
  const unsupportedThinkingField = rejectsThinkingField(fields);
  const retryAfterMs =
    response.status === 429 ? rateLimitRetryDelayMs(response.headers) : undefined;
  return {
    status: response.status,
    ...(parsed.type ? { type: parsed.type } : {}),
    ...(parsed.code ? { code: parsed.code } : {}),
    ...(parsed.param ? { param: parsed.param } : {}),
    ...(requestIdFromHeaders(response.headers)
      ? { requestId: requestIdFromHeaders(response.headers) }
      : {}),
    bodyBytes: new TextEncoder().encode(body).byteLength,
    contentType: response.headers.get("content-type") ?? "unknown",
    contextWindowExceeded,
    protocolMismatch,
    ...(unsupportedOutputLimitField ? { unsupportedOutputLimitField } : {}),
    ...(unsupportedThinkingField ? { unsupportedThinkingField } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    publicMessage: contextWindowExceeded
      ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
      : protocolMismatch
        ? "The selected model requires the Responses API."
        : describeHttpStatus(response.status, fields.param, retryAfterMs),
  };
}

/**
 * Say what the status means for the operator, and keep the number.
 *
 * The sentence is self-contained on purpose: it is the only thing that reaches
 * surfaces with no room for the structured provider detail — a push
 * notification, a chat error bubble, a log line — so it has to carry both the
 * diagnosis and the number a bug report needs. Derived from the status and the
 * blamed request field alone, never from the provider's own prose.
 */
export function describeHttpStatus(status: number, param?: string, retryAfterMs?: number): string {
  const retryHint =
    status === 429 && retryAfterMs !== undefined && retryAfterMs > 0
      ? ` Retry after about ${formatRetryDelay(retryAfterMs)}.`
      : "";
  return `${httpStatusDiagnosis(status, param)} (HTTP ${status}).${retryHint}`;
}

function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function httpStatusDiagnosis(status: number, param?: string): string {
  switch (status) {
    case 400:
    case 422:
      return "The model provider rejected the request as malformed";
    case 401:
    case 403:
      return "The model provider rejected the API credentials — check the key for this backend";
    case 404:
      return param?.toLowerCase() === "model"
        ? "The model provider does not have the assigned model — check the model assignment"
        : "The model provider has no such endpoint or model";
    case 408:
      return "The model provider timed out handling the request";
    case 413:
      return "The model provider rejected the request as too large";
    case 429:
      return "The model provider rate-limited this request — try again shortly";
    case 503:
      return "The model provider is temporarily unavailable";
    default:
      if (status >= 500) return "The model provider failed while handling the request";
      return "The model API request failed";
  }
}

/**
 * Context classification shared by initial HTTP failures and structured
 * failures delivered inside a successful Responses SSE connection.
 */
export function isContextWindowHttpError(fields: HttpErrorFields): boolean {
  if (
    fields.status !== undefined &&
    fields.status !== 400 &&
    fields.status !== 422 &&
    fields.status !== 200
  ) {
    return false;
  }
  const code = (fields.code ?? fields.type ?? "").toLowerCase();
  if (CONTEXT_ERROR_CODES.has(code)) return true;

  const message = fields.message ?? "";
  const strongMatch =
    /\bprompt is too long\b/i.test(message) ||
    /\b(?:prompt|input)\b.{0,80}\bexceeds?\b.{0,80}\bcontext\b/i.test(message) ||
    /\bmaximum context length\b.{0,120}\b(?:exceed|requested)\w*/i.test(message) ||
    /\bcontext window\b.{0,80}\b(?:exceed|too long)\w*/i.test(message);
  return strongMatch && fields.structured !== false && fields.status !== 200;
}

/**
 * Reduce a decoded HTTP error to the provider metadata that travels with a
 * terminal failure. Same sanitizer the log line uses, so a field can never
 * reach an operator surface less scrubbed than it reaches the journal.
 */
export function providerFailureDetail(error: DecodedHttpError): AgentProviderFailureDetail {
  return {
    ...(error.status > 0 ? { status: error.status } : {}),
    ...maybeField("type", error.type),
    ...maybeField("code", error.code),
    ...maybeField("param", error.param),
    ...maybeField("requestId", error.requestId),
  };
}

function maybeField(
  key: "type" | "code" | "param" | "requestId",
  value: string | undefined,
): Partial<AgentProviderFailureDetail> {
  const safe = sanitizeProviderFailureField(value);
  return safe ? { [key]: safe } : {};
}

/** One-line metadata only; safe for structured logger messages. */
export function describeDecodedHttpError(error: DecodedHttpError): string {
  return [
    `status=${error.status}`,
    `type=${safeMetadata(error.type)}`,
    `code=${safeMetadata(error.code)}`,
    `param=${safeMetadata(error.param)}`,
    `requestId=${safeMetadata(error.requestId)}`,
    `bodyBytes=${error.bodyBytes}`,
    `contentType=${safeMetadata(error.contentType)}`,
  ].join(" ");
}

function parseErrorEnvelope(body: string): Omit<HttpErrorFields, "status"> {
  try {
    const parsed = JSON.parse(body) as unknown;
    const root = asRecord(parsed);
    const error = asRecord(root?.error) ?? root;
    return {
      structured: true,
      type: stringField(error, "type"),
      code: stringField(error, "code"),
      param: stringField(error, "param"),
      message: stringField(error, "message") ?? stringField(root, "message"),
    };
  } catch {
    return { message: body, structured: false };
  }
}

function unsupportedOutputField(
  fields: HttpErrorFields,
): "max_tokens" | "max_completion_tokens" | undefined {
  if (fields.status !== 400 && fields.status !== 422) return undefined;
  const param = fields.param?.toLowerCase();
  const structuredKind = `${fields.type ?? ""} ${fields.code ?? ""}`;
  const structuredUnsupported =
    /\b(?:unsupported|unknown|unrecognized)[_-]?(?:parameter|field)\b/i.test(structuredKind);
  if ((param === "max_tokens" || param === "max_completion_tokens") && structuredUnsupported) {
    return param;
  }
  if (fields.structured === false) return undefined;
  const message = fields.message ?? "";
  if (/\b(?:unsupported|unknown|unrecognized)\b.{0,80}\bmax_tokens\b/i.test(message)) {
    return "max_tokens";
  }
  if (/\b(?:unsupported|unknown|unrecognized)\b.{0,80}\bmax_completion_tokens\b/i.test(message)) {
    return "max_completion_tokens";
  }
  return undefined;
}

/**
 * Did the server reject the request because it does not accept a `thinking`
 * block at all?
 *
 * Only some OpenAI-compatible servers take one, so the bounded shape has to be
 * offered and withdrawn rather than assumed — the same negotiate-once ladder
 * the output-limit field walks. The wordings differ more than the
 * unsupported-parameter family does: OpenAI-style servers say "unknown" or
 * "unsupported", while one reasoning model behind an OpenAI-compatible server answers
 * `Extra inputs are not permitted, field: 'thinking'`. Matching the field name near any of
 * those keeps a complaint about the budget's VALUE — a floor, a ceiling —
 * from being read as the field being absent, which would withdraw a shape the
 * server does support.
 */
function rejectsThinkingField(fields: HttpErrorFields): boolean {
  if (fields.status !== 400 && fields.status !== 422) return false;
  const structuredKind = `${fields.type ?? ""} ${fields.code ?? ""}`;
  if (
    fields.param?.toLowerCase() === "thinking" &&
    /\b(?:unsupported|unknown|unrecognized|extra)[_-]?(?:parameter|field|input)s?\b/i.test(
      structuredKind,
    )
  ) {
    return true;
  }
  if (fields.structured === false) return false;
  const message = fields.message ?? "";
  return /\b(?:unsupported|unknown|unrecognized|extra inputs?)\b.{0,80}\bthinking\b/i.test(message);
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("openai-request-id") ??
    undefined
  );
}

function safeMetadata(value: string | undefined): string {
  return sanitizeProviderFailureField(value) ?? "none";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether a failed turn blames the request or the environment it was sent
 * into.
 *
 * `request` means the payload itself is the problem: this prompt is too long,
 * this body is malformed. Sending it again unchanged fails again, so a caller
 * is right to give up on it and move on.
 *
 * `provider` means the model was never reached on its merits: no credit, a
 * rejected key, a rate limit, a gateway error, a dead socket. The same payload
 * will succeed once the environment is repaired, and repair usually needs a
 * human — topping up an account, rotating a key — on a timescale of hours, not
 * the minutes a retry ladder spans.
 *
 * The distinction exists because callers that consume their input on failure
 * (a queue that marks a document processed) destroy work when they mistake the
 * second for the first.
 */
export type AgentFailureScope = "request" | "provider";

/**
 * Statuses that blame the submitted payload. Everything else is environment.
 *
 * Deliberately an allow-list rather than a deny-list of outage codes. The two
 * misclassifications are not symmetric: calling a provider outage a request
 * failure discards work permanently, while calling a request failure an outage
 * only costs retries against a backend that is answering. So an unrecognised
 * status — a provider's non-standard code, a future one — must land on
 * `provider`, and only statuses that certainly indict the request are listed.
 */
const REQUEST_SCOPED_STATUSES = new Set([
  400, // malformed body
  413, // payload too large
  422, // semantically invalid body
]);

/**
 * Request-scoped failures that arrive without a usable HTTP status.
 *
 * Each is a verdict the backend delivered on its merits, so the status the
 * transport carried (a 200 stream, or none at all) says nothing useful:
 *
 * - `context_window_exceeded` — providers signal it as 400, as 422, or inside
 *   a 200 stream, so the code is the only reliable discriminator.
 * - `output_truncated` — the model answered and ran into its output ceiling.
 * - `tool_iteration_cap` — the model answered, repeatedly, until our own
 *   tool-use loop cap stopped it.
 *
 * The last two are proof the backend is reachable and serving, which is
 * exactly the question the caller-side outage guards ask. Classifying them as
 * environment faults would let a run of over-long or loop-prone payloads read
 * as a dead backend.
 */
const REQUEST_SCOPED_CODES = new Set([
  "context_window_exceeded",
  "output_truncated",
  "tool_iteration_cap",
]);

/**
 * Classify a terminal failure by what it blames.
 *
 * Reads only the machine-readable fields — never the provider's prose, which
 * is unstable across vendors and versions. A failure with no HTTP status at
 * all (a dead socket, a timeout, a truncated stream) is environment by
 * definition: nothing about the payload was ever adjudicated.
 */
export function agentFailureScope(failure: {
  code?: string;
  provider?: { status?: number };
}): AgentFailureScope {
  if (failure.code !== undefined && REQUEST_SCOPED_CODES.has(failure.code)) return "request";
  const status = failure.provider?.status;
  if (status === undefined) return "provider";
  return REQUEST_SCOPED_STATUSES.has(status) ? "request" : "provider";
}
