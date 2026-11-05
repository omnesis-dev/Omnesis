// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi, afterEach } from "vitest";
import { discoverDirectCandidates, GatewayRequestRefused } from "./google-device-pairing.js";
import type { pinnedGatewayJson } from "./google-device-pairing.js";
const candidate = {
  gatewayId: "00000000-0000-4000-8000-000000000001",
  publicOrigin: "https://gateway.example.com",
  certificate: "approved-cert",
  identityToken: "local-approved",
};
afterEach(() => vi.restoreAllMocks());
const signal = new AbortController().signal;
const saved = [{ address: "192.168.1.10", port: 7600 }];

test("only a device token sent inside already pinned gateway TLS obtains bounded hints", async () => {
  const json = vi
    .fn<typeof pinnedGatewayJson>()
    .mockResolvedValue({ version: 1, candidates: saved });
  expect(await discoverDirectCandidates(candidate, "device-token", signal, json)).toEqual(saved);
  expect(json).toHaveBeenCalledExactlyOnceWith(
    candidate,
    "/devices/direct-candidates",
    undefined,
    expect.any(AbortSignal),
    undefined,
    { token: "device-token", tlsSpkiFingerprint: undefined, directCandidates: [] },
  );
});
test("connectivity loss or older absent route preserves saved hints but auth pin and metadata errors fail closed", async () => {
  for (const error of [
    Object.assign(new Error("network"), { code: "ECONNREFUSED" }),
    new GatewayRequestRefused(404),
    new GatewayRequestRefused(429),
    new GatewayRequestRefused(500),
    new GatewayRequestRefused(503),
    new GatewayRequestRefused(599),
  ])
    expect(
      await discoverDirectCandidates(
        candidate,
        "token",
        signal,
        vi.fn().mockRejectedValue(error),
        saved,
      ),
    ).toEqual(saved);
  expect(
    await discoverDirectCandidates(
      candidate,
      "token",
      signal,
      vi.fn().mockRejectedValue(new GatewayRequestRefused(404)),
    ),
  ).toEqual([]);
  for (const error of [
    new GatewayRequestRefused(401),
    new GatewayRequestRefused(403),
    new GatewayRequestRefused(400),
    new GatewayRequestRefused(499),
    new GatewayRequestRefused(600),
    new GatewayRequestRefused(undefined),
    new Error("pin mismatch"),
  ])
    await expect(
      discoverDirectCandidates(candidate, "token", signal, vi.fn().mockRejectedValue(error), saved),
    ).rejects.toBe(error);
  await expect(
    discoverDirectCandidates(
      candidate,
      "token",
      signal,
      vi.fn().mockResolvedValue({ version: 1, candidates: [{ address: "127.0.0.1", port: 443 }] }),
    ),
  ).rejects.toThrow();
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  await expect(
    discoverDirectCandidates(
      candidate,
      "token",
      cancelled.signal,
      vi.fn().mockRejectedValue(new GatewayRequestRefused(404)),
    ),
  ).rejects.toThrow("cancelled");
});

test("an internal discovery deadline retains hints while a concurrent pin rejection still fails closed", async () => {
  const elapsed = new AbortController();
  elapsed.abort();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(elapsed.signal);
  expect(
    await discoverDirectCandidates(
      candidate,
      "token",
      signal,
      vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ABORT_ERR" })),
      saved,
    ),
  ).toEqual(saved);
  await expect(
    discoverDirectCandidates(
      candidate,
      "token",
      signal,
      vi.fn().mockRejectedValue(new Error("pin mismatch")),
      saved,
    ),
  ).rejects.toThrow("pin mismatch");
});
