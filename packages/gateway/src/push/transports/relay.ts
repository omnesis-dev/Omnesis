// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Content-blind relay transport. The credential identifies a relay-enrolled
 * carrier token; the request body is deliberately empty. Notification text,
 * kind, identifiers, and collapse keys remain in the gateway delivery queue.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RelayWakeTarget {
  relayUrl: string;
  relayCredential: string;
}

export type RelayWakeResult =
  | { ok: true; statusCode: 202 }
  | { ok: false; statusCode: number; reason: string; retryAfterMs?: number };

export interface RelayPushClientOptions {
  fetchFn?: FetchFn;
  requestTimeoutMs?: number;
  /** Optional server-side delivery origin; the registered public relay identity is unchanged. */
  deliveryUrl?: string;
}

export class RelayPushClient {
  private readonly fetchFn: FetchFn;
  private readonly deliveryUrl?: string;

  constructor(private readonly opts: RelayPushClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.deliveryUrl = opts.deliveryUrl ? validateDeliveryUrl(opts.deliveryUrl) : undefined;
  }

  async wake(target: RelayWakeTarget): Promise<RelayWakeResult> {
    const endpoint = new URL("v1/wake", ensureTrailingSlash(this.deliveryUrl ?? target.relayUrl));
    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.relayCredential}`,
        "content-length": "0",
      },
      // An absent body is part of the privacy boundary. Do not replace this
      // with `{}`: accepting arbitrary JSON here invites content fields later.
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const reason = await readBoundedResponse(response);
    if (response.status === 202) return { ok: true, statusCode: 202 };
    return {
      ok: false,
      statusCode: response.status,
      reason: reason || response.statusText || "relay rejected wake",
      ...retryAfter(response),
    };
  }
}

function retryAfter(response: Response): { retryAfterMs: number } | Record<string, never> {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return {};
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return {};
  return { retryAfterMs: Math.min(Math.ceil(delay), MAX_RETRY_AFTER_MS) };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function validateDeliveryUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("push relay delivery URL must not contain credentials, query, or fragment");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isPrivateIpv4(parsed.hostname))
  ) {
    throw new Error("push relay delivery URL must use HTTPS or a private IPv4 HTTP endpoint");
  }
  return parsed.toString();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("relay response exceeded the maximum size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("relay response exceeded the maximum size");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
