// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { FetchLikeResponse } from "./types.js";

const MAX_GATEWAY_RESPONSE_BYTES = 1024 * 1024;
export const MAX_GATEWAY_REASON_CHARS = 512;

/** Read a gateway body without allowing an unbounded response allocation. */
export async function readBoundedResponseText(
  response: FetchLikeResponse,
  maximumBytes = MAX_GATEWAY_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw tooLarge();

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw tooLarge();
    return text;
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function boundedGatewayReason(reason: string): string {
  return reason.slice(0, MAX_GATEWAY_REASON_CHARS);
}

function tooLarge(): Error {
  return new Error("Gateway response exceeded the extension size limit");
}
