// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one way an E2E test talks to its gateway over HTTP.
 *
 * Both spawned-gateway harnesses expose these as methods bound to their own
 * URL and API key. Keeping the transport here means a test's failure output
 * does not depend on which harness it happens to be using.
 */

import { readFileSync } from "node:fs";

/** How many times a 503 + `Retry-After` is waited out before giving up. */
const MAX_BACKPRESSURE_WAITS = 3;
/** Cap on an honoured `Retry-After`, so a bad header cannot stall a test. */
const MAX_RETRY_AFTER_MS = 5_000;
/** Response body kept in a failure message. */
const MAX_BODY_CHARS = 1000;
/** Gateway log lines appended to a 5xx failure message. */
const LOG_TAIL_LINES = 40;

/** A gateway response that was not 2xx, with the status and body attached. */
export interface GatewayRequestError extends Error {
  status: number;
  body: string;
}

export interface GatewayEndpoint {
  gatewayUrl: string;
  apiKey: string;
  /** Where the spawned gateway writes its log, when the harness captures one. */
  gatewayLogPath?: string;
}

/** Issue a request against the gateway with the harness API key. */
export async function gatewayFetch(
  endpoint: GatewayEndpoint,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${endpoint.gatewayUrl}${path}`, { ...init, headers });
}

/**
 * Request a route and parse its JSON body, throwing when the gateway did not
 * answer 2xx. The thrown error carries `status` and `body`, so a test asserting
 * on a rejection can match on the status rather than on message text.
 *
 * A 503 carrying `Retry-After` is the gateway's documented writer-queue
 * backpressure, which self-heals as the writer drains; it is waited out a
 * bounded number of times, as the production gateway client does, before being
 * reported as a failure.
 */
export async function gatewayJson<T = unknown>(
  endpoint: GatewayEndpoint,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res = await gatewayFetch(endpoint, path, init);
  for (let wait = 0; res.status === 503 && wait < MAX_BACKPRESSURE_WAITS; wait += 1) {
    const seconds = Number(res.headers.get("Retry-After"));
    const delayMs =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res = await gatewayFetch(endpoint, path, init);
  }

  const body = await res.text();
  if (!res.ok) {
    const shown =
      body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body || "(empty body)";
    // A 5xx body is sanitized down to a request id, so the message that
    // explains it lives only in the gateway's log.
    const detail = res.status >= 500 ? gatewayLogTail(endpoint.gatewayLogPath) : "";
    throw Object.assign(
      new Error(`gateway ${init?.method ?? "GET"} ${path} → ${res.status}: ${shown}${detail}`),
      { status: res.status, body },
    ) as GatewayRequestError;
  }
  // A 2xx may legitimately carry no body (204 No Content).
  return (body ? JSON.parse(body) : null) as T;
}

/**
 * The end of the spawned gateway's log, read at throw time — the harness
 * deletes its temp directory during teardown, before a reporter would print.
 */
function gatewayLogTail(logPath: string | undefined): string {
  if (!logPath) return "";
  try {
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-LOG_TAIL_LINES);
    return lines.length
      ? `\n--- gateway log (last ${lines.length} lines) ---\n${lines.join("\n")}`
      : "";
  } catch {
    return "";
  }
}
