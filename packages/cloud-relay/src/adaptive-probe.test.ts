// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test, vi } from "vitest";
import { probeGatewayDevice } from "./adaptive-probe.js";
const options = {
  gateway: {
    publicOrigin: "https://gateway.example.test",
    certificate: "public-fixture-certificate",
  },
  deviceId: "00000000-0000-4000-8000-000000000001",
  token: "fictional-token",
  candidate: { address: "192.168.1.20", port: 8443 },
  candidates: [],
  tlsSpkiFingerprint: "a".repeat(64),
  signal: new AbortController().signal,
};
test("LAN probing authenticates the exact saved device over canonical pinned TLS without experimental discovery", async () => {
  const request = vi.fn().mockResolvedValue({
    deviceId: options.deviceId,
    scopes: ["read"],
    deviceName: "Fictional collector",
  });
  expect(await probeGatewayDevice(options, request)).toEqual([]);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    options.gateway,
    "/whoami",
    undefined,
    options.signal,
    options.candidate.address,
    { token: options.token, connectPort: 8443, tlsSpkiFingerprint: options.tlsSpkiFingerprint },
  );
  for (const body of [null, {}, { deviceId: "different-device" }]) {
    request.mockResolvedValueOnce(body);
    await expect(probeGatewayDevice(options, request)).rejects.toThrow();
  }
  request.mockRejectedValueOnce(new Error("TLS public key refused"));
  await expect(probeGatewayDevice(options, request)).rejects.toThrow("TLS public key refused");
});
test("real probe transport fails before credentials when saved TLS material is invalid", async () => {
  await expect(probeGatewayDevice(options)).rejects.toThrow();
});

test("canonical re-verification has no LAN override and requires the identical saved device", async () => {
  const { candidate: _candidate, ...canonical } = options;
  const request = vi.fn().mockResolvedValue({ deviceId: options.deviceId });
  expect(await probeGatewayDevice(canonical, request)).toEqual([]);
  expect(request).toHaveBeenLastCalledWith(
    options.gateway,
    "/whoami",
    undefined,
    options.signal,
    undefined,
    {
      token: options.token,
      connectPort: undefined,
      tlsSpkiFingerprint: options.tlsSpkiFingerprint,
    },
  );
  await probeGatewayDevice({ ...canonical, connectHost: "127.0.0.1" }, request);
  expect(request.mock.calls.at(-1)![4]).toBe("127.0.0.1");
  request.mockResolvedValue({ deviceId: "different-device" });
  await expect(probeGatewayDevice(canonical, request)).rejects.toThrow();
});
