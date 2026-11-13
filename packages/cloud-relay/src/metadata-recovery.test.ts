// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { closeServer, listen, tlsFiles } from "../test/support.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
import { probeGatewayDevice } from "./adaptive-probe.js";
import { certificateFingerprint } from "./gateway-binding.js";
import { GatewayTlsIdentityRefused, tlsSpkiFingerprint } from "./pinned-key.js";
import { connectOrigin } from "./network.js";
import { connectPreferredGateway } from "./direct-path.js";
import {
  discoverDirectCandidates,
  pinnedGatewayJson,
  GatewayRequestRefused,
} from "./google-device-pairing.js";
import { createRelayClientProxy } from "./client-proxy.js";
import type { TLSSocket } from "node:tls";

vi.mock("./network.js", async (original) => {
  const actual = await original<typeof import("./network.js")>();
  return {
    ...actual,
    connectOrigin: vi.fn<typeof actual.connectOrigin>((...args) => {
      // Only fixture TCP destinations are mapped; real TLS identity, SNI and all ports remain unchanged.
      if (args[5] === "192.168.1.20" || args[5] === "192.168.1.21") args[5] = "127.0.0.1";
      return actual.connectOrigin(...args);
    }),
  };
});
afterEach(() => {
  vi.mocked(connectOrigin).mockClear();
  vi.useRealTimers();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-metadata-recovery-"));
  await mkdir(join(directory, "gateway"));
  await mkdir(join(directory, "reassigned"));
  const approvedFiles = tlsFiles(join(directory, "gateway"), "gateway.example.test");
  const rejectedFiles = tlsFiles(join(directory, "reassigned"), "gateway.example.test");
  // Keep the unrelated key's certificate valid even while the renewal test advances its verification clock.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-key",
      rejectedFiles.keyFile,
      "-out",
      rejectedFiles.certFile,
      "-days",
      "10",
      "-set_serial",
      "3",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:gateway.example.test",
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(approvedFiles.certFile, "utf8"),
    key = await readFile(approvedFiles.keyFile, "utf8");
  const otherCertificate = await readFile(rejectedFiles.certFile, "utf8"),
    otherKey = await readFile(rejectedFiles.keyFile, "utf8");
  let rejectedBytes = 0;
  const requests: {
    path: string;
    token: string | undefined;
    host: string | undefined;
    sni: string | false | null;
    body: string;
  }[] = [];
  let status = 200,
    body: unknown;
  const good = createServer({ cert: certificate, key }, (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(part);
      requests.push({
        path: req.url!,
        token: req.headers.authorization,
        host: req.headers.host,
        sni: (req.socket as TLSSocket).servername,
        body: Buffer.concat(chunks).toString(),
      });
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(
          req.url === "/whoami"
            ? JSON.stringify({ deviceId: "device-one" })
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
        );
    })().catch(() => res.destroy());
  });
  const reassigned = createServer({ cert: otherCertificate, key: otherKey });
  reassigned.on("secureConnection", (socket) =>
    socket.on("data", (data) => (rejectedBytes += data.length)),
  );
  const goodUrl = await listen(good),
    otherUrl = await listen(reassigned);
  const publicOrigin = goodUrl.replace("http://127.0.0.1", "https://gateway.example.test");
  const saved = [{ address: "192.168.1.20", port: Number(new URL(otherUrl).port) }];
  const fresh = [{ address: "192.168.1.21", port: Number(new URL(goodUrl).port) }];
  body = { version: 1, candidates: fresh };
  const binding = Object.freeze({ publicOrigin, certificate });
  const pin = tlsSpkiFingerprint(certificate),
    fingerprint = certificateFingerprint(certificate);
  const json: typeof pinnedGatewayJson = (candidate, path, input, signal, _host, options) =>
    pinnedGatewayJson(candidate, path, input, signal, "127.0.0.1", options);
  return {
    binding,
    saved,
    fresh,
    pin,
    fingerprint,
    good,
    reassigned,
    requests,
    json,
    rejectedBytes: () => rejectedBytes,
    reply(code: number, value: unknown) {
      status = code;
      body = value;
    },
    replaceCanonical() {
      good.setSecureContext({ cert: otherCertificate, key: otherKey });
      return otherCertificate;
    },
    async renew() {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-key",
          approvedFiles.keyFile,
          "-out",
          approvedFiles.certFile,
          "-days",
          "10",
          "-set_serial",
          "2",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:gateway.example.test",
        ],
        { stdio: "ignore" },
      );
      const renewed = await readFile(approvedFiles.certFile, "utf8");
      good.setSecureContext({ cert: renewed, key });
      return renewed;
    },
    async close() {
      await closeServer(good);
      await closeServer(reassigned);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("stale DHCP TLS identity can recover only metadata through the same canonical pin and bearer", async () => {
  const f = await fixture();
  try {
    for (const pin of [undefined, f.pin]) {
      vi.mocked(connectOrigin).mockClear();
      const hints = await discoverDirectCandidates(
        f.binding,
        "device-token",
        AbortSignal.timeout(5000),
        f.json,
        f.saved,
        pin,
      );
      expect(hints).toEqual(f.fresh);
      expect(vi.mocked(connectOrigin).mock.calls.map((call) => call[6])).toEqual([
        f.saved[0]!.port,
        undefined,
      ]);
      expect(f.requests.at(-1)).toEqual({
        path: "/devices/direct-candidates",
        token: "Bearer device-token",
        host: new URL(f.binding.publicOrigin).host,
        sni: "gateway.example.test",
        body: "",
      });
      expect(f.rejectedBytes()).toBe(0);
      vi.mocked(connectOrigin).mockClear();
      expect(
        await discoverDirectCandidates(
          f.binding,
          "device-token",
          AbortSignal.timeout(5000),
          f.json,
          hints,
          pin,
        ),
      ).toEqual(f.fresh);
      expect(vi.mocked(connectOrigin).mock.calls.map((call) => call[6])).toEqual([
        f.fresh[0]!.port,
      ]);
    }
  } finally {
    await f.close();
  }
});

test("a home address held by another machine is skipped before any byte is sent, and the body travels once over the canonical route", async () => {
  const f = await fixture();
  const adapter = createRelayClientProxy({
    gatewayUrl: f.binding.publicOrigin,
    gatewayCa: f.binding.certificate,
    gatewayFingerprint: f.fingerprint,
    tlsSpkiFingerprint: f.pin,
    expectedGatewayToken: "device-token",
    directCandidates: f.saved,
    gatewayConnectHost: "127.0.0.1",
  });
  try {
    const refused = vi.fn();
    const stream = await connectPreferredGateway({
      origin: new URL(f.binding.publicOrigin),
      certificate: f.binding.certificate,
      fingerprint: f.fingerprint,
      tlsSpkiFingerprint: f.pin,
      candidates: f.saved,
      signal: AbortSignal.timeout(5000),
      connectHost: "127.0.0.1",
      onRefusedHint: refused,
    });
    stream.destroy();
    expect(refused).toHaveBeenCalledExactlyOnceWith(f.saved[0]);
    // The refused address first, then the canonical one under the identical saved identity.
    expect(vi.mocked(connectOrigin).mock.calls.map((call) => [call[6], call[7]])).toEqual([
      [f.saved[0]!.port, f.pin],
      [undefined, f.pin],
    ]);
    const url = await listen(adapter.server);
    expect(
      (
        await fetch(url + "/documents", {
          method: "POST",
          headers: { authorization: "Bearer device-token" },
          body: "sent-exactly-once",
        })
      ).status,
    ).toBe(200);
    expect(f.requests.filter((value) => value.body === "sent-exactly-once")).toHaveLength(1);
    expect(f.rejectedBytes()).toBe(0);
    // With the canonical route also presenting another key there is nowhere left to go.
    f.replaceCanonical();
    expect(
      (
        await fetch(url + "/documents", {
          method: "POST",
          headers: { authorization: "Bearer device-token" },
          body: "never-sent",
        })
      ).status,
    ).toBe(502);
    expect(f.requests.filter((value) => value.body === "never-sent")).toEqual([]);
    expect(f.rejectedBytes()).toBe(0);
  } finally {
    await adapter.close();
    await f.close();
  }
});

test("canonical authentication and malformed responses remain terminal while temporary service failures retain hints", async () => {
  const f = await fixture();
  try {
    for (const status of [401, 403, 307]) {
      f.reply(status, {});
      await expect(
        discoverDirectCandidates(
          f.binding,
          "device-token",
          AbortSignal.timeout(5000),
          f.json,
          f.saved,
          f.pin,
        ),
      ).rejects.toBeInstanceOf(GatewayRequestRefused);
    }
    for (const body of [
      "not JSON",
      {},
      { version: 1, candidates: [{ address: "127.0.0.1", port: 443 }] },
    ]) {
      f.reply(200, body);
      await expect(
        discoverDirectCandidates(
          f.binding,
          "device-token",
          AbortSignal.timeout(5000),
          f.json,
          f.saved,
          f.pin,
        ),
      ).rejects.toThrow();
    }
    for (const status of [404, 429, 503]) {
      f.reply(status, {});
      expect(
        await discoverDirectCandidates(
          f.binding,
          "device-token",
          AbortSignal.timeout(5000),
          f.json,
          f.saved,
          f.pin,
        ),
      ).toEqual(f.saved);
    }
    f.replaceCanonical();
    for (const saved of [f.saved, []]) {
      vi.mocked(connectOrigin).mockClear();
      await expect(
        discoverDirectCandidates(
          f.binding,
          "device-token",
          AbortSignal.timeout(5000),
          f.json,
          saved,
          f.pin,
        ),
      ).rejects.toBeInstanceOf(GatewayTlsIdentityRefused);
      expect(vi.mocked(connectOrigin).mock.calls).toHaveLength(saved.length + 1);
    }
    expect(f.rejectedBytes()).toBe(0);
  } finally {
    await f.close();
  }
});

test("healthy LAN metadata needs no relay and a canonical network outage preserves previously verified hints", async () => {
  const f = await fixture();
  try {
    // The canonical address is deliberately closed; only the authenticated LAN endpoint stays online.
    const closed = createServer();
    const closedUrl = await listen(closed);
    await closeServer(closed);
    expect(
      await discoverDirectCandidates(
        f.binding,
        "device-token",
        AbortSignal.timeout(5000),
        f.json,
        [{ address: f.saved[0]!.address, port: Number(new URL(closedUrl).port) }],
        f.pin,
      ),
    ).toEqual(f.fresh);
    expect(vi.mocked(connectOrigin).mock.calls.map((call) => call[6])).toEqual([
      Number(new URL(closedUrl).port),
      undefined,
    ]);
    vi.mocked(connectOrigin).mockClear();
    const binding = {
      ...f.binding,
      publicOrigin: closedUrl.replace("http://127.0.0.1", "https://gateway.example.test"),
    };
    expect(
      await discoverDirectCandidates(
        binding,
        "device-token",
        AbortSignal.timeout(5000),
        f.json,
        f.fresh,
        f.pin,
      ),
    ).toEqual(f.fresh);
    expect(vi.mocked(connectOrigin).mock.calls).toHaveLength(1);
    expect(
      await discoverDirectCandidates(
        binding,
        "device-token",
        AbortSignal.timeout(5000),
        f.json,
        f.saved,
        f.pin,
      ),
    ).toEqual(f.saved);
    expect(f.rejectedBytes()).toBe(0);
  } finally {
    await f.close();
  }
});

test("a running SPKI-paired route recovers expired same-key TLS only after exact-device verification and never retries a body", async () => {
  const f = await fixture();
  const savedAuthority = JSON.stringify(f.binding);
  vi.useFakeTimers({
    toFake: ["Date"],
    now: Date.parse(new X509Certificate(f.binding.certificate).validTo) + 60_000,
  });
  const path: AdaptiveGatewayPath = new AdaptiveGatewayPath({
    candidates: f.fresh,
    refresh: (saved, signal) =>
      discoverDirectCandidates(f.binding, "device-token", signal, f.json, saved, f.pin),
    reverify: async (signal) => {
      await probeGatewayDevice(
        {
          gateway: f.binding,
          deviceId: "device-one",
          token: "device-token",
          candidates: [],
          tlsSpkiFingerprint: f.pin,
          signal,
        },
        f.json,
      );
    },
    probe: (candidate, signal) =>
      probeGatewayDevice(
        {
          gateway: f.binding,
          deviceId: "device-one",
          token: "device-token",
          candidates: path.candidates(),
          candidate,
          tlsSpkiFingerprint: f.pin,
          signal,
        },
        f.json,
      ),
  });
  const adapter = createRelayClientProxy({
    gatewayUrl: f.binding.publicOrigin,
    gatewayCa: f.binding.certificate,
    gatewayFingerprint: f.fingerprint,
    tlsSpkiFingerprint: f.pin,
    expectedGatewayToken: "device-token",
    adaptivePath: path,
    gatewayConnectHost: "127.0.0.1",
  });
  try {
    const url = await listen(adapter.server);
    await path.check();
    expect(() => path.assertUsable()).toThrow("Strict verification");
    expect(
      (
        await fetch(url + "/documents", {
          method: "POST",
          headers: { authorization: "Bearer device-token" },
          body: "failed-upload",
        })
      ).status,
    ).toBe(502);
    expect(f.requests).toEqual([]);
    const renewed = await f.renew();
    expect(tlsSpkiFingerprint(renewed)).toBe(f.pin);
    expect(certificateFingerprint(renewed)).not.toBe(f.fingerprint);
    f.reply(503, {});
    await path.check();
    expect(() => path.assertUsable()).toThrow("Strict verification");
    expect(f.requests.map((value) => value.path)).toEqual(["/whoami"]);
    expect(
      (
        await fetch(url + "/documents", {
          method: "POST",
          headers: { authorization: "Bearer device-token" },
          body: "failed-upload",
        })
      ).status,
    ).toBe(502);
    f.reply(200, { version: 1, candidates: f.fresh });
    await path.check();
    path.assertUsable();
    expect(f.requests.map((value) => value.path)).toEqual([
      "/whoami",
      "/whoami",
      "/whoami",
      "/devices/direct-candidates",
    ]);
    expect(
      f.requests.every((value) => value.token === "Bearer device-token" && value.body === ""),
    ).toBe(true);
    expect(
      (
        await fetch(url + "/documents", {
          method: "POST",
          headers: { authorization: "Bearer device-token" },
          body: "fresh-upload",
        })
      ).status,
    ).toBe(200);
    expect(f.requests.filter((value) => value.body === "failed-upload")).toEqual([]);
    expect(f.requests.filter((value) => value.body === "fresh-upload")).toHaveLength(1);
    const beforeWrongKey = f.requests.length;
    const replacement = f.replaceCanonical();
    expect(Date.parse(new X509Certificate(replacement).validTo)).toBeGreaterThan(Date.now());
    await path.check();
    await path.check();
    expect(() => path.assertUsable()).toThrow("Strict verification");
    expect(f.requests).toHaveLength(beforeWrongKey);
    await f.renew();
    f.reply(401, {});
    await path.check();
    expect(() => path.assertUsable()).toThrow("Repair pairing");
    const attempts = vi.mocked(connectOrigin).mock.calls.length;
    await path.check();
    expect(vi.mocked(connectOrigin).mock.calls).toHaveLength(attempts);
    expect(JSON.stringify(f.binding)).toBe(savedAuthority);
  } finally {
    path.close();
    await adapter.close();
    await f.close();
  }
});

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());
