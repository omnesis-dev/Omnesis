// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { checkSession } from "./api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("the session read aborts a stalled request so bootstrap can show recovery", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_input: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  }));
  const read = checkSession();
  const failure = expect(read).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  expect(signal?.aborted).toBe(true);
});

test("a completed session read clears its deadline", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return Response.json({ authenticated: true, scope: ["admin"], csrfToken: "fictional-csrf" });
  }));
  expect(await checkSession()).toEqual({ authenticated: true, scope: ["admin"], csrfToken: "fictional-csrf" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal?.aborted).toBe(false);
});
