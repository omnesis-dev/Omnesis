// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { readDesktopRemoteProtection } from "./remote-protection.js";
import type { DesktopPairing } from "./enrollment.js";
const pairing: DesktopPairing = {
  kind: "collector",
  token: "fixture-token",
  gatewayUrl: "https://library.example.test",
  gatewayFingerprint: "a".repeat(64),
  gatewayCertificate: "invented-certificate",
  scopes: ["read", "write:*"],
  deviceId: "00000000-0000-4000-8000-000000000003",
};
const transport = { url: "http://127.0.0.1:18607", close: async () => {} };
const signal = () => new AbortController().signal;
test("only current encrypted evidence from the authenticated pinned local proxy passes", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ status: "ok", storageProtection: { version: 1, atRest: "encrypted" } }),
      ),
  );
  expect(await readDesktopRemoteProtection(transport, pairing, signal(), fetcher)).toBe(
    "encrypted",
  );
  expect(String(fetcher.mock.calls[0]![0])).toBe("http://127.0.0.1:18607/health");
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    redirect: "error",
    headers: { authorization: "Bearer fixture-token" },
  });
});
test("plaintext, absent, old, unknown and oversized evidence never become protected", async () => {
  for (const [value, expected] of [
    [{ storageProtection: { version: 1, atRest: "unprotected" } }, "unprotected"],
    [{ storageProtection: { version: 1, atRest: "unavailable" } }, "unavailable"],
    [{ storageProtection: { version: 0, atRest: "encrypted" } }, "unavailable"],
    [{ status: "ok" }, "unavailable"],
    [{ storageProtection: { version: 1, atRest: true } }, "unavailable"],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)));
    expect(await readDesktopRemoteProtection(transport, pairing, signal(), fetcher)).toBe(expected);
  }
  const oversized = vi.fn<typeof fetch>(async () => new Response("x".repeat(65_537)));
  expect(await readDesktopRemoteProtection(transport, pairing, signal(), oversized)).toBe(
    "unavailable",
  );
});
test("offline or refused requests fail closed and cancellation cannot yield stale positive proof", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error("invented-offline");
  });
  expect(await readDesktopRemoteProtection(transport, pairing, signal(), fetcher)).toBe(
    "unavailable",
  );
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    readDesktopRemoteProtection(transport, pairing, aborted.signal, fetcher),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(
    readDesktopRemoteProtection(
      { ...transport, url: "https://unrelated.example.test" },
      pairing,
      signal(),
      fetcher,
    ),
  ).rejects.toThrow("paired transport");
  expect(fetcher).toHaveBeenCalledOnce();
});
