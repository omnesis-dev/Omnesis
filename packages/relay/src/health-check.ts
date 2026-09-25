// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PUSH_RELAY_PROTOCOL_VERSION } from "@omnesis/core/push";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 16 * 1024;

const carrierHealthSchema = z.object({
  configured: z.boolean(),
  status: z.enum(["unknown", "reachable", "unreachable"]),
  lastSuccessAt: z.number().int().nonnegative().nullable(),
  lastFailureAt: z.number().int().nonnegative().nullable(),
});

const relayHealthSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ready", "unknown", "degraded"]),
  protocols: z.object({
    enrolment: z.array(z.number().int().positive()),
    wake: z.array(z.number().int().positive()),
  }),
  carriers: z.object({
    ios: carrierHealthSchema.nullable(),
    android: carrierHealthSchema.nullable(),
  }),
});

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RelayHealthCheckOptions {
  url: URL;
  maxSuccessAgeMs: number;
  maxClockSkewMs: number;
  timeoutMs: number;
  now?: () => number;
  fetchFn?: FetchFn;
}

export type RelayHealthCheckResult =
  | { kind: "healthy"; message: string }
  | { kind: "unhealthy"; message: string }
  | { kind: "probe_failed"; message: string };

export async function checkRelayHealth(
  options: RelayHealthCheckOptions,
): Promise<RelayHealthCheckResult> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(new URL("/health", options.url), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return { kind: "probe_failed", message: "relay health request failed" };
  }

  let body: string;
  try {
    body = await readBoundedText(response);
  } catch (err) {
    return err instanceof ResponseTooLargeError
      ? { kind: "probe_failed", message: "relay health response exceeded the size limit" }
      : { kind: "probe_failed", message: "relay health response could not be read" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return { kind: "probe_failed", message: "relay health response was not valid JSON" };
  }
  const parsed = relayHealthSchema.safeParse(decoded);
  if (!parsed.success) {
    return { kind: "probe_failed", message: "relay health response had an invalid shape" };
  }

  const health = parsed.data;
  if (!health.protocols.enrolment.includes(PUSH_RELAY_PROTOCOL_VERSION)) {
    return { kind: "unhealthy", message: "relay does not accept this enrolment protocol" };
  }
  if (!health.protocols.wake.includes(PUSH_RELAY_PROTOCOL_VERSION)) {
    return { kind: "unhealthy", message: "relay does not accept this wake protocol" };
  }
  if (response.status !== 200 || !health.ok || health.status !== "ready") {
    return { kind: "unhealthy", message: `relay status is ${health.status}` };
  }

  const now = (options.now ?? Date.now)();
  for (const [name, carrier] of [
    ["iOS", health.carriers.ios],
    ["Android", health.carriers.android],
  ] as const) {
    if (carrier === null || !carrier.configured) {
      return { kind: "unhealthy", message: `${name} carrier is not configured` };
    }
    if (carrier.status !== "reachable" || carrier.lastSuccessAt === null) {
      return { kind: "unhealthy", message: `${name} carrier is not reachable` };
    }
    if (carrier.lastSuccessAt > now + options.maxClockSkewMs) {
      return { kind: "unhealthy", message: `${name} carrier success timestamp is in the future` };
    }
    if (now - carrier.lastSuccessAt > options.maxSuccessAgeMs) {
      return { kind: "unhealthy", message: `${name} carrier success is stale` };
    }
    if (carrier.lastFailureAt !== null && carrier.lastFailureAt > carrier.lastSuccessAt) {
      return { kind: "unhealthy", message: `${name} carrier failed after its last success` };
    }
  }

  return { kind: "healthy", message: "relay is ready and both carrier successes are fresh" };
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

class ResponseTooLargeError extends Error {}
