// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { callError, providerCallError, type RealtimeCallError } from "./call-error.js";
import type { IncomingMessage } from "node:http";

const MAX_REJECTION_BYTES = 8 * 1024;
const REJECTION_TIMEOUT_MS = 2000;

function rejection(status: number | undefined, body?: unknown): RealtimeCallError {
  if (status === 401 || status === 403) return callError("authentication_failed");
  if (status === 404) return callError("model_unavailable");
  if (status !== undefined && status >= 500) return callError("provider_error");
  const classified = providerCallError(body);
  if (classified.code !== "provider_error") return classified;
  return callError(status === 429 ? "rate_limited" : "provider_error");
}

/** HTTP rejection bodies are untrusted; retain only bounded allowlisted identifiers, never prose. */
export function readHandshakeError(
  response: IncomingMessage,
  signal: AbortSignal,
): Promise<RealtimeCallError> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (body?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      response.off("data", data);
      response.off("end", end);
      response.off("error", failed);
      response.off("aborted", failed);
      response.off("close", failed);
      // destroy() may asynchronously emit an error from the rejected HTTP transport.
      response.once("error", () => {});
      response.destroy();
      resolve(rejection(response.statusCode, body));
    };
    const failed = () => finish();
    const aborted = () => finish();
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REJECTION_BYTES) finish();
      else chunks.push(buffer);
    };
    const end = () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish();
      }
    };
    const timer = setTimeout(failed, REJECTION_TIMEOUT_MS);
    timer.unref();
    response.on("data", data);
    response.once("end", end);
    response.once("error", failed);
    response.once("aborted", failed);
    response.once("close", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) finish();
  });
}
