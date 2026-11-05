// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  createRelayClientProxy,
  certificateFingerprint,
  RelayAccounts,
  RelaySessions,
  createCloudRelay,
  registerGatewayKey,
} from "@omnesis/cloud-relay";
import { recoveryFixture } from "../../../cloud-relay/test/recovery-fixture.js";
import { until } from "../../../cloud-relay/test/support.js";
import { E2EHarness } from "./harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { mockDoc } from "./mock-source.js";
import { getDocumentCount } from "./helpers.js";
import { authorizeMcpClient, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { verifiedLoopbackFetch } from "./verified-tls-fetch.js";

/** Stable logical endpoints with replaceable isolated backends model a new VPS/IP, not restored relay state. */
async function bridge(record = false) {
  let target: number | undefined;
  const sockets = new Set<Socket>(),
    chunks: Buffer[] = [];
  const server = createServer((client) => {
    if (target === undefined) {
      client.destroy();
      return;
    }
    const upstream = connect(target, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.once("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
      if (record) socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    chunks,
    setTarget(value: number | undefined) {
      target = value;
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  "empty relay rebuild rotates routing credentials automatically while stable gateway TLS, devices, MCP and direct access survive",
  async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-wipe-"));
    const control = await bridge(),
      data = await bridge(true),
      logicalRelay = `http://127.0.0.1:${control.port}`,
      publicOrigin = `https://gateway.example.test:${data.port}`;
    let relay: ReturnType<typeof createCloudRelay> | undefined,
      accounts: RelayAccounts | undefined,
      harness: E2EHarness | undefined,
      adapter: ReturnType<typeof createRelayClientProxy> | undefined,
      directAdapter: ReturnType<typeof createRelayClientProxy> | undefined,
      mcp: AuthorizedMcpClient | undefined;
    const database = join(directory, "relay.sqlite"),
      f = await recoveryFixture(directory, logicalRelay, publicOrigin);
    const sessionFile = join(directory, "gateway-session.json"),
      ownerKeyFile = join(directory, "owner.key"),
      receiptFile = join(directory, "receipt.json");
    const originalFetch = globalThis.fetch;
    try {
      await writeFile(ownerKeyFile, f.owner.privateKey, { mode: 0o600 });
      await writeFile(receiptFile, JSON.stringify(f.receipt()), { mode: 0o600 });
      const startRelay = async () => {
        accounts = new RelayAccounts(database);
        relay = createCloudRelay({
          accounts,
          sessions: new RelaySessions(randomBytes(32)),
          controlOrigin: logicalRelay,
          hostnameProof: () => Promise.resolve(true),
          recoveryPolicy: f.policy(),
        });
        relay.server.listen(0, "127.0.0.1");
        relay.dataServer.listen(0, "127.0.0.1");
        await Promise.all([once(relay.server, "listening"), once(relay.dataServer, "listening")]);
        control.setTarget((relay.server.address() as AddressInfo).port);
        data.setTarget((relay.dataServer.address() as AddressInfo).port);
      };
      await startRelay();
      const keyOptions = {
        relayUrl: logicalRelay,
        sessionFile,
        ownerKeyFile,
        recoveryReceiptFile: receiptFile,
        gatewayId: f.registration.gatewayId,
        publicOrigin,
        certificateFile: f.files.certFile,
        privateKeyFile: f.files.keyFile,
      };
      expect((await registerGatewayKey(keyOptions)).accountId).toBe(f.account);
      adapter = createRelayClientProxy({
        gatewayUrl: publicOrigin,
        gatewayCa: f.registration.certificate,
        gatewayFingerprint: certificateFingerprint(f.registration.certificate),
        gatewayConnectHost: "127.0.0.1",
      });
      adapter.server.listen(0, "127.0.0.1");
      await once(adapter.server, "listening");
      const adapterUrl = `http://127.0.0.1:${(adapter.server.address() as AddressInfo).port}`;
      let directUrl = "";
      harness = new E2EHarness({
        extraGatewayEnv: {
          OMNESIS_EXPERIMENTAL: "1",
          OMNESIS_CLOUD_RELAY_URL: logicalRelay,
          OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
          OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerKeyFile,
          OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE: receiptFile,
          OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.registration.gatewayId,
          OMNESIS_TLS_CERT: f.files.certFile,
          OMNESIS_TLS_KEY: f.files.keyFile,
          OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: publicOrigin,
          get OMNESIS_PUBLIC_BASE_URL() {
            return `https://localhost:${harness!.gatewayPort}`;
          },
        },
        gatewayTransport: async (url) => {
          directUrl = url;
          await until(async () => {
            try {
              const response = await fetch(adapterUrl + "/health");
              await response.arrayBuffer();
              return response.status === 200;
            } catch {
              return false;
            }
          }, 15_000);
          return adapterUrl;
        },
      });
      const sourceId = "mock-recovery-notes:fictional",
        source = harness.registerMockSource({
          sourceType: "mock-recovery-notes",
          providerType: "mock-recovery",
          accountId: "fictional",
        });
      source.setDocuments([
        mockDoc("recovery-one", {
          title: "Fictional recovery note",
          content: "Synthetic gateway data survives a relay database wipe.",
        }),
      ]);
      await harness.start();
      await harness.triggerSyncAndWait(sourceId);
      expect(await getDocumentCount(adapterUrl, harness.apiKey, sourceId)).toBe(1);
      const roster = await harness.gatewayJson<{
          items: Array<{ id: string; name: string; online: boolean }>;
        }>("/admin/devices"),
        collector = roster.items.find((item) => item.name === "Synthetic E2E collector")!;
      expect(collector.online).toBe(true);
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "mock-recovery-notes",
          accountId: "fictional",
          deviceId: collector.id,
          config: {},
        }),
      });
      directAdapter = createRelayClientProxy({
        gatewayUrl: directUrl,
        gatewayCa: f.registration.certificate,
        gatewayFingerprint: certificateFingerprint(f.registration.certificate),
      });
      directAdapter.server.listen(0, "127.0.0.1");
      await once(directAdapter.server, "listening");
      const directRequestUrl = `http://127.0.0.1:${(directAdapter.server.address() as AddressInfo).port}`;
      const directDevice = await (
        await fetch(directRequestUrl + "/admin/devices", {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Fictional independent direct collector",
            kind: "collector",
            scopes: ["read"],
          }),
        })
      ).json();
      vi.stubGlobal(
        "fetch",
        verifiedLoopbackFetch(publicOrigin, f.registration.certificate, originalFetch),
      );
      mcp = await authorizeMcpClient(
        { gatewayUrl: publicOrigin, apiKey: harness.apiKey },
        {
          principalName: "Fictional recovery MCP agent",
          grantName: "Synthetic recovery access",
          credentialLabel: "Recovery test client",
          capabilities: ["direct"],
          rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        },
      );
      const oauthToken = mcp.provider.savedTokens?.access_token;
      expect(oauthToken).toBeTruthy();
      expect((await mcp.client.listTools()).tools.length).toBeGreaterThan(0);
      const preWipeSession = JSON.parse(await readFile(sessionFile, "utf8"));
      expect(preWipeSession.expiresAt).toBeGreaterThan(Date.now() / 1000 + 300);
      const hashes = await Promise.all(
        [ownerKeyFile, f.files.keyFile, f.files.certFile, receiptFile].map(async (file) =>
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ),
      );
      // Destroy the database and all relay memory, then use an independently keyed empty relay on new ports.
      control.setTarget(undefined);
      data.setTarget(undefined);
      await relay!.close();
      accounts!.close();
      relay = undefined;
      accounts = undefined;
      for (const suffix of ["", "-wal", "-shm"]) await rm(database + suffix, { force: true });
      const directResponse = await fetch(directRequestUrl + "/whoami", {
        headers: { authorization: `Bearer ${directDevice.token}` },
      });
      expect(directResponse.status).toBe(200);
      expect((await directResponse.json()).deviceId).toBe(directDevice.device.id);
      await startRelay();
      expect(accounts!.gatewayBinding(f.account)).toBeUndefined();
      expect(accounts!.googleAccountForOwner(f.account)).toBeUndefined();
      expect(
        (
          await fetch(logicalRelay + "/_relay/v2/gateway", {
            headers: { authorization: `Bearer ${preWipeSession.token}` },
          })
        ).status,
      ).toBe(401);
      await until(async () => {
        try {
          const next = JSON.parse(await readFile(sessionFile, "utf8"));
          return (
            next.token !== preWipeSession.token &&
            accounts!.gatewayBinding(f.account)?.gatewayId === f.registration.gatewayId
          );
        } catch {
          return false;
        }
      }, 20_000);
      await until(async () => {
        try {
          const response = await fetch(adapterUrl + "/whoami", {
            headers: { authorization: `Bearer ${harness!.apiKey}` },
          });
          await response.arrayBuffer();
          return response.status === 200;
        } catch {
          return false;
        }
      }, 20_000);
      await until(async () => {
        const result = await harness!.gatewayJson<{
          items: Array<{ id: string; online: boolean }>;
        }>("/admin/devices");
        return result.items.find((item) => item.id === collector.id)?.online === true;
      }, 20_000);
      source.setDocuments([
        mockDoc("recovery-one"),
        mockDoc("recovery-two", {
          title: "Fictional post-recovery note",
          content: "A second synthetic upload after automatic routing recovery.",
        }),
      ]);
      const result = await harness.gatewayJson<{ ok: boolean }>(
        `/admin/sources/${encodeURIComponent(sourceId)}/sync`,
        { method: "POST", body: "{}" },
      );
      expect(result.ok).toBe(true);
      await harness.waitForSyncComplete(sourceId);
      expect(await getDocumentCount(adapterUrl, harness.apiKey, sourceId)).toBe(2);
      expect((await mcp.client.listTools()).tools.length).toBeGreaterThan(0);
      const documents = await harness.gatewayJson<{ items: Array<{ id: string; title: string }> }>(
        "/documents/list",
      );
      const recoveredDocument = documents.items.find(
        (document) => document.title === "Fictional post-recovery note",
      );
      expect(recoveredDocument).toBeDefined();
      const retrieved = await mcp.client.callTool({
        name: "fetch_many",
        arguments: { documents: [{ documentId: recoveredDocument!.id }] },
      });
      expect(
        (retrieved.structuredContent as { items: Array<{ kind: string }> }).items[0]?.kind,
      ).toBe("document");
      expect(mcp.provider.savedTokens?.access_token).toBe(oauthToken);
      expect(
        await Promise.all(
          [ownerKeyFile, f.files.keyFile, f.files.certFile, receiptFile].map(async (file) =>
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          ),
        ),
      ).toEqual(hashes);
      expect(accounts!.gatewayBinding(f.account)?.publicOrigin).toBe(publicOrigin);
      const wire = Buffer.concat(data.chunks).toString("latin1");
      for (const secret of [
        harness.apiKey,
        directDevice.token,
        "Fictional recovery note",
        "Synthetic gateway data survives a relay database wipe.",
        "A second synthetic upload after automatic routing recovery.",
      ])
        expect(wire).not.toContain(secret);
    } finally {
      await mcp?.client.close();
      await mcp?.transport.close();
      vi.unstubAllGlobals();
      await harness?.destroy();
      await adapter?.close();
      await directAdapter?.close();
      control.setTarget(undefined);
      data.setTarget(undefined);
      await relay?.close();
      accounts?.close();
      await control.close();
      await data.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  gatewayBootBudgetMs() + 90_000,
);
