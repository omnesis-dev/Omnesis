// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHandshakeError } from "./handshake-error.js";

function fixture(status: number) {
  const response = new IncomingMessage(new Socket());
  response.statusCode = status;
  const abort = new AbortController();
  const result = readHandshakeError(response, abort.signal);
  return { response, abort, result };
}
afterEach(() => vi.useRealTimers());

describe("bounded realtime handshake rejections", () => {
  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [404, "model_unavailable"],
    [429, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
  ] as const)("classifies HTTP%s safely", async (status, code) => {
    const f = fixture(status);
    f.response.emit("end");
    expect(await f.result).toMatchObject({ code, fatal: true });
    expect(f.response.destroyed).toBe(true);
  });
  it.each([
    "credit_balance_exhausted",
    "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ])("retains bounded HTTP429 %s", async (code) => {
    const f = fixture(429);
    f.response.emit(
      "data",
      Buffer.from(JSON.stringify({ error: { code, message: "PRIVATE_SENTINEL" } })),
    );
    f.response.emit("end");
    const error = await f.result;
    expect(error).toMatchObject({ code, retryable: false });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_SENTINEL");
  });
  it("preserves quota-type veto on a conflicting rate code", async () => {
    const f = fixture(429);
    f.response.emit(
      "data",
      JSON.stringify({ error: { code: "rate_limit_exceeded", type: "insufficient_quota" } }),
    );
    f.response.emit("end");
    expect(await f.result).toMatchObject({ code: "quota_exhausted", retryable: false });
  });
  it.each(["invalid", "oversize", "error", "aborted", "close", "cancel"])(
    "settles and destroys a %s response",
    async (mode) => {
      const f = fixture(429);
      if (mode === "invalid") {
        f.response.emit("data", "PRIVATE_SENTINEL");
        f.response.emit("end");
      }
      if (mode === "oversize") f.response.emit("data", Buffer.alloc(8193));
      if (mode === "error") f.response.emit("error", new Error("PRIVATE_SENTINEL"));
      if (mode === "aborted" || mode === "close") f.response.emit(mode);
      if (mode === "cancel") f.abort.abort();
      expect(await f.result).toMatchObject({ code: "rate_limited" });
      expect(f.response.destroyed).toBe(true);
      expect(f.response.listenerCount("data")).toBe(0);
    },
  );
  it("bounds a rejection stream that never completes", async () => {
    vi.useFakeTimers();
    const f = fixture(429);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f.result).toMatchObject({ code: "rate_limited" });
    expect(f.response.destroyed).toBe(true);
  });
});
