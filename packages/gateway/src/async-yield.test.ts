// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { yieldToEventLoop, DEFAULT_INGEST_YIELD_BATCH } from "./async-yield.js";

describe("yieldToEventLoop", () => {
  test("returns control to the event loop (a pending immediate runs before we resume)", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("immediate"));
    await yieldToEventLoop();
    order.push("after-yield");
    // The yield is a `setImmediate`, so the earlier-queued immediate fires
    // first — proving the loop got a turn rather than a microtask hop.
    expect(order).toEqual(["immediate", "after-yield"]);
  });

  test("DEFAULT_INGEST_YIELD_BATCH is a positive integer", () => {
    expect(Number.isInteger(DEFAULT_INGEST_YIELD_BATCH)).toBe(true);
    expect(DEFAULT_INGEST_YIELD_BATCH).toBeGreaterThan(0);
  });
});
