// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { probeGatewayDevice } from "./adaptive-probe.js";
import { runRelayCommand } from "./runtime.js";
import { createRelayClientProxy } from "./client-proxy.js";
import {
  discoverDirectCandidates,
  GatewayRequestRefused,
  pinnedGatewayJson,
} from "./google-device-pairing.js";
import { certificateFingerprint } from "./gateway-binding.js";
import { GatewayTlsIdentityRefused, tlsSpkiFingerprint } from "./pinned-key.js";

vi.mock("./client-proxy.js", async (original) => {
  const actual = await original<typeof import("./client-proxy.js")>();
  const { createServer } = await import("node:http");
  return {
    ...actual,
    createRelayClientProxy: vi.fn<typeof actual.createRelayClientProxy>(() => {
      const server = createServer();
      vi.spyOn(server, "unref");
      return {
        server,
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      };
    }),
  };
});
vi.mock("./adaptive-probe.js", () => ({ probeGatewayDevice: vi.fn() }));
vi.mock("./google-device-pairing.js", async (original) => ({
  ...(await original<typeof import("./google-device-pairing.js")>()),
  discoverDirectCandidates: vi.fn(),
  pinnedGatewayJson: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-runtime-direct-"));
  vi.mocked(createRelayClientProxy).mockClear();
  vi.mocked(discoverDirectCandidates).mockReset();
  vi.mocked(probeGatewayDevice).mockReset();
  vi.mocked(pinnedGatewayJson).mockReset();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function bundle() {
  const paths = tlsFiles(directory, "gateway.example.test"),
    certificate = await readFile(paths.certFile, "utf8");
  const file = join(directory, "device.json");
  const value = {
    gatewayUrl: "https://gateway.example.test",
    gatewayFingerprint: certificateFingerprint(certificate),
    gatewayCertificate: certificate,
    token: "component-owned-device-token",
    deviceId: randomUUID(),
    kind: "collector",
    scopes: ["read", "write:*"],
  };
  return {
    file,
    value,
    env: { OMNESIS_CLOUD_RELAY_DEVICE_FILE: file, OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0" },
  };
}

test("legacy exact-leaf bundles skip optional hint refresh and keep their original trust contract", async () => {
  const f = await bundle();
  await writeFile(f.file, JSON.stringify(f.value));
  const transport = await runRelayCommand("client", f.env);
  try {
    expect(discoverDirectCandidates).not.toHaveBeenCalled();
    expect(transport!.gatewayUrl).toBe(f.value.gatewayUrl);
    expect(createRelayClientProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayFingerprint: f.value.gatewayFingerprint,
        gatewayCa: f.value.gatewayCertificate,
        expectedGatewayToken: f.value.token,
        tlsSpkiFingerprint: undefined,
        directCandidates: undefined,
      }),
    );
  } finally {
    await transport!.close();
  }
});

test("approved public-key bundle looks for home once before listening, saves refreshed hints and starts an unrefd ephemeral adapter", async () => {
  const f = await bundle(),
    pin = tlsSpkiFingerprint(f.value.gatewayCertificate),
    saved = [{ address: "192.168.1.20", port: 7600 }],
    fresh = [{ address: "fd00::1", port: 8443 }];
  const paired = { ...f.value, tlsSpkiFingerprint: pin, directCandidates: saved };
  await writeFile(f.file, JSON.stringify(paired), { mode: 0o600 });
  vi.mocked(discoverDirectCandidates).mockResolvedValue(fresh);
  const transport = await runRelayCommand("client", {
    ...f.env,
    OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
    OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP: "10.0.0.9",
  });
  try {
    const target = { publicOrigin: f.value.gatewayUrl, certificate: f.value.gatewayCertificate };
    expect(probeGatewayDevice).toHaveBeenCalledExactlyOnceWith({
      gateway: target,
      deviceId: f.value.deviceId,
      token: f.value.token,
      candidate: saved[0],
      candidates: saved,
      tlsSpkiFingerprint: pin,
      signal: expect.any(AbortSignal),
    });
    // The saved address answered, so it also carries the refresh.
    expect(discoverDirectCandidates).toHaveBeenCalledExactlyOnceWith(
      target,
      f.value.token,
      expect.any(AbortSignal),
      expect.any(Function),
      saved,
      pin,
      saved,
    );
    // The refresh's canonical dial uses the operator's address override, like traffic does.
    const signal = new AbortController().signal;
    await vi.mocked(discoverDirectCandidates).mock.calls[0]![3]!(
      target,
      "/devices/direct-candidates",
      undefined,
      signal,
      "ignored",
      { token: f.value.token },
    );
    expect(pinnedGatewayJson).toHaveBeenCalledExactlyOnceWith(
      target,
      "/devices/direct-candidates",
      undefined,
      signal,
      "10.0.0.9",
      { token: f.value.token },
    );
    // A restart away from home begins with what the gateway last reported.
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({
      ...paired,
      directCandidates: fresh,
    });
    if (process.platform !== "win32") {
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    }
    expect(createRelayClientProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        directCandidates: fresh,
        tlsSpkiFingerprint: pin,
        expectedGatewayToken: f.value.token,
      }),
    );
    expect(
      vi.mocked(createRelayClientProxy).mock.results[0]!.value.server.unref,
    ).toHaveBeenCalledOnce();
    expect(transport!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const adaptive = vi.mocked(createRelayClientProxy).mock.calls[0]![0].adaptivePath!;
    expect(adaptive.isLocal()).toBe(true);
    vi.mocked(discoverDirectCandidates).mockRejectedValueOnce(
      new GatewayTlsIdentityRefused("expired"),
    );
    await adaptive.check();
    expect(() => adaptive.assertUsable()).toThrow("Strict verification");
    await adaptive.check();
    adaptive.assertUsable();
    expect(probeGatewayDevice).toHaveBeenCalledWith({
      gateway: target,
      deviceId: f.value.deviceId,
      token: f.value.token,
      candidates: [],
      connectHost: "10.0.0.9",
      tlsSpkiFingerprint: pin,
      signal: expect.any(AbortSignal),
    });
  } finally {
    await transport!.close();
  }
});

test("started away from home, the saved hints are not dialled for the refresh and connections begin on the relay", async () => {
  const f = await bundle(),
    saved = [{ address: "192.168.1.20", port: 7600 }];
  const text = JSON.stringify({ ...f.value, directCandidates: saved });
  await writeFile(f.file, text);
  vi.mocked(probeGatewayDevice).mockRejectedValue(
    Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
  );
  vi.mocked(discoverDirectCandidates).mockResolvedValue(saved);
  const transport = await runRelayCommand("client", f.env);
  try {
    expect(vi.mocked(discoverDirectCandidates).mock.calls[0]!.slice(4)).toEqual([
      saved,
      undefined,
      [],
    ]);
    const adaptive = vi.mocked(createRelayClientProxy).mock.calls[0]![0].adaptivePath!;
    expect(adaptive.isLocal()).toBe(false);
    // Unchanged hints leave the device file untouched.
    expect(await readFile(f.file, "utf8")).toBe(text);
  } finally {
    await transport!.close();
  }
});

test("invalid saved SPKI or routing hints fail before discovery and auth failures never start an adapter", async () => {
  const f = await bundle(),
    pin = tlsSpkiFingerprint(f.value.gatewayCertificate);
  for (const invalid of [
    { tlsSpkiFingerprint: "a".repeat(64) },
    { tlsSpkiFingerprint: pin, directCandidates: [{ address: "127.0.0.1", port: 7600 }] },
  ]) {
    await writeFile(f.file, JSON.stringify({ ...f.value, ...invalid }));
    await expect(runRelayCommand("client", f.env)).rejects.toThrow();
  }
  expect(discoverDirectCandidates).not.toHaveBeenCalled();
  expect(createRelayClientProxy).not.toHaveBeenCalled();
  await writeFile(
    f.file,
    JSON.stringify({ ...f.value, tlsSpkiFingerprint: pin, directCandidates: [] }),
  );
  for (const [error, message] of [
    [new GatewayRequestRefused(401), "Repair pairing"],
    [new Error("gateway public key pin mismatch"), "Repair pairing"],
    [new GatewayTlsIdentityRefused("expired"), "Strict verification"],
  ] as const) {
    vi.mocked(discoverDirectCandidates).mockRejectedValue(error);
    await expect(runRelayCommand("client", f.env)).rejects.toThrow(message);
  }
  expect(createRelayClientProxy).not.toHaveBeenCalled();
});

test("a hinted legacy leaf bundle never opts into same-key renewal recovery", async () => {
  const f = await bundle();
  const hints = [{ address: "192.168.1.20", port: 7600 }];
  await writeFile(f.file, JSON.stringify({ ...f.value, directCandidates: hints }));
  vi.mocked(discoverDirectCandidates).mockResolvedValue(hints);
  const transport = await runRelayCommand("client", f.env);
  try {
    const adaptive = vi.mocked(createRelayClientProxy).mock.calls[0]![0].adaptivePath!;
    vi.mocked(discoverDirectCandidates).mockRejectedValue(new GatewayTlsIdentityRefused("expired"));
    await adaptive.check();
    await adaptive.check();
    expect(discoverDirectCandidates).toHaveBeenCalledTimes(2);
    expect(() => adaptive.assertUsable()).toThrow("Repair pairing");
  } finally {
    await transport!.close();
  }
});
