// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeJsonRpcLine, readJsonRpcLines } from "./json-rpc-lines.js";

const message = { id: 1, result: { text: "alpha\u2028beta\u2029gamma😀\nnext\rline" } };

async function decode(chunks: Buffer[]): Promise<string[]> {
  const input = new PassThrough();
  const lines: string[] = [];
  readJsonRpcLines(input, (line) => lines.push(line));
  const ended = once(input, "end");
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await ended;
  return lines;
}

describe("JSON-RPC LF framing", () => {
  it.each(["raw", "escaped"])("preserves %s Unicode at every byte boundary", async (mode) => {
    const wire = Buffer.from(
      mode === "raw" ? `${JSON.stringify(message)}\n` : encodeJsonRpcLine(message),
    );
    for (let split = 0; split <= wire.length; split++) {
      const lines = await decode([wire.subarray(0, split), wire.subarray(split)]);
      expect(lines.map((line) => JSON.parse(line))).toEqual([message]);
    }
    const lines = await decode(Array.from(wire, (byte) => Buffer.from([byte])));
    expect(lines.map((line) => JSON.parse(line))).toEqual([message]);
  });

  it("escapes only wire separators while preserving payload Unicode", () => {
    const encoded = encodeJsonRpcLine(message);
    expect(encoded).not.toMatch(/[\u2028\u2029]/);
    expect(encoded).toContain("\\u2028");
    expect(encoded).toContain("\\u2029");
    expect(encoded).toContain("😀");
    expect(encoded.split("\n")).toHaveLength(2);
    expect(JSON.parse(encoded)).toEqual(message);
  });

  it("handles coalesced frames, CRLF, and a final unterminated frame", async () => {
    const json = JSON.stringify(message);
    expect(await decode([Buffer.from(`${json}\r\n${json}\n${json}`)])).toEqual([json, json, json]);
  });
});
