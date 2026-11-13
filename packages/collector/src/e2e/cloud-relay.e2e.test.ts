// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import {
  createServer as createTcpServer,
  connect as connectTcp,
  Socket,
  type AddressInfo,
} from "node:net";
import {
  createRelayClientProxy,
  certificateFingerprint,
  tlsSpkiFingerprint,
  hostedGatewayHostname,
} from "@omnesis/cloud-relay";
import { runRelayCommand } from "@omnesis/cloud-relay/runtime";
import {
  GatewayWsClient,
  HttpGatewayClient,
  PAIRED_TRANSPORT_WS_HEARTBEAT_TIMEOUT_MS,
} from "@omnesis/gateway-client";
import {
  defaultScopesForDeviceKind,
  ProviderId,
  SourceId,
  type DocumentInput,
} from "@omnesis/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { registerSubprocessGroup, killSubprocessGroup } from "./subprocess-reaper.js";
import { E2EHarness } from "./harness.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { mockDoc } from "./mock-source.js";
import { getDocumentCount } from "./helpers.js";
import { authorizeMcpClient, revokeAccess, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { lostAckProxy } from "./lost-ack-proxy.js";
import { verifiedLoopbackFetch } from "./verified-tls-fetch.js";

const execFileAsync = promisify(execFile);

describe("native cloud tunnel with real gateway, collector sync engine and CLI", () => {
  let directory: string;
  let relay: RelayProcess;
  let adapter: ReturnType<typeof createRelayClientProxy>;
  let harness: E2EHarness;
  let directGateway: string;
  let proxyUrl: string;
  let adapterUrl: string;
  let faults: Awaited<ReturnType<typeof lostAckProxy>>;
  let publicOrigin: string;
  let gatewayCertificate: string;
  let gatewayAuthorityCertificate: string;
  let wireServer: ReturnType<typeof createTcpServer>;
  const wireSockets = new Set<Socket>();
  const wireChunks: Buffer[] = [];
  const priorCloudRelayEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;
  const gatewayId = randomUUID();
  const gatewayHostname = hostedGatewayHostname(gatewayId, "relay.example.test");

  beforeAll(async () => {
    process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
    directory = await mkdtemp(join(tmpdir(), "omnesis-cloud-e2e-"));
    const keyFile = join(directory, "relay-key");
    const gatewayKeyFile = join(directory, "gateway-key.pem");
    const gatewayCertFile = join(directory, "gateway-cert.pem");
    const authorityKeyFile = join(directory, "authority-key.pem");
    const authorityCertFile = join(directory, "authority-cert.pem");
    const gatewayRequestFile = join(directory, "gateway.csr");
    const gatewayExtensionsFile = join(directory, "gateway.ext");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      authorityKeyFile,
      "-out",
      authorityCertFile,
      "-days",
      "1",
      "-subj",
      "/CN=fictional relay authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await execFileAsync("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      gatewayKeyFile,
      "-out",
      gatewayRequestFile,
      "-subj",
      "/CN=gateway.example.test",
    ]);
    await writeFile(
      gatewayExtensionsFile,
      `subjectAltName=DNS:${gatewayHostname},DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    );
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      gatewayRequestFile,
      "-CA",
      authorityCertFile,
      "-CAkey",
      authorityKeyFile,
      "-CAcreateserial",
      "-out",
      gatewayCertFile,
      "-days",
      "1",
      "-extfile",
      gatewayExtensionsFile,
    ]);
    gatewayAuthorityCertificate = await readFile(authorityCertFile, "utf8");
    gatewayCertificate = await readFile(gatewayCertFile, "utf8");
    await writeFile(keyFile, randomBytes(32));
    relay = await startRelayProcess({
      OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile,
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_CLOUD_RELAY_DB: join(directory, "accounts.sqlite"),
      OMNESIS_CLOUD_RELAY_PORT: "0",
      OMNESIS_CLOUD_RELAY_DOMAIN: "relay.example.test",
    });
    const sessionFile = join(directory, "session.json");
    wireServer = createTcpServer((client) => {
      const upstream = connectTcp({ host: "127.0.0.1", port: relay.dataPort });
      const stop = () => {
        client.destroy();
        upstream.destroy();
      };
      for (const socket of [client, upstream]) {
        wireSockets.add(socket);
        socket.once("close", () => {
          wireSockets.delete(socket);
          stop();
        });
        socket.on("error", stop);
        socket.on("data", (chunk: Buffer) => wireChunks.push(Buffer.from(chunk)));
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    wireServer.listen(0, "127.0.0.1");
    await once(wireServer, "listening");
    publicOrigin = `https://${gatewayHostname}:${(wireServer.address() as AddressInfo).port}`;
    const registration = e2eTsxCommand("packages/cloud-relay/src/main.ts");
    await execFileAsync(registration.command, [...registration.args, "register-key"], {
      env: e2eGatewayEnv({
        OMNESIS_CLOUD_RELAY_ENABLED: "1",
        OMNESIS_CLOUD_RELAY_URL: relay.url,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
        OMNESIS_TLS_CERT: gatewayCertFile,
        OMNESIS_TLS_KEY: gatewayKeyFile,
        OMNESIS_PUBLIC_BASE_URL: publicOrigin,
      }),
      timeout: 15_000,
    });
    expect(JSON.parse(await readFile(sessionFile, "utf8"))).toMatchObject({
      authentication: "gateway-key-v2",
    });
    expect(
      (
        await fetch(`${relay.url}/_relay/v1/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
    adapter = createRelayClientProxy({
      gatewayUrl: publicOrigin,
      gatewayCa: gatewayCertificate,
      gatewayFingerprint: certificateFingerprint(gatewayCertificate),
      gatewayConnectHost: "127.0.0.1",
    });
    adapter.server.listen(0, "127.0.0.1");
    await once(adapter.server, "listening");
    adapterUrl = `http://127.0.0.1:${(adapter.server.address() as AddressInfo).port}`;
    faults = await lostAckProxy(adapterUrl);
    proxyUrl = faults.url;
    harness = new E2EHarness({
      extraGatewayEnv: {
        OMNESIS_CLOUD_RELAY_ENABLED: "1",
        OMNESIS_CLOUD_RELAY_URL: relay.url,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
        OMNESIS_TLS_CERT: gatewayCertFile,
        OMNESIS_TLS_KEY: gatewayKeyFile,
        get OMNESIS_PUBLIC_BASE_URL() {
          return `https://localhost:${harness.gatewayPort}`;
        },
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: publicOrigin,
      },
      gatewayTransport: async (url) => {
        directGateway = url;
        const deadline = Date.now() + 15_000;
        for (;;) {
          const health = await fetch(`${proxyUrl}/health`);
          await health.arrayBuffer();
          if (health.status === 200) return proxyUrl;
          if (Date.now() >= deadline) throw new Error("Gateway tunnel did not register");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
    });
    const source = harness.registerMockSource({
      sourceType: "mock-relay-notes",
      providerType: "mock-relay",
      accountId: "fictional",
    });
    source.setDocuments([
      mockDoc("relay-one", {
        title: "Fictional tunnel note",
        content: "A synthetic note transported through the native cloud tunnel.",
      }),
      mockDoc("relay-two"),
    ]);
    const excluded = harness.registerMockSource({
      sourceType: "mock-relay-private",
      providerType: "mock-relay-private",
      accountId: "fictional",
    });
    excluded.setDocuments([
      mockDoc("relay-denied", {
        title: "Fictional excluded document",
        content: "This synthetic source is excluded from the external agent grant.",
      }),
    ]);
    try {
      await harness.start();
    } catch (error) {
      throw new Error(
        `Synthetic gateway startup failed; WebSocket statuses: ${faults.upgradeStatuses.join(", ")}`,
        { cause: error },
      );
    }
    const roster = await harness.gatewayJson<{
      items: Array<{ id: string; name: string; connectionPath?: string }>;
    }>("/admin/devices");
    const collector = roster.items.find((device) => device.name === "Synthetic E2E collector");
    if (!collector) throw new Error("Synthetic collector registration missing");
    expect(collector.connectionPath).toBe("relay");
    // The mock sync engine advertises descriptors but intentionally does not
    // create inventory rows. Owner-created sources make OAuth grant selection
    // exercise the same registered inventory as a production collector.
    for (const type of ["mock-relay-notes", "mock-relay-private"])
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type,
          accountId: "fictional",
          deviceId: collector.id,
          config: {},
        }),
      });
  }, gatewayBootBudgetMs() + 30_000);

  afterAll(async () => {
    try {
      await harness?.destroy();
    } finally {
      try {
        await faults?.close();
        await adapter?.close();
      } finally {
        for (const socket of wireSockets) socket.destroy();
        if (wireServer?.listening)
          await new Promise<void>((resolve) => wireServer.close(() => resolve()));
        await relay?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
        if (priorCloudRelayEnabled === undefined) delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
        else process.env.OMNESIS_CLOUD_RELAY_ENABLED = priorCloudRelayEnabled;
      }
    }
  }, 30_000);

  test("collector pairs and syncs real documents over relayed HTTP and device WebSocket", async () => {
    expect(harness.gatewayUrl).toBe(proxyUrl);
    await harness.triggerSyncAndWait("mock-relay-notes:fictional");
    expect(await getDocumentCount(proxyUrl, harness.apiKey, "mock-relay-notes:fictional")).toBe(2);
    expect(
      harness
        .getStatus()
        .statuses.find((status) => status.sourceId === "mock-relay-notes:fictional")?.state,
    ).toBe("idle");
  }, 30_000);

  test("a committed upload with a lost acknowledgement retries the same page without duplicate documents or cursor changes", async () => {
    const credential = faults.collector();
    const sourceId = SourceId("mock-relay-notes:fictional"),
      providerId = ProviderId("mock-relay:fictional");
    const client = new HttpGatewayClient(proxyUrl, credential.token);
    const observer = new HttpGatewayClient(adapterUrl, credential.token);
    const before = await observer.getSyncState(sourceId);
    const initialCount = await getDocumentCount(adapterUrl, harness.apiKey, sourceId);
    const wipeEpoch = await client.beginSyncAttempt(sourceId, { attemptId: randomUUID() });
    if (wipeEpoch === undefined)
      throw new Error("Synthetic gateway must support atomic source pages");
    const id = randomUUID(),
      cursor = { page: "lost-ack-page", offset: 3 };
    const document: DocumentInput = {
      ...mockDoc("relay-lost-ack", { title: "Fictional acknowledged-once note" }),
      sourceId,
      providerId,
      metadata: {},
      sourceCreatedAt: "2025-01-01T00:00:00Z",
      sourceUpdatedAt: "2025-01-01T00:00:00Z",
    };
    await client.prepareStructuredPage(sourceId, {
      id,
      writeEpoch: wipeEpoch,
      result: { cursor, hasMore: false, documents: [document] },
    });
    let committed:
      { cursor: unknown; count: number; pendingId?: string; cursorCommitted?: boolean } | undefined;
    faults.arm(id, async () => {
      const state = await observer.getSyncState(sourceId),
        pending = await observer.getPendingStructuredPage(sourceId);
      committed = {
        cursor: state?.cursor,
        count: await getDocumentCount(adapterUrl, harness.apiKey, sourceId),
        pendingId: pending?.id,
        cursorCommitted: pending?.cursorCommitted,
      };
    });
    const result = await client.upsertWithCursor({
      sourceId,
      providerId,
      pendingPageId: id,
      wipeEpoch,
      cursor,
      hasMore: false,
      documents: [document],
    });
    expect(faults.failure()).toBeUndefined();
    expect(result.rejected).not.toBe(true);
    expect(committed).toEqual({
      cursor,
      count: initialCount + 1,
      pendingId: id,
      cursorCommitted: true,
    });
    expect(before?.cursor).not.toEqual(cursor);
    const attempts = faults.attempts.filter((attempt) => attempt.pendingPageId === id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.body).toBe(attempts[1]!.body);
    expect(attempts.map((attempt) => attempt.status)).toEqual([200, 200]);
    const digest = createHash("sha256").update(`Bearer ${credential.token}`).digest("hex");
    expect(attempts.map((attempt) => attempt.authorizationDigest)).toEqual([digest, digest]);
    expect((await observer.getSyncState(sourceId))?.cursor).toEqual(cursor);
    expect(await getDocumentCount(adapterUrl, harness.apiKey, sourceId)).toBe(initialCount + 1);
    const identity = await fetch(adapterUrl + "/whoami", {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect((await identity.json()).deviceId).toBe(credential.deviceId);
    expect(await client.acknowledgeStructuredPage(sourceId, { id, writeEpoch: wipeEpoch })).toEqual(
      { acknowledged: true },
    );
    expect(await client.getPendingStructuredPage(sourceId)).toBeNull();
  }, 30_000);

  test("real CLI uses the relay with its existing gateway token", async () => {
    const command = e2eTsxCommand("packages/cli/src/index.ts");
    const { stdout } = await execFileAsync(command.command, [...command.args, "whoami", "--json"], {
      cwd: join(import.meta.dirname, "../../../.."),
      env: {
        ...process.env,
        OMNESIS_CONFIG_DIR: join(directory, "cli"),
        OMNESIS_GATEWAY_URL: proxyUrl,
        OMNESIS_TOKEN: harness.apiKey,
        OMNESIS_LOG_LEVEL: "error",
      },
      timeout: 20_000,
    });
    expect(JSON.parse(stdout).scopes).toContain("admin");
  });

  test("CLI automatically starts and retires its private paired-device adapter while help needs no cloud configuration", async () => {
    const command = e2eTsxCommand("packages/cli/src/index.ts");
    const file = join(directory, "cli-device.json");
    const paired = await harness.gatewayJson<{ token: string; device: { id: string } }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Synthetic automatic CLI",
          kind: "cli",
          scopes: ["admin", "read"],
        }),
      },
    );
    await writeFile(
      file,
      JSON.stringify({
        gatewayUrl: publicOrigin,
        gatewayFingerprint: certificateFingerprint(gatewayCertificate),
        gatewayCertificate,
        tlsSpkiFingerprint: tlsSpkiFingerprint(gatewayCertificate),
        directCandidates: [],
        token: paired.token,
        deviceId: paired.device.id,
        kind: "cli",
        scopes: ["read"],
      }),
      { mode: 0o600 },
    );
    const guardFile = join(directory, "automatic-cli-network-guard.cjs");
    await writeFile(
      guardFile,
      `
      const net = require("node:net");
      const original = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function(...args) {
        const candidate = Array.isArray(args[0]) ? args[0][0] : args[0];
        const port = typeof candidate === "object" && candidate !== null ? candidate.port : candidate;
        if (Number(port) === 7600) throw new Error("Synthetic CLI must not contact the default gateway port");
        return Reflect.apply(original, this, args);
      };
    `,
    );
    const env = {
      ...e2eGatewayEnv(),
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CONFIG_DIR: join(directory, "automatic-cli"),
      OMNESIS_GATEWAY_URL: undefined,
      OMNESIS_GATEWAY_REQUEST_URL: undefined,
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: file,
      OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP: "127.0.0.1",
      OMNESIS_TOKEN: paired.token,
      OMNESIS_LOG_LEVEL: "error",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(guardFile)}`,
    };
    const result = await execFileAsync(command.command, [...command.args, "whoami", "--json"], {
      env,
      timeout: 20_000,
    });
    expect(JSON.parse(result.stdout).deviceId).toBe(paired.device.id);
    const help = await execFileAsync(command.command, [...command.args, "--help"], {
      env: { ...env, OMNESIS_CLOUD_RELAY_DEVICE_FILE: join(directory, "missing-device.json") },
      timeout: 20_000,
    });
    expect(help.stdout).toContain("omnesis");
    const defaultDir = join(directory, "default-cloud-cli");
    const defaultFile = join(defaultDir, "cloud-relay", "cli-device.json");
    await mkdir(join(defaultDir, "cloud-relay"), { recursive: true, mode: 0o700 });
    await writeFile(defaultFile, await readFile(file), { mode: 0o600 });
    await writeFile(join(defaultDir, "token"), paired.token + "\n", { mode: 0o600 });
    const automatic = {
      ...env,
      OMNESIS_CONFIG_DIR: defaultDir,
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: undefined,
      OMNESIS_TOKEN: undefined,
    };
    const defaultResult = await execFileAsync(
      command.command,
      [...command.args, "whoami", "--json"],
      { env: automatic, timeout: 20_000 },
    );
    expect(JSON.parse(defaultResult.stdout).deviceId).toBe(paired.device.id);
    await writeFile(defaultFile, "malformed old cloud bundle", { mode: 0o600 });
    for (const flag of ["--help", "-V"]) {
      const info = await execFileAsync(command.command, [...command.args, flag], {
        env: automatic,
        timeout: 20_000,
      });
      expect(info.stdout.length).toBeGreaterThan(0);
    }
    const manual = await execFileAsync(command.command, [...command.args, "whoami", "--json"], {
      env: { ...automatic, OMNESIS_GATEWAY_URL: proxyUrl, OMNESIS_TOKEN: harness.apiKey },
      timeout: 20_000,
    });
    expect(JSON.parse(manual.stdout).scopes).toContain("admin");
    expect(await readFile(join(defaultDir, "token"), "utf8")).toBe(paired.token + "\n");
    const collector = await harness.gatewayJson<{
      token: string;
      device: { id: string; kind: string };
    }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "Synthetic automatic collector",
        kind: "collector",
        scopes: ["read"],
      }),
    });
    expect(collector.device.kind).toBe("collector");
    expect(collector.token).not.toBe(paired.token);
    const collectorDir = join(directory, "default-cloud-collector");
    await mkdir(join(collectorDir, "cloud-relay"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(collectorDir, "cloud-relay", "collector-device.json"),
      JSON.stringify({
        ...JSON.parse(await readFile(file, "utf8")),
        token: collector.token,
        deviceId: collector.device.id,
        kind: "collector",
      }),
      { mode: 0o600 },
    );
    await writeFile(join(collectorDir, "collector-token"), collector.token, { mode: 0o600 });
    await writeFile(join(collectorDir, "token"), harness.apiKey, { mode: 0o600 });
    const repoRoot = join(import.meta.dirname, "../../../..");
    const collectorProbe = join(directory, "collector-default-probe.mts");
    await writeFile(
      collectorProbe,
      `
      await import(${JSON.stringify(pathToFileURL(join(repoRoot, "packages/collector/src/load-env.ts")).href)});
      const { readCollectorTokenFile } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "packages/core/src/index.ts")).href)});
      const token = readCollectorTokenFile(process.env.OMNESIS_CONFIG_DIR);
      if (!token || !process.env.OMNESIS_GATEWAY_REQUEST_URL) throw new Error("Collector bootstrap did not select its saved authority");
      const response = await fetch(process.env.OMNESIS_GATEWAY_REQUEST_URL + "/whoami", {headers:{authorization:"Bearer " + token}});
      if (!response.ok) throw new Error("Collector authentication failed");
      process.stdout.write(JSON.stringify(await response.json()) + "\\n");
    `,
    );
    const collectorCommand = e2eTsxCommand(collectorProbe);
    const collectorResult = await execFileAsync(collectorCommand.command, collectorCommand.args, {
      env: { ...automatic, OMNESIS_CONFIG_DIR: collectorDir },
      timeout: 20_000,
    });
    const collectorIdentity = JSON.parse(collectorResult.stdout);
    expect(collectorIdentity.deviceId).toBe(collector.device.id);
    expect(collectorIdentity.deviceId).not.toBe(paired.device.id);
    expect(collectorIdentity.scopes).not.toContain("admin");
    expect(await readFile(join(collectorDir, "token"), "utf8")).toBe(harness.apiKey);
  });

  test("external MCP discovers OAuth, completes PKCE and obeys source grants through public end-to-end TLS", async () => {
    await harness.triggerSyncAndWait("mock-relay-private:fictional");
    const { items: documents } = await harness.gatewayJson<{
      items: Array<{ id: string; title: string; sourceId: string }>;
    }>("/documents/list");
    const allowedDocument = documents.find((item) => item.title === "Fictional tunnel note")!;
    const deniedDocument = documents.find((item) => item.title === "Fictional excluded document")!;
    expect(allowedDocument?.id).toBeTruthy();
    expect(deniedDocument?.id).toBeTruthy();
    const overview = await harness.gatewayJson<{ sources: Array<{ id: string }> }>("/admin/access");
    expect(overview.sources.map((source) => source.id)).toContain(allowedDocument.sourceId);
    const actualFetch = globalThis.fetch;
    await expect(
      verifiedLoopbackFetch(publicOrigin, "", actualFetch)(`${publicOrigin}/health`),
    ).rejects.toThrow();
    const nativeFetch = verifiedLoopbackFetch(
      publicOrigin,
      gatewayAuthorityCertificate,
      actualFetch,
    );
    const requests: Array<{ url: string; relayHeader: boolean }> = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === publicOrigin)
        requests.push({
          url: request.url,
          relayHeader: request.headers.has("x-omnesis-relay-session"),
        });
      const response = await nativeFetch(request);
      if (new URL(request.url).pathname.endsWith("/decision") && !response.ok)
        throw new Error(`Synthetic MCP grant approval refused: ${await response.text()}`);
      return response;
    }) as typeof fetch);
    const firstWireChunk = wireChunks.length;
    let authorized: AuthorizedMcpClient | undefined;
    try {
      const challenge = await fetch(`${publicOrigin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{}",
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain(
        `${publicOrigin}/.well-known/oauth-protected-resource/mcp`,
      );
      await challenge.arrayBuffer();
      authorized = await authorizeMcpClient(
        { gatewayUrl: publicOrigin, apiKey: harness.apiKey },
        {
          principalName: "Fictional relayed MCP client",
          grantName: "Selected synthetic source",
          credentialLabel: "Fictional remote agent",
          capabilities: ["direct"],
          rules: [
            {
              capability: "direct",
              sources: { mode: "allowlist", sourceIds: [allowedDocument.sourceId] },
            },
          ],
        },
      );
      expect(authorized.provider.authorizationUrl?.origin).toBe(publicOrigin);
      expect(authorized.provider.authorizationUrl?.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorized.provider.savedTokens?.access_token).toMatch(/^omn_oat_/);
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toContain(
        "fetch_many",
      );
      const result = await authorized.client.callTool({
        name: "fetch_many",
        arguments: {
          documents: [{ documentId: allowedDocument.id }, { documentId: deniedDocument.id }],
        },
      });
      const items = (result.structuredContent as { items: Array<{ kind: string }> }).items;
      expect(items[0]?.kind).toBe("document");
      expect(items[1]?.kind).toBe("error");
      expect(JSON.stringify(result)).toContain(
        "A synthetic note transported through the native cloud tunnel.",
      );
      expect(JSON.stringify(result)).not.toContain(
        "This synthetic source is excluded from the external agent grant.",
      );
      expect(requests.some((item) => item.url.includes("oauth-protected-resource"))).toBe(true);
      expect(requests.some((item) => item.url.includes("oauth-authorization-server"))).toBe(true);
      expect(requests.every((item) => !item.relayHeader)).toBe(true);
      const ciphertext = Buffer.concat(wireChunks.slice(firstWireChunk));
      expect(ciphertext.length).toBeGreaterThan(1024);
      expect(ciphertext.includes(Buffer.from(gatewayHostname))).toBe(true);
      for (const secret of [
        authorized.provider.savedTokens!.access_token,
        authorized.provider.savedTokens!.refresh_token!,
        authorized.portal.cookie,
        harness.apiKey,
        "A synthetic note transported through the native cloud tunnel.",
      ])
        expect(ciphertext.includes(Buffer.from(secret))).toBe(false);
      await revokeAccess(publicOrigin, authorized.portal, {
        kind: "credential",
        id: authorized.credentialId,
      });
      await expect(authorized.client.listTools()).rejects.toThrow();
    } finally {
      await authorized?.client.close();
      await authorized?.transport.close();
      vi.unstubAllGlobals();
    }
  }, 30_000);

  test("fresh direct MCP OAuth and refresh keep working while the separately configured relay is offline", async () => {
    const documents = await harness.gatewayJson<{ items: Array<{ id: string; title: string }> }>(
      "/documents/list",
    );
    const selected = documents.items.find((item) => item.title === "Fictional tunnel note")!;
    expect(selected).toBeDefined();
    const offline = relay;
    await offline.close();
    const actualFetch = globalThis.fetch;
    const directFetch = verifiedLoopbackFetch(
      directGateway,
      gatewayAuthorityCertificate,
      actualFetch,
    );
    const forbidden: string[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === publicOrigin) {
        forbidden.push(request.url);
        throw new Error("Relay is offline during direct OAuth");
      }
      return directFetch(request);
    }) as typeof fetch);
    let authorized: AuthorizedMcpClient | undefined;
    try {
      const challenge = await fetch(`${directGateway}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{}",
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain(
        `${directGateway}/.well-known/oauth-protected-resource/mcp`,
      );
      await challenge.arrayBuffer();
      authorized = await authorizeMcpClient(
        { gatewayUrl: directGateway, apiKey: harness.apiKey },
        {
          principalName: "Fictional independent direct client",
          grantName: "Direct while relay offline",
          credentialLabel: "Synthetic direct MCP",
          capabilities: ["direct"],
          rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        },
      );
      expect(authorized.provider.authorizationUrl?.origin).toBe(directGateway);
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toContain(
        "fetch_many",
      );
      const result = await authorized.client.callTool({
        name: "fetch_many",
        arguments: { documents: [{ documentId: selected.id }] },
      });
      expect(JSON.stringify(result)).toContain(
        "A synthetic note transported through the native cloud tunnel.",
      );
      const refresh = await fetch(`${directGateway}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: authorized.provider.savedClientInformation!.client_id,
          refresh_token: authorized.provider.savedTokens!.refresh_token!,
        }),
      });
      expect(refresh.status).toBe(200);
      expect((await refresh.json()).access_token).toMatch(/^omn_oat_/);
      expect(forbidden).toEqual([]);
    } finally {
      await authorized?.client.close();
      await authorized?.transport.close();
      vi.unstubAllGlobals();
      relay = await offline.restart();
      await vi.waitFor(
        async () => {
          const response = await fetch(`${proxyUrl}/health`);
          await response.arrayBuffer();
          expect(response.status).toBe(200);
        },
        { timeout: 15_000, interval: 20 },
      );
    }
  }, 30_000);

  test("direct no-Google collector and relay collector share one gateway with independent identities", async () => {
    const command = e2eTsxCommand("packages/collector/src/main.ts");
    const collectors = [
      { name: "fictional-relay-daemon", url: proxyUrl, cloudRelay: "1" },
      { name: "fictional-direct-daemon", url: directGateway, cloudRelay: "0" },
    ].map((topology) => {
      const configDir = join(directory, topology.name);
      const proc = spawn(command.command, command.args, {
        cwd: join(import.meta.dirname, "../../../.."),
        env: {
          ...e2eGatewayEnv(),
          OMNESIS_CLOUD_RELAY_ENABLED: topology.cloudRelay,
          OMNESIS_SYNTHETIC: "1",
          OMNESIS_MDNS_DISABLE: "1",
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_GATEWAY_URL: topology.url,
          OMNESIS_TOKEN: harness.apiKey,
          OMNESIS_COLLECTOR_HOSTNAME: topology.name,
          OMNESIS_TRUST_FINGERPRINT: certificateFingerprint(gatewayCertificate),
          OMNESIS_CLOUD_RELAY_URL: undefined,
          OMNESIS_CLOUD_RELAY_DEVICE_FILE: undefined,
          OMNESIS_LOG_FILE: join(configDir, "collector.log"),
          OMNESIS_LOG_LEVEL: "info",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      registerSubprocessGroup(proc);
      const output = { text: "" };
      const capture = (chunk: Buffer) => {
        output.text = (output.text + chunk.toString()).slice(-16000);
      };
      proc.stdout.on("data", capture);
      proc.stderr.on("data", capture);
      return { ...topology, configDir, proc, output };
    });
    try {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { items } = await harness.gatewayJson<{
          items: Array<{ id: string; name: string; online: boolean }>;
        }>("/admin/devices");
        if (
          collectors.every(
            (collector) =>
              items.some(
                (device) => device.name === `${collector.name}-collector` && device.online,
              ) && collector.output.text.includes("WebSocket authenticated with gateway"),
          )
        )
          break;
        if (
          collectors.some((collector) => collector.proc.exitCode !== null) ||
          Date.now() >= deadline
        )
          throw new Error(
            `Mixed collectors did not connect: ${collectors.map((collector) => collector.output.text).join("\n")}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const identities: Array<{ deviceId: string; token: string; url: string }> = [];
      for (const collector of collectors) {
        const token = (await readFile(join(collector.configDir, "collector-token"), "utf8")).trim();
        expect(token).not.toBe(harness.apiKey);
        const response = await fetch(`${collector.url}/whoami`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const identity = (await response.json()) as { deviceId: string; scopes: string[] };
        expect(identity.scopes).not.toContain("admin");
        expect(
          (
            await fetch(`${collector.url}/admin/devices`, {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(403);
        identities.push({ deviceId: identity.deviceId, token, url: collector.url });
      }
      expect(identities[0]!.deviceId).not.toBe(identities[1]!.deviceId);
      expect(identities[0]!.token).not.toBe(identities[1]!.token);
      // Revoking the direct node cannot revoke or upgrade the relay node's independent permission.
      await harness.gatewayJson(`/admin/devices/${identities[1]!.deviceId}`, { method: "DELETE" });
      expect(
        (
          await fetch(`${identities[1]!.url}/whoami`, {
            headers: { authorization: `Bearer ${identities[1]!.token}` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${identities[0]!.url}/whoami`, {
            headers: { authorization: `Bearer ${identities[0]!.token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      for (const collector of collectors) await killSubprocessGroup(collector.proc);
    }
  }, 30_000);

  test("a paired device uses the home network at home, continues through the relay when home goes silent, and returns when it is back", async () => {
    // The gateway advertises this home address itself, as a Docker host's recorded network. It
    // exists nowhere: inside this process only, dialling it reaches a forwarder to the gateway,
    // or, once the device has "left", reaches nothing at all, with no refusal.
    const homeAddress = "192.168.77.10";
    let away = false;
    let homeDials = 0;
    let homeConnections = 0;
    let relayConnections = 0;
    const countRelay = (): void => {
      relayConnections++;
    };
    wireServer.on("connection", countRelay);
    const forwarded = new Set<Socket>();
    const forwarder = createTcpServer((client) => {
      homeConnections++;
      const upstream = connectTcp({ host: "127.0.0.1", port: harness.gatewayPort });
      for (const socket of [client, upstream]) {
        forwarded.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => {
          forwarded.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    forwarder.listen(0, "127.0.0.1");
    await once(forwarder, "listening");
    const homePort = (forwarder.address() as AddressInfo).port;
    const leaveHome = (): void => {
      away = true;
      // Established connections fall silent too: no bytes, no close, in either direction.
      for (const socket of forwarded) {
        socket.unpipe();
        socket.pause();
      }
    };
    const originalConnect = Socket.prototype.connect;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
      if (typeof first === "object" && first !== null && "host" in first) {
        const target = first as { host?: string };
        if (target.host === homeAddress) {
          homeDials++;
          // Dropped packets: the connection attempt is never answered.
          if (away) return this;
          target.host = "127.0.0.1";
        }
      }
      return Reflect.apply(originalConnect, this, args) as Socket;
    } as typeof Socket.prototype.connect;
    const { configDir } = harness as unknown as { configDir: string };
    const hostNetworkFile = join(configDir, "host-network");
    await writeFile(hostNetworkFile, `port ${homePort}\ninterface eth0 ${homeAddress}\n`);
    const paired = await harness.gatewayJson<{ token: string; device: { id: string } }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Synthetic travelling collector",
          kind: "collector",
          scopes: defaultScopesForDeviceKind("collector"),
        }),
      },
    );
    // Paired away from home: the device file holds no home address yet.
    const deviceFile = join(directory, "travelling-device.json");
    await writeFile(
      deviceFile,
      JSON.stringify({
        gatewayUrl: publicOrigin,
        gatewayFingerprint: certificateFingerprint(gatewayCertificate),
        gatewayCertificate,
        tlsSpkiFingerprint: tlsSpkiFingerprint(gatewayCertificate),
        directCandidates: [],
        token: paired.token,
        deviceId: paired.device.id,
        kind: "collector",
        scopes: ["read"],
      }),
      { mode: 0o600 },
    );
    const transport = (await runRelayCommand("client", {
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: deviceFile,
      OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
      OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP: "127.0.0.1",
    }))!;
    const socket = new GatewayWsClient(transport.url, paired.token, {
      reconnectDelay: 200,
      heartbeatTimeoutMs: PAIRED_TRANSPORT_WS_HEARTBEAT_TIMEOUT_MS,
    });
    const whoami = async (): Promise<number> => {
      const started = Date.now();
      const response = await fetch(`${transport.url}/whoami`, {
        headers: { authorization: `Bearer ${paired.token}` },
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { deviceId: string }).deviceId).toBe(paired.device.id);
      return Date.now() - started;
    };
    const socketPath = async (expected: "local" | "relay", budgetMs: number): Promise<number> => {
      const started = Date.now();
      for (;;) {
        const { items } = await harness.gatewayJson<{
          items: Array<{ id: string; online: boolean; connectionPath?: string }>;
        }>("/admin/devices");
        const device = items.find((item) => item.id === paired.device.id);
        if (device?.online && device.connectionPath === expected && socket.isAuthenticated())
          return Date.now() - started;
        if (Date.now() - started > budgetMs)
          throw new Error(
            `Device socket did not reach the ${expected} route: ${JSON.stringify(device)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      // The one check at start learned the home address from the gateway over the relay, saved
      // it for the next start, and found it reachable.
      expect(JSON.parse(await readFile(deviceFile, "utf8")).directCandidates).toEqual([
        { address: homeAddress, port: homePort },
      ]);
      let relayBefore = relayConnections;
      let homeBefore = homeConnections;
      await whoami();
      expect(homeConnections).toBe(homeBefore + 1);
      expect(relayConnections).toBe(relayBefore);
      socket.connect();
      await socketPath("local", 10_000);

      leaveHome();
      // A request made right after leaving waits once for the silent home address, then
      // completes through the relay.
      relayBefore = relayConnections;
      expect(await whoami()).toBeLessThan(5_000);
      expect(relayConnections).toBeGreaterThan(relayBefore);
      // The device socket, silent on the home route, is released and reconnects on the relay.
      await socketPath("relay", 25_000);
      // Away is now known: requests no longer try the home address at all.
      homeBefore = homeDials;
      for (let index = 0; index < 3; index++) await whoami();
      // At most one background check can have looked for home meanwhile.
      expect(homeDials - homeBefore).toBeLessThanOrEqual(1);

      // Home again: the periodic check finds it and moves the socket and new requests back.
      away = false;
      await socketPath("local", 25_000);
      homeBefore = homeConnections;
      relayBefore = relayConnections;
      await whoami();
      expect(homeConnections).toBe(homeBefore + 1);
      expect(relayConnections).toBe(relayBefore);
    } finally {
      socket.disconnect();
      await transport.close();
      Socket.prototype.connect = originalConnect;
      wireServer.off("connection", countRelay);
      for (const held of forwarded) held.destroy();
      await new Promise<void>((resolve) => forwarder.close(() => resolve()));
      await rm(hostNetworkFile, { force: true });
      await harness.gatewayJson(`/admin/devices/${paired.device.id}`, { method: "DELETE" });
    }
  }, 120_000);

  test("a relay daemon restart preserves account routing and the gateway reconnects automatically", async () => {
    const countBeforeRestart = await getDocumentCount(
      proxyUrl,
      harness.apiKey,
      "mock-relay-notes:fictional",
    );
    const url = relay.url;
    relay = await relay.restart();
    expect(relay.url).toBe(url);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response = await fetch(`${proxyUrl}/whoami`, {
        headers: { authorization: `Bearer ${harness.apiKey}` },
      });
      await response.arrayBuffer();
      if (response.status === 200) break;
      if (Date.now() >= deadline) throw new Error("Gateway did not reconnect after relay restart");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await getDocumentCount(proxyUrl, harness.apiKey, "mock-relay-notes:fictional")).toBe(
      countBeforeRestart,
    );
  }, 30_000);

  test("relay identity does not authorize gateway access, and direct access coexists", async () => {
    expect((await fetch(`${proxyUrl}/whoami`)).status).toBe(401);
    expect(
      (
        await fetch(`${proxyUrl}/whoami`, {
          headers: { authorization: "Bearer invalid-fixture" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${directGateway}/whoami`, {
          headers: { authorization: `Bearer ${harness.apiKey}` },
        })
      ).status,
    ).toBe(200);
  });

  test("remote relay traffic does not inherit local portal-login rate-limit exemptions", async () => {
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${proxyUrl}/portal/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "fictional-invalid-token" }),
      });
      attempts.push(response.status);
      await response.arrayBuffer();
    }
    // Earlier successful MCP owner sign-in also consumes this shared IP budget.
    expect(attempts).toContain(401);
    expect(attempts.every((status) => status === 401 || status === 429)).toBe(true);
    expect(attempts[10]).toBe(429);
  });
});

interface RelayProcess {
  url: string;
  dataPort: number;
  close(): Promise<void>;
  restart(): Promise<RelayProcess>;
}

async function startRelayProcess(env: NodeJS.ProcessEnv): Promise<RelayProcess> {
  const command = e2eTsxCommand("packages/cloud-relay/src/main.ts");
  const proc: ChildProcess = spawn(command.command, [...command.args, "serve"], {
    cwd: join(import.meta.dirname, "../../../.."),
    env: { ...e2eGatewayEnv(), ...env, OMNESIS_LOG_LEVEL: "info" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerSubprocessGroup(proc);
  try {
    const ready = await new Promise<{ url: string; dataPort: number }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Relay daemon did not become ready: ${output}`)),
        15000,
      );
      const inspect = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-16000);
        const match = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        const data = /TLS passthrough port (\d+)/.exec(output);
        if (match && data) {
          clearTimeout(timer);
          resolve({ url: match[1], dataPort: Number(data[1]) });
        }
      };
      proc.stdout!.on("data", inspect);
      proc.stderr!.on("data", inspect);
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Relay exited ${code}: ${output}`));
      });
    });
    return {
      ...ready,
      close: async () => {
        await killSubprocessGroup(proc);
      },
      restart: async () => {
        await killSubprocessGroup(proc);
        return startRelayProcess({
          ...env,
          OMNESIS_CLOUD_RELAY_PORT: new URL(ready.url).port,
          OMNESIS_CLOUD_RELAY_DATA_PORT: String(ready.dataPort),
        });
      },
    };
  } catch (error) {
    await killSubprocessGroup(proc);
    throw error;
  }
}
