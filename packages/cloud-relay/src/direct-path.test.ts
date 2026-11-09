// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { expect, test, vi, afterEach } from "vitest";
import {
  connectPreferredGateway,
  connectivityFailure,
  deadlineFailure,
  directCandidatesSchema,
  privateDirectAddress,
} from "./direct-path.js";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import type { connectOrigin } from "./network.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fakeDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("deadline")), ms);
    return controller.signal;
  });
}
const base = () => ({
  origin: new URL("https://gateway.example.com"),
  certificate: "approved-leaf",
  fingerprint: "a".repeat(64),
  candidates: [{ address: "192.168.1.20", port: 7600 }],
  signal: new AbortController().signal,
});

test("literal private addresses are routing hints, never public loopback wildcard mapped or scoped destinations", () => {
  for (const ip of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "fc00::1",
    "fd12::1234",
  ])
    expect(privateDirectAddress(ip), ip).toBe(true);
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "100.64.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.167.1.1",
    "8.8.8.8",
    "gateway.local",
    "::",
    "::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:192.168.1.1",
    "fd00::1%en0",
    "10.01.2.3",
  ])
    expect(privateDirectAddress(ip), ip).toBe(false);
  for (const value of [
    { version: 2, candidates: [] },
    { version: 1, candidates: [{ address: "10.0.0.1", port: 0 }] },
    { version: 1, candidates: Array(9).fill({ address: "10.0.0.1", port: 443 }) },
    { version: 1, candidates: [{ address: "10.0.0.1", port: 443, hostname: "attacker.example" }] },
  ])
    expect(directCandidatesSchema.safeParse(value).success).toBe(false);
});

test("prefer LAN before canonical relay, retaining original DNS identity and strict trust contract", async () => {
  const stream = new PassThrough();
  const connect = vi.fn<typeof connectOrigin>().mockResolvedValue(stream);
  const options = { ...base(), tlsSpkiFingerprint: "b".repeat(64) };
  expect(await connectPreferredGateway(options, connect)).toBe(stream);
  expect(connect).toHaveBeenCalledExactlyOnceWith(
    options.origin,
    options.certificate,
    expect.any(AbortSignal),
    false,
    options.fingerprint,
    "192.168.1.20",
    7600,
    options.tlsSpkiFingerprint,
  );
});

