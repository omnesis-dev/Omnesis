// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { localAcmeAuthority } from "../test/acme-authority.js";
import { listen, closeServer, tlsFiles } from "../test/support.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import { cloudflareDnsProvider } from "./cloudflare-dns.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { RelaySessions } from "./identity.js";
import { GatewayTunnel } from "./tunnel-client.js";
import { gatewayKeySessionSource } from "./gateway-key-client.js";
import { GatewayPublicSni } from "./acme-sni.js";
import { issueAcmeCertificate } from "./acme-client.js";
import type { AddressInfo } from "node:net";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-system-"));
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function peer(port: number, hostname: string, ca: string): Promise<string> {
  const socket = connect({
    host: "127.0.0.1",
    port,
    servername: hostname,
    ca,
    rejectUnauthorized: true,
  });
  try {
    await once(socket, "secureConnect");
    expect(socket.authorized).toBe(true);
    return socket.getPeerCertificate().fingerprint256;
  } finally {
    socket.destroy();
  }
}
test("real gateway-only ACME DNS01 issuance plus opaque tunnel keeps direct TLS clients and public SNI clients online together", async () => {
  const gatewayId = randomUUID(),
    hostname = hostedGatewayHostname(gatewayId, "relay.example.test"),
    tls = tlsFiles(directory),
    directCertificate = await readFile(tls.certFile, "utf8"),
    key = await readFile(tls.keyFile, "utf8");
  const records = new Map<string, string>(),
    authority = await localAcmeAuthority(directory, hostname, records);
  const providerRecords = new Map<string, Record<string, unknown>>(),
    relayDnsToken = "fixture-relay-only-DNS-edit-token";
  const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(init!.headers).toMatchObject({ authorization: `Bearer ${relayDnsToken}` });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)),
        id = randomBytes(16).toString("hex");
      providerRecords.set(id, { id, ...body });
      records.set(id, body.content);
      return Response.json({ success: true, result: { id, ...body } });
    }
    if (init?.method === "DELETE") {
      const id = String(url).split("/").at(-1)!;
      providerRecords.delete(id);
      records.delete(id);
      return Response.json({ success: true, result: { id } });
    }
    return Response.json({ success: true, result: [...providerRecords.values()] });
  });
  const dns = await AcmeDnsChallenges.open({
    file: join(directory, "dns-journal"),
    suffix: "relay.example.test",
    provider: cloudflareDnsProvider({
      zoneId: "a".repeat(32),
      zoneName: "relay.example.test",
      token: relayDnsToken,
      fetch: providerFetch,
    }),
  });
  const accounts = new RelayAccounts(":memory:"),
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      acmeDns: dns,
      allowLoopbackEnrollment: true,
      relayDomain: "relay.example.test",
    });
  const relayUrl = await listen(relay.server);
  relay.dataServer.listen(0, "127.0.0.1");
  await once(relay.dataServer, "listening");
  const publicSni = new GatewayPublicSni();
  const server = createServer(
    { cert: directCertificate, key, SNICallback: publicSni.callback },
    (_req, res) => res.end("gateway-only-plaintext"),
  );
  const gatewayUrl = (await listen(server)).replace("http:", "https:");
  const publicOrigin = `https://${hostname}:${(relay.dataServer.address() as AddressInfo).port}`;
  const sessionFile = join(directory, "session"),
    publicCertificateFile = join(directory, "public.crt");
  const relayRequests: string[] = [];
  const controlFetch: typeof fetch = async (url, init) => {
    expect(new URL(String(url)).origin).toBe(relayUrl);
    expect([
      "/_relay/v2/key/challenge",
      "/_relay/v2/key/complete",
      "/_relay/v2/acme/challenge",
    ]).toContain(new URL(String(url)).pathname);
    relayRequests.push(String(init?.body ?? ""));
    return fetch(url, init);
  };
  const controller = await createGatewayAcmeController(
    {
      OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
      OMNESIS_ACME_TERMS_ACCEPTED: "1",
      OMNESIS_ACME_CERT_FILE: publicCertificateFile,
      OMNESIS_TLS_CERT: tls.certFile,
      OMNESIS_TLS_KEY: tls.keyFile,
      OMNESIS_PUBLIC_BASE_URL: publicOrigin,
      OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
      OMNESIS_CLOUD_RELAY_URL: relayUrl,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    },
    {
      configDir: directory,
      fetch: controlFetch,
      trustedRoots: [authority.root],
      issuer: (options) =>
        issueAcmeCertificate({
          ...options,
          lookup: async (_host, value) => [...records.values()].includes(value),
        }),
      activate: async (material) => {
        publicSni.activate(material);
      },
    },
  );
  const source = gatewayKeySessionSource({
    relayUrl,
    sessionFile,
    gatewayId,
    publicOrigin,
    certificateFile: publicCertificateFile,
    privateKeyFile: `${publicCertificateFile}.key`,
  });
  const tunnel = new GatewayTunnel({ relayUrl, gatewayUrl, gatewayId, session: source });
  try {
    await source();
    tunnel.start();
    expect(await controller!.renew(new AbortController().signal)).toBe(true);
    const port = Number(new URL(gatewayUrl).port),
      fingerprint = new X509Certificate(directCertificate).fingerprint256;
    expect(await peer(port, "localhost", directCertificate)).toBe(fingerprint);
    const publicCertificate = new X509Certificate(await readFile(publicCertificateFile));
    expect(await peer(port, hostname, authority.root)).toBe(publicCertificate.fingerprint256);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        expect(
          await peer((relay.dataServer.address() as AddressInfo).port, hostname, authority.root),
        ).toBe(publicCertificate.fingerprint256);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(controller!.fingerprintSha256()).toBe(
      publicCertificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    );
    expect(await readFile(tls.certFile, "utf8")).toBe(directCertificate);
    expect(await readFile(tls.keyFile, "utf8")).toBe(key);
    expect(records.size).toBe(0);
    expect(authority.requests).toContain("/finalize");
    expect(authority.requests).toContain("/certificate");
    const csr = authority.payloads
      .map((text) => (text ? JSON.parse(text) : {}))
      .find((value) => value.csr)?.csr;
    expect(csr).toBeTruthy();
    const relayBodies = relayRequests.join("\n");
    for (const secret of [
      key,
      await readFile(`${publicCertificateFile}.key`, "utf8"),
      await readFile(`${publicCertificateFile}.acme-account`, "utf8"),
      relayDnsToken,
      csr,
    ])
      expect(relayBodies).not.toContain(secret);
    expect(relayBodies).not.toContain('"csr"');
    expect(relayBodies).not.toContain('"protected"');
    expect(providerFetch).toHaveBeenCalled();

    const publicKey = await readFile(`${publicCertificateFile}.key`, "utf8");
    const stablePublicPin = controller!.spkiFingerprintSha256();
    tlsFiles(directory);
    const renewedDirectCertificate = await readFile(tls.certFile, "utf8"),
      renewedDirectKey = await readFile(tls.keyFile, "utf8");
    server.setSecureContext({ cert: renewedDirectCertificate, key: renewedDirectKey });
    expect(await peer(port, "localhost", renewedDirectCertificate)).toBe(
      new X509Certificate(renewedDirectCertificate).fingerprint256,
    );
    expect(await peer(port, hostname, authority.root)).toBe(publicCertificate.fingerprint256);
    expect(await controller!.renew(new AbortController().signal)).toBe(false);
    expect(controller!.spkiFingerprintSha256()).toBe(stablePublicPin);
    expect(await readFile(`${publicCertificateFile}.key`, "utf8")).toBe(publicKey);
  } finally {
    tunnel.stop();
    await controller?.close();
    await relay.close();
    accounts.close();
    await closeServer(server);
    await authority.close();
  }
});

