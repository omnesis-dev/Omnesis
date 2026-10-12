// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Readable } from "node:stream";

/** JSON-RPC stdio frames end at LF, never at Unicode text separators. */
export function readJsonRpcLines(input: Readable, onLine: (line: string) => void): void {
  let pending = "";
  // Node retains partial UTF-8 sequences across byte chunks.
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    pending += chunk;
    let start = 0;
    let end: number;
    while ((end = pending.indexOf("\n", start)) !== -1) {
      const line = pending.slice(start, end);
      start = end + 1;
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    pending = pending.slice(start);
  });
  input.on("end", () => {
    if (pending) onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    pending = "";
  });
}

/** Keep valid JSON text compatible with peers that recognize extra line separators. */
export function encodeJsonRpcLine(message: unknown): string {
  return `${JSON.stringify(message)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}\n`;
}
