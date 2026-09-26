// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:tls";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { generateSelfSigned } from "../tls.js";
import { createServedByGatewayCheck, probeServedCertificate } from "./served-by-gateway.js";
import type { AddressInfo } from "node:net";

describe("probeServedCertificate", () => {
  let server: Server;
  let port: number;
  let fingerprint: string;

  beforeAll(async () => {
    const material = generateSelfSigned();
    fingerprint = material.fingerprintSha256;
    server = createServer({ cert: material.cert, key: material.key }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("fingerprints the certificate a TLS client meets, trusted or not", async () => {
    expect(await probeServedCertificate(new URL(`https://127.0.0.1:${port}/mcp`))).toBe(
      fingerprint,
    );
  });

  test("answers null when nothing answers", async () => {
    const closed = createServer({});
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const unusedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await probeServedCertificate(new URL(`https://127.0.0.1:${unusedPort}/mcp`))).toBeNull();
  });
});

describe("createServedByGatewayCheck", () => {
  const OWN = "ab".repeat(32);
  const DIRECT = "https://gateway.example.org:7600/mcp";
  const PROXIED = "https://gateway.example.org/mcp";
  const UNREACHABLE = "https://offline.example.org/mcp";

  test("counts a resource as the gateway's only when it presents the gateway's certificate", async () => {
    const check = createServedByGatewayCheck({
      fingerprint: () => OWN.toUpperCase(),
      probe: async (resource) =>
        ({ [DIRECT]: OWN, [PROXIED]: "cd".repeat(32) })[resource.toString()] ?? null,
    });
    expect(Object.fromEntries(await check([DIRECT, PROXIED, UNREACHABLE]))).toEqual({
      [DIRECT]: true,
      [PROXIED]: false,
      [UNREACHABLE]: false,
    });
  });

  test("reuses an answer briefly and probes again after the certificate changes or time passes", async () => {
    let own = OWN;
    let clock = 0;
    const probe = vi.fn(async () => OWN);
    const check = createServedByGatewayCheck({ fingerprint: () => own, probe, now: () => clock });

    expect((await check([DIRECT])).get(DIRECT)).toBe(true);
    expect((await check([DIRECT])).get(DIRECT)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);

    own = "ef".repeat(32);
    expect((await check([DIRECT])).get(DIRECT)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);

    clock = 61_000;
    await check([DIRECT]);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test("treats every resource as proxied when the gateway has no certificate to compare", async () => {
    const probe = vi.fn(async () => OWN);
    const check = createServedByGatewayCheck({ fingerprint: () => undefined, probe });
    expect((await check([DIRECT])).get(DIRECT)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