test("managed setup discovers hosted routing, enrolls without Google, obtains a real ACME leaf and reconnects with unchanged local ownership", async () => {
  const { GatewayCloudRelayManagement } = await import("./management-service.js");
  const { request } = await import("node:https");
  const records = new Map<string, string>();
  const dns = await AcmeDnsChallenges.open({
    file: join(directory, "managed-dns-journal"),
    suffix: "relay.example.test",
    provider: {
      async create(value) {
        records.set(value.id, value.value);
      },
      async remove(value) {
        records.delete(value.id);
      },
    },
  });
  const accounts = new RelayAccounts(":memory:");
  const relay = createCloudRelay({
    accounts,
    sessions: new RelaySessions(randomBytes(32)),
    acmeDns: dns,
    allowLoopbackEnrollment: true,
    relayDomain: "relay.example.test",
  });
  const relayUrl = await listen(relay.server);
  relay.dataServer.listen(0, "127.0.0.1");
  await once(relay.dataServer, "listening");
  const tls = tlsFiles(directory),
    direct = await readFile(tls.certFile, "utf8"),
    key = await readFile(tls.keyFile, "utf8"),
    sni = new GatewayPublicSni();
  let origin = "",
    authority: Awaited<ReturnType<typeof localAcmeAuthority>> | undefined;
  const { getRequestListener } = await import("@hono/node-server");
  const { createDatabase } = await import("../../gateway/src/db.js");
  const { createServer: createGatewayApp } = await import("../../gateway/src/server.js");
  const databaseFile = join(directory, "managed-gateway.sqlite"),
    db = createDatabase(databaseFile);
  const { createNodeWebSocket } = await import("@hono/node-ws");
  const { DeviceWsServer } = await import("../../gateway/src/ws.js");
  const { mountDeviceWsRoute } = await import("../../gateway/src/device-ws-route.js");
  const { directWriteGate } = await import("../../gateway/src/write-gate.js");
  const { createDevice } = await import("../../gateway/src/data/repositories/DeviceRepository.js");
  const { createToken } = await import("../../gateway/src/data/repositories/TokenRepository.js");
  const { makeCommand, PROTOCOL_VERSION } = await import("@omnesis/core");
  const { SCOPE_READ } = await import("@omnesis/types");
  const { WebSocket } = await import("ws");
  const pairedDevice = createDevice(db, { name: "Fictional encrypted CLI", kind: "cli" });
  const pairedToken = createToken(db, pairedDevice.id, [SCOPE_READ]).token;
  const wsServer = new DeviceWsServer({ db, writeGate: directWriteGate(db) });
  let publicSocket: InstanceType<typeof WebSocket> | undefined;
  let manager: Awaited<ReturnType<typeof GatewayCloudRelayManagement.open>> | undefined = undefined;
  const app = createGatewayApp(db, databaseFile, {
    configDir: directory,
    publicBaseUrl: "https://direct.example.test",
    additionalOAuthIssuerUrls: () => (origin ? [origin] : []),
    cloudRelayExposure: () => manager?.isExposing() ?? false,
    wsServer,
  });
  const directApp = createGatewayApp(db, databaseFile, { configDir: directory });
  const server = createServer(
    { cert: direct, key, SNICallback: sni.callback },
    getRequestListener(app.fetch),
  );
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  mountDeviceWsRoute(app, wsServer, upgradeWebSocket);
  injectWebSocket(server);
  const gatewayUrl = (await listen(server)).replace("http:", "https:");
  const login = async (publicPath: boolean): Promise<number> =>
    new Promise((resolve, reject) => {
      const target = new URL(publicPath ? origin : gatewayUrl);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: Number(target.port),
          servername: target.hostname,
          path: "/portal/api/login",
          method: "POST",
          ca: publicPath ? authority!.root : direct,
          headers: {
            host: target.host,
            "content-type": "application/json",
            "x-forwarded-for": "127.0.0.1",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ token: "invalid-isolated-login-token" }));
    });
  manager = await GatewayCloudRelayManagement.open({
    configDir: directory,
    env: {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_URL: relayUrl,
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
    },
    gatewayUrl: () => gatewayUrl,
    directCertificateCoversHostname: (hostname) =>
      new X509Certificate(direct).checkHost(hostname) !== undefined,
    directIdentity: () => ({
      id: "direct",
      names: ["localhost"],
      kind: "self-signed",
      state: "valid",
      pinPolicy: "existing-device-policy",
    }),
    activate: async (material) => sni.activate(material),
    controller: (env, options) =>
      createGatewayAcmeController(env, {
        ...options,
        trustedRoots: [authority!.root],
        issuer: (value) =>
          issueAcmeCertificate({
            ...value,
            lookup: async (_host, digest) => [...records.values()].includes(digest),
          }),
      }),
    probe: async (url, signal) =>
      new Promise<boolean>((resolve, reject) => {
        const target = new URL("/.well-known/oauth-protected-resource/mcp", url);
        const req = request(
          {
            hostname: "127.0.0.1",
            port: Number(target.port),
            path: target.pathname,
            servername: target.hostname,
            headers: { host: target.host },
            ca: authority!.root,
            signal,
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve(res.statusCode === 200 && JSON.parse(text).resource === `${url}/mcp`),
            );
          },
        );
        req.on("error", reject);
        req.end();
      }),
  });
  try {
    const configured = await manager!.configure({ relayUrl, termsAccepted: true });
    origin = configured.publicOrigin!;
    authority = await localAcmeAuthority(directory, new URL(origin).hostname, records);
    await manager!.configure({
      relayUrl,
      acmeDirectoryUrl: authority.directoryUrl,
      termsAccepted: true,
    });
    for (let attempt = 0; attempt < 12; attempt++) expect(await login(false)).not.toBe(429);
    await manager!.enable();
    await vi.waitFor(async () => expect((await manager!.status()).publicMcp.ready).toBe(true), {
      timeout: 15_000,
    });
    publicSocket = new WebSocket(`${origin.replace("https:", "wss:")}/device/ws`, {
      ca: authority.root,
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
      headers: { authorization: `Bearer ${pairedToken}` },
      handshakeTimeout: 5000,
    });
    let upgradeStatus: number | undefined;
    publicSocket.on("upgrade", (response) => {
      upgradeStatus = response.statusCode;
    });
    await once(publicSocket, "open");
    expect(upgradeStatus).toBe(101);
    const hello = makeCommand("hello", { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
    const greeting = once(publicSocket, "message");
    publicSocket.send(JSON.stringify(hello));
    const [message] = await greeting;
    expect(JSON.parse(String(message))).toMatchObject({
      kind: "response",
      correlationId: hello.id,
      ok: true,
      result: { deviceId: pairedDevice.id },
    });
    publicSocket.terminate();
    await once(publicSocket, "close");
    publicSocket = undefined;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) statuses.push(await login(true));
    expect(statuses.at(-1)).toBe(429);
    // Another app in the same process keeps its direct-only exemption, even with reused bindings.
    const sharedBindings = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await directApp.request(
        "https://direct.example.test/portal/api/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "invalid-isolated-login-token" }),
        },
        sharedBindings,
      );
      expect(response.status).not.toBe(429);
    }
    const first = await manager!.status();
    expect(first.enrollment.state).toBe("enrolled");
    expect(first.google.configured).toBe(false);
    expect(first.certificate.state).toBe("valid");
    const expiry = Date.parse(first.certificate.expiresAt!);
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiry - 7 * 86400_000);
    expect((await manager!.status()).certificate.state).toBe("expiring");
    clock.mockReturnValue(expiry + 1);
    expect((await manager!.status()).certificate.state).toBe("expired");
    clock.mockRestore();
    const owner = await readFile(join(directory, "cloud-relay/owner.key")),
      publicKey = await readFile(join(directory, "cloud-relay/public.key"));
    await manager!.disable();
    expect(await login(false)).not.toBe(429);
    expect(await peer(Number(new URL(gatewayUrl).port), "localhost", direct)).toBe(
      new X509Certificate(direct).fingerprint256,
    );
    await manager!.enable();
    await vi.waitFor(async () => expect((await manager!.status()).publicMcp.ready).toBe(true), {
      timeout: 5000,
    });
    expect((await manager!.status()).gatewayId).toBe(first.gatewayId);
    expect(await readFile(join(directory, "cloud-relay/owner.key"))).toEqual(owner);
    expect(await readFile(join(directory, "cloud-relay/public.key"))).toEqual(publicKey);
    expect(records.size).toBe(0);
    expect(authority.requests).toContain("/finalize");
  } finally {
    publicSocket?.terminate();
    wsServer.stop();
    await manager!.close();
    await relay.close();
    accounts.close();
    await closeServer(server);
    await authority?.close();
    await Promise.all([app.close(), directApp.close()]);
    db.close();
  }
});
