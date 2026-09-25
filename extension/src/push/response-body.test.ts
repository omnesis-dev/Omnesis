// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { boundedGatewayReason, readBoundedResponseText } from "./response-body.js";

function response(text: string, contentLength: string | null = null) {
  return {
    status: 200,
    headers: { get: () => contentLength },
    text: vi.fn(() => Promise.resolve(text)),
  };
}

describe("bounded gateway responses", () => {
  it("rejects a declared oversized body before reading it", async () => {
    const res = response("not read", "11");
    await expect(readBoundedResponseText(res, 10)).rejects.toThrow(/size limit/i);
    expect(res.text).not.toHaveBeenCalled();
  });

  it("bounds fallback responses without a native stream", async () => {
    await expect(readBoundedResponseText(response("123456"), 5)).rejects.toThrow(/size limit/i);
    await expect(readBoundedResponseText(response("12345"), 5)).resolves.toBe("12345");
  });

  it("cancels a chunked native body as soon as the cap is crossed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("456"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedResponseText(
        { status: 200, headers: { get: () => null }, body, text: () => Promise.resolve("") },
        5,
      ),
    ).rejects.toThrow(/size limit/i);
    expect(cancelled).toBe(true);
  });

  it("bounds diagnostic reasons before storage or display", () => {
    expect(boundedGatewayReason("x".repeat(600))).toHaveLength(512);
  });
});
