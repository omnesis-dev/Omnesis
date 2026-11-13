// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { readJsonBody } from "./relay-json-body.js";
import type { IncomingMessage } from "node:http";

afterEach(() => vi.useRealTimers());
const body = (text?: string) => {
  const stream = new PassThrough();
  if (text !== undefined) stream.end(text);
  return stream as unknown as IncomingMessage;
};

test("reads bounded JSON and refuses anything over the limit or unparseable", async () => {
  expect(await readJsonBody(body('{"ok":true}'), 64)).toEqual({ ok: true });
  await expect(readJsonBody(body("x".repeat(65)), 64)).rejects.toMatchObject({ status: 413 });
  await expect(readJsonBody(body("{"), 64)).rejects.toMatchObject({ status: 400 });
});

test("a sender who never finishes is cut off at the deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reading = readJsonBody(body(), 64);
  const failed = expect(reading).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(5001);
  await failed;
});
