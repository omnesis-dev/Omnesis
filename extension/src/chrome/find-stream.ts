// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface FindStreamEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Bounded SSE decoding supports arbitrary chunk boundaries and heartbeat comments. */
export async function readFindStream(
  response: Response,
  accept: (event: FindStreamEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
    throw new Error("Gateway returned an invalid Find stream");
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    data: string[] = [],
    frameSize = 0,
    total = 0;
  async function line(text: string): Promise<void> {
    if (!text) {
      if (data.length) {
        const value = JSON.parse(data.join("\n")) as { type?: unknown; payload?: unknown };
        if (
          !value ||
          typeof value.type !== "string" ||
          !value.payload ||
          typeof value.payload !== "object" ||
          Array.isArray(value.payload)
        )
          throw new Error("Gateway returned an invalid Find event");
        await accept({ type: value.type, payload: value.payload as Record<string, unknown> });
      }
      data = [];
      frameSize = 0;
    } else if (text.startsWith("data:")) {
      const value = text.slice(5).replace(/^ /, "");
      frameSize += value.length;
      if (frameSize > 1000000) throw new Error("Find event exceeded the size limit");
      data.push(value);
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 8000000) throw new Error("Find response exceeded the size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const text = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (text.length > 1000000) throw new Error("Find event exceeded the size limit");
        await line(text);
      }
      if (buffer.length > 1000000) throw new Error("Find event exceeded the size limit");
    }
    buffer += decoder.decode();
    if (buffer || data.length) throw new Error("Find connection ended during an event. Try again.");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
