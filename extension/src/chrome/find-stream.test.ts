// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { readFindStream } from "./find-stream.js";

describe("bounded Find SSE", () => {
  it("decodes chunk-split UTF8, CRLF, multiline data and ignored heartbeats", async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\n\r\ndata: {"type":"find.decision",\r\ndata: "payload":{"reason":"café"}}\r\n\r\n',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const accept = vi.fn().mockResolvedValue(undefined);
    await readFindStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      accept,
      new AbortController().signal,
    );
    expect(accept).toHaveBeenCalledWith({ type: "find.decision", payload: { reason: "café" } });
  });
  it("rejects oversized frames and truncated events without buffering an unbounded response", async () => {
    for (const text of [
      'data: {"type":"find.complete","payload":{}}',
      `data: ${"x".repeat(1000001)}\n\n`,
    ]) {
      await expect(
        readFindStream(
          new Response(text, { headers: { "content-type": "text/event-stream" } }),
          async () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });
  it("cancels a stalled reader promptly", async () => {
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: canceled });
    const abort = new AbortController();
    const reading = readFindStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      async () => undefined,
      abort.signal,
    );
    abort.abort();
    await expect(reading).rejects.toThrow();
    expect(canceled).toHaveBeenCalled();
  });
});