test("a home connection outlives the deadline that bounded its dial and ends with its caller", async () => {
  fakeDeadlines();
  const stream = new PassThrough();
  const connect = vi.fn<typeof connectOrigin>().mockResolvedValue(stream);
  const caller = new AbortController();
  expect(await connectPreferredGateway({ ...base(), signal: caller.signal }, connect)).toBe(stream);
  const dialing = connect.mock.calls[0]![2]!;
  await vi.advanceTimersByTimeAsync(60_000);
  // Neither the 750 ms attempt deadline nor the 5 s scan budget reaches an established socket.
  expect(dialing.aborted).toBe(false);
  expect(stream.destroyed).toBe(false);
  caller.abort();
  expect(stream.destroyed).toBe(true);
  // One that closed by itself no longer listens to its caller.
  const closed = new PassThrough();
  const other = new AbortController();
  const remove = vi.spyOn(other.signal, "removeEventListener");
  await connectPreferredGateway(
    { ...base(), signal: other.signal },
    vi.fn<typeof connectOrigin>().mockResolvedValue(closed),
  );
  closed.destroy();
  await vi.advanceTimersByTimeAsync(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("a home address that fails the saved TLS identity is skipped and reported, and the canonical route decides", async () => {
  const refused = vi.fn();
  const stream = new PassThrough();
  const connect = vi
    .fn<typeof connectOrigin>()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("Gateway public key pin mismatch"))
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("Gateway certificate hostname mismatch"))
    .mockResolvedValue(stream);
  const candidates = [
    { address: "192.168.1.20", port: 7600 },
    { address: "10.0.0.20", port: 7600 },
  ];
  expect(
    await connectPreferredGateway({ ...base(), candidates, onRefusedHint: refused }, connect),
  ).toBe(stream);
  expect(refused.mock.calls).toEqual([[candidates[0]], [candidates[1]]]);
  expect(connect.mock.calls[2]![6]).toBeUndefined();
  // The canonical route is held to the same identity and its refusal is final.
  const canonical = new GatewayTlsIdentityRefused("Gateway certificate pin mismatch");
  const strict = vi.fn<typeof connectOrigin>().mockRejectedValue(canonical);
  await expect(connectPreferredGateway(base(), strict)).rejects.toBe(canonical);
  expect(strict).toHaveBeenCalledTimes(2);
});

test("only explicit reachability failures advance routes and no TLS or application authentication failure falls back", async () => {
  for (const code of [
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
  ]) {
    const connect = vi
      .fn<typeof connectOrigin>()
      .mockRejectedValueOnce(Object.assign(new Error("unreachable"), { code }))
      .mockResolvedValue(new PassThrough());
    await connectPreferredGateway({ ...base(), connectHost: "127.0.0.1" }, connect);
    expect(connect.mock.calls[1]?.[5]).toBe("127.0.0.1");
    expect(connect.mock.calls[1]?.[6]).toBeUndefined();
  }
  for (const error of [
    new Error("pin mismatch"),
    Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }),
    Object.assign(new Error("hostname"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    { status: 401 },
    null,
    "failure",
    { code: "" },
  ]) {
    const connect = vi.fn<typeof connectOrigin>().mockRejectedValue(error);
    await expect(connectPreferredGateway(base(), connect)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
  }
  expect(connectivityFailure({ code: 123 })).toBe(false);
});

test("bounded LAN timeouts fall back but caller cancellation never opens another connection", async () => {
  fakeDeadlines();
  const connect = vi
    .fn<typeof connectOrigin>()
    .mockImplementationOnce(async (_a, _b, signal) => {
      await new Promise((_, reject) =>
        signal!.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("abort"), { code: "ABORT_ERR" })),
          { once: true },
        ),
      );
      throw new Error("unreachable");
    })
    .mockResolvedValue(new PassThrough());
  const pending = connectPreferredGateway(base(), connect);
  await vi.advanceTimersByTimeAsync(751);
  await pending;
  expect(connect).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  const stopped = vi.fn<typeof connectOrigin>().mockImplementation(async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("network");
  });
  await expect(
    connectPreferredGateway({ ...base(), signal: controller.signal }, stopped),
  ).rejects.toThrow("cancelled");
  expect(stopped).toHaveBeenCalledTimes(1);
  const already = new AbortController();
  already.abort(new Error("already cancelled"));
  await expect(
    connectPreferredGateway({ ...base(), candidates: [], signal: already.signal }, connect),
  ).rejects.toThrow("already cancelled");
  const invalid = { ...base(), candidates: [{ address: "127.0.0.1", port: 443 }] };
  await expect(connectPreferredGateway(invalid, connect)).rejects.toThrow();
});

test("total budget stops scanning further hints and empty hints use canonical transport directly", async () => {
  fakeDeadlines();
  const options = { ...base(), candidates: Array(8).fill({ address: "10.0.0.1", port: 443 }) };
  let count = 0;
  const connect = vi
    .fn<typeof connectOrigin>()
    .mockImplementation(async (_a, _b, signal, _d, _e, host) => {
      if (host === undefined) return new PassThrough();
      count++;
      await new Promise((_, reject) =>
        signal!.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("timed out"), { code: "ABORT_ERR" })),
          { once: true },
        ),
      );
      throw new Error("unreachable");
    });
  const pending = connectPreferredGateway(options, connect);
  await vi.advanceTimersByTimeAsync(5001);
  await pending;
  expect(count).toBe(7);
  expect(connect).toHaveBeenCalledTimes(8);
  await connectPreferredGateway({ ...base(), candidates: [] }, connect);
});

test("only the connector's explicit aborted-I/O error is a deadline fallback, never a concurrent certificate failure", () => {
  const controller = new AbortController();
  expect(
    deadlineFailure(controller.signal, Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
  ).toBe(false);
  controller.abort();
  for (const error of [
    null,
    { code: "ABORT_ERR" },
    new Error("pin"),
    Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }),
  ])
    expect(deadlineFailure(controller.signal, error)).toBe(false);
  expect(
    deadlineFailure(controller.signal, Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
  ).toBe(true);
});
