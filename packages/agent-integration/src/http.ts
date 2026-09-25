// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import http from "node:http";
import https from "node:https";

import { pinnedTlsOptions, type TlsTrust, validateGatewayUrl } from "./tls.js";

const SUBSCRIPTION_CONDITION_UNSUPPORTED = "SUBSCRIPTION_CONDITION_UNSUPPORTED";

/**
 * Socket budget for an ordinary gateway call — a read, or a write the gateway
 * settles in one transaction. Operations that run an agent turn behind the
 * request are far slower than this and pass their own budget instead.
 */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 20_000;

export interface GatewayRequestOptions {
  /** Socket budget for this one call. Defaults to {@link DEFAULT_GATEWAY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * How this client says a rejection reason, in its own words.
 *
 * The gateway's own text is never rendered: a rejection is classified by its
 * code and described from here, so no prose from a response body reaches an
 * external agent's runtime. That matters more than it looks — the thing being
 * refused is a request that a corpus-reading compiler considered, and its own
 * words about the refusal are exactly what must not travel.
 *
 * The code set is declared once, in `@omnesis/types` (`REFUSAL_CODES`), and
 * restated here rather than imported — this runtime is published as a plugin
 * for foreign harnesses and its dependency footprint is deliberately three
 * third-party packages, which `stage-packages.test.mjs` pins. What holds the
 * restatement to the declaration is `refusal-vocabulary.test.ts`, which reads
 * this object and both Hermes adapters and reddens if any of their key sets
 * drift from the source.
 *
 * The sentences stay this runtime's own, because the audiences differ: these
 * are written for an agent deciding what to do next, not for the operator
 * reading their own corpus.
 */
const SUBSCRIPTION_UNSUPPORTED_MESSAGES = {
  unsupported_condition: "The requested subscription condition is not currently supported.",
  not_a_condition:
    "The request does not describe something that happens, so nothing can watch for it.",
  ambiguous_request: "The request has more than one reasonable reading.",
  compiler_failed: "The gateway could not compile the request into a watch. Asking again may work.",
} as const;

type SubscriptionUnsupportedReason = keyof typeof SUBSCRIPTION_UNSUPPORTED_MESSAGES;

export interface IntegrationGatewayError {
  error: (typeof SUBSCRIPTION_UNSUPPORTED_MESSAGES)[SubscriptionUnsupportedReason];
  code: typeof SUBSCRIPTION_CONDITION_UNSUPPORTED;
  details: { reason: SubscriptionUnsupportedReason };
}

export class IntegrationHttpError extends Error {
  readonly gatewayError?: IntegrationGatewayError;

  constructor(
    readonly status: number,
    message: string,
    gatewayError?: unknown,
    /**
     * The gateway's machine-readable error code, when the response carried one.
     * Only the code is kept — never the message or detail — so a rejection can
     * be classified (retryable, still-running, fatal) without an arbitrary
     * response body crossing into an external agent's runtime.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "IntegrationHttpError";
    this.gatewayError =
      status === 422 ? parseSubscriptionUnsupportedError(gatewayError) : undefined;
  }
}

/**
 * The socket budget for this request elapsed. The gateway may still be working:
 * a request that mutates server state is only safely repeated when it carries
 * an idempotency key, which is why the answer client derives one.
 */
export class GatewayRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`gateway request timed out after ${timeoutMs}ms`);
    this.name = "GatewayRequestTimeoutError";
  }
}

function unsupportedReason(value: unknown): SubscriptionUnsupportedReason | null {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(SUBSCRIPTION_UNSUPPORTED_MESSAGES, value)
  ) {
    return null;
  }
  return value as SubscriptionUnsupportedReason;
}

function parseSubscriptionUnsupportedError(value: unknown): IntegrationGatewayError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.code !== SUBSCRIPTION_CONDITION_UNSUPPORTED) return undefined;
  const rawDetails =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? record.details
      : record.detail && typeof record.detail === "object" && !Array.isArray(record.detail)
        ? record.detail
        : null;
  const reason = unsupportedReason(
    rawDetails ? (rawDetails as Record<string, unknown>).reason : undefined,
  );
  if (!reason) return undefined;
  return {
    error: SUBSCRIPTION_UNSUPPORTED_MESSAGES[reason],
    code: SUBSCRIPTION_CONDITION_UNSUPPORTED,
    details: { reason },
  };
}

/**
 * Every gateway error response carries `{ error, code }`. Lift just the code so
 * callers can branch on the failure kind; the vocabulary is the gateway's own
 * fixed set of SCREAMING_SNAKE identifiers, so anything else is discarded.
 */
function parseGatewayErrorCode(responseBody: string): string | undefined {
  if (responseBody.length > 4_096) return undefined;
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const code = (parsed as Record<string, unknown>).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function parseUnprocessableGatewayError(
  status: number,
  responseBody: string,
): IntegrationGatewayError | undefined {
  // Only the subscription compiler's typed 422 is useful to an external
  // agent. Never forward an arbitrary error response body.
  if (status !== 422 || responseBody.length > 4_096) return undefined;
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return parseSubscriptionUnsupportedError(parsed);
  } catch {
    return undefined;
  }
}

export class PinnedGatewayHttpClient {
  private readonly base: URL;
  private readonly tlsOptions: ReturnType<typeof pinnedTlsOptions> | null;

  constructor(
    gatewayUrl: string,
    private readonly token: string,
    trust?: TlsTrust,
  ) {
    this.base = validateGatewayUrl(gatewayUrl);
    if (this.base.protocol === "https:" && !trust) {
      throw new Error("HTTPS integration requires pinned TLS trust material");
    }
    this.tlsOptions =
      this.base.protocol === "https:" ? pinnedTlsOptions(this.base.hostname, trust!) : null;
  }

  requestJson<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    value?: unknown,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
    const url = new URL(path, this.base);
    const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
    const request = url.protocol === "https:" ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          ...(this.tlsOptions ?? {}),
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": String(body.byteLength),
                }
              : {}),
          },
          signal,
          timeout: timeoutMs,
        },
        (response) => {
          let received = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > 1024 * 1024) {
              req.destroy(new Error("gateway response exceeded 1 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const responseBody = Buffer.concat(chunks).toString("utf8");
            if (status < 200 || status >= 300) {
              reject(
                new IntegrationHttpError(
                  status,
                  `gateway rejected request (HTTP ${status})`,
                  parseUnprocessableGatewayError(status, responseBody),
                  parseGatewayErrorCode(responseBody),
                ),
              );
              return;
            }
            if (!responseBody) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(responseBody) as T);
            } catch {
              reject(new Error("gateway returned invalid JSON"));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new GatewayRequestTimeoutError(timeoutMs)));
      req.end(body ?? undefined);
    });
  }

  postJson<T = unknown>(
    path: string,
    value: unknown,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return this.requestJson("POST", path, value, signal, options);
  }
}
