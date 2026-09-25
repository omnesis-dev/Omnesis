// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABORT_KEY, createMailboxServer, get, put, wait } from "./mailbox.mjs";

let server;
let base;

beforeEach(async () => {
  server = createMailboxServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((ok) => server.close(ok));
});

describe("mailbox", () => {
  it("stores and returns a value, and reports an absent key as null", async () => {
    expect(await get(base, "join")).toBeNull();
    await put(base, "join", "https://gateway.example.invalid:7600");
    expect(await get(base, "join")).toBe("https://gateway.example.invalid:7600");
  });

  it("overwrites a key", async () => {
    await put(base, "phase", "installed");
    await put(base, "phase", "updated");
    expect(await get(base, "phase")).toBe("updated");
  });

  it("refuses keys outside the allowed shape", async () => {
    await expect(put(base, "../etc", "x")).rejects.toThrow(/invalid key/);
    const res = await fetch(`${base}/v1/${encodeURIComponent("A B")}`);
    expect(res.status).toBe(404);
  });

  it("refuses an oversized body", async () => {
    await expect(put(base, "big", "x".repeat(65 * 1024))).rejects.toThrow();
    expect(await get(base, "big")).toBeNull();
  });

  it("waits for a key that arrives later", async () => {
    setTimeout(() => void put(base, "code", "ABCD-1234"), 50);
    const result = await wait(base, "code", { timeoutMs: 5000, intervalMs: 20 });
    expect(result).toEqual({ status: "ok", value: "ABCD-1234" });
  });

  it("ends a wait at once when the other side aborts", async () => {
    await put(base, ABORT_KEY, "gateway install failed");
    const started = Date.now();
    const result = await wait(base, "code", { timeoutMs: 5000, intervalMs: 20 });
    expect(result).toEqual({ status: "aborted", value: "gateway install failed" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("times out when the key never arrives", async () => {
    const result = await wait(base, "code", { timeoutMs: 100, intervalMs: 20 });
    expect(result.status).toBe("timeout");
  });

  it("keeps retrying while the mailbox is unreachable", async () => {
    const port = server.address().port;
    await new Promise((ok) => server.close(ok));
    const late = createMailboxServer();
    setTimeout(() => {
      late.listen(port, "127.0.0.1", () => void put(base, "fingerprint", "sha256:00"));
    }, 100);
    try {
      const result = await wait(base, "fingerprint", { timeoutMs: 5000, intervalMs: 30 });
      expect(result).toEqual({ status: "ok", value: "sha256:00" });
    } finally {
      await new Promise((ok) => late.close(ok));
      server = createMailboxServer();
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    }
  });

  it("reports a mailbox that answered and then went away", async () => {
    const result = await (async () => {
      setTimeout(() => server.close(), 100);
      return wait(base, "code", { timeoutMs: 5000, goneAfterMs: 200, intervalMs: 20 });
    })();
    expect(result.status).toBe("gone");
    server = createMailboxServer();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  });
});
