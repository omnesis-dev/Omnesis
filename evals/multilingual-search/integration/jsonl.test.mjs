// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { jsonlRecords } from "./jsonl.mjs";

test("JSONL preserves Unicode separators and split UTF-8 bytes", async () => {
  const records = [{ text: "卒業。\u2028次\u2029끝" }, { text: "é\nline\rreturn" }];
  const bytes = Buffer.from(records.map((row) => JSON.stringify(row)).join("\r\n"));
  const observed = [];
  for await (const row of jsonlRecords(
    Readable.from([...bytes].map((byte) => Buffer.from([byte]))),
  ))
    observed.push(row);
  assert.deepEqual(observed, records);
});

test("JSONL rejects a truncated record instead of silently skipping it", async () => {
  await assert.rejects(async () => {
    for await (const row of jsonlRecords(Readable.from(['{"text":"unfinished']))) void row;
  }, SyntaxError);
});
