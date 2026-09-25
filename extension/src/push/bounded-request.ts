// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readBoundedResponseText } from "./response-body.js";
import type { FetchLike, FetchLikeResponse } from "./types.js";

/**
 * One gateway request with a hard wall-clock bound covering both the response
 * headers and the body read, and a bounded body size. The MV3 worker must
 * never sit on a stalled connection, so the whole exchange shares one deadline
 * and the returned response carries the already-read body.
 */
export async function boundedRequest(
  fetch: FetchLike,
  input: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
): Promise<FetchLikeResponse> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await withTimeout(
      fetch(input, { ...init, signal: controller.signal }),
      timeoutMs,
    );
    const body = await withTimeout(
      readBoundedResponseText(response),
      Math.max(1, deadline - Date.now()),
    );
    return {
      status: response.status,
      headers: response.headers,
      text: () => Promise.resolve(body),
    };
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway request timed out")), timeoutMs);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
