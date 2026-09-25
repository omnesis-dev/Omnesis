// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnswerResponse } from "@omnesis/types/privacy";

export interface SubmitAnswerInput {
  question: string;
  clientRequestId: string;
  conversationId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  approval?: "allow" | "never";
}

export interface AnswerRequestOptions {
  signal?: AbortSignal;
}

export interface AnswerHttpClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** A typed HTTP failure from the public Answer boundary. */
export class AnswerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: Readonly<Record<string, unknown>> | null,
    message: string,
  ) {
    super(message);
    this.name = "AnswerHttpError";
  }
}

/** A malformed success payload is never safe to forward across the privacy boundary. */
export class InvalidAnswerResponseError extends Error {
  constructor() {
    super("Gateway returned a malformed Answer response.");
    this.name = "InvalidAnswerResponseError";
  }
}

/**
 * Minimal, cancellation-aware client for the gateway's privacy-brokered
 * `/answer` boundary. It deliberately does not inherit the collector client's
 * retry/backpressure policy: an interactive caller must remain in control of
 * cancellation and idempotency.
 */
export class AnswerHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnswerHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(
    input: SubmitAnswerInput,
    options: AnswerRequestOptions = {},
  ): Promise<AnswerResponse> {
    return this.request("/answer", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({
        ...input,
        // Callers choose whether they can complete a held approval workflow.
        // The low-level client preserves the route's non-interactive default;
        // interactive MCP supplies `allow` explicitly and later retrieves the
        // owner-bound task once, after the user confirms approval.
        approval: input.approval ?? "never",
      }),
    });
  }

  async getTask(taskId: string, options: AnswerRequestOptions = {}): Promise<AnswerResponse> {
    return this.request(`/answer/tasks/${encodeURIComponent(taskId)}`, {
      signal: options.signal,
    });
  }

  private async request(path: string, init: RequestInit): Promise<AnswerResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "omnesis-answer-client",
        ...init.headers,
      },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw parseAnswerHttpError(response.status, payload);
    return parseAnswerResponse(payload);
  }
}

function parseAnswerHttpError(status: number, payload: unknown): AnswerHttpError {
  const record = asRecord(payload);
  const code = typeof record?.code === "string" ? record.code : null;
  const message =
    typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : `Gateway returned ${status}`;
  return new AnswerHttpError(status, code, asRecord(record?.detail), message);
}

export function parseAnswerResponse(value: unknown): AnswerResponse {
  const record = asRecord(value);
  if (!record) throw new InvalidAnswerResponseError();
  const base = parseBase(record);
  switch (record.status) {
    case "released":
      assertExactKeys(record, [...BASE_KEYS, "releaseId", "answer"]);
      return {
        ...base,
        status: "released",
        releaseId: stringField(record, "releaseId"),
        answer: stringField(record, "answer"),
      };
    case "released_with_reductions":
      assertExactKeys(record, [...BASE_KEYS, "releaseId", "answer", "reductions"]);
      return {
        ...base,
        status: "released_with_reductions",
        releaseId: stringField(record, "releaseId"),
        answer: stringField(record, "answer"),
        reductions: stringArrayField(record, "reductions"),
      };
    case "approval_required":
      assertExactKeys(record, [...BASE_KEYS, "approvalId", "approvalExpiresAt"]);
      return {
        ...base,
        status: "approval_required",
        approvalId: stringField(record, "approvalId"),
        approvalExpiresAt: finiteNumberField(record, "approvalExpiresAt"),
      };
    case "denied": {
      assertExactKeys(record, [...BASE_KEYS, "reason"]);
      const reason = stringField(record, "reason");
      if (!DENIAL_REASONS.has(reason)) throw new InvalidAnswerResponseError();
      return {
        ...base,
        status: "denied",
        reason: reason as Extract<AnswerResponse, { status: "denied" }>["reason"],
      };
    }
    default:
      throw new InvalidAnswerResponseError();
  }
}

const BASE_KEYS = ["status", "workflowId", "conversationId", "taskId"] as const;
const DENIAL_REASONS = new Set([
  "privacy_policy",
  "hard_stop",
  "user_denied",
  "expired",
  "canceled",
  "approval_not_available",
]);

function parseBase(record: Record<string, unknown>): {
  workflowId: string;
  conversationId: string;
  taskId: string;
} {
  return {
    workflowId: stringField(record, "workflowId"),
    conversationId: stringField(record, "conversationId"),
    taskId: stringField(record, "taskId"),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new InvalidAnswerResponseError();
  return value;
}

function finiteNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidAnswerResponseError();
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new InvalidAnswerResponseError();
  }
  return value;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new InvalidAnswerResponseError();
  }
}
