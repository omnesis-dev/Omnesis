// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  SCOPE_WRITE_ALL,
  defaultScopesForDeviceKind,
  DEVICE_KINDS,
  Scope,
  writeScope,
  type DeviceId,
  type DeviceKind,
} from "@omnesis/types";
import { AccountId, SourceId, SourceType } from "@omnesis/types";
import {
  PROTOCOL_VERSION,
  PAIRING_PROTOCOL_VERSION,
  SOURCE_CONTRACT_WIRE_RANGE,
} from "@omnesis/core";
import { computeSnapshotAbsencePlan, createDatabase, getSyncState, getWipeEpoch } from "./db.js";
import { LATEST_SCHEMA_VERSION } from "./data/migrations.js";
import { createServer } from "./server.js";
import {
  addSourceMember,
  createSource,
  getSource,
  listSourceMembers,
  markSourceRemoved,
} from "./data/repositories/SourceRepository.js";
import {
  createDevice,
  createPairing,
  peekPairing,
  updateDeviceCapabilities,
} from "./data/repositories/DeviceRepository.js";
import { initializeOrAssertSourceMemberConfigContract } from "./data/repositories/SourceMemberConfigContractRepository.js";
import { createSession, createToken, lookupToken } from "./data/repositories/TokenRepository.js";
import { directWriteGate, type WriteGate } from "./write-gate.js";
import { DEFAULT_SEARCH_PARAMS, DEFAULT_SEARCH_BOOSTS } from "./search/search-config.js";
import type { IComputeScheduler } from "./http/services/ports.js";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { unlinkSync, existsSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SearchPipeline } from "./search/pipeline.js";
import type { McpHttpRuntime } from "./http/routes/mcp-streamable.js";
import type { DeviceWsServer } from "./ws.js";
import {
  connectCollectorDeclarations,
  resetConnectedCollectorDeclarations,
} from "./collector-declaration-roster.js";
import { ConfigStore } from "./config-store.js";
import { authorizeInteractiveAccess } from "./access/test-utils.js";
import { MCP_ACCESS_SCOPE } from "./access/types.js";
import { STALE_DEVICE_REVOCATION_IMPACT_ERROR } from "./access/agent-device-authorization.js";

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let TEST_TOKEN: string;
let DECLARATION_TOKEN: string | null;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function storedSessionRowId(db: Db, sessionId: string): string {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return db
    .prepare<[string], { id: string }>("SELECT id FROM sessions WHERE session_hash = ?")
    .get(sessionHash)!.id;
}

/**
 * Helper: create a device + token with the given scopes. Uses a unique name
 * so it can be called many times per test.
 */
function mintToken(
  scopes: readonly Scope[],
  kind: DeviceKind = "cli",
): { deviceId: DeviceId; token: string } {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind });
  const { token } = createToken(db, dev.id, scopes);
  return { deviceId: dev.id, token };
}

function req(path: string, options: RequestInit = {}) {
  const declarationWrite =
    options.method === "POST" &&
    [
      "/admin/link-declarations",
      "/admin/url-canonicalizers",
      "/admin/url-graph-roles",
      "/admin/url-hub-sources",
      "/admin/known-url-patterns",
    ].includes(path);
  if (declarationWrite && DECLARATION_TOKEN === null) {
    const declarationDevice = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL], "collector");
    connectCollectorDeclarations(declarationDevice.deviceId);
    DECLARATION_TOKEN = declarationDevice.token;
  }
  return app.request(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${declarationWrite ? DECLARATION_TOKEN : TEST_TOKEN}`,
      ...options.headers,
    },
  });
}

function makeDocPayload(externalId = "msg-1", providerId = "google", sourceId = "gmail") {
  return {
    providerId,
    sourceId,
    externalId,
    title: "Test Email",
    content: "# Hello",
    contentHash: `hash-${externalId}`,
    metadata: { author: "alice@example.com" },
    sourceCreatedAt: "2024-01-15T10:00:00Z",
    sourceUpdatedAt: "2024-01-15T10:00:00Z",
  };
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-server-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  // Full-scope token used by the shared `req` helper.
  TEST_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]).token;
  DECLARATION_TOKEN = null;
  app = createServer(db);
});

afterEach(() => {
  resetConnectedCollectorDeclarations();
  db.close();
  cleanupDb(dbPath);
});

test("transport admission rejects requests before route services run", async () => {
  const admission = vi.fn(() => Promise.resolve(new Response("shutting down", { status: 503 })));
  const draining = createServer(db, undefined, { requestAdmission: admission });
  expect((await draining.request("/health")).status).toBe(503);
  expect((await draining.request("/ws", { headers: { Upgrade: "websocket" } })).status).toBe(503);
  expect(admission).toHaveBeenCalledTimes(2);
});

test("production server wires analytics adoption into an exclusive to partitioned PATCH", async () => {
  const { AnalyticsDb } = await import("./analytics-db.js");
  const analyticsPath = `/tmp/omnesis-mode-transition-${randomUUID()}.duckdb`;
  const analyticsDb = new AnalyticsDb(analyticsPath);
  await analyticsDb.open();
  const owner = createDevice(db, {
    name: "transition-host",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: ["notes-synth"],
      multiDeviceModes: { "notes-synth": "partitioned" },
      memberScopedParams: { "notes-synth": [] },
      syncLease: true,
    },
  });
  const source = createSource(db, {
    type: SourceType("notes-synth"),
    accountId: AccountId("fictional-transition"),
    deviceId: owner.id,
    multiDeviceMode: "exclusive",
  });
  await analyticsDb.ingestPage({
    tableName: "transition_metrics",
    records: [{ id: "metric-1", value: 7 }],
    schema: {
      tableName: "transition_metrics",
      displayName: "Transition metrics",
      description: "Synthetic transition metrics",
      columns: [
        { name: "id", type: "VARCHAR", description: "Stable id" },
        { name: "value", type: "BIGINT", description: "Synthetic value" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
    },
    sourceId: source.id,
  });
  const withAnalytics = createServer(db, undefined, { analyticsDb });

  try {
    const response = await withAnalytics.request(
      `/admin/sources/${encodeURIComponent(source.id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ multiDeviceMode: "partitioned" }),
      },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).source.multiDeviceMode).toBe("partitioned");
    expect(
      (await analyticsDb.executeQuery("SELECT id, _stream_id FROM transition_metrics")).rows,
    ).toEqual([["metric-1", owner.id]]);
  } finally {
    await analyticsDb.close();
    cleanupDb(analyticsPath);
    if (existsSync(`${analyticsPath}.wal`)) unlinkSync(`${analyticsPath}.wal`);
  }
});

describe("mode-transition config publication ordering", () => {
  async function raceFixture() {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-mode-config-race-${randomUUID()}.duckdb`;
    const configDir = `/tmp/omnesis-mode-config-race-${randomUUID()}`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const configStore = new ConfigStore({
      filePath: `${configDir}/omnesis.json`,
      watchDebounceMs: 40,
    });
    await configStore.load();
    const owner = createDevice(db, {
      name: "transition-config-host",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: ["notes-synth"],
        multiDeviceModes: { "notes-synth": "partitioned" },
        memberScopedParams: { "notes-synth": [] },
        syncLease: true,
      },
    });
    const source = createSource(db, {
      type: SourceType("notes-synth"),
      accountId: AccountId("fictional-config-race"),
      deviceId: owner.id,
      multiDeviceMode: "exclusive",
      config: { syncInterval: "5m" },
    });
    await configStore.put({
      sources: { [source.id]: { enabled: true, syncInterval: "5m" } },
    });

    let releaseFirstUpdate!: () => void;
    let markFirstUpdateEntered!: () => void;
    const firstUpdateEntered = new Promise<void>((resolve) => {
      markFirstUpdateEntered = resolve;
    });
    const firstUpdateGate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const realUpdate = configStore.update.bind(configStore);
    let updateCount = 0;
    vi.spyOn(configStore, "update").mockImplementation(async (transform) => {
      updateCount += 1;
      if (updateCount === 1) {
        markFirstUpdateEntered();
        await firstUpdateGate;
      }
      return realUpdate(transform);
    });
    const raceApp = createServer(db, undefined, { analyticsDb, configStore });
    const request = (path: string, method: string, body?: unknown) =>
      raceApp.request(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const cleanup = async () => {
      configStore.stop();
      await analyticsDb.close();
      rmSync(configDir, { recursive: true, force: true });
      cleanupDb(analyticsPath);
      if (existsSync(`${analyticsPath}.wal`)) unlinkSync(`${analyticsPath}.wal`);
    };
    return {
      source,
      configStore,
      request,
      firstUpdateEntered,
      releaseFirstUpdate,
      cleanup,
    };
  }

  test("a delayed transition publication cannot overwrite a newer source config PATCH", async () => {
    const fixture = await raceFixture();
    try {
      const transition = fixture.request(
        `/admin/sources/${encodeURIComponent(fixture.source.id)}`,
        "PATCH",
        { multiDeviceMode: "partitioned" },
      );
      await fixture.firstUpdateEntered;
      expect(getSource(db, fixture.source.id)?.multiDeviceMode).toBe("partitioned");

      const patch = await fixture.request(
        `/admin/sources/${encodeURIComponent(fixture.source.id)}`,
        "PATCH",
        { config: { syncInterval: "15m" } },
      );
      expect(patch.status).toBe(200);
      fixture.releaseFirstUpdate();
      expect((await transition).status).toBe(200);

      expect(fixture.configStore.get().sources?.[fixture.source.id]?.syncInterval).toBe("15m");
    } finally {
      fixture.releaseFirstUpdate();
      await fixture.cleanup();
    }
  });

  test("a delayed transition publication cannot recreate a deleted source config", async () => {
    const fixture = await raceFixture();
    try {
      const transition = fixture.request(
        `/admin/sources/${encodeURIComponent(fixture.source.id)}`,
        "PATCH",
        { multiDeviceMode: "partitioned" },
      );
      await fixture.firstUpdateEntered;
      expect(getSource(db, fixture.source.id)?.multiDeviceMode).toBe("partitioned");

      const removal = await fixture.request(
        `/admin/sources/${encodeURIComponent(fixture.source.id)}`,
        "DELETE",
      );
      expect(removal.status).toBe(200);
      fixture.releaseFirstUpdate();
      // The transition request observes the concurrent deletion when it
      // prepares its response; the publication still must not resurrect it.
      expect((await transition).status).toBe(404);

      expect(getSource(db, fixture.source.id)).toBeNull();
      expect(fixture.configStore.get().sources?.[fixture.source.id]).toBeUndefined();
    } finally {
      fixture.releaseFirstUpdate();
      await fixture.cleanup();
    }
  });
});

describe("health endpoint", () => {
  test("returns ok + product version without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("exposes the public feature gate and compat subset", async () => {
    const res = await app.request("/health");
    const body = (await res.json()) as {
      experimental: boolean;
      compat: { schema: number; ws: number; pairing: number; watchPrivacyPolicy: number };
    };
    expect(typeof body.experimental).toBe("boolean");
    expect(body.compat.schema).toBe(LATEST_SCHEMA_VERSION);
    expect(body.compat.ws).toBe(PROTOCOL_VERSION);
    expect(body.compat.pairing).toBe(PAIRING_PROTOCOL_VERSION);
    expect(body.compat.watchPrivacyPolicy).toBe(1);
  });

  test("advertises experimental visibility and the subscriptions capability without auth", async () => {
    const originalExperimental = process.env.OMNESIS_EXPERIMENTAL;
    const originalSynthetic = process.env.OMNESIS_SYNTHETIC;
    try {
      delete process.env.OMNESIS_EXPERIMENTAL;
      delete process.env.OMNESIS_SYNTHETIC;
      const off = await (await app.request("/health")).json();
      expect(off.experimental).toBe(false);
      // A harness reads this before it holds any token: it is what decides
      // whether the installed skill and plugin offer Watch tools at all.
      expect(off.capabilities).toEqual({
        subscriptions: false,
        sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
      });

      process.env.OMNESIS_EXPERIMENTAL = "1";
      const on = await (await app.request("/health")).json();
      expect(on.experimental).toBe(true);
      expect(on.capabilities).toEqual({
        subscriptions: true,
        sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
      });
    } finally {
      if (originalExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = originalExperimental;
      if (originalSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
      else process.env.OMNESIS_SYNTHETIC = originalSynthetic;
    }
  });
});

describe("generally available MCP", () => {
  test("constructs Direct in production mode", async () => {
    const previousExperimental = process.env.OMNESIS_EXPERIMENTAL;
    const previousSynthetic = process.env.OMNESIS_SYNTHETIC;
    const analyticsPath = `/tmp/omnesis-mcp-ga-analytics-${randomUUID()}.db`;
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsDb = new AnalyticsDb(analyticsPath);
    let runtime: McpHttpRuntime | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    const privateResource = "https://private.example.net:7600/mcp";
    try {
      process.env.OMNESIS_EXPERIMENTAL = "0";
      delete process.env.OMNESIS_SYNTHETIC;
      await analyticsDb.open();
      const authorized = authorizeInteractiveAccess(db, {
        selection: {
          kind: "new-principal",
          principalName: "Direct MCP server test",
          grantName: "Whole-corpus Direct",
          rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
          credentialLabel: "Server test credential",
          expiresAt: null,
        },
        resource: privateResource,
        scope: MCP_ACCESS_SCOPE,
      });
      const accessToken = authorized.tokens.accessToken;
      const notePrincipalCredentialUsage = vi.fn();
      const gaApp = createServer(db, undefined, {
        analyticsDb,
        searchPipeline: {} as SearchPipeline,
        principalCredentialUsageBuffer: {
          note: notePrincipalCredentialUsage,
          drain: () => [],
          restore: () => {},
          size: () => 0,
        },
        publicBaseUrl: "https://omnesis.test",
        mcpResourceUrls: [privateResource],
        onMcpHttpRuntime: (value) => {
          runtime = value;
        },
      });
      transport = new StreamableHTTPClientTransport(new URL(privateResource), {
        authProvider: { token: async () => accessToken },
        fetch: (input, init) => gaApp.fetch(new Request(input, init)),
      });
      client = new Client(
        { name: "mcp-ga-server-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("run_sql");
      expect(notePrincipalCredentialUsage).toHaveBeenCalledWith(authorized.credentialId);
      const siblingAudience = await gaApp.request("https://omnesis.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "audience-isolation-test", version: "1.0.0" },
          },
        }),
      });
      expect(siblingAudience.status).toBe(401);
    } finally {
      await Promise.allSettled([
        ...(client ? [client.close()] : []),
        ...(transport ? [transport.close()] : []),
        ...(runtime ? [runtime.close()] : []),
      ]);
      await analyticsDb.close();
      cleanupDb(analyticsPath);
      if (previousExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previousExperimental;
      if (previousSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
      else process.env.OMNESIS_SYNTHETIC = previousSynthetic;
    }
  });
});

describe("compat manifest endpoint", () => {
  test("returns 401 without auth", async () => {
    const res = await app.request("/admin/compat");
    expect(res.status).toBe(401);
  });

  test("returns 403 for a non-admin token", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const res = await app.request("/admin/compat", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test("returns the full manifest for an admin token", async () => {
    const res = await req("/admin/compat");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      productVersion: string;
      stores: { mainDb: { policy: string; version: number } };
      protocols: { ws: number; pairing: number };
      httpApi: { versionedUrl: string | null };
    };
    expect(body.productVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.stores.mainDb).toEqual({
      policy: "numbered-migrations",
      version: LATEST_SCHEMA_VERSION,
    });
    expect(body.protocols.ws).toBe(PROTOCOL_VERSION);
    expect(body.protocols.pairing).toBe(PAIRING_PROTOCOL_VERSION);
    expect(body.httpApi.versionedUrl).toBeNull();
  });
});

describe("whoami endpoint", () => {
  test("returns 401 without auth", async () => {
    const res = await app.request("/whoami");
    expect(res.status).toBe(401);
  });

  test("returns token + device + scopes for a read-only token", async () => {
    const dev = createDevice(db, { name: "agent-laptop", kind: "cli" });
    const { id: tokenId, token } = createToken(db, dev.id, [SCOPE_READ]);

    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokenId: string;
      deviceId: string;
      deviceName: string;
      scopes: string[];
    };
    expect(body.tokenId).toBe(tokenId);
    expect(body.deviceId).toBe(dev.id);
    expect(body.deviceName).toBe("agent-laptop");
    expect(body.scopes).toEqual([SCOPE_READ]);
  });

  test("admin token sees admin scope in whoami", async () => {
    const { token } = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toContain(SCOPE_ADMIN);
    expect(body.scopes).toContain(SCOPE_READ);
  });
});

describe("auth middleware", () => {
  test("rejects requests without auth header", async () => {
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects requests with wrong key", async () => {
    const res = await app.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts requests with correct key", async () => {
    const res = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(200);
  });

  test("a malformed sourceId on ingest is refused as a bad request, not an internal error", async () => {
    // The ingest body schema admits any non-empty string here, so a malformed
    // id reaches the write-scope check before anything else looks at it.
    // Branding it there threw an error this layer does not classify, which the
    // top-level handler turned into a sanitized 500 — telling the client
    // nothing and putting "unhandled error" in the operator's journal for what
    // is a client mistake.
    const res = await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            providerId: "example",
            sourceId: "NOT A SOURCE ID",
            externalId: "e1",
            title: "t",
            content: "c",
            contentHash: "h",
            sourceCreatedAt: "2026-01-01T00:00:00.000Z",
            sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
            metadata: {},
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).not.toBe("INTERNAL_ERROR");
    // Named by the check that refused it, not by the body schema — the schema
    // admits this id, which is why the check has to be the one to say no.
    expect(body.error).toBe("Invalid sourceId: NOT A SOURCE ID");
  });

  test("the analytics ingest shares that gate, so it answers the same way", async () => {
    // Same push gate, a different route and a different ordering ahead of it.
    // Two paths reach one throw, so exercising either alone leaves the other
    // free to stop reaching it.
    const res = await req("/analytics/ingest", {
      method: "POST",
      // A body the schema accepts, so the gate is what answers. Named `table`,
      // it is refused by validation instead and the gate is never reached —
      // which a bare status assertion cannot tell apart.
      body: JSON.stringify({ tableName: "t", sourceId: "NOT A SOURCE ID", records: [] }),
    });
    expect(res.status).toBe(400);
    // The same message as its sibling: a 400 from body-schema validation would
    // satisfy a bare status assertion with the gate removed.
    expect((await res.json()).error).toBe("Invalid sourceId: NOT A SOURCE ID");
  });

  test("portal routes do not require auth", async () => {
    const res = await app.request("/portal/");
    // Should not return 401 — portal is auth-exempt
    expect(res.status).not.toBe(401);
  });

  test("portal assets are served with Cache-Control: no-cache so updates aren't masked by stale caches", async () => {
    const res = await app.request("/portal/");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    // A weak ETag must still be present so the no-cache revalidation can
    // short-circuit to a 304 when the file is unchanged.
    expect(res.headers.get("ETag")).toMatch(/^W\//);
  });

  test("API routes still require auth when portal is exempt", async () => {
    const res = await app.request("/documents/count/gmail");
    expect(res.status).toBe(401);
  });

  test("accepts requests with valid token from DB", async () => {
    const { token } = mintToken([SCOPE_WRITE_ALL]);
    const res = await app.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(200);
  });

  test("read-only token cannot access write routes", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const res = await app.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(403);
  });

  test("read-only token can access read routes", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const res = await app.request("/documents/count/gmail", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("write:<type> token can push docs of that type only", async () => {
    const { token } = mintToken([writeScope(SourceType("gmail"))]);
    // gmail — allowed
    const okRes = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [makeDocPayload("gm-1")] }),
    });
    expect(okRes.status).toBe(200);

    // calendar — forbidden
    const bad = { ...makeDocPayload("cal-1"), sourceId: "calendar" };
    const badRes = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [bad] }),
    });
    expect(badRes.status).toBe(403);
  });

  test("repairs an older browser token before accepting unified web captures", async () => {
    const { token } = mintToken([Scope("write:extension-dom")], "browser");
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        documents: [makeDocPayload("browser-page", "web", "web")],
      }),
    });

    expect(res.status).toBe(200);
    expect(lookupToken(db, token)?.scopes).toContain(writeScope(SourceType("web")));
  });

  test("fails closed when hosted-scope reconciliation cannot persist", async () => {
    const { token } = mintToken([Scope("write:extension-dom")], "browser");
    const failingApp = createServer(db, undefined, {
      writeGate: {
        ...directWriteGate(db),
        reconcileDeviceTokenScopes: async () => {
          throw new Error("fictional writer outage");
        },
      },
    });

    const res = await failingApp.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        documents: [makeDocPayload("unrepaired-browser-page", "web", "web")],
      }),
    });

    expect(res.status).toBe(403);
    expect(lookupToken(db, token)?.scopes).not.toContain(writeScope(SourceType("web")));
  });

  test("browser scope repair grants web access only", async () => {
    const { token } = mintToken([Scope("write:extension-dom")], "browser");
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        documents: [makeDocPayload("not-a-browser-page", "google", "gmail")],
      }),
    });

    expect(res.status).toBe(403);
    const scopes = lookupToken(db, token)?.scopes ?? [];
    expect(scopes).toContain(writeScope(SourceType("web")));
    expect(scopes).not.toContain(writeScope(SourceType("gmail")));
  });

  test("an admin token may ingest without an explicit write scope, like every other write route", async () => {
    const { token } = mintToken([SCOPE_ADMIN, SCOPE_READ]);
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [makeDocPayload("msg-x")] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 1 });
  });

  test("source-scoped write token cannot delete another source's documents", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [{ ...makeDocPayload("cal-1"), sourceId: "google-calendar" }],
      }),
    });

    const { token } = mintToken([writeScope(SourceType("gmail"))]);
    const res = await app.request("/documents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "google",
        sourceId: "google-calendar",
        externalIds: ["cal-1"],
      }),
    });
    expect(res.status).toBe(403);

    const countRes = await req("/documents/count/google-calendar");
    expect(((await countRes.json()) as { count: number }).count).toBe(1);
  });

  test("document reconcile requires a matching write scope", async () => {
    const readOnly = mintToken([SCOPE_READ]);
    const readRes = await app.request("/documents/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readOnly.token}` },
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: [],
      }),
    });
    expect(readRes.status).toBe(403);

    const gmailWriter = mintToken([writeScope(SourceType("gmail"))]);
    const mismatchRes = await app.request("/documents/reconcile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gmailWriter.token}`,
      },
      body: JSON.stringify({
        providerId: "google",
        sourceId: "google-calendar",
        presentExternalIds: [],
      }),
    });
    expect(mismatchRes.status).toBe(403);
  });

  test("source-scoped write token cannot mutate another source via cursor or sync-state writes", async () => {
    const { token } = mintToken([writeScope(SourceType("gmail"))]);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const syncStateRes = await app.request("/sync-state/google-calendar", {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: { syncToken: "abc" } }),
    });
    expect(syncStateRes.status).toBe(403);

    const cursorRes = await app.request("/documents/with-cursor", {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "google",
        sourceId: "google-calendar",
        hasMore: false,
        cursor: { syncToken: "abc" },
      }),
    });
    expect(cursorRes.status).toBe(403);

    const state = await (await req("/sync-state/google-calendar")).json();
    expect(state).toEqual({ cursor: null, lastSyncedAt: null, wipeEpoch: 0 });
  });

  test("source-scoped write token cannot wipe another source or an entire provider", async () => {
    const { token } = mintToken([writeScope(SourceType("gmail"))]);
    const headers = { Authorization: `Bearer ${token}` };

    const sourceRes = await app.request("/documents/delete-all/source/google-calendar", {
      method: "POST",
      headers,
    });
    expect(sourceRes.status).toBe(403);

    const providerRes = await app.request("/documents/delete-all/provider/google", {
      method: "POST",
      headers,
    });
    expect(providerRes.status).toBe(403);
  });

  test("analytics ingest requires matching source scope or broad write when sourceId is absent", async () => {
    const { token } = mintToken([writeScope(SourceType("gmail"))]);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const otherSource = await app.request("/analytics/ingest", {
      method: "POST",
      headers,
      body: JSON.stringify({
        tableName: "health_samples",
        records: [],
        sourceId: "apple-health:local",
      }),
    });
    expect(otherSource.status).toBe(403);

    const sourceLess = await app.request("/analytics/ingest", {
      method: "POST",
      headers,
      body: JSON.stringify({ tableName: "legacy_table", records: [] }),
    });
    expect(sourceLess.status).toBe(403);

    const schema = {
      tableName: "gmail_dynamic",
      displayName: "Gmail dynamic",
      description: "Synthetic dynamic table",
      columns: [{ name: "id", type: "VARCHAR", description: "Row id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    for (const dynamic of [
      { ...schema, dynamicColumns: true },
      {
        ...schema,
        columns: [{ ...schema.columns[0], sourceColumnId: "upstream:user-controlled-column" }],
      },
    ]) {
      const response = await app.request("/analytics/ingest", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tableName: "gmail_dynamic",
          records: [],
          sourceId: "gmail",
          schema: dynamic,
        }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("a joined collector whose member contract changed cannot write documents or analytics", async () => {
    const type = SourceType("visits-synth");
    const capabilities = {
      hostableSourceTypes: [type],
      multiDeviceModes: { [type]: "partitioned" as const },
      memberScopedParams: { [type]: ["sessionsPath"] },
      syncLease: true,
    };
    const owner = createDevice(db, {
      name: `contract-owner-${randomUUID()}`,
      kind: "collector",
      capabilities,
    });
    const member = createDevice(db, {
      name: `contract-member-${randomUUID()}`,
      kind: "collector",
      capabilities,
    });
    const source = createSource(db, {
      type,
      accountId: AccountId("contract-write-fence"),
      deviceId: owner.id,
      multiDeviceMode: "partitioned",
    });
    addSourceMember(db, source.id, member.id);
    initializeOrAssertSourceMemberConfigContract(db, source.id, ["sessionsPath"]);
    updateDeviceCapabilities(db, member.id, {
      ...capabilities,
      memberScopedParams: { [type]: [] },
    });
    const token = createToken(db, member.id, [writeScope(type)]).token;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const documents = await app.request("/documents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        documents: [makeDocPayload("contract-row", type, source.id)],
      }),
    });
    expect(documents.status).toBe(409);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM documents WHERE source_id = ?").get(source.id),
    ).toEqual({ count: 0 });

    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-contract-analytics-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    try {
      const analytics = await withAnalytics.request("/analytics/ingest", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tableName: "contract_rows",
          sourceId: source.id,
          schema: {
            tableName: "contract_rows",
            displayName: "Contract rows",
            description: "Synthetic rows used to verify member contract fencing",
            columns: [{ name: "id", type: "VARCHAR", description: "Synthetic row id" }],
            primaryKey: ["id"],
          },
          records: [{ id: "contract-row" }],
        }),
      });
      expect(analytics.status).toBe(409);
      expect(
        (
          await analyticsDb.executeQuery(
            "SELECT table_name FROM information_schema.tables WHERE table_name = 'contract_rows'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await analyticsDb.close();
      cleanupDb(analyticsPath);
    }
  });

  test("a scoped analytics write preserves and rejects its stale supplied epoch", async () => {
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const type = SourceType("gmail");
    const writer = mintToken([writeScope(type)], "collector");
    const source = createSource(db, {
      type,
      accountId: AccountId(`epoch-${randomUUID()}@example.com`),
      deviceId: writer.deviceId,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${writer.token}`,
    };
    const begin = async () =>
      (
        (await (
          await app.request(`/sync-state/${source.id}/begin`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).json()) as { wipeEpoch: number }
      ).wipeEpoch;
    const staleEpoch = await begin();
    const currentEpoch = await begin();

    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const ingest = (writeEpoch: number, id: string) =>
      withAnalytics.request("/analytics/ingest", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tableName: "gmail_epoch_rows",
          sourceId: source.id,
          schema: {
            tableName: "gmail_epoch_rows",
            displayName: "Epoch rows",
            description: "Rows used to verify stale epoch fencing",
            columns: [{ name: "id", type: "VARCHAR", description: "Row id" }],
            primaryKey: ["id"],
          },
          records: [{ id }],
          writeEpoch,
        }),
      });
    try {
      expect(await (await ingest(staleEpoch, "stale")).json()).toMatchObject({ ingested: 0 });
      expect(await (await ingest(currentEpoch, "current")).json()).toMatchObject({ ingested: 1 });
      expect((await analyticsDb.executeQuery("SELECT id FROM gmail_epoch_rows")).rows).toEqual([
        ["current"],
      ]);
    } finally {
      await analyticsDb.close();
      for (const suffix of ["", ".wal"]) {
        if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
      }
    }
  });

  test("source registry and process-wide source metadata pushes reject narrow write tokens", async () => {
    const { token } = mintToken([writeScope(SourceType("gmail"))], "collector");
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const bulkUpsert = await app.request("/devices/sources/bulk-upsert", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sources: [{ type: "google-calendar", accountId: "local", enabled: true }],
      }),
    });
    expect(bulkUpsert.status).toBe(403);

    const processWide = await app.request("/admin/source-prior-defaults", {
      method: "POST",
      headers,
      body: JSON.stringify({ entries: [{ sourceIdPrefix: "gmail", weight: 0.1 }] }),
    });
    expect(processWide.status).toBe(403);
  });

  test("/admin/* requires admin scope", async () => {
    const readOnly = mintToken([SCOPE_READ]);
    const r = await app.request("/admin/devices", {
      headers: { Authorization: `Bearer ${readOnly.token}` },
    });
    expect(r.status).toBe(403);

    const adminTok = mintToken([SCOPE_ADMIN]);
    const r2 = await app.request("/admin/devices", {
      headers: { Authorization: `Bearer ${adminTok.token}` },
    });
    expect(r2.status).toBe(200);
  });
});

describe("GET /admin/sources — pushBased derivation", () => {
  test("phone-hosted and descriptor-declared push sources are push-based", async () => {
    const ios = mintToken([SCOPE_ADMIN], "ios");
    updateDeviceCapabilities(db, ios.deviceId, {
      hostableSourceTypes: ["apple-health"],
      pushBasedSourceTypes: ["apple-health"],
      multiDeviceModes: { "apple-health": "replicated" },
      replicaVersionPolicies: { "apple-health": "source-updated-at" },
      syncLease: true,
    });
    const collector = createDevice(db, {
      name: "collector-with-push-descriptor",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("browser"), SourceType("gmail")],
        pushBasedSourceTypes: [SourceType("browser")],
      },
    });

    const create = (type: string, accountId: string, deviceId: string) =>
      req("/admin/sources", {
        method: "POST",
        body: JSON.stringify({ type, accountId, deviceId, enabled: true }),
      });

    expect((await create("apple-health", "local", ios.deviceId)).status).toBe(200);
    expect((await create("browser", "local", collector.id)).status).toBe(200);
    expect((await create("gmail", "me@example.com", collector.id)).status).toBe(200);

    const res = await req("/admin/sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ type: string; pushBased?: boolean }>;
    };
    expect(body.items.find((s) => s.type === "apple-health")?.pushBased).toBe(true);
    expect(body.items.find((s) => s.type === "browser")?.pushBased).toBe(true);
    expect(body.items.find((s) => s.type === "gmail")?.pushBased).toBe(false);
  });

  test("browser device self-registered sources are push-based", async () => {
    const { token } = mintToken([writeScope(SourceType("browser"))], "browser");
    const doc = {
      ...makeDocPayload("browser-page-1"),
      providerId: "browser",
      sourceId: "browser",
      title: "Example browser page",
      metadata: { url: "https://example.com/articles/browser-capture" },
    };
    const ingest = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [doc] }),
    });
    expect(ingest.status).toBe(200);

    const res = await req("/admin/sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ type: string; pushBased?: boolean }>;
    };
    expect(body.items.find((s) => s.type === "browser")?.pushBased).toBe(true);
  });
});

describe("device management endpoints", () => {
  test("an in-flight mobile source mutation is refused when repair rotates its pairing", async () => {
    const device = createDevice(db, {
      name: "fictional-phone",
      kind: "ios",
      installId: "fictional-install-source-race",
      capabilities: {
        hostableSourceTypes: ["activity-segments"],
        pushBasedSourceTypes: ["activity-segments"],
        multiDeviceModes: { "activity-segments": "partitioned" },
      },
    });
    const oldCredential = createToken(db, device.id, [SCOPE_ADMIN]);
    const source = createSource(db, {
      type: SourceType("activity-segments"),
      accountId: AccountId("local"),
      deviceId: device.id,
      multiDeviceMode: "partitioned",
    });
    const pairing = createPairing(db, {
      kind: "ios",
      scopes: [SCOPE_ADMIN],
      repairDeviceId: device.id,
    });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const gated: WriteGate = {
      ...base,
      moveSource: async (id, patch) => {
        entered.resolve();
        await release.promise;
        return base.moveSource(id, patch);
      },
    };
    const racedApp = createServer(db, undefined, { writeGate: gated });

    const mutation = racedApp.request(`/admin/sources/${encodeURIComponent(source.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${oldCredential.token}`,
        "Content-Type": "application/json",
        "omnesis-pairing-generation": oldCredential.id,
      },
      body: JSON.stringify({ enabled: false, deviceId: device.id }),
    });
    await entered.promise;

    const repaired = await racedApp.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: pairing.pairingCode,
        capabilities: {
          installId: "fictional-install-source-race",
          suggestedName: "fictional-phone",
          platform: "ios",
          hostableSourceTypes: ["activity-segments"],
          pushBasedSourceTypes: ["activity-segments"],
          multiDeviceModes: { "activity-segments": "partitioned" },
        },
      }),
    });
    expect(repaired.status).toBe(200);
    const replacement = (await repaired.json()) as { token: string; tokenId: string };
    release.resolve();

    const response = await mutation;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_PAIRING" });
    expect(getSource(db, source.id)?.enabled).toBe(true);
    expect(lookupToken(db, oldCredential.token)).toBeNull();
    expect(lookupToken(db, replacement.token)?.id).toBe(replacement.tokenId);
  });

  test("an in-flight mobile mode transition cannot start after pairing repair", async () => {
    const capabilities = {
      installId: "fictional-install-transition-race",
      suggestedName: "fictional-transition-phone",
      platform: "ios",
      hostableSourceTypes: ["activity-segments"],
      pushBasedSourceTypes: ["activity-segments"],
      multiDeviceModes: { "activity-segments": "partitioned" as const },
    };
    const device = createDevice(db, {
      name: capabilities.suggestedName,
      kind: "ios",
      installId: capabilities.installId,
      capabilities,
    });
    const oldCredential = createToken(db, device.id, [SCOPE_ADMIN]);
    const source = createSource(db, {
      type: SourceType("activity-segments"),
      accountId: AccountId("local"),
      deviceId: device.id,
      multiDeviceMode: "exclusive",
    });
    const pairing = createPairing(db, {
      kind: "ios",
      scopes: [SCOPE_ADMIN],
      repairDeviceId: device.id,
    });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const racedApp = createServer(db, undefined, {
      // The stale fence fires before adoption; a presence-only analytics seam
      // is sufficient to construct the production transition coordinator.
      analyticsDb: {} as never,
      writeGate: {
        ...base,
        prepareSourceModeTransition: async (...args) => {
          entered.resolve();
          await release.promise;
          return base.prepareSourceModeTransition(...args);
        },
      },
    });

    const mutation = racedApp.request(`/admin/sources/${encodeURIComponent(source.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${oldCredential.token}`,
        "Content-Type": "application/json",
        "omnesis-pairing-generation": oldCredential.id,
      },
      body: JSON.stringify({ multiDeviceMode: "partitioned" }),
    });
    await entered.promise;
    const repaired = await racedApp.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: pairing.pairingCode, capabilities }),
    });
    expect(repaired.status).toBe(200);
    release.resolve();

    const response = await mutation;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_PAIRING" });
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_mode_transitions").get()).toEqual({ n: 0 });
  });

  test("an in-flight mobile source removal cannot land after pairing repair", async () => {
    const sourceType = SourceType("apple-health");
    const capabilities = {
      installId: "fictional-install-remove-race",
      suggestedName: "fictional-remove-phone",
      platform: "ios",
      hostableSourceTypes: [sourceType],
      pushBasedSourceTypes: [sourceType],
      multiDeviceModes: { [sourceType]: "replicated" as const },
      replicaVersionPolicies: { [sourceType]: "source-updated-at" as const },
      syncLease: true,
    };
    const device = createDevice(db, {
      name: capabilities.suggestedName,
      kind: "ios",
      installId: capabilities.installId,
      capabilities,
    });
    const siblingCapabilities = {
      ...capabilities,
      installId: "fictional-install-remove-sibling",
      suggestedName: "fictional-remove-tablet",
    };
    const sibling = createDevice(db, {
      name: siblingCapabilities.suggestedName,
      kind: "ios",
      installId: siblingCapabilities.installId,
      capabilities: siblingCapabilities,
    });
    const scopes = [SCOPE_ADMIN, writeScope(sourceType)];
    const oldCredential = createToken(db, device.id, scopes);
    const siblingCredential = createToken(db, sibling.id, scopes);
    const source = createSource(db, {
      type: sourceType,
      accountId: AccountId("local"),
      deviceId: device.id,
      multiDeviceMode: "replicated",
      replicaVersionPolicy: "source-updated-at",
    });
    addSourceMember(db, source.id, sibling.id);
    const pairing = createPairing(db, {
      kind: "ios",
      scopes,
      repairDeviceId: device.id,
    });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const racedApp = createServer(db, undefined, {
      writeGate: {
        ...base,
        removeSource: async (...args) => {
          entered.resolve();
          await release.promise;
          return base.removeSource(...args);
        },
      },
    });
    const mutation = racedApp.request(`/admin/sources/${encodeURIComponent(source.id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${oldCredential.token}`,
        "omnesis-pairing-generation": oldCredential.id,
      },
    });
    expect(
      (
        await racedApp.request(`/sync-state/${encodeURIComponent(source.id)}/lease`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${oldCredential.token}`,
            "Content-Type": "application/json",
            "omnesis-pairing-generation": oldCredential.id,
          },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    await entered.promise;
    expect(
      (
        await racedApp.request("/devices/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingCode: pairing.pairingCode, capabilities }),
        })
      ).status,
    ).toBe(200);
    release.resolve();

    const response = await mutation;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_PAIRING" });
    expect(getSource(db, source.id)).not.toBeNull();
    const siblingClaim = await racedApp.request(
      `/sync-state/${encodeURIComponent(source.id)}/lease`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${siblingCredential.token}`,
          "Content-Type": "application/json",
          "omnesis-pairing-generation": siblingCredential.id,
        },
        body: "{}",
      },
    );
    expect(siblingClaim.status).toBe(200);
    expect(await siblingClaim.json()).toMatchObject({ granted: false, holder: device.id });
  });

  test("an in-flight mobile bulk registration cannot land after pairing repair", async () => {
    const capabilities = {
      installId: "fictional-install-bulk-race",
      suggestedName: "fictional-bulk-phone",
      platform: "ios",
      hostableSourceTypes: ["activity-segments"],
      pushBasedSourceTypes: ["activity-segments"],
      multiDeviceModes: { "activity-segments": "partitioned" as const },
    };
    const device = createDevice(db, {
      name: capabilities.suggestedName,
      kind: "ios",
      installId: capabilities.installId,
      capabilities,
    });
    const scopes = [SCOPE_ADMIN, writeScope(SourceType("activity-segments"))];
    const oldCredential = createToken(db, device.id, scopes);
    const pairing = createPairing(db, { kind: "ios", scopes, repairDeviceId: device.id });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const racedApp = createServer(db, undefined, {
      writeGate: {
        ...base,
        createSource: async (opts) => {
          entered.resolve();
          await release.promise;
          return base.createSource(opts);
        },
      },
    });
    const mutation = racedApp.request("/devices/sources/bulk-upsert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oldCredential.token}`,
        "Content-Type": "application/json",
        "omnesis-pairing-generation": oldCredential.id,
      },
      body: JSON.stringify({
        sources: [{ type: "activity-segments", accountId: "local", enabled: true }],
      }),
    });
    await entered.promise;
    expect(
      (
        await racedApp.request("/devices/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingCode: pairing.pairingCode, capabilities }),
        })
      ).status,
    ).toBe(200);
    release.resolve();

    const response = await mutation;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_PAIRING" });
    expect(getSource(db, SourceId("activity-segments:local"))).toBeNull();
  });

  test("a refused stale detach keeps the member's replicated sync lease", async () => {
    const sourceType = SourceType("apple-health");
    const capabilities = (installId: string, suggestedName: string) => ({
      installId,
      suggestedName,
      platform: "ios",
      hostableSourceTypes: [sourceType],
      pushBasedSourceTypes: [sourceType],
      multiDeviceModes: { [sourceType]: "replicated" as const },
      replicaVersionPolicies: { [sourceType]: "source-updated-at" as const },
      syncLease: true,
    });
    const firstCaps = capabilities("fictional-install-detach-race", "fictional-health-phone");
    const first = createDevice(db, {
      name: firstCaps.suggestedName,
      kind: "ios",
      installId: firstCaps.installId,
      capabilities: firstCaps,
    });
    const secondCaps = capabilities("fictional-install-health-sibling", "fictional-health-tablet");
    const second = createDevice(db, {
      name: secondCaps.suggestedName,
      kind: "ios",
      installId: secondCaps.installId,
      capabilities: secondCaps,
    });
    const scopes = [SCOPE_ADMIN, writeScope(sourceType)];
    const oldCredential = createToken(db, first.id, scopes);
    const secondCredential = createToken(db, second.id, scopes);
    const source = createSource(db, {
      type: sourceType,
      accountId: AccountId("local"),
      deviceId: first.id,
      multiDeviceMode: "replicated",
      replicaVersionPolicy: "source-updated-at",
    });
    addSourceMember(db, source.id, second.id);
    const pairing = createPairing(db, { kind: "ios", scopes, repairDeviceId: first.id });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const racedApp = createServer(db, undefined, {
      writeGate: {
        ...base,
        removeSourceMember: async (...args) => {
          entered.resolve();
          await release.promise;
          return base.removeSourceMember(...args);
        },
      },
    });
    const firstHeaders = {
      Authorization: `Bearer ${oldCredential.token}`,
      "Content-Type": "application/json",
      "omnesis-pairing-generation": oldCredential.id,
    };
    expect(
      (
        await racedApp.request(`/sync-state/${encodeURIComponent(source.id)}/lease`, {
          method: "POST",
          headers: firstHeaders,
          body: "{}",
        })
      ).status,
    ).toBe(200);

    const detach = racedApp.request(
      `/admin/sources/${encodeURIComponent(source.id)}/members/${first.id}`,
      { method: "DELETE", headers: firstHeaders },
    );
    await entered.promise;
    expect(
      (
        await racedApp.request("/devices/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingCode: pairing.pairingCode, capabilities: firstCaps }),
        })
      ).status,
    ).toBe(200);
    release.resolve();
    expect((await detach).status).toBe(409);

    const siblingClaim = await racedApp.request(
      `/sync-state/${encodeURIComponent(source.id)}/lease`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secondCredential.token}`,
          "Content-Type": "application/json",
          "omnesis-pairing-generation": secondCredential.id,
        },
        body: "{}",
      },
    );
    expect(siblingClaim.status).toBe(200);
    expect(await siblingClaim.json()).toMatchObject({ granted: false, holder: first.id });
    expect(listSourceMembers(db, source.id).map((member) => member.deviceId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test("an in-flight self-revoke cannot revoke a newly repaired mobile pairing", async () => {
    const device = createDevice(db, {
      name: "fictional-tablet",
      kind: "android",
      installId: "fictional-install-revoke-race",
    });
    const oldCredential = createToken(db, device.id, [SCOPE_ADMIN]);
    const pairing = createPairing(db, {
      kind: "android",
      scopes: [SCOPE_ADMIN],
      repairDeviceId: device.id,
    });
    const entered = deferred();
    const release = deferred();
    const base = directWriteGate(db);
    const gated: WriteGate = {
      ...base,
      revokeDevice: async (id, fence) => {
        entered.resolve();
        await release.promise;
        return base.revokeDevice(id, fence);
      },
    };
    const racedApp = createServer(db, undefined, { writeGate: gated });

    const revoke = racedApp.request(`/admin/devices/${device.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${oldCredential.token}`,
        "omnesis-pairing-generation": oldCredential.id,
      },
    });
    await entered.promise;

    const repaired = await racedApp.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode: pairing.pairingCode,
        capabilities: {
          installId: "fictional-install-revoke-race",
          suggestedName: "fictional-tablet",
          platform: "android",
        },
      }),
    });
    expect(repaired.status).toBe(200);
    const replacement = (await repaired.json()) as { token: string; tokenId: string };
    release.resolve();

    const response = await revoke;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_PAIRING" });
    expect(lookupToken(db, oldCredential.token)).toBeNull();
    expect(lookupToken(db, replacement.token)?.id).toBe(replacement.tokenId);

    const authorized = await racedApp.request("/admin/devices", {
      headers: { Authorization: `Bearer ${replacement.token}` },
    });
    expect(authorized.status).toBe(200);
  });

  test("POST /admin/devices creates device + returns token", async () => {
    const res = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "macbook-collector",
        kind: "collector",
        scopes: ["write:*"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device: { id: string; name: string; kind: string };
      token: string;
    };
    expect(body.device.name).toBe("macbook-collector");
    expect(body.device.kind).toBe("collector");
    expect(body.token).toMatch(/^omn_[a-f0-9]{32}$/);
  });

  test("POST /admin/devices rejects invalid kind", async () => {
    const res = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "x", kind: "server", scopes: ["read"] }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /admin/devices rejects invalid scope", async () => {
    const res = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "x", kind: "cli", scopes: ["bogus"] }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /admin/devices lists paired devices", async () => {
    await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "d1", kind: "cli", scopes: ["admin"] }),
    });
    await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "d2", kind: "portal", scopes: ["admin"] }),
    });
    const res = await req("/admin/devices");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { name: string }[];
      pageInfo: { hasMore: boolean };
    };
    expect(body.pageInfo.hasMore).toBe(false);
    const names = body.items.map((d) => d.name).sort();
    expect(names).toContain("d1");
    expect(names).toContain("d2");
  });

  test("device list and doctor compute push plans from their cached device snapshot", async () => {
    const created = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "cached-store-phone",
        kind: "ios",
        scopes: ["admin"],
        capabilities: { pushAppId: "dev.omnesis.ios" },
      }),
    });
    const { device } = (await created.json()) as { device: { id: string } };

    // Change only the live row, deliberately bypassing the cache invalidation
    // hook. Both response fields must describe the cached row rather than
    // combining its old registration state with a fresh device lookup.
    db.prepare(
      `UPDATE devices
          SET relay_consent_app_id = 'dev.omnesis.ios', relay_consented_at = 123
        WHERE id = ?`,
    ).run(device.id);

    const listed = (await (await req("/admin/devices")).json()) as {
      items: Array<{
        id: string;
        relayConsent: null | { appId: string };
        pushPlan: { transport: string; reasonCode?: string };
      }>;
    };
    expect(listed.items.find((item) => item.id === device.id)).toMatchObject({
      relayConsent: null,
      pushPlan: { transport: "unavailable", reasonCode: "relay-disabled" },
    });

    const doctor = (await (await req("/admin/doctor")).json()) as {
      checks: Array<{ id: string; hint?: string }>;
    };
    const push = doctor.checks.find((check) => check.id === "push.inventory");
    expect(push?.hint).toContain("approve relay notifications");
    expect(push?.hint).not.toContain("omnesis push setup");
  });

  test("DELETE /admin/devices/:id revokes device and tokens", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "doomed", kind: "cli", scopes: ["admin"] }),
    });
    const { device, token } = (await create.json()) as { device: { id: string }; token: string };

    const del = await req(`/admin/devices/${device.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The just-revoked token should no longer authenticate.
    const check = await app.request("/admin/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(check.status).toBe(401);
  });

  test("DELETE /admin/devices/:id reports a changed revocation impact", async () => {
    const device = createDevice(db, { name: "fictional-stale-agent", kind: "agent" });
    const credential = createToken(db, device.id, [SCOPE_ADMIN]);
    const base = directWriteGate(db);
    const revokeDevice = vi.fn(async () => {
      throw new Error(STALE_DEVICE_REVOCATION_IMPACT_ERROR);
    });
    const staleApp = createServer(db, undefined, {
      writeGate: { ...base, revokeDevice },
    });

    const response = await staleApp.request(
      `/admin/devices/${device.id}?impactFingerprint=${"a".repeat(64)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential.token}` },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "DEVICE_REVOCATION_IMPACT_CHANGED" });
    expect(revokeDevice).toHaveBeenCalledWith(device.id, undefined, "a".repeat(64));
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(device.id)).toEqual({
      revoked_at: null,
    });
  });

  test("DELETE /admin/devices/:id keeps the row as revoked; minting for it is refused", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "revocable-cli", kind: "cli", scopes: ["read"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const del = await req(`/admin/devices/${device.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { revoked?: boolean }).revoked).toBe(true);

    // The row survives, marked revoked.
    const list = (await (await req("/admin/devices")).json()) as {
      items: Array<{ id: string; revokedAt: number | null }>;
    };
    const row = list.items.find((d) => d.id === device.id);
    expect(row).toBeDefined();
    expect(row?.revokedAt).not.toBeNull();

    // A fresh token would silently resurrect the device's access.
    const mint = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["read"] }),
    });
    expect(mint.status).toBe(409);
    expect(((await mint.json()) as { code?: string }).code).toBe("DEVICE_REVOKED");
  });

  test("DELETE /admin/devices/:id?forget=true refuses while sources remain, then deletes", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "forgettable", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };
    const src = await req("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "test-source",
        accountId: "forget-acct",
        deviceId: device.id,
      }),
    });
    expect(src.status).toBe(200);

    // Forget is refused while the device still hosts the source…
    const refused = await req(`/admin/devices/${device.id}?forget=true`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { code?: string; sources?: string[] };
    expect(refusedBody.code).toBe("DEVICE_STILL_HOSTS_SOURCES");
    expect(refusedBody.sources).toContain("test-source:forget-acct");

    // …and the source is untouched by the attempt.
    const sources = (await (await req("/admin/sources")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(sources.items.map((s) => s.id)).toContain("test-source:forget-acct");

    await req("/admin/sources/test-source:forget-acct", { method: "DELETE" });
    const forgotten = await req(`/admin/devices/${device.id}?forget=true`, { method: "DELETE" });
    expect(forgotten.status).toBe(200);
    const after = (await (await req("/admin/devices")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(after.items.some((d) => d.id === device.id)).toBe(false);
  });

  test("PATCH /admin/devices/:id renames a device and refuses a taken name", async () => {
    const a = (await (
      await req("/admin/devices", {
        method: "POST",
        body: JSON.stringify({ name: "rename-me", kind: "cli", scopes: ["read"] }),
      })
    ).json()) as { device: { id: string } };
    await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "already-here", kind: "cli", scopes: ["read"] }),
    });

    const ok = await req(`/admin/devices/${a.device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed-cli" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { device: { name: string } }).device.name).toBe("renamed-cli");

    const taken = await req(`/admin/devices/${a.device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "already-here" }),
    });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code?: string }).code).toBe("DEVICE_NAME_TAKEN");
  });

  // A collector on the gateway host registers itself under a fixed
  // `<hostname>-collector` name with the local bootstrap token. After a
  // revoke that name is still held by its own dormant row, so the route has
  // to adopt it rather than refuse — a fresh row would strand the sources,
  // memberships and cursors that hang off the old device id.
  test("POST /admin/devices reclaims a revoked collector row of the same name", async () => {
    const created = (await (
      await req("/admin/devices", {
        method: "POST",
        body: JSON.stringify({
          name: "workstation-collector",
          kind: "collector",
          scopes: ["read", "write:*"],
        }),
      })
    ).json()) as { device: { id: DeviceId } };
    const deviceId = created.device.id;
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("reclaim-acct"),
      deviceId,
    });
    db.prepare(
      "INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at) VALUES (?, ?, ?, ?)",
    ).run(source.id, deviceId, JSON.stringify({ page: 7 }), 1_700_000_000_000);

    expect((await req(`/admin/devices/${deviceId}`, { method: "DELETE" })).status).toBe(200);

    const reclaimed = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "workstation-collector",
        kind: "collector",
        scopes: ["read", "write:*"],
        capabilities: { hostname: "workstation.example.com", platform: "linux" },
      }),
    });
    expect(reclaimed.status).toBe(200);
    const body = (await reclaimed.json()) as {
      device: { id: DeviceId; revokedAt: number | null };
      token: string;
      reclaimed?: boolean;
    };
    expect(body.reclaimed).toBe(true);
    expect(body.device.id).toBe(deviceId);
    expect(body.device.revokedAt).toBeNull();
    // Identity survived: the source still points at the same device and the
    // cursor row is untouched.
    expect(getSource(db, source.id)?.deviceId).toBe(deviceId);
    expect(getSyncState(db, source.id, deviceId)?.cursor).toBe(JSON.stringify({ page: 7 }));
    // The fresh credential works and the revoked one is gone.
    expect(lookupToken(db, body.token)?.deviceId).toBe(deviceId);
  });

  test("POST /admin/devices still refuses a revoked row of a different kind", async () => {
    const created = (await (
      await req("/admin/devices", {
        method: "POST",
        body: JSON.stringify({ name: "shared-name", kind: "cli", scopes: ["read"] }),
      })
    ).json()) as { device: { id: DeviceId } };
    await req(`/admin/devices/${created.device.id}`, { method: "DELETE" });

    const refused = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "shared-name", kind: "collector", scopes: ["read"] }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code?: string }).code).toBe("DEVICE_NAME_TAKEN");
  });

  test("POST /admin/devices still refuses a live row of the same name", async () => {
    await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "live-collector", kind: "collector", scopes: ["read"] }),
    });
    const refused = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "live-collector", kind: "collector", scopes: ["read"] }),
    });
    expect(refused.status).toBe(409);
  });

  test("GET /admin/devices marks a revoked source-hosting device needs-pairing", async () => {
    const mint = async (name: string): Promise<DeviceId> =>
      (
        (await (
          await req("/admin/devices", {
            method: "POST",
            body: JSON.stringify({ name, kind: "collector", scopes: ["read"] }),
          })
        ).json()) as { device: { id: DeviceId } }
      ).device.id;
    const hosting = { id: await mint("dormant-collector") };
    const retired = { id: await mint("retired-collector") };
    createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("dormant-acct"),
      deviceId: hosting.id,
    });

    const paired = (await (await req("/admin/devices")).json()) as {
      items: Array<{ id: DeviceId; needsPairing: boolean }>;
    };
    expect(paired.items.find((d) => d.id === hosting.id)?.needsPairing).toBe(false);

    await req(`/admin/devices/${hosting.id}`, { method: "DELETE" });
    await req(`/admin/devices/${retired.id}`, { method: "DELETE" });

    const after = (await (await req("/admin/devices")).json()) as {
      items: Array<{ id: DeviceId; needsPairing: boolean }>;
    };
    expect(after.items.find((d) => d.id === hosting.id)?.needsPairing).toBe(true);
    // Revoked with nothing to bring back is simply retired, not stuck.
    expect(after.items.find((d) => d.id === retired.id)?.needsPairing).toBe(false);
  });

  test("a repair pairing code adopts only the device it names", async () => {
    const target = createDevice(db, {
      name: "repair-target-collector",
      kind: "collector",
      capabilities: { installId: "install-target" },
    });
    const bystander = createDevice(db, {
      name: "bystander-collector",
      kind: "collector",
      capabilities: { installId: "install-bystander" },
    });
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("repair-acct"),
      deviceId: target.id,
    });

    const minted = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "collector", repairDeviceId: target.id }),
    });
    expect(minted.status).toBe(200);
    const { pairingCode } = (await minted.json()) as { pairingCode: string };

    // The redeeming client suggests the BYSTANDER's name, which on a plain
    // pairing would steer the adoption to that row. A repair code ignores it.
    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        capabilities: { suggestedName: "bystander-collector" },
      }),
    });
    expect(exchange.status).toBe(200);
    const paired = (await exchange.json()) as { device: { id: DeviceId; name: string } };
    expect(paired.device.id).toBe(target.id);
    expect(paired.device.name).toBe("repair-target-collector");
    expect(getSource(db, source.id)?.deviceId).toBe(target.id);
    // The bystander keeps its own row AND its install identity: a repair
    // touches the device it names and nothing else.
    const bystanderRow = db
      .prepare<
        [string],
        { name: string; install_id: string | null }
      >("SELECT name, install_id FROM devices WHERE id = ?")
      .get(bystander.id);
    expect(bystanderRow?.name).toBe("bystander-collector");
    expect(bystanderRow?.install_id).toBe("install-bystander");
  });

  test("a repair pairing refuses a client already paired as another device", async () => {
    const target = createDevice(db, {
      name: "pinned-target-collector",
      kind: "collector",
      capabilities: { installId: "install-pinned-target" },
    });
    createDevice(db, {
      name: "other-collector",
      kind: "collector",
      capabilities: { installId: "install-other" },
    });
    const minted = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "collector", repairDeviceId: target.id }),
    });
    const { pairingCode } = (await minted.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { installId: "install-other" } }),
    });
    expect(exchange.status).toBe(409);
    // The refusal rolls back, so the one-shot code is still redeemable by the
    // machine the operator actually meant.
    const retried = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { installId: "install-pinned-target" } }),
    });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { device: { id: DeviceId } }).device.id).toBe(target.id);
  });

  test("a repair pairing code survives a revoke and keeps the device id", async () => {
    const created = (await (
      await req("/admin/devices", {
        method: "POST",
        body: JSON.stringify({ name: "remote-collector", kind: "collector", scopes: ["read"] }),
      })
    ).json()) as { device: { id: DeviceId } };
    const deviceId = created.device.id;
    const source = createSource(db, {
      type: SourceType("test-source"),
      accountId: AccountId("remote-acct"),
      deviceId,
    });
    db.prepare(
      "INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at) VALUES (?, ?, ?, ?)",
    ).run(source.id, deviceId, JSON.stringify({ page: 3 }), 1_700_000_000_000);
    await req(`/admin/devices/${deviceId}`, { method: "DELETE" });

    const minted = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "collector", repairDeviceId: deviceId }),
    });
    const { pairingCode } = (await minted.json()) as { pairingCode: string };
    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { hostname: "remote.example.com" } }),
    });
    expect(exchange.status).toBe(200);
    const paired = (await exchange.json()) as {
      device: { id: DeviceId; revokedAt: number | null };
    };
    expect(paired.device.id).toBe(deviceId);
    expect(paired.device.revokedAt).toBeNull();
    expect(getSyncState(db, source.id, deviceId)?.cursor).toBe(JSON.stringify({ page: 3 }));
  });

  // A portal login consumes its code through its own path, which resolves the
  // row by install identity and never reads the repair target — so a bound
  // code would look like it worked and quietly land on a new row.
  test("a repair pairing refuses a portal session", async () => {
    const target = createDevice(db, { name: "browser-session", kind: "portal" });
    const response = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "portal", repairDeviceId: target.id }),
    });
    expect(response.status).toBe(400);
  });

  test("a repair pairing refuses a kind that is not the target's", async () => {
    const target = createDevice(db, { name: "kind-mismatch-collector", kind: "collector" });
    const response = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", repairDeviceId: target.id }),
    });
    expect(response.status).toBe(400);
  });

  test("a repair pairing code dies with the device it names", async () => {
    const target = createDevice(db, { name: "vanishing-collector", kind: "collector" });
    const minted = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "collector", repairDeviceId: target.id }),
    });
    const { pairingCode } = (await minted.json()) as { pairingCode: string };
    expect(
      (await req(`/admin/devices/${target.id}?forget=true`, { method: "DELETE" })).status,
    ).toBe(200);

    // The pairing row cascades away with the device row, so the code is
    // simply invalid — there is no identity left for it to restore.
    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: {} }),
    });
    expect(exchange.status).toBe(400);
  });

  // Device-level self annotation
  test("PATCH /admin/devices/:id stores self emails and phones (E.164)", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "selfmac", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const patch = await req(`/admin/devices/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        selfEmails: ["Me@Example.COM"],
        selfPhones: ["+447700000000"],
      }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      device: { selfEmails: string[]; selfPhones: string[] };
    };
    expect(body.device.selfEmails).toEqual(["me@example.com"]);
    expect(body.device.selfPhones).toEqual(["+447700000000"]);
  });

  test("PATCH /admin/devices/:id rejects malformed emails", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "selfbad1", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const patch = await req(`/admin/devices/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ selfEmails: ["not-an-email"] }),
    });
    expect(patch.status).toBe(400);
  });

  test("PATCH /admin/devices/:id rejects unparseable phones", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "selfbad2", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const patch = await req(`/admin/devices/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ selfPhones: ["not-a-phone"] }),
    });
    expect(patch.status).toBe(400);
  });

  test("PATCH /admin/devices/:id requires at least one of selfEmails / selfPhones", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "selfempty", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const patch = await req(`/admin/devices/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(patch.status).toBe(400);
  });

  test("PATCH /admin/devices/:id 404s on unknown device", async () => {
    const patch = await req(`/admin/devices/does-not-exist`, {
      method: "PATCH",
      body: JSON.stringify({ selfEmails: ["a@b.c"] }),
    });
    expect(patch.status).toBe(404);
  });

  test("an integration only ever holds answer-bounded tokens", async () => {
    const wideCreate = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "voice-wide", kind: "integration", scopes: ["admin"] }),
    });
    expect(wideCreate.status).toBe(400);
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "voice-desk", kind: "integration", scopes: ["answer"] }),
    });
    expect(create.status).toBe(200);
    const { device } = (await create.json()) as { device: { id: string } };

    const wide = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["read"] }),
    });
    expect(wide.status).toBe(409);
    expect(((await wide.json()) as { code: string }).code).toBe("INTEGRATION_SCOPES");
    const bounded = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["answer"] }),
    });
    expect(bounded.status).toBe(200);

    // A pairing — fresh or a repair — carries the answer scope by default and nothing wider.
    const repair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "integration", repairDeviceId: device.id }),
    });
    expect(((await repair.json()) as { scopes: string[] }).scopes).toEqual(["answer"]);
    const widePair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "integration", name: "Voice wide", scopes: ["admin"] }),
    });
    expect(widePair.status).toBe(400);
  });

  test("an integration's access level is chosen at pairing from a portal session only", async () => {
    const login = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0]!;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const portal = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Omnesis-CSRF": csrfToken,
        },
        body: JSON.stringify(body),
      });
    const created = await portal("/admin/access/levels", {
      name: "Voice answers",
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ],
    });
    const { level } = (await created.json()) as { level: { id: string } };

    const unnamed = await portal("/admin/devices/pair", { kind: "integration" });
    expect(unnamed.status).toBe(400);
    const viaBearer = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "integration", name: "Voice desk", accessLevelId: level.id }),
    });
    expect(viaBearer.status).toBe(403);
    const notIntegration = await portal("/admin/devices/pair", {
      kind: "cli",
      accessLevelId: level.id,
    });
    expect(notIntegration.status).toBe(400);
    const viaPortal = await portal("/admin/devices/pair", {
      kind: "integration",
      name: "Voice desk",
      accessLevelId: level.id,
    });
    expect(viaPortal.status).toBe(200);
    const { pairingCode } = (await viaPortal.json()) as { pairingCode: string };
    const redeemed = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        kind: "integration",
        capabilities: { suggestedName: "voice-desk" },
      }),
    });
    expect(redeemed.status).toBe(200);
    const { device } = (await redeemed.json()) as {
      device: { name: string; accessLevelId: string | null };
    };
    expect(device.name).toBe("Voice desk");
    expect(device.accessLevelId).toBe(level.id);
  });

  test("the device list shows a device's new access level as soon as it is saved", async () => {
    const login = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0]!;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const portal = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Omnesis-CSRF": csrfToken,
        },
        body: JSON.stringify(body),
      });
    const created = await portal("/admin/access/levels", "POST", {
      name: "Voice answers",
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ],
    });
    expect(created.status).toBe(201);
    const { level } = (await created.json()) as { level: { id: string } };
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "voice-desk", kind: "integration", scopes: ["answer"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };
    // Read once so the cached list holds the device before the change.
    await req("/admin/devices");

    const put = await portal(`/admin/access/devices/${device.id}/level`, "PUT", {
      levelId: level.id,
    });
    expect(put.status).toBe(200);
    const listed = (await (await req("/admin/devices")).json()) as {
      items: { id: string; accessLevelId: string | null }[];
    };
    expect(listed.items.find((d) => d.id === device.id)?.accessLevelId).toBe(level.id);
  });

  test("the /answer routes resolve a device's access level from the device table", async () => {
    const agentRouteDeps: import("./http/routes/agent.js").AgentRoutesDeps = {};
    createServer(db, undefined, { agentRouteDeps });
    const own = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "own-cli", kind: "cli", scopes: ["answer"] }),
    });
    const ownId = ((await own.json()) as { device: { id: string } }).device.id;
    expect(agentRouteDeps.deviceAnswerScope?.(ownId, "token-1")).toEqual({ kind: "default" });

    const integration = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "voice-desk", kind: "integration", scopes: ["answer"] }),
    });
    const id = ((await integration.json()) as { device: { id: string } }).device.id;
    expect(agentRouteDeps.deviceAnswerScope?.(id, "token-1")).toEqual({ kind: "unassigned" });
    // A level id no live level carries: the integration is refused, never widened.
    db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run(
      "00000000-0000-4000-8000-00000000abcd",
      id,
    );
    expect(agentRouteDeps.deviceAnswerScope?.(id, "token-1")).toEqual({
      kind: "unavailable",
      levelId: "00000000-0000-4000-8000-00000000abcd",
    });
  });

  test("deprecated APNs registration alias installs the content-free direct transport", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "older-ios-build", kind: "ios", scopes: ["admin"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };
    const response = await req(`/admin/devices/${device.id}/apns-token`, {
      method: "POST",
      body: JSON.stringify({
        deviceToken: "a".repeat(64),
        environment: "production",
        bundleId: "dev.example.ios",
      }),
    });
    expect(response.status).toBe(200);
    expect(
      db
        .prepare<
          [string],
          { push_transport: string }
        >("SELECT push_transport FROM devices WHERE id = ?")
        .get(device.id)?.push_transport,
    ).toBe("direct-apns");
  });

  test("removed FCM registration alias is not exposed", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "older-android-build", kind: "android", scopes: ["admin"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };
    const response = await req(`/admin/devices/${device.id}/fcm-token`, {
      method: "POST",
      body: JSON.stringify({ registrationToken: "fictional-registration-token" }),
    });
    expect(response.status).toBe(404);
    expect(
      db
        .prepare<
          [string],
          { push_transport: string }
        >("SELECT push_transport FROM devices WHERE id = ?")
        .get(device.id)?.push_transport,
    ).toBeNull();
  });

  test.each(DEVICE_KINDS.filter((kind) => kind !== "agent"))(
    "pairing without scopes carries the %s kind's canonical grant",
    async (kind) => {
      const response = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ name: `default-grant-${kind}`, kind }),
      });
      expect(response.status).toBe(200);
      const pending = (await response.json()) as { scopes: string[] };
      expect(pending.scopes).toEqual(defaultScopesForDeviceKind(kind));
    },
  );

  test("explicit pairing scopes override the kind's canonical grant", async () => {
    const response = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "narrow-cli", kind: "cli", scopes: ["read"] }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { scopes: string[] }).scopes).toEqual(["read"]);
  });

  test("pairing rejects an empty scope list", async () => {
    const response = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "scope-less-device",
        kind: "ios",
        scopes: [],
      }),
    });
    expect(response.status).toBe(400);
  });

  test("admin can invalidate an unused pairing code", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "rotated-phone", kind: "android", scopes: ["read"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const invalid = await req("/admin/devices/pair", {
      method: "DELETE",
      body: JSON.stringify({ pairingCode: "not-a-code" }),
    });
    expect(invalid.status).toBe(400);
    const revoked = await req("/admin/devices/pair", {
      method: "DELETE",
      body: JSON.stringify({ pairingCode }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(exchange.status).toBe(400);
  });

  test("pairing flow: admin creates code, unauth client exchanges for token", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "ios-phone",
        kind: "ios",
        scopes: ["admin", "write:apple-health"],
      }),
    });
    expect(pair.status).toBe(200);
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    // Unauth request to /devices/pair — exchange code for token.
    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { hostname: "phone" } }),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as {
      device: { name: string; kind: string; capabilities: Record<string, unknown> };
      token: string;
      scopes: string[];
    };
    expect(body.device.name).toBe("ios-phone");
    expect(body.device.kind).toBe("ios");
    expect(body.device.capabilities.hostname).toBe("phone");
    expect(body.scopes).toContain("write:apple-health");

    // Second exchange with the same code fails (one-shot).
    const second = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(second.status).toBe(400);
  });

  test("agent pairing codes require the exact delivery-only scope", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      for (const scopes of [["subscriptions:receive", "read"], ["subscriptions:manage"], []]) {
        const response = await req("/admin/devices/pair", {
          method: "POST",
          body: JSON.stringify({
            name: "fictional-agent-integration",
            kind: "agent",
            scopes,
          }),
        });
        expect(response.status).toBe(400);
      }

      const valid = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({
          name: "fictional-agent-integration",
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      });
      expect(valid.status).toBe(200);

      const defaulted = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ name: "fictional-agent-integration", kind: "agent" }),
      });
      expect(defaulted.status).toBe(200);
      expect(((await defaulted.json()) as { scopes: string[] }).scopes).toEqual([
        "subscriptions:receive",
      ]);
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });

  test("agent pairing redemption replays the identical HTTP response after a lost reply", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const pairing = createPairing(db, {
        name: "fictional-hermes-recovery",
        kind: "agent",
        scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      });
      const body = JSON.stringify({
        pairingCode: pairing.pairingCode,
        idempotencyKey: "k".repeat(43),
        agentIntegration: { harness: "hermes" },
        capabilities: {
          suggestedName: "fictional-hermes-recovery",
          agentIntegration: {
            harness: "hermes",
            deliveryProtocolMin: 3,
            deliveryProtocolMax: 3,
            maxConcurrentRuns: 1,
            watchPrivacyPolicyVersion: 1,
          },
        },
      });
      const first = await app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const firstPayload = (await first.json()) as { device: { id: string } };
      const replay = await app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(firstPayload);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM tokens WHERE device_id = ?")
          .get(firstPayload.device.id),
      ).toEqual({ count: 3 });
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });

  test("agent pairing mints and redeems on an ordinary gateway", async () => {
    // The managed harness integration is generally available: only Watch
    // management still rides on the experimental runtime, and that is
    // advertised as a capability rather than hidden behind pairing.
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    const previousSynthetic = process.env.OMNESIS_SYNTHETIC;
    delete process.env.OMNESIS_EXPERIMENTAL;
    delete process.env.OMNESIS_SYNTHETIC;
    try {
      const mint = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({
          name: "fictional-openclaw-default-gateway",
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      });
      expect(mint.status).toBe(200);
      const minted = (await mint.json()) as { pairingCode: string };

      const redeem = await app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingCode: minted.pairingCode,
          agentIntegration: { harness: "openclaw" },
          capabilities: {
            suggestedName: "fictional-openclaw-default-gateway",
            agentIntegration: {
              harness: "openclaw",
              deliveryProtocolMin: 3,
              deliveryProtocolMax: 3,
              maxConcurrentRuns: 2,
              watchPrivacyPolicyVersion: 1,
            },
          },
        }),
      });
      expect(redeem.status).toBe(200);
      const paired = (await redeem.json()) as {
        device: { kind: string };
        credentials: Record<string, { token: string }>;
      };
      expect(paired.device.kind).toBe("agent");
      // Delivery, ingestion and management: the three operational credentials
      // the plugin needs, none of which can read the corpus.
      expect(Object.keys(paired.credentials).sort()).toEqual([
        "delivery",
        "ingestion",
        "management",
      ]);
      expect(peekPairing(db, minted.pairingCode)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
      if (previousSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
      else process.env.OMNESIS_SYNTHETIC = previousSynthetic;
    }
  });

  test("an agent host reconnects over HTTP by presenting its own credential", async () => {
    const capabilities = {
      suggestedName: "fictional-openclaw-reconnect",
      agentIntegration: {
        harness: "openclaw",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 2,
        watchPrivacyPolicyVersion: 1,
      },
    };
    const mintCode = async () => {
      const mint = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "agent" }),
      });
      return ((await mint.json()) as { pairingCode: string }).pairingCode;
    };
    const redeem = (pairingCode: string, continuityCredential?: string) =>
      app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingCode,
          agentIntegration: { harness: "openclaw" },
          capabilities,
          ...(continuityCredential ? { continuityCredential } : {}),
        }),
      });

    const first = (await (await redeem(await mintCode())).json()) as {
      device: { id: string };
      reconnected: boolean;
      credentials: { delivery: { token: string } };
    };
    expect(first.reconnected).toBe(false);

    const refused = await redeem(await mintCode());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "AGENT_DEVICE_EXISTS" });

    const again = await redeem(await mintCode(), first.credentials.delivery.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      device: { id: first.device.id },
      reconnected: true,
    });
    expect(lookupToken(db, first.credentials.delivery.token)).toBeNull();
  });

  test("admin can bind an agent repair code to one exact existing device", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const existing = createDevice(db, {
      name: "fictional-openclaw-agent",
      kind: "agent",
    });
    try {
      const response = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({
          repairDeviceId: existing.id,
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ repairDeviceId: existing.id });

      const wrongName = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({
          repairDeviceId: existing.id,
          name: "different-fictional-agent",
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      });
      expect(wrongName.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });

  test("pairing rejects malformed source-type capability entries", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "collector-with-bad-capability",
        kind: "collector",
        scopes: ["admin"],
      }),
    });
    expect(pair.status).toBe(200);
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        capabilities: { pushBasedSourceTypes: ["Browser"] },
      }),
    });
    expect(exchange.status).toBe(400);
  });

  // The browser-capture extension pairs as its own `browser`
  // device kind and receives a token scoped to write:web ONLY. The device
  // kind is the physical client; the source it contributes captures to is the
  // unified `web` source. This is the end-to-end of the device-kind chunk:
  // the real handshake mints a browser device, and the resulting token can
  // push web docs but nothing else.
  test("pairing flow: browser kind redeems into a write:web-only token", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "chrome-extension",
        kind: "browser",
        scopes: ["write:web"],
      }),
    });
    expect(pair.status).toBe(200);
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { platform: "web" } }),
    });
    expect(exchange.status).toBe(200);
    const paired = (await exchange.json()) as {
      device: { kind: string };
      token: string;
      scopes: string[];
    };
    expect(paired.device.kind).toBe("browser");
    // Exactly one scope, and it is write:web — never read/admin/write:*.
    expect(paired.scopes).toEqual(["write:web"]);

    // The minted token is ACCEPTED for a web-source write: the gateway's
    // write-scope gate parses the sourceId and checks scopes, so the auth
    // layer accepts a write:web token pushing to the `web` source.
    const webDoc = {
      ...makeDocPayload("page-1"),
      providerId: "web",
      sourceId: "web",
    };
    const okRes = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${paired.token}` },
      body: JSON.stringify({ documents: [webDoc] }),
    });
    expect(okRes.status).toBe(200);

    // REJECTED for another source's write (gmail) — write:web does not
    // satisfy write:gmail.
    const gmailRes = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${paired.token}` },
      body: JSON.stringify({ documents: [makeDocPayload("gm-1")] }),
    });
    expect(gmailRes.status).toBe(403);

    // REJECTED for any read — the token carries no read scope.
    const readRes = await app.request("/documents/count/web", {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(readRes.status).toBe(403);

    // REJECTED for any admin route — the token carries no admin scope.
    const adminRes = await app.request("/admin/devices", {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(adminRes.status).toBe(403);
  });

  // A pairing request whose response was lost (timeout after the gateway had
  // already spent the code) is replayed with the same idempotency key and
  // gets the same credentials back; without the key the spent code is just
  // invalid, as before.
  test("pairing flow: a browser redemption replays for the same idempotency key", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "chrome-extension-retry", kind: "browser" }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };
    const body = {
      pairingCode,
      idempotencyKey: "k".repeat(43),
      capabilities: { platform: "web", installId: "fictional-retry-install" },
    };
    const redeem = () =>
      app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await redeem();
    expect(first.status).toBe(200);
    const minted = (await first.json()) as { device: { id: string }; token: string };

    const replay = await redeem();
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { device: { id: string }; token: string };
    expect(replayed.token).toBe(minted.token);
    expect(replayed.device.id).toBe(minted.device.id);

    const withoutKey = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: body.capabilities }),
    });
    expect(withoutKey.status).toBe(400);

    // The same key with different capabilities is not the same request.
    const reused = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        capabilities: { platform: "web", installId: "another-retry-install" },
      }),
    });
    expect(reused.status).toBe(409);

    // Once the receipt has expired the code is simply spent.
    db.prepare("UPDATE pairing_redemption_receipts SET expires_at = 0").run();
    const expired = await redeem();
    expect(expired.status).toBe(400);
  });

  // One write-scope rule for every write route: an admin-only token (no
  // write:* and no per-source grant) is accepted for document ingest exactly
  // as it is for every other source mutation, and a token with neither admin
  // nor a matching write grant is refused everywhere.
  test("document ingest applies the same write-scope rule as the other write routes", async () => {
    const adminOnly = mintToken([SCOPE_ADMIN], "cli");
    const adminWrite = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminOnly.token}` },
      body: JSON.stringify({ documents: [makeDocPayload("admin-write-1")] }),
    });
    expect(adminWrite.status).toBe(200);

    const readOnly = mintToken([SCOPE_READ], "cli");
    const readWrite = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readOnly.token}` },
      body: JSON.stringify({ documents: [makeDocPayload("read-write-1")] }),
    });
    expect(readWrite.status).toBe(403);
  });

  // Durable removal: once a push source is removed, its device keeps its
  // token and keeps POSTing, but the gateway must reject those pushes and
  // refuse to auto-resurrect the source — until an explicit re-enable.
  describe("durable push-source removal", () => {
    function browserDoc(externalId: string) {
      return {
        providerId: "browser",
        sourceId: "browser",
        externalId,
        title: "Captured page",
        content: "# Page",
        contentHash: `hash-${externalId}`,
        metadata: {},
        sourceCreatedAt: "2024-01-15T10:00:00Z",
        sourceUpdatedAt: "2024-01-15T10:00:00Z",
      };
    }
    function sourceRow(id: string) {
      return db.prepare("SELECT id FROM sources WHERE id = ?").get(id) as
        | { id: string }
        | undefined;
    }
    function docRow(externalId: string) {
      return db
        .prepare("SELECT id FROM documents WHERE source_id = 'browser' AND external_id = ?")
        .get(externalId) as { id: string } | undefined;
    }
    async function pushBrowser(token: string, externalId: string) {
      const res = await app.request("/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ documents: [browserDoc(externalId)] }),
      });
      return res;
    }

    test("removed source: pushes are rejected and the row is not resurrected", async () => {
      const { token } = mintToken([writeScope(SourceType("browser"))], "browser");

      // First push auto-registers the `browser` source.
      const first = await pushBrowser(token, "page-1");
      expect(first.status).toBe(200);
      expect((await first.json()) as { rejected?: unknown }).not.toHaveProperty("rejected");
      expect(sourceRow("browser")).toBeDefined();
      expect(docRow("page-1")).toBeDefined();

      // Operator removes the source via the admin API.
      const del = await req("/admin/sources/browser", { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(sourceRow("browser")).toBeUndefined();
      // Removal is accepted, not completed: the source has stopped, and
      // deleting what it ingested continues after the response.
      expect(await del.json()).toMatchObject({ ok: true, state: "removing" });

      // The device (token intact) pushes again — rejected, not written, and
      // the source row stays gone (ensurePushSourcesRegistered must not heal it).
      const second = await pushBrowser(token, "page-2");
      expect(second.status).toBe(200);
      const body = (await second.json()) as {
        rejected?: Array<{ sourceId: string; reason: string }>;
      };
      expect(body.rejected).toEqual([{ sourceId: "browser", reason: "removed" }]);
      expect(docRow("page-2")).toBeUndefined();
      expect(sourceRow("browser")).toBeUndefined();

      // Legacy collectors use a broad write token and POST /documents. They
      // may bypass pause checks, but never the durable removal tombstone.
      const legacy = await req("/documents", {
        method: "POST",
        body: JSON.stringify({ documents: [browserDoc("page-3")] }),
      });
      expect((await legacy.json()).rejected).toEqual([{ sourceId: "browser", reason: "removed" }]);
      expect(docRow("page-3")).toBeUndefined();
    });

    test("a source being removed is reported on GET /admin/sources until it drains", async () => {
      // The `sources` row is deleted up front so the source stops syncing, so
      // `pendingRemovals` is the only thing that keeps it accounted for while
      // its data is deleted. Every client renders the removing state from here.
      const { token } = mintToken([writeScope(SourceType("browser"))], "browser");
      await pushBrowser(token, "pending-1");

      const before = (await (await req("/admin/sources")).json()) as {
        items: Array<{ id: string }>;
        pendingRemovals: Array<{ id: string; type: string; state: string }>;
      };
      expect(before.items.map((s) => s.id)).toContain("browser");
      expect(before.pendingRemovals).toEqual([]);
      expect(await (await req("/admin/sources")).json()).toHaveProperty("removedSourceIds", []);

      await req("/admin/sources/browser", { method: "DELETE" });

      // The purge is fast on a corpus this size, so assert the shape of the
      // report rather than racing it: either the source is still draining and
      // named in `pendingRemovals`, or it has finished and is gone from both.
      const after = (await (await req("/admin/sources")).json()) as {
        items: Array<{ id: string }>;
        pendingRemovals: Array<{ id: string; type: string; state: string }>;
      };
      expect(after.items.map((s) => s.id)).not.toContain("browser");
      expect(await (await req("/admin/sources")).json()).toHaveProperty("removedSourceIds", [
        "browser",
      ]);
      for (const entry of after.pendingRemovals) {
        expect(entry).toMatchObject({ id: "browser", type: "browser", state: "removing" });
      }
    });

    test("paused source: pushes are rejected with reason 'paused' but the row survives", async () => {
      const { token } = mintToken([writeScope(SourceType("browser"))], "browser");
      expect((await pushBrowser(token, "p-1")).status).toBe(200);
      expect(sourceRow("browser")).toBeDefined();

      // Pause via the admin enabled-toggle.
      const patch = await req("/admin/sources/browser", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      expect(patch.status).toBe(200);

      const res = await pushBrowser(token, "p-2");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rejected?: Array<{ sourceId: string; reason: string }> };
      expect(body.rejected).toEqual([{ sourceId: "browser", reason: "paused" }]);
      expect(docRow("p-2")).toBeUndefined();
      // The row survives a pause (unlike a removal).
      expect(sourceRow("browser")).toBeDefined();
    });

    test("re-pairing clears the tombstone so pushes flow again", async () => {
      const { token } = mintToken([writeScope(SourceType("browser"))], "browser");
      await pushBrowser(token, "r-1");
      await req("/admin/sources/browser", { method: "DELETE" });

      // Sanity: still removed.
      const rejected = await pushBrowser(token, "r-2");
      expect((await rejected.json()) as { rejected?: unknown }).toHaveProperty("rejected");

      // Re-pair a browser device (the extension keeps its old token, but a
      // fresh pair is the user's explicit "resume"). The granted write:browser
      // scope is what clears the `browser` tombstone.
      const pair = await req("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ name: "chrome-2", kind: "browser", scopes: ["write:browser"] }),
      });
      const { pairingCode } = (await pair.json()) as { pairingCode: string };
      const exchange = await app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode, capabilities: { platform: "web" } }),
      });
      expect(exchange.status).toBe(200);
      const fresh = (await exchange.json()) as { token: string };

      // The new token's push is accepted and re-registers the source.
      const resumed = await pushBrowser(fresh.token, "r-3");
      expect(resumed.status).toBe(200);
      expect((await resumed.json()) as { rejected?: unknown }).not.toHaveProperty("rejected");
      expect(sourceRow("browser")).toBeDefined();
      expect(docRow("r-3")).toBeDefined();
    });

    test("a write:* token (the collector) cannot bypass removal", async () => {
      // Tombstone the source, then push via a full-scope token. Broad writers
      // may bypass pauses, but a durable removal applies to every ingest path.
      const { token } = mintToken([writeScope(SourceType("browser"))], "browser");
      await pushBrowser(token, "b-1");
      await req("/admin/sources/browser", { method: "DELETE" });

      // TEST_TOKEN holds write:* — the write is still rejected.
      const res = await req("/documents", {
        method: "POST",
        body: JSON.stringify({ documents: [browserDoc("b-2")] }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { rejected?: unknown }).toMatchObject({
        rejected: [{ sourceId: "browser", reason: "removed" }],
      });
      expect(docRow("b-2")).toBeUndefined();
    });

    // Health (Apple Health / Health Connect) pushes its records via
    // /analytics/ingest, tagged with `sourceId`. The same removal tombstone
    // must reject that path too — and the rejection fires even when no
    // analytics DB is wired (this test server has none), because it's the
    // signal that tells the device to stop.
    test("analytics ingest is rejected for a removed health source", async () => {
      // Register an Apple Health source on an ios device via the admin API
      // (mirrors the iOS opt-in's POST /admin/sources).
      const ios = createDevice(db, {
        name: "fictional-health-phone",
        kind: "ios",
        capabilities: {
          hostableSourceTypes: ["apple-health"],
          pushBasedSourceTypes: ["apple-health"],
          multiDeviceModes: { "apple-health": "replicated" },
          replicaVersionPolicies: { "apple-health": "source-updated-at" },
          syncLease: true,
        },
      });
      const created = await req("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "apple-health",
          accountId: "local",
          deviceId: ios.id,
        }),
      });
      expect(created.status).toBe(200);
      expect(sourceRow("apple-health:local")).toBeDefined();

      // Remove it, then push a health record with a scoped write:apple-health
      // token — rejected, source stays gone.
      expect((await req("/admin/sources/apple-health:local", { method: "DELETE" })).status).toBe(
        200,
      );
      const { token } = mintToken([writeScope(SourceType("apple-health"))], "ios");
      const ingest = await app.request("/analytics/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tableName: "health_activity",
          records: [{ id: "x1", steps: 100 }],
          sourceId: "apple-health:local",
        }),
      });
      expect(ingest.status).toBe(200);
      const body = (await ingest.json()) as {
        rejected?: Array<{ sourceId: string; reason: string }>;
      };
      expect(body.rejected).toEqual([{ sourceId: "apple-health:local", reason: "removed" }]);
      expect(sourceRow("apple-health:local")).toBeUndefined();
    });
  });

  // Self annotation staged at pairing-code creation lands on the
  // device at redeem, via the same write path as PATCH /admin/devices/:id.
  test("pairing flow: staged self info is applied to the device at redeem (normalized)", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "selfpaired",
        kind: "cli",
        scopes: ["admin"],
        selfEmails: ["Owner@Example.COM"],
        selfPhones: ["+1 202 555 0123"],
      }),
    });
    expect(pair.status).toBe(200);
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(exchange.status).toBe(200);
    const { device } = (await exchange.json()) as { device: { id: string } };

    // The redeem response's device snapshot predates the self-info write;
    // re-read via the admin list to assert the persisted annotation.
    const list = await req("/admin/devices");
    const { items } = (await list.json()) as {
      items: { id: string; selfEmails: string[]; selfPhones: string[] }[];
    };
    const paired = items.find((d) => d.id === device.id)!;
    expect(paired.selfEmails).toEqual(["owner@example.com"]);
    expect(paired.selfPhones).toEqual(["+12025550123"]);
  });

  test("pairing flow: without self info the device has none (default unchanged)", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "noself", kind: "cli", scopes: ["admin"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(exchange.status).toBe(200);
    const { device } = (await exchange.json()) as { device: { id: string } };

    const list = await req("/admin/devices");
    const { items } = (await list.json()) as {
      items: { id: string; selfEmails: string[]; selfPhones: string[] }[];
    };
    const paired = items.find((d) => d.id === device.id)!;
    expect(paired.selfEmails).toEqual([]);
    expect(paired.selfPhones).toEqual([]);
  });

  test("pairing flow: an unparseable self phone is rejected with 400 (code not minted)", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "selfbadphone",
        kind: "cli",
        scopes: ["admin"],
        selfPhones: ["not-a-phone"],
      }),
    });
    expect(pair.status).toBe(400);
  });

  /** Mint a nameless code for `kind` and redeem it with the given capabilities. */
  const redeemDevice = async (kind: string, capabilities: Record<string, string>) => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind, scopes: ["read"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };
    const res = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { device: { id: string; name: string } }).device;
  };

  test("pairing flow: a re-pair adopts the row by install identity, even after a rename", async () => {
    const redeem = (capabilities: Record<string, string>) => redeemDevice("ios", capabilities);

    // First pair: the phone names itself and carries its install identity.
    const first = await redeem({ suggestedName: "phone-a1b2c3", installId: "install-phone-1" });
    // The operator renames the row (display only).
    const rename = await req(`/admin/devices/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Kitchen phone" }),
    });
    expect(rename.status).toBe(200);

    // Re-pair with the same install identity but a different suggested name:
    // the renamed row is adopted, id and name intact.
    const again = await redeem({ suggestedName: "phone-zzzzzz", installId: "install-phone-1" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Kitchen phone");

    // A client that only remembers its previous device id is adopted too.
    const byPrevious = await redeem({ suggestedName: "phone-other", previousDeviceId: first.id });
    expect(byPrevious.id).toBe(first.id);

    // A different install identity is a different device, whatever it's called.
    const other = await redeem({ suggestedName: "phone-a1b2c3", installId: "install-phone-2" });
    expect(other.id).not.toBe(first.id);
  });

  test("pairing flow: an identity-adopted row keeps its name even when the suggested name is taken", async () => {
    const redeem = (capabilities: Record<string, string>) => redeemDevice("ios", capabilities);
    const first = await redeem({ suggestedName: "phone-c3d4e5", installId: "install-keep-1" });
    const rename = await req(`/admin/devices/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hallway phone" }),
    });
    expect(rename.status).toBe(200);
    // Another install now holds the auto-name the first phone was born with.
    const second = await redeem({ suggestedName: "phone-c3d4e5", installId: "install-keep-2" });
    expect(second.name).toBe("phone-c3d4e5");

    // The first phone re-pairs suggesting its birth name: adopted by identity,
    // it keeps "Hallway phone" instead of colliding with the second row.
    const again = await redeem({ suggestedName: "phone-c3d4e5", installId: "install-keep-1" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Hallway phone");
    const list = (await (await req("/admin/devices")).json()) as {
      items: { id: string; name: string }[];
    };
    expect(list.items.find((d) => d.id === second.id)?.name).toBe("phone-c3d4e5");
  });

  test("pairing flow: the name rung never adopts a row stamped with another install's identity", async () => {
    const redeem = (capabilities: Record<string, string>) => redeemDevice("ios", capabilities);
    const owner = await redeem({ suggestedName: "shared-name", installId: "install-owner" });

    // A client without an install identity that suggests the same name gets
    // its own, distinguishable row; the owner's row and identity are untouched.
    const stranger = await redeem({ suggestedName: "shared-name" });
    expect(stranger.id).not.toBe(owner.id);
    expect(stranger.name).toMatch(/^shared-name-[0-9a-f]{4}$/);
    const list = (await (await req("/admin/devices")).json()) as {
      items: { id: string; installId: string | null }[];
    };
    expect(list.items.find((d) => d.id === owner.id)?.installId).toBe("install-owner");

    // A row paired without an install identity is adopted by name and stamped
    // with the adopter's identity; from then on it belongs to that install.
    const legacy = await redeem({ suggestedName: "legacy-phone" });
    const adopted = await redeem({ suggestedName: "legacy-phone", installId: "install-adopter" });
    expect(adopted.id).toBe(legacy.id);
    const late = await redeem({ suggestedName: "legacy-phone", installId: "install-late" });
    expect(late.id).not.toBe(legacy.id);
  });

  test("pairing flow: install identity outranks a remembered device id, which is ignored across kinds and unknown ids", async () => {
    const a = await redeemDevice("ios", { suggestedName: "phone-aaaaaa", installId: "install-a" });
    const b = await redeemDevice("ios", { suggestedName: "phone-bbbbbb", installId: "install-b" });
    // A client carrying b's identity but remembering a's id is b.
    const asB = await redeemDevice("ios", {
      suggestedName: "phone-bbbbbb",
      installId: "install-b",
      previousDeviceId: a.id,
    });
    expect(asB.id).toBe(b.id);

    // A remembered id of another kind, or one the gateway never issued, is
    // not adopted: the client gets a fresh row.
    const cli = await redeemDevice("cli", { suggestedName: "build-box" });
    const crossKind = await redeemDevice("ios", {
      suggestedName: "phone-cccccc",
      previousDeviceId: cli.id,
    });
    expect(crossKind.id).not.toBe(cli.id);
    const unknown = await redeemDevice("ios", {
      suggestedName: "phone-dddddd",
      previousDeviceId: "00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.name).toBe("phone-dddddd");

    // A malformed identity is refused at the boundary rather than stored.
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", scopes: ["read"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };
    const bad = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, capabilities: { installId: 123 } }),
    });
    expect(bad.status).toBe(400);
  });

  test("pairing flow: a revoked device that pairs again is reclaimed by its remembered id", async () => {
    const phone = await redeemDevice("ios", {
      suggestedName: "phone-eeeeee",
      installId: "install-e",
    });
    const revoke = await req(`/admin/devices/${phone.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    const back = await redeemDevice("ios", {
      suggestedName: "phone-ffffff",
      previousDeviceId: phone.id,
    });
    expect(back.id).toBe(phone.id);
    const list = (await (await req("/admin/devices")).json()) as {
      items: { id: string; revokedAt: number | null; installId: string | null }[];
    };
    const row = list.items.find((d) => d.id === phone.id);
    expect(row?.revokedAt).toBeNull();
    expect(row?.installId).toBe("install-e");
  });

  test("name is optional — device's suggestedName is used when admin skips it", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", scopes: ["admin"] }),
    });
    expect(pair.status).toBe(200);
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        capabilities: { suggestedName: "Maya-iPhone-iphone", platform: "ios" },
      }),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { device: { name: string } };
    expect(body.device.name).toBe("Maya-iPhone-iphone");
  });

  test("name is optional — falls back to <kind>-<short> when no suggestedName", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "cli", scopes: ["read"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { device: { name: string } };
    expect(body.device.name).toMatch(/^cli-[0-9a-f]{8}$/);
  });

  test("admin name still wins over device suggestedName", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "kitchen-ipad", kind: "ios", scopes: ["admin"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingCode,
        capabilities: { suggestedName: "should-be-ignored" },
      }),
    });
    const body = (await exchange.json()) as { device: { name: string } };
    expect(body.device.name).toBe("kitchen-ipad");
  });

  test("pairing flow: /devices/pair rate-limits brute-force attempts (429 + Retry-After)", async () => {
    // The pairing limiter's burst capacity is 10/min per source IP, and every
    // test request shares one IP, so a rapid run of bogus-code attempts empties
    // the bucket and the next is refused. Guards the route wiring (pairing.ts)
    // that defends a 40-bit code over its 10-minute TTL — without this, deleting
    // the limiter guard would still pass every other pairing test.
    let refusal: Response | undefined;
    for (let i = 0; i < 15; i++) {
      const res = await app.request("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: "DEADBEEF99" }),
      });
      if (res.status === 429) {
        refusal = res;
        break;
      }
    }
    expect(refusal, "expected a 429 once the per-IP burst bucket emptied").toBeDefined();
    expect(refusal?.headers.get("Retry-After")).toBe("60");
  });

  test("pairing flow: an expired code is rejected at redeem (400)", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "cli", scopes: ["read"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    // Force the staged code past its TTL, then redeem — exercises the real
    // consumePairing expiry branch over HTTP (previously covered only at the
    // SQL layer).
    db.prepare("UPDATE device_pairings SET expires_at = ? WHERE pairing_code = ?").run(
      Date.now() - 1000,
      pairingCode,
    );

    const exchange = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(exchange.status).toBe(400);
  });

  test("pairing flow: a name held by a different-kind device is rejected (409)", async () => {
    // Pair a cli device named "shared-host".
    const first = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "shared-host", kind: "cli", scopes: ["read"] }),
    });
    const { pairingCode: code1 } = (await first.json()) as { pairingCode: string };
    const r1 = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: code1 }),
    });
    expect(r1.status).toBe(200);

    // A second pairing for a DIFFERENT kind under the same name is refused —
    // the name is the re-pair dedup key and can't be silently re-homed across
    // kinds.
    const second = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "shared-host", kind: "ios", scopes: ["admin"] }),
    });
    const { pairingCode: code2 } = (await second.json()) as { pairingCode: string };
    const r2 = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: code2 }),
    });
    expect(r2.status).toBe(409);
  });

  test("/admin/devices/pair includes tlsFingerprint when configured", async () => {
    const fp = "f".repeat(64);
    const customApp = createServer(db, undefined, { tlsFingerprintSha256: fp });
    const res = await customApp.request("/admin/devices/pair", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "ios", scopes: ["admin"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tlsFingerprint: string };
    expect(typeof body.tlsFingerprint).toBe("string");
    expect(body.tlsFingerprint).toHaveLength(64);
    expect(body.tlsFingerprint).toBe(fp);
  });

  test("/admin/devices/pair returns empty tlsFingerprint when unconfigured", async () => {
    // Default test server (the shared `app` built in beforeEach) carries no
    // tlsFingerprintSha256; the field should still be present, just empty.
    const res = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "cli", scopes: ["read"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tlsFingerprint: string };
    expect(body.tlsFingerprint).toBe("");
  });

  /** Mint a pending pairing code; pair-qr judges addresses for the phone it names. */
  async function mintPairingCode(kind: "ios" | "android" = "android"): Promise<string> {
    const res = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { pairingCode: string }).pairingCode;
  }

  test("/admin/devices/pair-qr emits V3 with fingerprint when TLS is configured", async () => {
    const pairingCode = await mintPairingCode();
    const fp = "a".repeat(64);
    const customApp = createServer(db, undefined, { tlsFingerprintSha256: fp });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://10.0.0.5:7600",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qrPayload: string };
    const parsed = JSON.parse(body.qrPayload);
    expect(parsed).toEqual({
      v: 3,
      gatewayUrl: "https://10.0.0.5:7600",
      pairingCode,
      fingerprint: fp,
    });
  });

  test("/admin/devices/pair-qr falls back to V2 when TLS is unconfigured", async () => {
    const pairingCode = await mintPairingCode();
    const res = await req("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://10.0.0.5:7600",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qrPayload: string };
    const parsed = JSON.parse(body.qrPayload);
    expect(parsed).toEqual({
      v: 2,
      gatewayUrl: "https://10.0.0.5:7600",
      pairingCode,
    });
  });

  test("/admin/devices/pair-qr emits V4 with system trust for an allowlisted origin", async () => {
    const pairingCode = await mintPairingCode();
    const customApp = createServer(db, undefined, {
      systemTrustPairingOrigins: ["https://public-gateway.example.com"],
    });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://public-gateway.example.com",
        trustMode: "system",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qrPayload: string };
    expect(JSON.parse(body.qrPayload)).toEqual({
      v: 4,
      gatewayUrl: "https://public-gateway.example.com",
      pairingCode,
      tls: { mode: "system" },
    });
  });

  test("/admin/devices/pair-qr automatically selects stable trust for an allowlisted origin", async () => {
    const pairingCode = await mintPairingCode();
    const customApp = createServer(db, undefined, {
      tlsFingerprintSha256: "b".repeat(64),
      systemTrustPairingOrigins: ["https://public-gateway.example.com:7600"],
    });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://public-gateway.example.com:7600",
        trustMode: "auto",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qrPayload: string };
    expect(JSON.parse(body.qrPayload)).toEqual({
      v: 4,
      gatewayUrl: "https://public-gateway.example.com:7600",
      pairingCode,
      tls: { mode: "system" },
    });
  });

  test("/admin/devices/pair-qr rejects system trust for a non-allowlisted origin", async () => {
    const pairingCode = await mintPairingCode();
    const customApp = createServer(db, undefined, {
      systemTrustPairingOrigins: ["https://public-gateway.example.com"],
    });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://attacker.example.org",
        trustMode: "system",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("/admin/devices/pair-qr emits V4 pinned-leaf trust when explicitly requested", async () => {
    const pairingCode = await mintPairingCode();
    const fp = "b".repeat(64);
    const customApp = createServer(db, undefined, { tlsFingerprintSha256: fp });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairingCode,
        gatewayUrl: "https://10.0.0.5:7600",
        trustMode: "pinned-leaf",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qrPayload: string };
    expect(JSON.parse(body.qrPayload)).toEqual({
      v: 4,
      gatewayUrl: "https://10.0.0.5:7600",
      pairingCode,
      tls: { mode: "pinned-leaf", fingerprint: fp },
    });
  });

  test("/admin/devices/pair-qr refuses an iPhone a Tailscale IP", async () => {
    const pairingCode = await mintPairingCode("ios");
    const customApp = createServer(db, undefined, { tlsFingerprintSha256: "a".repeat(64) });
    const res = await customApp.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, gatewayUrl: "https://100.101.102.103:7600" }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/Tailscale IP address/);
  });

  test("/admin/devices/pair-qr refuses a code that is not pending", async () => {
    const res = await req("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({ pairingCode: "ABCDEF0123", gatewayUrl: "https://10.0.0.5:7600" }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/expired or was already used/);
  });

  test("/admin/devices/pair-addresses judges each address for the phone behind the code", async () => {
    const pairingCode = await mintPairingCode("ios");
    const res = await req("/admin/devices/pair-addresses", {
      method: "POST",
      body: JSON.stringify({ pairingCode }),
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      platform: string;
      addresses: Array<{ gatewayUrl: string; usable: boolean }>;
      recommendedUrl: string | null;
    };
    expect(plan.platform).toBe("ios");
    expect(Array.isArray(plan.addresses)).toBe(true);
    expect(plan.recommendedUrl).toBe(plan.addresses.find((a) => a.usable)?.gatewayUrl ?? null);
  });

  test("/admin/devices/pair-addresses refuses a code that is not pending", async () => {
    const res = await req("/admin/devices/pair-addresses", {
      method: "POST",
      body: JSON.stringify({ pairingCode: "ABCDEF0123" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/self/candidate", () => {
  function insertDoc(sourceId: string, id: string): void {
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'p', ?, ?, 't', 'c', 'h', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, sourceId, id);
  }

  test("proposes the single email-shaped source account when no self exists", async () => {
    insertDoc("gmail:me@example.com", "d1");
    const res = await req("/admin/self/candidate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: { email: string; sourceId: string } | null };
    expect(body.candidate).toEqual({ email: "me@example.com", sourceId: "gmail:me@example.com" });
  });

  test("proposes nothing once a canonical self exists", async () => {
    insertDoc("gmail:me@example.com", "d1");
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES ('self', 'Maya', 'config', TRUE, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    const res = await req("/admin/self/candidate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: unknown };
    expect(body.candidate).toBeNull();
  });

  test("requires admin scope", async () => {
    const res = await app.request("/admin/self/candidate", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("portal security headers", () => {
  test("index.html carries CSP + X-Frame-Options + X-Content-Type-Options + Referrer-Policy", async () => {
    const res = await app.request("/portal/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    // Strict CSP keeps script/style/connect/img to 'self' (vendoring
    // means we no longer trust any third-party CDN).
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  test("CSP does NOT permit https://esm.sh or any third-party origin in script-src", async () => {
    const res = await app.request("/portal/");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toMatch(/esm\.sh/);
    expect(csp).not.toMatch(/script-src[^;]*\bhttps?:\b/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("CSP script-src contains a sha256 hash matching the index.html importmap", async () => {
    // Without this hash, Chrome blocks the inline `<script type="importmap">`
    // and every bare module specifier ("htm/preact", "preact", …) fails
    // to resolve — the portal renders as a black screen on fresh tab loads.
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html = readFileSync(join(import.meta.dirname, "..", "portal", "index.html"), "utf8");
    const importmap = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i);
    expect(importmap).not.toBeNull();
    const expectedHash = createHash("sha256").update(importmap![1], "utf8").digest("base64");

    const res = await app.request("/portal/");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    // script-src allow-lists every inline script (importmap + theme bootstrap)
    // by hash, so assert the importmap hash is present rather than pinning it
    // to a fixed position after 'self'.
    expect(csp).toMatch(/script-src 'self' /);
    expect(csp).toContain(`'sha256-${expectedHash}'`);
  });

  test("CSP script-src allow-lists the inline theme-bootstrap script", async () => {
    // The no-flash theme script in index.html runs before paint to apply the
    // saved light/dark preference. Under the strict CSP it only executes if
    // its exact SHA-256 is allow-listed — otherwise the saved theme is
    // ignored on load and a light-mode user reloads into a dark flash.
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html = readFileSync(join(import.meta.dirname, "..", "portal", "index.html"), "utf8");
    // The bootstrap is the only inline <script> with neither `type` nor `src`.
    const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/i);
    expect(bootstrap).not.toBeNull();
    const expectedHash = createHash("sha256").update(bootstrap![1], "utf8").digest("base64");

    const res = await app.request("/portal/");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(`'sha256-${expectedHash}'`);
  });

  test("non-html portal assets get nosniff + frame-deny but no CSP", async () => {
    // Vendored bundles are subresources; CSP on JS/CSS responses is
    // meaningless. The content-type-options + frame-options stay on
    // every response so a stray request can't be reinterpreted.
    const res = await app.request("/portal/js/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("vendored ESM bundles are served from /portal/vendor/", async () => {
    // Sanity: the always-on shell deps must resolve through the
    // local vendor route (no CDN fallback).
    const res = await app.request("/portal/vendor/preact.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("index.html importmap points at /portal/vendor/, not at https://esm.sh/", async () => {
    const res = await app.request("/portal/");
    const body = await res.text();
    expect(body).toContain("/portal/vendor/preact.js");
    expect(body).toContain("/portal/vendor/marked.js");
    expect(body).toContain("/portal/vendor/dompurify.js");
    // The only mention of esm.sh is in the explanatory comment about
    // the migration — never as a live URL on a script/link tag.
    expect(body).not.toMatch(/<(?:script|link)[^>]*esm\.sh/);
  });
});

describe("portal login endpoint", () => {
  // Mint a nameless portal pairing code (no admin name) — the case where the
  // browser-supplied deviceName decides which device row the login lands on.
  const mintNamelessPortalCode = async () => {
    const p = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "portal", scopes: ["read"] }),
    });
    return ((await p.json()) as { pairingCode: string }).pairingCode;
  };

  test("rejects missing input", async () => {
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("accepts a valid bearer token and sets a session cookie", async () => {
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__omnesis_session=");
    const body = (await res.json()) as { ok: boolean; scopes: Scope[]; csrfToken: string };
    expect(body.ok).toBe(true);
    expect(body.scopes).toContain(SCOPE_ADMIN);
    expect(body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("authenticated portal requests refresh the session cookie only when due", async () => {
    const dev = createDevice(db, { name: `portal-${randomUUID()}`, kind: "portal" });
    const { id: tokenId } = createToken(db, dev.id, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const sessionApp = createServer(db, undefined, {
      timings: { sessionTtlMs: 60_000, sessionRefreshThrottleMs: 10_000 },
    });

    let res = await sessionApp.request("/portal/api/session", {
      headers: { Cookie: `__omnesis_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const sessionBody = (await res.clone().json()) as { csrfToken: string };
    expect(sessionBody.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Set-Cookie")).toBeNull();

    db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
      Date.now() - 11_000,
      storedSessionRowId(db, sessionId),
    );
    res = await sessionApp.request("/portal/api/session", {
      headers: { Cookie: `__omnesis_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const refreshedCookie = res.headers.get("Set-Cookie") ?? "";
    expect(refreshedCookie).toContain(`__omnesis_session=${sessionId}`);
    expect(refreshedCookie).toContain("Max-Age=60");
  });

  test("authenticated portal requests record activity for the session's device", async () => {
    const dev = createDevice(db, { name: `portal-${randomUUID()}`, kind: "portal" });
    const { id: tokenId } = createToken(db, dev.id, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const note = vi.fn();
    const sessionApp = createServer(db, undefined, {
      tokenUsageBuffer: {
        note,
        drain: () => [],
        size: () => 0,
      },
    });

    const res = await sessionApp.request("/portal/api/session", {
      headers: { Cookie: `__omnesis_session=${sessionId}` },
    });

    expect(res.status).toBe(200);
    expect(note).toHaveBeenCalledWith(tokenId, dev.id);
  });

  test("raw-token portal sessions do not record browser activity against a CLI device", async () => {
    const dev = createDevice(db, { name: `cli-${randomUUID()}`, kind: "cli" });
    const { id: tokenId } = createToken(db, dev.id, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const note = vi.fn();
    const sessionApp = createServer(db, undefined, {
      tokenUsageBuffer: {
        note,
        drain: () => [],
        size: () => 0,
      },
    });

    const res = await sessionApp.request("/portal/api/session", {
      headers: { Cookie: `__omnesis_session=${sessionId}` },
    });

    expect(res.status).toBe(200);
    expect(note).not.toHaveBeenCalled();
  });

  test("rejects an invalid bearer token", async () => {
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "omn_deadbeef" }),
    });
    expect(res.status).toBe(401);
  });

  test("redeems a portal pairing code into a session + mints a device", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "laptop-portal", kind: "portal", scopes: ["admin"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pairingCode }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie") ?? "").toContain("__omnesis_session=");
    const body = (await res.json()) as { ok: boolean; scopes: Scope[] };
    expect(body.scopes).toContain(SCOPE_ADMIN);

    // The new portal device is in the registry under the pairing's name.
    const list = await req("/admin/devices");
    const names = ((await list.json()) as { items: { name: string; kind: string }[] }).items
      .filter((d) => d.kind === "portal")
      .map((d) => d.name);
    expect(names).toContain("laptop-portal");

    // Pairing code is one-shot — second attempt fails.
    const replay = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pairingCode }),
    });
    expect(replay.status).toBe(401);
  });

  test("a portal browser re-login adopts its renamed device row by install identity", async () => {
    const login = (deviceName: string, token: string) =>
      app.request("/portal/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, deviceName, installId: "install-portal-1" }),
      });
    const portalDevices = async () =>
      (
        (await (await req("/admin/devices")).json()) as {
          items: { id: string; name: string; kind: string }[];
        }
      ).items.filter((d) => d.kind === "portal");

    expect((await login("Portal cccc3333", await mintNamelessPortalCode())).status).toBe(200);
    const row = (await portalDevices()).find((d) => d.name === "Portal cccc3333");
    expect(row).toBeDefined();
    const rename = await req(`/admin/devices/${row!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Study laptop" }),
    });
    expect(rename.status).toBe(200);

    // The same browser (same install identity) logs in with a fresh code and
    // a different cached device name: no new row, the rename sticks.
    expect((await login("Portal dddd4444", await mintNamelessPortalCode())).status).toBe(200);
    const after = await portalDevices();
    expect(after.filter((d) => d.id === row!.id).map((d) => d.name)).toEqual(["Study laptop"]);
    expect(after.some((d) => d.name === "Portal dddd4444")).toBe(false);
  });

  test("distinct nameless portal browsers keep distinct devices — neither evicts the other's session", async () => {
    // Regression for the two-machine logout: a nameless portal pairing used to
    // resolve to the shared canonical name "portal", so a second browser's
    // login replaced the first's device row and cascade-deleted its session.
    // With each browser sending its own stable `deviceName`, the rows stay
    // distinct and both sessions survive.
    const sessionCookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0];

    const loginA = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: await mintNamelessPortalCode(),
        deviceName: "Portal aaaa1111",
      }),
    });
    expect(loginA.status).toBe(200);
    const cookieA = sessionCookieOf(loginA);
    expect(cookieA).toContain("__omnesis_session=");

    const loginB = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: await mintNamelessPortalCode(),
        deviceName: "Portal bbbb2222",
      }),
    });
    expect(loginB.status).toBe(200);
    const cookieB = sessionCookieOf(loginB);

    // Two distinct portal device rows — no collapse onto a shared "portal".
    const list = await req("/admin/devices");
    const portalNames = ((await list.json()) as { items: { name: string; kind: string }[] }).items
      .filter((d) => d.kind === "portal")
      .map((d) => d.name);
    expect(portalNames).toContain("Portal aaaa1111");
    expect(portalNames).toContain("Portal bbbb2222");

    // The crux: A's session still authenticates AFTER B logged in.
    const aStillIn = await app.request("/portal/api/session", { headers: { Cookie: cookieA } });
    expect(((await aStillIn.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const bStillIn = await app.request("/portal/api/session", { headers: { Cookie: cookieB } });
    expect(((await bStillIn.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });

  test("re-pairing the SAME browser reuses its device row (no accumulation)", async () => {
    const portalCount = async () => {
      const list = await req("/admin/devices");
      return ((await list.json()) as { items: { name: string; kind: string }[] }).items.filter(
        (d) => d.kind === "portal" && d.name === "Portal cccc3333",
      ).length;
    };

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/portal/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: await mintNamelessPortalCode(),
          deviceName: "Portal cccc3333",
        }),
      });
      expect(res.status).toBe(200);
    }
    // Same stable name across three pairings → exactly one row, not three.
    expect(await portalCount()).toBe(1);
  });

  test("nameless login without a deviceName still succeeds and falls back to 'portal'", async () => {
    // Backward-compat: an older cached SPA sends no deviceName. Login must still
    // work, and the device resolves to the canonical "portal" name.
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: await mintNamelessPortalCode() }),
    });
    expect(res.status).toBe(200);
    const list = await req("/admin/devices");
    const portalNames = ((await list.json()) as { items: { name: string; kind: string }[] }).items
      .filter((d) => d.kind === "portal")
      .map((d) => d.name);
    expect(portalNames).toContain("portal");
  });

  test("accepts lowercase pairing codes", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "lc-portal", kind: "portal", scopes: ["admin"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pairingCode.toLowerCase() }),
    });
    expect(res.status).toBe(200);
  });

  test("rejects a non-portal pairing code without burning it", async () => {
    const pair = await req("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "cli-code", kind: "cli", scopes: ["admin"] }),
    });
    const { pairingCode } = (await pair.json()) as { pairingCode: string };

    // Portal login on a cli code is a generic miss (401), not a distinct
    // "wrong kind" signal — and crucially it must NOT consume the code.
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pairingCode }),
    });
    expect(res.status).toBe(401);

    // The code is still redeemable by the kind it was minted for.
    const redeem = await app.request("/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode }),
    });
    expect(redeem.status).toBe(200);
  });

  test("rejects an invalid pairing code", async () => {
    const res = await app.request("/portal/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "0123456789" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("token management endpoints", () => {
  test("POST /admin/tokens mints a second token for a device", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "multi", kind: "cli", scopes: ["admin"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const res = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["read"], name: "readonly" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; scopes: string[] };
    expect(body.scopes).toEqual(["read"]);
    expect(body.token).toMatch(/^omn_[a-f0-9]{32}$/);
  });

  test("POST /admin/tokens honors ttlMs (expiry) and defaults to never-expire", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "ttl-dev", kind: "cli", scopes: ["admin"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    // With ttlMs → response echoes a future expiresAt and the row gets expires_at.
    const res = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["read"], ttlMs: 3_600_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; expiresAt: number | null };
    expect(body.expiresAt).not.toBeNull();
    expect(body.expiresAt as number).toBeGreaterThan(Date.now());
    const row = db
      .prepare<
        [string],
        { expires_at: number | null }
      >("SELECT expires_at FROM tokens WHERE id = ?")
      .get(body.id);
    expect(row?.expires_at).toBeGreaterThan(Date.now());

    // Without ttlMs → never expires (expiresAt null, row null) — protects existing tokens.
    const res2 = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id, scopes: ["read"] }),
    });
    const body2 = (await res2.json()) as { id: string; expiresAt: number | null };
    expect(body2.expiresAt).toBeNull();
    const row2 = db
      .prepare<
        [string],
        { expires_at: number | null }
      >("SELECT expires_at FROM tokens WHERE id = ?")
      .get(body2.id);
    expect(row2?.expires_at).toBeNull();
  });

  test("DELETE /admin/tokens/:id revokes the token", async () => {
    const { deviceId } = mintToken([SCOPE_ADMIN]);
    const res = await req("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId, scopes: ["read"] }),
    });
    const { id } = (await res.json()) as { id: string };
    const del = await req(`/admin/tokens/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });
});

describe("POST /documents", () => {
  test("ingests documents and returns count", async () => {
    const res = await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(2);
  });

  test("returns 400 when documents array is missing", async () => {
    const res = await req("/documents", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("wakes the indexer when documents are upserted", async () => {
    let wakes = 0;
    const customApp = createServer(db, undefined, {
      indexerControl: {
        reindexMissing: async () => ({ indexed: 0, errors: 0 }),
        wake: () => {
          wakes++;
        },
      },
    });

    const res = await customApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [makeDocPayload("wake-1"), makeDocPayload("wake-2")],
      }),
    });
    expect(res.status).toBe(200);
    expect(wakes).toBe(1);
  });

  test("does not wake when the cutoff filter drops every document", async () => {
    let wakes = 0;
    const customApp = createServer(db, undefined, {
      config: { dataRetention: { maxAge: "1h" } },
      indexerControl: {
        reindexMissing: async () => ({ indexed: 0, errors: 0 }),
        wake: () => {
          wakes++;
        },
      },
    });

    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const res = await customApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [{ ...makeDocPayload("stale-1"), sourceCreatedAt: stale }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0 });
    expect(wakes).toBe(0);
  });
});

describe("POST /documents/delete", () => {
  test("deletes specified documents", async () => {
    // Insert first
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/documents/delete", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        externalIds: ["msg-1"],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);
  });

  test("returns 400 when fields are missing", async () => {
    const res = await req("/documents/delete", {
      method: "POST",
      body: JSON.stringify({ providerId: "google" }),
    });
    expect(res.status).toBe(400);
  });

  // A deletion-only batch (e.g. a documents-only push source like Photos
  // reporting removed assets, with nothing new to ingest this cycle) has
  // no other call site that would surface a removed/paused rejection —
  // this is the ONLY gate for it, so it must not silently apply a
  // paused/removed source's buffered deletions.
  test("paused source: deletions are rejected with reason 'paused' and the documents survive", async () => {
    const { token } = mintToken([writeScope(SourceType("photos"))], "ios");
    const push = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [makeDocPayload("photo-1", "photos", "photos:local")] }),
    });
    expect(push.status).toBe(200);

    const patch = await req("/admin/sources/photos:local", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    const del = await app.request("/documents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "photos:local",
        sourceId: "photos:local",
        externalIds: ["photo-1"],
      }),
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      deleted: number;
      rejected?: Array<{ sourceId: string; reason: string }>;
    };
    expect(body.deleted).toBe(0);
    expect(body.rejected).toEqual([{ sourceId: "photos:local", reason: "paused" }]);

    const count = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE source_id = 'photos:local'")
      .get();
    expect(count?.count).toBe(1);
  });

  test("removed source: deletions are rejected with reason 'removed'", async () => {
    const { token } = mintToken([writeScope(SourceType("photos"))], "ios");
    const push = await app.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: [makeDocPayload("photo-2", "photos", "photos:local")] }),
    });
    expect(push.status).toBe(200);

    const remove = await req("/admin/sources/photos:local", { method: "DELETE" });
    expect(remove.status).toBe(200);

    const del = await app.request("/documents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "photos:local",
        sourceId: "photos:local",
        externalIds: ["photo-2"],
      }),
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      deleted: number;
      rejected?: Array<{ sourceId: string; reason: string }>;
    };
    expect(body.deleted).toBe(0);
    expect(body.rejected).toEqual([{ sourceId: "photos:local", reason: "removed" }]);
  });
});

describe("DELETE /documents/:id (single-document privacy delete)", () => {
  async function ingest(...externalIds: string[]) {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: externalIds.map((e) => makeDocPayload(e)) }),
    });
  }

  function docId(externalId: string): string {
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId);
    if (!row) throw new Error(`no document for ${externalId}`);
    return row.id;
  }

  test("deletes the document by id and reports the row count", async () => {
    await ingest("msg-1", "msg-2");
    const id = docId("msg-1");

    const res = await req(`/documents/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });

    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["msg-2"]);
  });

  test("cascades to attachment children", async () => {
    await ingest("msg-1", "msg-1/att/a1", "msg-2");
    const id = docId("msg-1");

    const res = await req(`/documents/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["msg-2"]);
  });

  test("tombstone keeps the page gone when the source re-ingests it", async () => {
    await ingest("msg-1", "msg-2");
    const id = docId("msg-1");
    await req(`/documents/${id}`, { method: "DELETE" });

    // The collector / browser pushes the same page again.
    const reIngest = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("msg-1")] }),
    });
    expect(reIngest.status).toBe(200);
    // The durable tombstone drops it at the repository choke point, so the
    // row is never re-created, and the response names the refused page so a
    // push client can stop re-sending it.
    expect(await reIngest.json()).toEqual({ ingested: 0, suppressed: ["msg-1"] });
    const count = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE external_id = 'msg-1'")
      .get();
    expect(count?.count).toBe(0);
  });

  test("?tombstone=0 deletes this copy only, so the source may bring the page back", async () => {
    await ingest("msg-1", "msg-2");
    const id = docId("msg-1");

    const res = await req(`/documents/${id}?tombstone=0`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM removed_documents").get()
        ?.count,
    ).toBe(0);

    const reIngest = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("msg-1")] }),
    });
    expect(await reIngest.json()).toEqual({ ingested: 1 });
    expect(docId("msg-1")).toBeTruthy();
  });

  test("rejects a tombstone flag that is not a boolean", async () => {
    await ingest("msg-1");
    const res = await req(`/documents/${docId("msg-1")}?tombstone=maybe`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  test("accepts an unambiguous id prefix", async () => {
    await ingest("msg-1");
    const id = docId("msg-1");

    const res = await req(`/documents/${id.slice(0, 8)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
  });

  test("returns 404 for an unknown id", async () => {
    const res = await req(`/documents/${randomUUID()}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("rejects a read-only token with 403", async () => {
    await ingest("msg-1");
    const id = docId("msg-1");
    const readOnly = mintToken([SCOPE_READ]).token;

    const res = await app.request(`/documents/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readOnly}` },
    });
    expect(res.status).toBe(403);
    // The document is untouched.
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);
  });
});

describe("GET /documents/stats/:sourceId", () => {
  test("returns empty stats for unknown source", async () => {
    const res = await req("/documents/stats/unknown");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documentCount).toBe(0);
    expect(data.earliestSourceDate).toBeNull();
    expect(data.latestSourceDate).toBeNull();
  });

  test("returns date range and counts after ingesting docs", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("msg-1"),
            sourceCreatedAt: "2024-01-10T08:00:00Z",
          },
          {
            ...makeDocPayload("msg-2"),
            sourceCreatedAt: "2024-06-15T12:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/documents/stats/gmail");
    const data = await res.json();
    expect(data.documentCount).toBe(2);
    expect(data.earliestSourceDate).toBe("2024-01-10T08:00:00Z");
    expect(data.latestSourceDate).toBe("2024-06-15T12:00:00Z");
  });

  test("sums messageCount from metadata.extra", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("chat-1"),
            sourceId: "whatsapp-messages",
            metadata: { extra: { messageCount: 15 } },
          },
          {
            ...makeDocPayload("chat-2"),
            sourceId: "whatsapp-messages",
            metadata: { extra: { messageCount: 30 } },
          },
        ],
      }),
    });

    const res = await req("/documents/stats/whatsapp-messages");
    const data = await res.json();
    expect(data.documentCount).toBe(2);
    expect(data.totalUnitCount).toBe(45);
  });
});

describe("POST /documents/stats (bulk)", () => {
  test("returns one row per requested sourceId", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("a"), sourceId: "gmail", sourceCreatedAt: "2024-01-10T08:00:00Z" },
          { ...makeDocPayload("b"), sourceId: "gmail", sourceCreatedAt: "2024-06-15T12:00:00Z" },
          { ...makeDocPayload("c"), sourceId: "calendar", sourceCreatedAt: "2024-04-01T09:00:00Z" },
        ],
      }),
    });

    const res = await req("/documents/stats", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["gmail", "calendar", "unknown"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data.stats).sort()).toEqual(["calendar", "gmail", "unknown"]);
    expect(data.stats.gmail.documentCount).toBe(2);
    expect(data.stats.calendar.documentCount).toBe(1);
    expect(data.stats.unknown.documentCount).toBe(0);
    expect(data.stats.unknown.earliestSourceDate).toBeNull();
  });

  test("rejects more than 100 source IDs", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `src-${i}`);
    const res = await req("/documents/stats", {
      method: "POST",
      body: JSON.stringify({ sourceIds: tooMany }),
    });
    expect(res.status).toBe(400);
  });

  test("empty input returns empty map", async () => {
    const res = await req("/documents/stats", {
      method: "POST",
      body: JSON.stringify({ sourceIds: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stats: {} });
  });

  test("dedups input source IDs", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("d"), sourceId: "gmail", sourceCreatedAt: "2024-01-10T08:00:00Z" },
        ],
      }),
    });
    const res = await req("/documents/stats", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["gmail", "gmail", "gmail"] }),
    });
    const data = await res.json();
    expect(Object.keys(data.stats)).toEqual(["gmail"]);
  });
});

describe("sync state endpoints", () => {
  test("rejects malformed source ids before sync-state writes", async () => {
    const res = await req("/sync-state/bad%0Aid/begin", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("returns null cursor for unknown source", async () => {
    const res = await req("/sync-state/unknown");
    expect(res.status).toBe(200);
    // wipeEpoch is 0 for a source that has never been wiped.
    expect(await res.json()).toEqual({ cursor: null, lastSyncedAt: null, wipeEpoch: 0 });
  });

  test("stores and retrieves sync state", async () => {
    const setRes = await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({ cursor: { historyId: "12345" } }),
    });
    expect(setRes.status).toBe(200);

    const getRes = await req("/sync-state/gmail");
    const data = await getRes.json();
    expect(data.cursor).toEqual({ historyId: "12345" });
    expect(data.lastSyncedAt).toBeTruthy();
  });

  test("a source's own identity and its family's both cross the cursor write", async () => {
    // A hop that re-lists the meta fields by name drops any field added to
    // the schema and the store but not to the list. This pins that the whole
    // meta object crosses, family included.
    const png = (fill: string) =>
      `data:image/svg+xml;base64,${Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`,
      ).toString("base64")}`;
    const setRes = await req("/sync-state/example-browser:one", {
      method: "POST",
      body: JSON.stringify({
        cursor: { phase: "done" },
        icon: png("#111111"),
        label: "BrowserOne",
        family: { icon: png("#222222"), label: "Browsers" },
      }),
    });
    expect(setRes.status).toBe(200);

    const meta = await (await req("/portal/source-meta.json")).json();
    expect(meta["example-browser:one"]).toMatchObject({ label: "BrowserOne" });
    expect(meta["example-browser"]).toMatchObject({ label: "Browsers" });
    // Both icons are rasterised on the way in, so a consumer never receives a
    // declaration in one form and a rendered image in the other.
    expect(meta["example-browser:one"].icon).toMatch(/^data:image\/png;base64,/);
    expect(meta["example-browser"].icon).toMatch(/^data:image\/png;base64,/);
    expect(meta["example-browser"].icon).not.toBe(meta["example-browser:one"].icon);
  });

  test("legacy cursor writes cannot regress a claimed source", async () => {
    await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({ cursor: { historyId: "current" } }),
    });
    const { wipeEpoch } = await (await req("/sync-state/gmail/begin", { method: "POST" })).json();

    const stale = await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({ cursor: { historyId: "stale" } }),
    });
    expect(await stale.json()).toEqual({ ok: false, rejected: true });
    expect((await (await req("/sync-state/gmail")).json()).cursor).toEqual({
      historyId: "current",
    });

    const current = await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({ cursor: { historyId: "next" }, writeEpoch: wipeEpoch }),
    });
    expect(await current.json()).toEqual({ ok: true });
    expect((await (await req("/sync-state/gmail")).json()).cursor).toEqual({
      historyId: "next",
    });
  });

  test("legacy document mutations require the claimed source epoch", async () => {
    const { wipeEpoch } = await (await req("/sync-state/gmail/begin", { method: "POST" })).json();

    const staleInsert = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("stale-insert")] }),
    });
    expect(await staleInsert.json()).toMatchObject({
      ingested: 0,
      rejectedSourceIds: ["gmail"],
    });

    const currentInsert = await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("kept"), makeDocPayload("victim")],
        writeEpochs: { gmail: wipeEpoch },
      }),
    });
    expect(await currentInsert.json()).toMatchObject({ ingested: 2 });

    const staleDelete = await req("/documents/delete", {
      method: "POST",
      body: JSON.stringify({ providerId: "google", sourceId: "gmail", externalIds: ["kept"] }),
    });
    expect(await staleDelete.json()).toEqual({ deleted: 0 });

    const staleReconcile = await req("/documents/reconcile", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["kept"],
      }),
    });
    // A stale epoch has no authority over the source at all: the snapshot is
    // not even diffed, so it records nothing.
    expect(await staleReconcile.json()).toEqual({ deleted: 0, deletedIds: [] });

    const currentReconcile = await req("/documents/reconcile", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["kept"],
        writeEpoch: wipeEpoch,
      }),
    });
    // Under the claimed epoch the snapshot is honoured — and honouring it means
    // recording the omission, not applying it.
    expect(await currentReconcile.json()).toMatchObject({
      deleted: 0,
      absence: { marked: 1, absent: 1 },
    });

    const currentDelete = await req("/documents/delete", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        externalIds: ["kept"],
        writeEpoch: wipeEpoch,
      }),
    });
    expect(await currentDelete.json()).toEqual({ deleted: 1 });
  });

  test("a partitioned source keeps one stream per device: namesake documents coexist, exists and privacy deletes stay in the device's stream", async () => {
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const type = SourceType("visits-synth");
    const modes = { [type]: "partitioned" as const };
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [type],
          multiDeviceModes: modes,
          memberScopedParams: { [type]: [] },
          syncLease: true,
        },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const source = createSource(db, {
      type,
      accountId: AccountId("local"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
    });
    addSourceMember(db, source.id, beta.id);
    const as =
      (token: string) =>
      (path: string, init: RequestInit = {}) =>
        app.request(path, {
          method: "POST",
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
    const alphaToken = createToken(db, alpha.id, [SCOPE_WRITE_ALL, SCOPE_READ]).token;
    const betaToken = createToken(db, beta.id, [SCOPE_WRITE_ALL, SCOPE_READ]).token;
    const asAlpha = as(alphaToken);
    const asBeta = as(betaToken);
    const day = (externalId: string) => makeDocPayload(externalId, "visits-synth", source.id);

    for (const push of [asAlpha, asBeta]) {
      expect(
        await (
          await push("/documents", { body: JSON.stringify({ documents: [day("day-1")] }) })
        ).json(),
      ).toMatchObject({ ingested: 1 });
    }
    const count = async () =>
      (
        (await (await req(`/documents/count/${encodeURIComponent(source.id)}`)).json()) as {
          count: number;
        }
      ).count;
    expect(await count()).toBe(2);
    const exists = async (push: typeof asAlpha) =>
      (
        (await (
          await push("/documents/exists", {
            body: JSON.stringify({
              providerId: "visits-synth",
              sourceId: source.id,
              externalIds: ["day-1"],
            }),
          })
        ).json()) as { existingIds: string[] }
      ).existingIds;
    expect(await exists(asAlpha)).toEqual(["day-1"]);
    expect(await exists(asBeta)).toEqual(["day-1"]);

    // The privacy delete of alpha's document leaves beta's namesake in place.
    const alphaDocId = db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND stream_id = ?")
      .get(source.id, alpha.id)!.id;
    expect((await req(`/documents/${alphaDocId}`, { method: "DELETE" })).status).toBe(200);
    expect(await count()).toBe(1);
    expect(await exists(asAlpha)).toEqual([]);
    expect(await exists(asBeta)).toEqual(["day-1"]);
    // Alpha's re-push is suppressed by its tombstone, and told so; beta's is not.
    expect(
      await (
        await asAlpha("/documents", { body: JSON.stringify({ documents: [day("day-1")] }) })
      ).json(),
    ).toEqual({ ingested: 0, suppressed: ["day-1"] });
    expect(await count()).toBe(1);

    // POST /analytics/ingest — each phone's namesake rows land in its own stream.
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const ingestAs = (token: string, value: number) =>
      withAnalytics.request("/analytics/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tableName: "visit_days",
          sourceId: source.id,
          schema: {
            tableName: "visit_days",
            displayName: "Visit days",
            description: "Per-day visit counts",
            columns: [
              { name: "id", type: "VARCHAR", description: "Day" },
              { name: "visits", type: "INTEGER", description: "Visits that day" },
            ],
            primaryKey: ["id"],
          },
          records: [{ id: "day-1", visits: value }],
        }),
      });
    try {
      expect(await (await ingestAs(alphaToken, 1)).json()).toMatchObject({ ingested: 1 });
      expect(await (await ingestAs(betaToken, 2)).json()).toMatchObject({ ingested: 1 });
      const rows = await analyticsDb.executeQuery(
        "SELECT id, visits, _stream_id FROM visit_days ORDER BY visits",
      );
      expect(rows.rows).toEqual([
        ["day-1", 1, alpha.id],
        ["day-1", 2, beta.id],
      ]);
    } finally {
      await analyticsDb.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
      }
    }
  });

  test("replicated deletion converges: one delete-and-reset cycle, then the item is disputed until its restorer agrees", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const type = SourceType("notes-synth");
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [type],
          multiDeviceModes: { [type]: "replicated" as const },
          syncLease: true,
        },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const gamma = host("gamma");
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, source.id, beta.id);
    addSourceMember(db, source.id, gamma.id);
    const as =
      (token: string) =>
      async (path: string, body: unknown): Promise<Record<string, unknown>> => {
        const res = await app.request(path, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as Record<string, unknown>;
      };
    const asAlpha = as(createToken(db, alpha.id, [SCOPE_WRITE_ALL]).token);
    const asBeta = as(createToken(db, beta.id, [SCOPE_WRITE_ALL]).token);
    const asGamma = as(createToken(db, gamma.id, [SCOPE_WRITE_ALL]).token);
    const page = (externalIds: string[], extra: Record<string, unknown> = {}) => ({
      providerId: "notes-synth",
      sourceId: source.id,
      documents: externalIds.map((id) => makeDocPayload(id, "notes-synth", source.id)),
      hasMore: false,
      cursor: { page: 1 },
      ...extra,
    });
    const begin = async (call: typeof asBeta) =>
      (await call(`/sync-state/${encodeURIComponent(source.id)}/begin`, {
        attemptId: randomUUID(),
      })) as { wipeEpoch: number };
    const held = () =>
      db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
        )
        .all(source.id)
        .map((r) => r.external_id);
    const synced = (deviceId: string) => getSyncState(db, source.id, deviceId)?.last_synced_at;

    // beta's replica holds four items; alpha's is a strict subset of it.
    expect(
      await asBeta("/documents/with-cursor", page(["n-1", "n-2", "n-3", "n-4"])),
    ).toMatchObject({ ingested: 4 });
    expect(await asAlpha(`/sync-state/${encodeURIComponent(source.id)}/lease`, {})).toMatchObject({
      granted: true,
    });
    expect(await asAlpha("/documents/with-cursor", page(["n-1", "n-2"]))).toMatchObject({
      ingested: 2,
    });
    const gammaEpoch0 = getWipeEpoch(db, source.id, gamma.id);

    // Cycle 1 — the one allowed cycle: the holder deletes, the siblings are
    // reset, and beta's bootstrap brings the item back.
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-3"] })),
    ).toMatchObject({ tombstonedDeleted: 1 });
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    expect(synced(beta.id)).toBeNull();
    expect(synced(gamma.id)).toBeNull();
    const betaEpoch = (await begin(asBeta)).wipeEpoch;
    expect(
      await asBeta(
        "/documents/with-cursor",
        page(["n-1", "n-2", "n-3", "n-4"], { wipeEpoch: betaEpoch }),
      ),
    ).toMatchObject({ ingested: 4 });
    expect(held()).toEqual(["n-1", "n-2", "n-3", "n-4"]);
    const gammaEpoch1 = getWipeEpoch(db, source.id, gamma.id);
    expect(gammaEpoch1).toBeGreaterThan(gammaEpoch0);

    // Cycles 2 and 3 — the holder keeps asserting the deletion. The item is
    // disputed: it stays, nobody is reset, and the holder's page advances.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const repeat = await asAlpha(
        "/documents/with-cursor",
        page(["n-1"], { deletedExternalIds: ["n-3"] }),
      );
      expect(repeat).toMatchObject({ ingested: 1, tombstonedDeleted: 0, deletionDisputed: 1 });
      expect(held()).toEqual(["n-1", "n-2", "n-3", "n-4"]);
      expect(synced(beta.id)).not.toBeNull();
      expect(getWipeEpoch(db, source.id, beta.id)).toBe(betaEpoch);
      expect(getWipeEpoch(db, source.id, gamma.id)).toBe(gammaEpoch1);
    }

    // A third member's tombstone for a disputed item is its verdict, not a
    // deferral: the page commits. A fresh deletion from a non-holder is
    // deferred.
    const gammaEpoch = (await begin(asGamma)).wipeEpoch;
    expect(
      await asGamma(
        "/documents/with-cursor",
        page(["n-1"], { deletedExternalIds: ["n-3"], wipeEpoch: gammaEpoch }),
      ),
    ).toMatchObject({ ingested: 1, tombstonedDeleted: 0, deletionDisputed: 1 });
    expect(held()).toEqual(["n-1", "n-2", "n-3", "n-4"]);
    expect(
      await asGamma(
        "/documents/with-cursor",
        page([], { deletedExternalIds: ["n-4"], wipeEpoch: gammaEpoch }),
      ),
    ).toMatchObject({ rejected: true, reason: "lease", deletionDeferred: true });
    expect(held()).toEqual(["n-1", "n-2", "n-3", "n-4"]);

    // The restorer agrees: the item is deleted without the lease and without
    // resetting anyone, and its history is closed.
    const alphaSynced = synced(alpha.id);
    const alphaEpoch = getWipeEpoch(db, source.id, alpha.id);
    const settled = await asBeta(
      "/documents/with-cursor",
      page([], { deletedExternalIds: ["n-3"], wipeEpoch: betaEpoch }),
    );
    expect(settled).toMatchObject({ tombstonedDeleted: 1 });
    expect(settled).not.toHaveProperty("deletionDeferred");
    expect(settled).not.toHaveProperty("deletionDisputed");
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    expect(synced(alpha.id)).toBe(alphaSynced);
    expect(getWipeEpoch(db, source.id, alpha.id)).toBe(alphaEpoch);
    expect(getWipeEpoch(db, source.id, gamma.id)).toBe(gammaEpoch);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM replica_deletion_claims WHERE source_id = ? AND role = 'restored'")
        .get(source.id)?.n,
    ).toBe(0);

    // A deleter that contributes the item again withdraws its verdict: the
    // item's history closes, so a later non-holder tombstone is a fresh one.
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-2"] })),
    ).toMatchObject({ tombstonedDeleted: 1 });
    expect(held()).toEqual(["n-1", "n-4"]);
    expect(await asAlpha("/documents/with-cursor", page(["n-2"]))).toMatchObject({ ingested: 1 });
    const betaEpoch2 = (await begin(asBeta)).wipeEpoch;
    expect(
      await asBeta(
        "/documents/with-cursor",
        page([], { deletedExternalIds: ["n-2"], wipeEpoch: betaEpoch2 }),
      ),
    ).toMatchObject({ rejected: true, reason: "lease", deletionDeferred: true });
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);

    // A restorer that sends no tombstones speaks through its snapshot, but one
    // snapshot is never a verdict: the omission is counted towards the same
    // corroboration an absence needs (the E2E suite drives it to maturity),
    // and the page commits without deleting or deferring anything.
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-4"] })),
    ).toMatchObject({ tombstonedDeleted: 1 });
    const betaEpoch3 = (await begin(asBeta)).wipeEpoch;
    expect(
      await asBeta("/documents/with-cursor", page(["n-4"], { wipeEpoch: betaEpoch3 })),
    ).toMatchObject({ ingested: 1 });
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    const omitted = await asBeta(
      "/documents/with-cursor",
      page([], { presentExternalIds: ["n-1", "n-2"], wipeEpoch: betaEpoch3 }),
    );
    expect(omitted).toMatchObject({ tombstonedDeleted: 0, reconcileDeferred: true });
    expect(omitted).not.toHaveProperty("deletionDeferred");
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    expect(
      db
        .prepare<
          [string, string],
          { omissions: number; role: string }
        >("SELECT omissions, role FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-4' AND device_id = ?")
        .get(source.id, beta.id),
    ).toEqual({ omissions: 1, role: "restored" });
    // Naming it again starts the clock over; its own tombstone settles at once.
    expect(
      await asBeta(
        "/documents/with-cursor",
        page([], { presentExternalIds: ["n-1", "n-2", "n-4"], wipeEpoch: betaEpoch3 }),
      ),
    ).toMatchObject({ tombstonedDeleted: 0 });
    expect(
      db
        .prepare<
          [string, string],
          { omissions: number }
        >("SELECT omissions FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-4' AND device_id = ?")
        .get(source.id, beta.id)?.omissions,
    ).toBe(0);
    expect(
      await asBeta(
        "/documents/with-cursor",
        page([], { deletedExternalIds: ["n-4"], wipeEpoch: betaEpoch3 }),
      ),
    ).toMatchObject({ tombstonedDeleted: 1 });
    expect(held()).toEqual(["n-1", "n-2"]);

    // The operator's own delete ends a dispute: the item goes, and so does
    // its history.
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-1"] })),
    ).toMatchObject({ tombstonedDeleted: 1 });
    const betaEpoch4 = (await begin(asBeta)).wipeEpoch;
    expect(
      await asBeta("/documents/with-cursor", page(["n-1"], { wipeEpoch: betaEpoch4 })),
    ).toMatchObject({ ingested: 1 });
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-1"] })),
    ).toMatchObject({ deletionDisputed: 1 });
    const disputedDocId = db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND external_id = 'n-1'")
      .get(source.id)!.id;
    const operatorDelete = await app.request(`/documents/${encodeURIComponent(disputedDocId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${createToken(db, alpha.id, [SCOPE_WRITE_ALL]).token}` },
    });
    expect(operatorDelete.status).toBe(200);
    expect(held()).toEqual(["n-2"]);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-1'")
        .get(source.id)?.n,
    ).toBe(0);

    // A whole-library snapshot sent on its own (the phones' path) speaks the
    // same language: it records who observed each absence and counts the
    // member's omissions of items it keeps alive, applying nothing until they
    // are corroborated.
    expect(
      await asAlpha("/documents/with-cursor", page([], { deletedExternalIds: ["n-2"] })),
    ).toMatchObject({ tombstonedDeleted: 1 });
    const betaEpoch5 = (await begin(asBeta)).wipeEpoch;
    expect(
      await asBeta("/documents/with-cursor", page(["n-2"], { wipeEpoch: betaEpoch5 })),
    ).toMatchObject({ ingested: 1 });
    const reconciled = await asBeta("/documents/reconcile", {
      providerId: "notes-synth",
      sourceId: source.id,
      presentExternalIds: [],
      writeEpoch: betaEpoch5,
      observationId: randomUUID(),
    });
    expect(reconciled).toMatchObject({ deleted: 0, deletedIds: [] });
    expect(reconciled).not.toHaveProperty("deletionDisputed");
    expect(held()).toEqual(["n-2"]);
    expect(
      db
        .prepare<
          [string, string],
          { omissions: number; role: string }
        >("SELECT omissions, role FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-2' AND device_id = ?")
        .get(source.id, beta.id),
    ).toEqual({ omissions: 1, role: "restored" });
    expect(
      db
        .prepare<
          [string],
          { observed_by: string }
        >("SELECT observed_by FROM document_absences WHERE source_id = ? AND external_id = 'n-2'")
        .get(source.id)?.observed_by,
    ).toBe(beta.id);
    // Naming it again resets the count and revokes the absence.
    await asBeta("/documents/reconcile", {
      providerId: "notes-synth",
      sourceId: source.id,
      presentExternalIds: ["n-2"],
      writeEpoch: betaEpoch5,
      observationId: randomUUID(),
    });
    expect(
      db
        .prepare<
          [string, string],
          { omissions: number }
        >("SELECT omissions FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-2' AND device_id = ?")
        .get(source.id, beta.id)?.omissions,
    ).toBe(0);
  });

  test("the sync lease over HTTP: only hosts claim, a handoff page from a non-holder is refused, a replicated non-holder defers its reconcile", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const handoffType = SourceType("calendar-synth");
    const replicatedType = SourceType("notes-synth");
    const modes = { [handoffType]: "handoff" as const, [replicatedType]: "replicated" as const };
    const host = (name: string, capable: boolean) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [handoffType, replicatedType],
          multiDeviceModes: modes,
          ...(capable ? { syncLease: true } : {}),
        },
      });
    const alpha = host("alpha", true);
    const beta = host("beta", true);
    const gamma = host("gamma", true);
    const stranger = host("stranger", true);
    const handoff = createSource(db, {
      type: handoffType,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "handoff",
    });
    addSourceMember(db, handoff.id, beta.id);
    const replicated = createSource(db, {
      type: replicatedType,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, replicated.id, beta.id);
    addSourceMember(db, replicated.id, gamma.id);
    const as =
      (token: string) =>
      (path: string, init: RequestInit = {}) =>
        app.request(path, {
          method: "POST",
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
    const asAlpha = as(createToken(db, alpha.id, [SCOPE_WRITE_ALL]).token);
    const asBeta = as(createToken(db, beta.id, [SCOPE_WRITE_ALL]).token);
    const asGamma = as(createToken(db, gamma.id, [SCOPE_WRITE_ALL]).token);
    const asStranger = as(createToken(db, stranger.id, [SCOPE_WRITE_ALL]).token);
    const leasePath = (id: string) => `/sync-state/${encodeURIComponent(id)}/lease`;

    // A device that does not host the source is refused; an unknown source is not found.
    expect((await asStranger(leasePath(handoff.id), { body: "{}" })).status).toBe(403);
    expect((await asAlpha(leasePath("calendar-synth:nobody"), { body: "{}" })).status).toBe(404);

    expect(await (await asAlpha(leasePath(handoff.id), { body: "{}" })).json()).toMatchObject({
      granted: true,
      holder: alpha.id,
    });
    expect(await (await asBeta(leasePath(handoff.id), { body: "{}" })).json()).toMatchObject({
      granted: false,
      reason: "held",
      holder: alpha.id,
    });
    const pageOf = (sourceId: string, externalId: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        providerId: sourceId.slice(0, sourceId.indexOf(":")),
        sourceId,
        documents: [makeDocPayload(externalId, sourceId.slice(0, sourceId.indexOf(":")), sourceId)],
        hasMore: false,
        cursor: { page: 1 },
        ...extra,
      });
    expect(
      await (await asBeta("/documents/with-cursor", { body: pageOf(handoff.id, "b-1") })).json(),
    ).toMatchObject({
      ingested: 0,
      reconciledDeleted: 0,
      rejected: true,
      reason: "lease",
      holder: alpha.id,
    });
    expect(
      await (await asAlpha("/documents/with-cursor", { body: pageOf(handoff.id, "a-1") })).json(),
    ).toMatchObject({ ingested: 1 });

    // A replicated member without the lease commits, deferring the snapshot.
    expect(await (await asAlpha(leasePath(replicated.id), { body: "{}" })).json()).toMatchObject({
      granted: true,
    });
    const deferred = (await (
      await asBeta("/documents/with-cursor", {
        body: pageOf(replicated.id, "n-1", { presentExternalIds: ["n-1"] }),
      })
    ).json()) as Record<string, unknown>;
    expect(deferred).toMatchObject({
      ingested: 1,
      reconciledDeleted: 0,
      reconcileDeferred: true,
    });
    // Deferring means the snapshot was not diffed at all, not that it was
    // diffed and found nothing.
    expect(deferred).not.toHaveProperty("absence");

    await asGamma("/documents/with-cursor", {
      body: pageOf(replicated.id, "gamma-observation"),
    });

    // A replicated non-holder may contribute rows, but it cannot remove a
    // sibling's rows through the explicit-tombstone channel. The holder's
    // accepted tombstone invalidates every sibling cursor so a healthy replica
    // reboots and can restore a row that was deleted from an incomplete view.
    await asAlpha("/documents/with-cursor", {
      body: pageOf(replicated.id, "shared-note"),
    });
    const betaEpoch = getWipeEpoch(db, replicated.id, beta.id);
    const gammaEpoch = getWipeEpoch(db, replicated.id, gamma.id);

    const legacyDelete = {
      providerId: replicatedType,
      sourceId: replicated.id,
      externalIds: ["shared-note"],
    };
    for (const call of [asAlpha, asBeta]) {
      const response = await call("/documents/delete", { body: JSON.stringify(legacyDelete) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        deleted: 0,
        rejected: true,
        reason: "replicated-deletion-requires-cursor",
      });
    }

    const noOpDelete = (await (
      await asAlpha("/documents/with-cursor", {
        body: pageOf(replicated.id, "alpha-no-op", {
          deletedExternalIds: ["missing-note"],
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(noOpDelete).toMatchObject({ tombstonedDeleted: 0 });
    expect(getWipeEpoch(db, replicated.id, beta.id)).toBe(betaEpoch);
    expect(getWipeEpoch(db, replicated.id, gamma.id)).toBe(gammaEpoch);

    const refusedDelete = (await (
      await asBeta("/documents/with-cursor", {
        body: pageOf(replicated.id, "beta-observation", {
          deletedExternalIds: ["shared-note"],
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(refusedDelete).toMatchObject({ tombstonedDeleted: 0, deletionDeferred: true });
    expect(
      db
        .prepare<
          [string, string],
          { count: number }
        >("SELECT COUNT(*) count FROM documents WHERE source_id = ? AND external_id = ?")
        .get(replicated.id, "shared-note")?.count,
    ).toBe(1);

    const acceptedDelete = (await (
      await asAlpha("/documents/with-cursor", {
        body: pageOf(replicated.id, "alpha-observation", {
          deletedExternalIds: ["shared-note"],
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(acceptedDelete).toMatchObject({ tombstonedDeleted: 1 });
    expect(getSyncState(db, replicated.id, beta.id)?.last_synced_at).toBeNull();
    expect(getSyncState(db, replicated.id, gamma.id)?.last_synced_at).toBeNull();
    expect(getWipeEpoch(db, replicated.id, beta.id)).toBeGreaterThan(betaEpoch);
    expect(getWipeEpoch(db, replicated.id, gamma.id)).toBeGreaterThan(gammaEpoch);

    const betaRetryEpoch = (
      (await (
        await asBeta(`/sync-state/${encodeURIComponent(replicated.id)}/begin`, {
          body: JSON.stringify({ attemptId: randomUUID() }),
        })
      ).json()) as { wipeEpoch: number }
    ).wipeEpoch;
    const resolvedRetry = (await (
      await asBeta("/documents/with-cursor", {
        body: pageOf(replicated.id, "beta-observation", {
          deletedExternalIds: ["shared-note"],
          wipeEpoch: betaRetryEpoch,
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(resolvedRetry).toMatchObject({ ingested: 1, tombstonedDeleted: 0 });
    expect(resolvedRetry).not.toHaveProperty("deletionDeferred");
    expect(getSyncState(db, replicated.id, beta.id)?.last_synced_at).not.toBeNull();
    const staleBetaPage = (await (
      await asBeta("/documents/with-cursor", {
        body: pageOf(replicated.id, "late-beta-row", { wipeEpoch: betaEpoch }),
      })
    ).json()) as Record<string, unknown>;
    expect(staleBetaPage).toMatchObject({ rejected: true });
    expect(
      db
        .prepare<
          [string, string],
          { count: number }
        >("SELECT COUNT(*) count FROM documents WHERE source_id = ? AND external_id = ?")
        .get(replicated.id, "late-beta-row")?.count,
    ).toBe(0);

    // Only the holder releases.
    expect(await (await asBeta(leasePath(handoff.id), { method: "DELETE" })).json()).toEqual({
      released: false,
    });
    expect(await (await asAlpha(leasePath(handoff.id), { method: "DELETE" })).json()).toEqual({
      released: true,
    });
  });

  test("a handoff lease rejection applies no analytics records or explicit deletes, and the same observation can retry after handover", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const type = SourceType("calendar-synth");
    const modes = { [type]: "handoff" as const };
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [type],
          multiDeviceModes: modes,
          syncLease: true,
        },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "handoff",
    });
    addSourceMember(db, source.id, beta.id);

    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const as = (deviceId: DeviceId) => {
      const token = createToken(db, deviceId, [SCOPE_WRITE_ALL]).token;
      return (path: string, body: unknown, method = "POST") =>
        withAnalytics.request(path, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
    };
    const asAlpha = as(alpha.id);
    const asBeta = as(beta.id);
    const leasePath = `/sync-state/${encodeURIComponent(source.id)}/lease`;
    const schema = {
      tableName: "handoff_events",
      displayName: "Handoff events",
      description: "Synthetic events used to verify lease fencing",
      columns: [
        { name: "id", type: "VARCHAR", description: "Event id" },
        { name: "value", type: "INTEGER", description: "Event value" },
      ],
      primaryKey: ["id"],
    };
    const ingest = (call: typeof asAlpha, body: Record<string, unknown>) =>
      call("/analytics/ingest", {
        tableName: "handoff_events",
        sourceId: source.id,
        records: [],
        ...body,
      });

    try {
      expect(await (await asAlpha(leasePath, {})).json()).toMatchObject({
        granted: true,
        holder: alpha.id,
      });
      expect(
        await (await ingest(asAlpha, { schema, records: [{ id: "kept", value: 1 }] })).json(),
      ).toMatchObject({ ingested: 1 });

      const rejectedBody = {
        schema,
        records: [{ id: "after-handover", value: 2 }],
        deletedIds: ["kept"],
        presentIds: ["after-handover"],
        observationId: "handoff-attempt-2",
      };
      expect(await (await ingest(asBeta, rejectedBody)).json()).toMatchObject({
        ingested: 0,
        deleted: 0,
        rejected: true,
        reason: "lease",
        holder: alpha.id,
      });
      expect(
        (await analyticsDb.executeQuery("SELECT id, value FROM handoff_events ORDER BY id")).rows,
      ).toEqual([["kept", 1]]);

      expect(await (await asBeta(leasePath, {}, "DELETE")).json()).toEqual({ released: false });
      expect(await (await asAlpha(leasePath, {}, "DELETE")).json()).toEqual({ released: true });

      // A rejection must not consume the snapshot observation. Once ownership
      // hands over, retrying the exact request applies all of its effects.
      expect(await (await ingest(asBeta, rejectedBody)).json()).toMatchObject({
        ingested: 1,
        deleted: 1,
        absence: { marked: 0, absent: 0 },
      });
      expect(
        (await analyticsDb.executeQuery("SELECT id, value FROM handoff_events ORDER BY id")).rows,
      ).toEqual([["after-handover", 2]]);
    } finally {
      await analyticsDb.close();
      cleanupDb(analyticsPath);
    }
  });

  test("a replicated analytics tombstone is holder-only and makes a sibling bootstrap to restore an incomplete-view deletion", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const type = SourceType("notes-synth");
    const modes = { [type]: "replicated" as const };
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [type],
          multiDeviceModes: modes,
          syncLease: true,
        },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, source.id, beta.id);

    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const tokenFor = (deviceId: DeviceId) => createToken(db, deviceId, [SCOPE_WRITE_ALL]).token;
    const alphaToken = tokenFor(alpha.id);
    const betaToken = tokenFor(beta.id);
    const operatorToken = tokenFor(createDevice(db, { name: "operator-cli", kind: "cli" }).id);
    const asDevice = (token: string, path: string, body: unknown) =>
      withAnalytics.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const schema = {
      tableName: "replicated_stats",
      displayName: "Replicated stats",
      description: "Synthetic counters used to verify replica lease semantics",
      columns: [
        { name: "id", type: "VARCHAR", description: "Counter id" },
        { name: "value", type: "INTEGER", description: "Counter value" },
      ],
      primaryKey: ["id"],
    };
    const ingest = (token: string, body: Record<string, unknown>) =>
      asDevice(token, "/analytics/ingest", {
        tableName: "replicated_stats",
        sourceId: source.id,
        records: [],
        ...body,
      });
    const begin = async (token: string) =>
      Number(
        (
          (await (
            await asDevice(token, `/sync-state/${encodeURIComponent(source.id)}/begin`, {})
          ).json()) as { wipeEpoch: number }
        ).wipeEpoch,
      );
    const finish = (token: string, writeEpoch: number, cursor: string) =>
      asDevice(token, `/sync-state/${encodeURIComponent(source.id)}`, {
        cursor: { value: cursor },
        writeEpoch,
      });

    try {
      expect(
        await (
          await asDevice(alphaToken, `/sync-state/${encodeURIComponent(source.id)}/lease`, {})
        ).json(),
      ).toMatchObject({ granted: true, holder: alpha.id });
      const alphaEpoch = await begin(alphaToken);
      const betaEpoch = await begin(betaToken);
      expect(await (await finish(alphaToken, alphaEpoch, "alpha-seeded")).json()).toEqual({
        ok: true,
      });
      expect(await (await finish(betaToken, betaEpoch, "beta-seeded")).json()).toEqual({
        ok: true,
      });
      expect(
        await (
          await ingest(alphaToken, {
            schema,
            writeEpoch: alphaEpoch,
            records: [
              { id: "kept", value: 1 },
              { id: "removed", value: 2 },
            ],
          })
        ).json(),
      ).toMatchObject({ ingested: 2 });

      const operatorDelete = (await (
        await ingest(operatorToken, {
          deletedIds: ["kept"],
          presentIds: [],
          observationId: "operator-observation",
        })
      ).json()) as Record<string, unknown>;
      expect(operatorDelete).toMatchObject({ deleted: 0, deletionDeferred: true });
      expect(operatorDelete).not.toHaveProperty("absence");

      const nonHolder = (await (
        await ingest(betaToken, {
          schema,
          writeEpoch: betaEpoch,
          records: [{ id: "replica", value: 3 }],
          deletedIds: ["removed"],
          presentIds: ["replica"],
          observationId: "replica-observation",
        })
      ).json()) as Record<string, unknown>;
      expect(nonHolder).toMatchObject({
        ingested: 1,
        deleted: 0,
        deletionDeferred: true,
      });
      expect(nonHolder).not.toHaveProperty("absence");
      expect(
        (await analyticsDb.executeQuery("SELECT id, value FROM replicated_stats ORDER BY id")).rows,
      ).toEqual([
        ["kept", 1],
        ["removed", 2],
        ["replica", 3],
      ]);

      const noOpDelete = await ingest(alphaToken, {
        deletedIds: ["not-present"],
        writeEpoch: alphaEpoch,
      });
      // A member's tombstone that names nothing the table holds applies nothing.
      expect(await noOpDelete.json()).toMatchObject({ deleted: 0 });
      expect(getWipeEpoch(db, source.id, beta.id)).toBe(betaEpoch);

      const holderDelete = await ingest(alphaToken, {
        deletedIds: ["removed"],
        writeEpoch: alphaEpoch,
      });
      expect(await holderDelete.json()).toMatchObject({ deleted: 1 });
      expect(getSyncState(db, source.id, beta.id)?.last_synced_at).toBeNull();
      const resetBetaEpoch = getWipeEpoch(db, source.id, beta.id);
      expect(resetBetaEpoch).toBeGreaterThan(betaEpoch);

      // A page that was already in flight under the sibling's old claim must
      // not land after the holder's delete and mask the required bootstrap.
      expect(
        await (
          await ingest(betaToken, {
            records: [{ id: "late", value: 4 }],
            writeEpoch: betaEpoch,
          })
        ).json(),
      ).toMatchObject({ ingested: 0, deleted: 0 });

      // The reset makes the sibling's next real run a bootstrap. Replaying its
      // complete local store restores the row the holder lacked.
      const recoveryEpoch = await begin(betaToken);
      expect(recoveryEpoch).toBeGreaterThan(resetBetaEpoch);
      expect(
        await (
          await ingest(betaToken, {
            schema,
            records: [
              { id: "kept", value: 1 },
              { id: "removed", value: 2 },
              { id: "replica", value: 3 },
            ],
            writeEpoch: recoveryEpoch,
          })
        ).json(),
      ).toMatchObject({ ingested: 3 });
      expect(
        (await analyticsDb.executeQuery("SELECT id, value FROM replicated_stats ORDER BY id")).rows,
      ).toEqual([
        ["kept", 1],
        ["removed", 2],
        ["replica", 3],
      ]);

      // The sibling's bootstrap put `removed` back: it is disputed now. The
      // holder's repeated tombstone is recorded and stripped, nobody is reset.
      const repeat = (await (
        await ingest(alphaToken, { deletedIds: ["removed"], writeEpoch: alphaEpoch })
      ).json()) as Record<string, unknown>;
      expect(repeat).toMatchObject({ deleted: 0, deletionDisputed: 1 });
      expect(repeat).not.toHaveProperty("deletionDeferred");
      expect(getWipeEpoch(db, source.id, beta.id)).toBe(recoveryEpoch);
      expect(
        db
          .prepare<
            [string, string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM replica_deletion_claims WHERE source_id = ? AND namespace = ? AND role = 'restored'")
          .get(source.id, "analytics:replicated_stats")?.n,
      ).toBe(1);

      // A fresh deletion the non-holder may not lead is still deferred, and
      // the rows of the same page are kept.
      expect(
        await (
          await ingest(betaToken, {
            records: [{ id: "late", value: 4 }],
            deletedIds: ["kept"],
            writeEpoch: recoveryEpoch,
          })
        ).json(),
      ).toMatchObject({ ingested: 1, deleted: 0, deletionDeferred: true });

      // The restorer's own tombstone settles the dispute: no lease, no reset.
      const alphaSynced = getSyncState(db, source.id, alpha.id)?.last_synced_at;
      const settle = (await (
        await ingest(betaToken, { deletedIds: ["removed"], writeEpoch: recoveryEpoch })
      ).json()) as Record<string, unknown>;
      expect(settle).toMatchObject({ deleted: 1 });
      expect(settle).not.toHaveProperty("deletionDeferred");
      expect(settle).not.toHaveProperty("deletionDisputed");
      expect(getSyncState(db, source.id, alpha.id)?.last_synced_at).toBe(alphaSynced);
      expect(
        (await analyticsDb.executeQuery("SELECT id FROM replicated_stats ORDER BY id")).rows,
      ).toEqual([["kept"], ["late"], ["replica"]]);

      // The holder's snapshot is reconciled in its own name; the non-holder's
      // is read for the rows it keeps alive and reconciled by nobody.
      const holderSnapshot = (await (
        await ingest(alphaToken, {
          presentIds: ["kept", "late"],
          observationId: "alpha-observation",
          writeEpoch: alphaEpoch,
        })
      ).json()) as Record<string, unknown>;
      expect(holderSnapshot).toMatchObject({ absence: { marked: 1 } });
      expect(
        (
          await analyticsDb.executeQuery(
            "SELECT key_value, observed_by FROM _analytics_absences ORDER BY key_value",
          )
        ).rows,
      ).toEqual([["replica", alpha.id]]);
      const memberSnapshot = (await (
        await ingest(betaToken, {
          presentIds: ["replica"],
          observationId: "beta-observation",
          writeEpoch: recoveryEpoch,
        })
      ).json()) as Record<string, unknown>;
      expect(memberSnapshot).not.toHaveProperty("absence");
      expect(memberSnapshot).not.toHaveProperty("deletionDeferred");
    } finally {
      await analyticsDb.close();
      cleanupDb(analyticsPath);
    }
  });

  test("members of a replicated source are fenced on their own rows across every write route", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const type = SourceType("notes-synth");
    const modes = { [type]: "replicated" as const };
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: { hostableSourceTypes: [type], multiDeviceModes: modes, syncLease: true },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, source.id, beta.id);
    const as = (token: string) => (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const alphaToken = createToken(db, alpha.id, [SCOPE_WRITE_ALL]).token;
    const betaToken = createToken(db, beta.id, [SCOPE_WRITE_ALL]).token;
    const asAlpha = as(alphaToken);
    const asBeta = as(betaToken);
    const begin = async (call: typeof asAlpha) =>
      ((await (await call(`/sync-state/${source.id}/begin`, {})).json()) as { wipeEpoch: number })
        .wipeEpoch;
    const payload = (externalId: string) => ({
      ...makeDocPayload(externalId, "notes-synth", source.id),
    });

    // alpha claims twice, beta once: the two rows hold distinct epochs, and
    // beta's claim does not supersede alpha's.
    await begin(asAlpha);
    const alphaEpoch = await begin(asAlpha);
    const betaEpoch = await begin(asBeta);
    expect(alphaEpoch).toBe(2);
    expect(betaEpoch).toBe(1);

    // POST /documents
    const alphaInsert = await asAlpha("/documents", {
      documents: [payload("a-1"), payload("a-2")],
      writeEpochs: { [source.id]: alphaEpoch },
    });
    expect(await alphaInsert.json()).toMatchObject({ ingested: 2 });
    const betaWithAlphaEpoch = await asBeta("/documents", {
      documents: [payload("b-stale")],
      writeEpochs: { [source.id]: alphaEpoch },
    });
    expect(await betaWithAlphaEpoch.json()).toMatchObject({
      ingested: 0,
      rejectedSourceIds: [source.id],
    });
    const betaInsert = await asBeta("/documents", {
      documents: [payload("b-1")],
      writeEpochs: { [source.id]: betaEpoch },
    });
    expect(await betaInsert.json()).toMatchObject({ ingested: 1 });

    // POST /documents/reconcile — beta's snapshot with alpha's epoch is
    // refused outright; with its own it records what is absent from beta's row.
    const reconcileBody = (writeEpoch: number) => ({
      providerId: "notes-synth",
      sourceId: source.id,
      presentExternalIds: ["a-1", "b-1"],
      writeEpoch,
    });
    expect(await (await asBeta("/documents/reconcile", reconcileBody(alphaEpoch))).json()).toEqual({
      deleted: 0,
      deletedIds: [],
    });
    expect(
      await (await asBeta("/documents/reconcile", reconcileBody(betaEpoch))).json(),
    ).toMatchObject({ deleted: 0, absence: { marked: 1, absent: 1 } });

    // POST /documents/delete
    const deleteBody = (writeEpoch: number) => ({
      providerId: "notes-synth",
      sourceId: source.id,
      externalIds: ["a-1"],
      writeEpoch,
    });
    for (const writeEpoch of [betaEpoch, alphaEpoch]) {
      const response = await asAlpha("/documents/delete", deleteBody(writeEpoch));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        deleted: 0,
        rejected: true,
        reason: "replicated-deletion-requires-cursor",
      });
    }

    // POST /analytics/ingest — the same DB behind a server with an analytics store.
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const asBetaAnalytics = (body: unknown) =>
      withAnalytics.request("/analytics/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${betaToken}` },
        body: JSON.stringify(body),
      });
    const analyticsBody = (writeEpoch: number, id: string) => ({
      tableName: "notes_stats",
      sourceId: source.id,
      schema: {
        tableName: "notes_stats",
        displayName: "Notes stats",
        description: "Per-note counters",
        columns: [
          { name: "id", type: "VARCHAR", description: "Note id" },
          { name: "words", type: "INTEGER", description: "Word count" },
        ],
        primaryKey: ["id"],
      },
      records: [{ id, words: 12 }],
      writeEpoch,
    });
    try {
      expect(
        await (await asBetaAnalytics(analyticsBody(alphaEpoch, "stale"))).json(),
      ).toMatchObject({ ingested: 0 });
      expect(await (await asBetaAnalytics(analyticsBody(betaEpoch, "fresh"))).json()).toMatchObject(
        { ingested: 1 },
      );
    } finally {
      await analyticsDb.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
      }
    }

    // POST /sync-state/:id — each member's cursor lands on its own row.
    expect(
      await (
        await asBeta(`/sync-state/${source.id}`, { cursor: { page: 1 }, writeEpoch: alphaEpoch })
      ).json(),
    ).toEqual({ ok: false, rejected: true });
    expect(
      await (
        await asBeta(`/sync-state/${source.id}`, { cursor: { page: 1 }, writeEpoch: betaEpoch })
      ).json(),
    ).toEqual({ ok: true });
  });

  test("refreshes metadata without rewriting the cursor", async () => {
    await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({ cursor: { historyId: "newest" } }),
    });

    const metaRes = await req("/sync-state/gmail/meta", {
      method: "POST",
      body: JSON.stringify({ label: "Mail", contentRetention: "best-effort" }),
    });

    expect(metaRes.status).toBe(200);
    expect((await (await req("/sync-state/gmail")).json()).cursor).toEqual({
      historyId: "newest",
    });
  });

  test("cancellation arriving before begin prevents a late claim", async () => {
    const attemptId = "36b48758-314d-48e4-8f37-10e8df82941b";
    const canceled = await req("/sync-state/gmail/revoke", {
      method: "POST",
      body: JSON.stringify({ attemptId }),
    });
    expect(await canceled.json()).toEqual({ revoked: false });

    const begin = await req("/sync-state/gmail/begin", {
      method: "POST",
      body: JSON.stringify({ attemptId }),
    });
    expect(await begin.json()).toEqual({});
    expect((await (await req("/sync-state/gmail")).json()).wipeEpoch).toBe(0);
  });

  test("revokes only the exact sync attempt epoch", async () => {
    const first = await (await req("/sync-state/gmail/begin", { method: "POST" })).json();
    const second = await (await req("/sync-state/gmail/begin", { method: "POST" })).json();

    const stale = await (
      await req("/sync-state/gmail/revoke", {
        method: "POST",
        body: JSON.stringify({ writeEpoch: first.wipeEpoch }),
      })
    ).json();
    const current = await (
      await req("/sync-state/gmail/revoke", {
        method: "POST",
        body: JSON.stringify({ writeEpoch: second.wipeEpoch }),
      })
    ).json();

    expect(stale).toEqual({ revoked: false });
    expect(current).toEqual({ revoked: true });
    expect((await (await req("/sync-state/gmail")).json()).wipeEpoch).toBe(second.wipeEpoch + 1);
  });

  test("does not persist an unnormalizable icon from sync-state metadata", async () => {
    const safeIcon = "data:image/png;base64,iVBORw0KGgo=";
    for (const icon of [safeIcon, "not a usable icon"]) {
      const setRes = await req("/sync-state/gmail", {
        method: "POST",
        body: JSON.stringify({ cursor: { icon }, icon }),
      });
      expect(setRes.status).toBe(200);
    }

    const stored = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get("gmail");
    expect(stored?.icon).toBe(safeIcon);

    const freshRes = await req("/sync-state/google-calendar", {
      method: "POST",
      body: JSON.stringify({ cursor: {}, icon: "not a usable icon" }),
    });
    expect(freshRes.status).toBe(200);
    const fresh = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get("google-calendar");
    expect(fresh?.icon).toBeNull();
  });

  test("returns 400 when cursor is missing", async () => {
    const res = await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /documents/list", () => {
  test("returns all documents with no filters", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/documents/list");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.pageInfo.hasMore).toBe(false);
    expect(data.pageInfo.nextCursor).toBeUndefined();
    expect(data.items[0].sourceId).toBe("gmail");
    expect(data.items[0].content).toBeTruthy();
    expect(data.items[0].updatedAt).toBeTruthy();
  });

  test("filters by excludeSources", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          { ...makeDocPayload("cal-1"), sourceId: "google-calendar" },
        ],
      }),
    });

    const res = await req("/documents/list?excludeSources=gmail");
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].sourceId).toBe("google-calendar");
  });

  test("supports pagination with limit and cursor", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2"), makeDocPayload("msg-3")],
      }),
    });

    const res1 = await req("/documents/list?limit=2");
    const data1 = await res1.json();
    expect(data1.items).toHaveLength(2);
    expect(data1.pageInfo.hasMore).toBe(true);
    expect(data1.pageInfo.nextCursor).toBe(data1.items[data1.items.length - 1].id);
    expect(data1.pageInfo.limit).toBe(2);

    const res2 = await req(
      `/documents/list?limit=2&cursor=${encodeURIComponent(data1.pageInfo.nextCursor)}`,
    );
    const data2 = await res2.json();
    expect(data2.items).toHaveLength(1);
    expect(data2.pageInfo.hasMore).toBe(false);
    expect(data2.pageInfo.nextCursor).toBeUndefined();
  });

  test("returns empty result when no documents exist", async () => {
    const res = await req("/documents/list");
    const data = await res.json();
    expect(data.items).toHaveLength(0);
    expect(data.pageInfo.hasMore).toBe(false);
  });
});

describe("POST /documents/exists", () => {
  test("returns existing external IDs", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/documents/exists", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        externalIds: ["msg-1", "msg-3"],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.existingIds).toEqual(["msg-1"]);
  });

  test("returns empty array when no IDs match", async () => {
    const res = await req("/documents/exists", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        externalIds: ["nonexistent"],
      }),
    });
    const data = await res.json();
    expect(data.existingIds).toEqual([]);
  });

  test("returns 400 when fields are missing", async () => {
    const res = await req("/documents/exists", {
      method: "POST",
      body: JSON.stringify({ providerId: "google" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /documents/by-url", () => {
  function makeDocWithUrl(externalId: string, sourceUrl: string) {
    return {
      ...makeDocPayload(externalId),
      metadata: { author: "alice@example.com", sourceUrl },
    };
  }

  test("resolves urls to documentIds", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocWithUrl("msg-a", "https://mail.google.com/mail/u/0/#inbox/abc"),
          makeDocWithUrl("msg-b", "https://www.notion.so/page-xyz"),
        ],
      }),
    });

    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({
        urls: [
          "https://mail.google.com/mail/u/0/#inbox/abc",
          "https://www.notion.so/page-xyz",
          "https://nowhere.example/missing",
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { matches: Record<string, string[]> };
    expect(Object.keys(data.matches)).toHaveLength(2);
    // Look up the actual ids from the DB to compare.
    const rows = db
      .prepare<
        [],
        { id: string; external_id: string }
      >("SELECT id, external_id FROM documents ORDER BY external_id")
      .all();
    const idByExt = Object.fromEntries(rows.map((r) => [r.external_id, r.id]));
    // Each URL resolves to a single documentId (no collisions).
    const allIds = new Set(Object.values(data.matches).flat());
    expect(allIds.has(idByExt["msg-a"])).toBe(true);
    expect(allIds.has(idByExt["msg-b"])).toBe(true);
  });

  test("response is keyed by the original URL the caller sent", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocWithUrl("gmail-a", "https://mail.google.com/mail/u/0/#inbox/19bda8ff08633a28"),
          makeDocWithUrl("gmail-b", "https://mail.google.com/mail/u/0/#inbox/19c24556cbcaec7b"),
        ],
      }),
    });

    const urlA = "https://mail.google.com/mail/u/0/#inbox/19bda8ff08633a28";
    const urlB = "https://mail.google.com/mail/u/0/#inbox/19c24556cbcaec7b";
    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls: [urlA, urlB] }),
    });
    const data = (await res.json()) as { matches: Record<string, string[]> };
    // Keys are the input URLs verbatim, not their normalized forms.
    expect(Object.keys(data.matches).sort()).toEqual([urlA, urlB].sort());
  });

  test("returns multiple documentIds when several rows share a source_url", async () => {
    // Parent email and its attachment both carry the same sourceUrl —
    // this is what the Gmail attachment builder does in real life
    // (see packages/core/src/attachments.ts).
    const sharedUrl = "https://mail.google.com/mail/u/0/#inbox/with-att";
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocWithUrl("parent", sharedUrl), makeDocWithUrl("parent/att/1", sharedUrl)],
      }),
    });
    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls: [sharedUrl] }),
    });
    const data = (await res.json()) as { matches: Record<string, string[]> };
    const ids = Object.values(data.matches)[0]!;
    expect(ids).toHaveLength(2);
  });

  test("multiple input URLs that normalize identically each get their own entry", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocWithUrl("msg-c", "https://www.notion.so/p-1?utm_source=email#section")],
      }),
    });

    const urls = [
      "https://www.notion.so/p-1#different-anchor",
      "https://www.notion.so/p-1?utm_campaign=foo",
    ];
    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    const data = (await res.json()) as { matches: Record<string, string[]> };
    // Anchor fragments and ignored params strip the same way → both
    // inputs hit the same row, but the response is keyed by ORIGINAL
    // URL, so each input shows up as its own entry pointing at the
    // same documentId.
    expect(Object.keys(data.matches).sort()).toEqual([...urls].sort());
    expect(new Set(Object.values(data.matches).flat()).size).toBe(1);
  });

  test("rejects empty urls array (400)", async () => {
    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("admin-registered canonicalizers collapse host-specific URL flavors at lookup", async () => {
    // Register a regex-rule canonicalizer for `mail.example.com` that
    // maps every label/account flavor onto `#message/<id>`. The
    // gateway has no source-specific knowledge until this register
    // call lands — this is the contract.
    await req("/admin/url-canonicalizers", {
      method: "POST",
      body: JSON.stringify({
        canonicalizers: [
          {
            hosts: ["mail.example.com"],
            rules: [
              {
                match:
                  "^https://mail\\.example\\.com/mail(?:/u/\\d+)?/?#(?:[a-z/]{0,200}/)?([0-9a-f]{6,})$",
                replacement: "https://mail.example.com/mail/#message/$1",
              },
            ],
          },
        ],
      }),
    });

    // Ingest one doc using the "API" form of the URL.
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocWithUrl("msg-1", "https://mail.example.com/mail/#inbox/abc123def")],
      }),
    });

    // Re-derive source_url for already-ingested rows (idempotent;
    // simulates the collector startup recompute call).
    const recompute = await req("/admin/url-canonicalizers/recompute-source-urls", {
      method: "POST",
      body: "{}",
    });
    expect(recompute.status).toBe(200);

    // Look up by THREE browser-flavor URLs of the same message — all
    // three should resolve to the one row.
    const urls = [
      "https://mail.example.com/mail/u/0/#inbox/abc123def",
      "https://mail.example.com/mail/u/0/#all/abc123def",
      "https://mail.example.com/mail/u/2/#starred/abc123def",
    ];
    const res = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    const data = (await res.json()) as { matches: Record<string, string[]> };
    expect(Object.keys(data.matches).sort()).toEqual([...urls].sort());
    expect(new Set(Object.values(data.matches).flat()).size).toBe(1);
  });

  test("POST /documents/with-cursor canonicalizes source_url at ingest time (no recompute needed)", async () => {
    // Register a Drive-style canonicalizer.
    await req("/admin/url-canonicalizers", {
      method: "POST",
      body: JSON.stringify({
        canonicalizers: [
          {
            hosts: ["drive.example.com"],
            rules: [
              {
                match: "^https://drive\\.example\\.com/file/d/([\\w-]+).*$",
                replacement: "https://drive.example.com/file/d/$1",
              },
            ],
          },
        ],
      }),
    });

    // Ingest via /documents/with-cursor (the collector's production path).
    // The raw sourceUrl includes /view?usp=drivesdk — the canonicalizer
    // should strip it at write time WITHOUT a separate recompute call.
    const res = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "google-drive",
        hasMore: false,
        cursor: {},
        documents: [
          {
            providerId: "google",
            sourceId: "google-drive",
            externalId: "drive-canon-1",
            title: "Test PDF",
            content: "# Test",
            contentHash: "hash-drive-canon-1",
            metadata: {
              sourceUrl: "https://drive.example.com/file/d/drive-canon-1/view?usp=drivesdk",
            },
            sourceCreatedAt: "2024-01-15T10:00:00Z",
            sourceUpdatedAt: "2024-01-15T10:00:00Z",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    // Verify source_url in DB is the canonical form.
    const row = db
      .prepare<
        [string],
        { source_url: string | null }
      >("SELECT source_url FROM documents WHERE external_id = ?")
      .get("drive-canon-1");
    expect(row?.source_url).toBe("https://drive.example.com/file/d/drive-canon-1");

    // Lookup by the raw variant should also resolve (input is canonicalized).
    const lookupRes = await req("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({
        urls: ["https://drive.example.com/file/d/drive-canon-1/view?usp=sharing"],
      }),
    });
    const lookupData = (await lookupRes.json()) as { matches: Record<string, string[]> };
    const ids =
      lookupData.matches["https://drive.example.com/file/d/drive-canon-1/view?usp=sharing"];
    expect(ids).toHaveLength(1);
  });
});

describe("POST /admin/source-prior-defaults", () => {
  // Registry is process-level — reset before each test so earlier
  // collector pushes don't leak into the next assertion.
  beforeEach(async () => {
    const { resetSourcePriorDefaults } = await import("./source-prior-defaults.js");
    resetSourcePriorDefaults();
  });

  test("rejects payloads with non-numeric weight (400)", async () => {
    const res = await req("/admin/source-prior-defaults", {
      method: "POST",
      body: JSON.stringify({
        entries: [{ sourceIdPrefix: "browser-history", weight: "bad" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts collector push, merges into the registry, GET reflects union", async () => {
    const post = await req("/admin/source-prior-defaults", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { sourceIdPrefix: "browser-history", weight: -0.04 },
          { sourceIdPrefix: "gmail", weight: 0.05 },
        ],
      }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; count: number };
    expect(postBody.ok).toBe(true);
    expect(postBody.count).toBe(2);

    const get = await req("/admin/source-prior-defaults");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as {
      entries: Array<{ sourceIdPrefix: string; weight: number }>;
    };
    const byPrefix = Object.fromEntries(getBody.entries.map((e) => [e.sourceIdPrefix, e.weight]));
    // Built-in `web` still present alongside collector entries.
    expect(byPrefix.web).toBe(-0.04);
    expect(byPrefix["browser-history"]).toBe(-0.04);
    expect(byPrefix.gmail).toBe(0.05);
  });

  test("re-posting replaces the collector layer but keeps built-ins", async () => {
    await req("/admin/source-prior-defaults", {
      method: "POST",
      body: JSON.stringify({
        entries: [{ sourceIdPrefix: "browser-history", weight: -0.04 }],
      }),
    });
    await req("/admin/source-prior-defaults", {
      method: "POST",
      body: JSON.stringify({ entries: [] }),
    });
    const get = await req("/admin/source-prior-defaults");
    const body = (await get.json()) as {
      entries: Array<{ sourceIdPrefix: string; weight: number }>;
    };
    const prefixes = body.entries.map((e) => e.sourceIdPrefix);
    expect(prefixes).toContain("web");
    expect(prefixes).not.toContain("browser-history");
  });
});

describe("POST /admin/url-graph-roles", () => {
  beforeEach(async () => {
    const { resetUrlGraphRoles } = await import("./url-graph-roles.js");
    const { resetKnownUrlPatterns } = await import("./known-url-patterns.js");
    const { resetUrlCanonicalizers } = await import("./url-canonicalizers.js");
    const { resetLinkDeclarationBundleReadiness } = await import("./link-declaration-readiness.js");
    resetUrlGraphRoles();
    resetKnownUrlPatterns();
    resetUrlCanonicalizers();
    resetLinkDeclarationBundleReadiness();
  });

  test("publishes canonicalizers, roles, and patterns as one ready generation", async () => {
    const post = await req("/admin/link-declarations", {
      method: "POST",
      body: JSON.stringify({
        canonicalizers: [
          {
            hosts: ["code.example.org"],
            rules: [
              {
                match: "^https://code[.]example[.]org/(.*)$",
                replacement: "https://code.example.org/$1",
              },
            ],
          },
        ],
        traversalHubPrefixes: ["browser-history"],
        fallbackRepresentationPrefixes: ["web"],
        referenceOnlyPrefixes: ["chrome-bookmarks"],
        patterns: [{ regex: "code[.]example[.]org/pull/[0-9]+" }],
      }),
    });
    expect(post.status).toBe(200);

    const roles = (await (await req("/admin/url-graph-roles")).json()) as {
      traversalHubPrefixes: string[];
      fallbackRepresentationPrefixes: string[];
      referenceOnlyPrefixes: string[];
      ready: boolean;
    };
    expect(roles).toMatchObject({
      fallbackRepresentationPrefixes: ["web"],
      referenceOnlyPrefixes: ["chrome-bookmarks"],
      ready: true,
    });
    expect(roles.traversalHubPrefixes).toContain("browser-history");

    const canonicalizers = (await (await req("/admin/url-canonicalizers")).json()) as {
      canonicalizers: Array<{ hosts: string[] }>;
    };
    expect(canonicalizers.canonicalizers.map((entry) => entry.hosts)).toContainEqual([
      "code.example.org",
    ]);
    const patterns = (await (await req("/admin/known-url-patterns")).json()) as {
      patterns: Array<{ regex: string }>;
    };
    expect(patterns.patterns).toEqual([{ regex: "code[.]example[.]org/pull/[0-9]+" }]);

    const { linkDeclarationBundlesReady } = await import("./link-declaration-readiness.js");
    expect(linkDeclarationBundlesReady()).toBe(true);
  });

  test("rejects an oversized streamed declaration before unknown JSON fields are parsed", async () => {
    const oversized = JSON.stringify({
      canonicalizers: [],
      traversalHubPrefixes: [],
      fallbackRepresentationPrefixes: [],
      referenceOnlyPrefixes: [],
      patterns: [],
      ignored: "x".repeat(300 * 1024),
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < oversized.length; offset += 8_192) {
          controller.enqueue(encoder.encode(oversized.slice(offset, offset + 8_192)));
        }
        controller.close();
      },
    });
    const declarationDevice = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL], "collector");
    connectCollectorDeclarations(declarationDevice.deviceId);
    DECLARATION_TOKEN = declarationDevice.token;
    const request = new Request("http://localhost/admin/link-declarations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DECLARATION_TOKEN}`,
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.request(request);
    expect(response.status).toBe(413);
  });

  test("accepts a native-backtracking shape because canonicalizers execute with RE2", async () => {
    const response = await req("/admin/link-declarations", {
      method: "POST",
      body: JSON.stringify({
        canonicalizers: [
          {
            hosts: ["code.example.org"],
            rules: [{ match: "^((a|aa))+$", replacement: "$1" }],
          },
        ],
        traversalHubPrefixes: [],
        fallbackRepresentationPrefixes: [],
        referenceOnlyPrefixes: [],
        patterns: [],
      }),
    });
    expect(response.status).toBe(200);
  });

  test("requires complete, valid and disjoint target-role declarations", async () => {
    const incomplete = await req("/admin/url-graph-roles", {
      method: "POST",
      body: JSON.stringify({ traversalHubPrefixes: ["history"] }),
    });
    expect(incomplete.status).toBe(400);

    const invalid = await req("/admin/url-graph-roles", {
      method: "POST",
      body: JSON.stringify({
        traversalHubPrefixes: ["History"],
        fallbackRepresentationPrefixes: [],
        referenceOnlyPrefixes: [],
      }),
    });
    expect(invalid.status).toBe(400);

    const duplicate = await req("/admin/url-graph-roles", {
      method: "POST",
      body: JSON.stringify({
        traversalHubPrefixes: ["history", "history"],
        fallbackRepresentationPrefixes: [],
        referenceOnlyPrefixes: [],
      }),
    });
    expect(duplicate.status).toBe(400);

    const overlap = await req("/admin/url-graph-roles", {
      method: "POST",
      body: JSON.stringify({
        traversalHubPrefixes: [],
        fallbackRepresentationPrefixes: ["bookmark"],
        referenceOnlyPrefixes: ["bookmark"],
      }),
    });
    expect(overlap.status).toBe(400);
  });

  test("legacy hub declarations affect traversal without marking target roles ready", async () => {
    const post = await req("/admin/url-hub-sources", {
      method: "POST",
      body: JSON.stringify({ prefixes: ["browser-history"] }),
    });
    expect(post.status).toBe(200);

    const get = await req("/admin/url-graph-roles");
    const body = (await get.json()) as { traversalHubPrefixes: string[]; ready: boolean };
    expect(body.traversalHubPrefixes).toContain("browser-history");
    expect(body.ready).toBe(false);
  });
});

describe("POST /admin/known-url-patterns", () => {
  // Registry is process-level — reset before each test so earlier
  // collector pushes don't leak into the next assertion.
  beforeEach(async () => {
    const { resetKnownUrlPatterns } = await import("./known-url-patterns.js");
    resetKnownUrlPatterns();
  });

  test("rejects a payload whose pattern has an empty regex (400)", async () => {
    const res = await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a malformed regex atomically (400)", async () => {
    await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "valid[.]example" }] }),
    });

    const malformed = await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "[unterminated" }] }),
    });
    expect(malformed.status).toBe(400);

    const get = await req("/admin/known-url-patterns");
    const body = (await get.json()) as { patterns: Array<{ regex: string }> };
    expect(body.patterns).toEqual([{ regex: "valid[.]example" }]);
  });

  test("accepts overlapping repetition because matching uses RE2", async () => {
    const response = await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "(a|aa)+$" }] }),
    });
    expect(response.status).toBe(200);
  });

  test("accepts a collector push and GET round-trips the patterns", async () => {
    const post = await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({
        patterns: [{ regex: "notion\\.so/([a-f0-9]{32})$" }, { regex: "drive\\.example\\.com" }],
      }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; count: number };
    expect(postBody.ok).toBe(true);
    expect(postBody.count).toBe(2);

    const get = await req("/admin/known-url-patterns");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { patterns: Array<{ regex: string }> };
    const regexes = getBody.patterns.map((p) => p.regex);
    expect(regexes).toContain("notion\\.so/([a-f0-9]{32})$");
    expect(regexes).toContain("drive\\.example\\.com");
  });

  test("re-posting replaces the previous set", async () => {
    await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "a\\.example\\.com" }] }),
    });
    await req("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns: [{ regex: "b\\.example\\.com" }] }),
    });
    const get = await req("/admin/known-url-patterns");
    const body = (await get.json()) as { patterns: Array<{ regex: string }> };
    const regexes = body.patterns.map((p) => p.regex);
    expect(regexes).toEqual(["b\\.example\\.com"]);
  });
});

describe("POST /documents/bulk", () => {
  async function ingestTwo(): Promise<{ id1: string; id2: string }> {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });
    const rows = db
      .prepare<
        [],
        { id: string; external_id: string }
      >("SELECT id, external_id FROM documents ORDER BY external_id")
      .all();
    return { id1: rows[0].id, id2: rows[1].id };
  }

  test("returns full doc rows keyed by id", async () => {
    const { id1, id2 } = await ingestTwo();

    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [id1, id2] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      docs: Record<string, { id: string; title: string; content: string }>;
    };
    expect(Object.keys(data.docs).sort()).toEqual([id1, id2].sort());
    expect(data.docs[id1].title).toBe("Test Email");
    expect(data.docs[id1].content).toBe("# Hello");
    expect(data.docs[id2].id).toBe(id2);
  });

  test("summary mode returns display identity without corpus content or metadata", async () => {
    const { id1 } = await ingestTwo();
    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [id1], summary: true }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { docs: Record<string, Record<string, unknown>> };
    expect(data.docs[id1]).toEqual({
      id: id1,
      provider_id: "google",
      source_id: "gmail",
      title: "Test Email",
    });
    expect(data.docs[id1]).not.toHaveProperty("content");
    expect(data.docs[id1]).not.toHaveProperty("metadata");
  });

  test("missing IDs are simply absent from the map", async () => {
    const { id1 } = await ingestTwo();
    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [id1, "definitely-not-a-real-id"] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { docs: Record<string, unknown> };
    expect(Object.keys(data.docs)).toEqual([id1]);
  });

  test("empty ids array returns empty docs map without hitting the DB", async () => {
    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ docs: {} });
  });

  test("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(400);
  });

  test("dedupes repeated IDs in the request", async () => {
    const { id1 } = await ingestTwo();
    const res = await req("/documents/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [id1, id1, id1] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { docs: Record<string, unknown> };
    expect(Object.keys(data.docs)).toEqual([id1]);
  });

  test("requires auth", async () => {
    const res = await app.request("/documents/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /documents with cutoff", () => {
  test("filters out documents older than maxAge", async () => {
    const cutoffApp = createServer(db, undefined, {
      config: { dataRetention: { maxAge: "1h" } },
    });
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    const res = await cutoffApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("recent-1"), sourceCreatedAt: recent },
          { ...makeDocPayload("old-1"), sourceCreatedAt: old },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 1 });

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);
  });

  test("keeps all documents when no cutoff configured", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago

    const res = await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("recent-1"), sourceCreatedAt: now.toISOString() },
          { ...makeDocPayload("old-1"), sourceCreatedAt: old },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });
  });

  test("drops all documents when all are older than cutoff", async () => {
    const cutoffApp = createServer(db, undefined, {
      config: { dataRetention: { maxAge: "1h" } },
    });
    const old1 = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const old2 = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    const res = await cutoffApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("old-1"), sourceCreatedAt: old1 },
          { ...makeDocPayload("old-2"), sourceCreatedAt: old2 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0 });
  });

  test("per-source maxAge overrides global", async () => {
    // Global allows 1y; per-source gmail allows only 1h. Calendar docs
    // older than 1h but younger than 1y should pass; gmail docs older than
    // 1h should be dropped.
    const cutoffApp = createServer(db, undefined, {
      config: {
        dataRetention: { maxAge: "1y" },
        sources: { gmail: { maxAge: "1h" } },
      },
    });
    const ninetyMin = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const res = await cutoffApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [
          // gmail: 90 min ago — older than per-source 1h cutoff → dropped.
          { ...makeDocPayload("gmail-old"), sourceCreatedAt: ninetyMin },
          // gmail: 5 min ago — within 1h → kept.
          { ...makeDocPayload("gmail-recent"), sourceCreatedAt: recent },
          // calendar: 90 min ago — older than per-source (no override),
          // but within global 1y → kept.
          {
            ...makeDocPayload("cal-old"),
            sourceId: "google-calendar",
            sourceCreatedAt: ninetyMin,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });

    const ids = db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM documents ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(ids.sort()).toEqual(["cal-old", "gmail-recent"]);
  });

  test("hot-reloads from configStore: edit takes effect on next request", async () => {
    // Stub a minimal ConfigStore — only `get()` is called by the ingest
    // filter; the rest of the interface stays unused here.
    let liveConfig: { dataRetention?: { maxAge?: string } } = {};
    const stubStore = { get: () => liveConfig as never } as unknown as Parameters<
      typeof createServer
    >[2] extends infer O
      ? O
      : never;
    const liveApp = createServer(db, undefined, {
      // configStore takes precedence over `config`. The fallback path
      // (without configStore) still works for plain tests above.
      configStore: stubStore as never,
    });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Initially no cutoff → old doc accepted.
    let res = await liveApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [{ ...makeDocPayload("a"), sourceCreatedAt: old }],
      }),
    });
    expect(await res.json()).toEqual({ ingested: 1 });

    // Operator edits the config — next request sees the new cutoff.
    liveConfig = { dataRetention: { maxAge: "1h" } };
    res = await liveApp.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        documents: [{ ...makeDocPayload("b"), sourceCreatedAt: old }],
      }),
    });
    expect(await res.json()).toEqual({ ingested: 0 });
  });
});

describe("POST /documents/reconcile replay safety", () => {
  test("one stable observation counts once across repeated route delivery", async () => {
    const replayApp = createServer(db, undefined, {
      config: {
        gateway: {
          snapshotAbsence: { minObservations: 3, minAge: "1ms", maxMarksPerSnapshot: 200 },
        },
      },
    });
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("kept"), makeDocPayload("omitted")] }),
    });
    const body = JSON.stringify({
      providerId: "google",
      sourceId: "gmail",
      presentExternalIds: ["kept"],
      observationId: "legacy-snapshot-a",
    });
    const submit = () =>
      replayApp.request("/documents/reconcile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body,
      });

    expect((await (await submit()).json()).absence).toMatchObject({ marked: 1 });
    expect((await (await submit()).json()).absence).toMatchObject({ marked: 0 });
    expect(
      db
        .prepare<
          [],
          { observations: number }
        >("SELECT observations FROM document_absences WHERE external_id = 'omitted'")
        .get()?.observations,
    ).toBe(1);
  });
});

describe("POST /documents/with-cursor cross-cutting concerns", () => {
  test("preserves a stable observation id through validation and route replay", async () => {
    const ioGate = {
      snapshotAbsencePlan: async (
        providerId: string,
        sourceId: string,
        presentExternalIds: string[],
        policy: Parameters<typeof computeSnapshotAbsencePlan>[4],
        scope?: Parameters<typeof computeSnapshotAbsencePlan>[5],
      ) => computeSnapshotAbsencePlan(db, providerId, sourceId, presentExternalIds, policy, scope),
    } as unknown as IComputeScheduler;
    const replayApp = createServer(db, undefined, {
      ioGate,
      config: {
        gateway: {
          snapshotAbsence: { minObservations: 3, minAge: "1ms", maxMarksPerSnapshot: 200 },
        },
      },
    });
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("kept"), makeDocPayload("omitted")] }),
    });
    const body = JSON.stringify({
      providerId: "google",
      sourceId: "gmail",
      presentExternalIds: ["kept"],
      observationId: "epoch-7:attempt-a",
      hasMore: false,
      cursor: { historyId: "7" },
    });
    const submit = () =>
      replayApp.request("/documents/with-cursor", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body,
      });

    expect((await (await submit()).json()).absence).toMatchObject({ marked: 1 });
    expect((await (await submit()).json()).absence).toMatchObject({ marked: 0 });
    expect(
      db
        .prepare<
          [],
          { observations: number }
        >("SELECT observations FROM document_absences WHERE external_id = 'omitted'")
        .get()?.observations,
    ).toBe(1);
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM document_absence_observations WHERE observation_id = 'epoch-7:attempt-a'")
        .get()?.count,
    ).toBe(1);
  });

  test("applies the same maxAge cutoff filter as POST /documents", async () => {
    // Per-source 1h cutoff. Gmail docs older than 1h get dropped at the
    // gateway boundary; this is identical to the `ingest` behaviour and
    // must survive the at-least-once cursor-write refactor.
    const cutoffApp = createServer(db, undefined, {
      config: { dataRetention: { maxAge: "1h" } },
    });
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    const res = await cutoffApp.request("/documents/with-cursor", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        documents: [
          { ...makeDocPayload("recent-1"), sourceCreatedAt: recent },
          { ...makeDocPayload("old-1"), sourceCreatedAt: old },
        ],
        hasMore: false,
        cursor: { historyId: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.reconciledDeleted).toBe(0);

    // Only the recent doc made it to the DB; the old one was culled.
    const ids = db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM documents WHERE source_id = 'gmail' ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["recent-1"]);

    // Cursor still advances even though one doc was dropped.
    const state = db
      .prepare<[string], { cursor: string }>("SELECT cursor FROM sync_state WHERE source_id = ?")
      .get("gmail");
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: 1 });
  });

  test("keeps the legacy deletion field on removed-source and stale-write responses", async () => {
    markSourceRemoved(db, SourceId("gmail:removed@example.com"));
    const removed = (await (
      await req("/documents/with-cursor", {
        method: "POST",
        body: JSON.stringify({
          providerId: "google",
          sourceId: "gmail:removed@example.com",
          hasMore: false,
          cursor: { historyId: 1 },
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(removed).toMatchObject({
      ingested: 0,
      reconciledDeleted: 0,
      rejectedAsRemoved: true,
    });

    await req("/sync-state/gmail:stale@example.com/begin", { method: "POST" });
    const stale = (await (
      await req("/documents/with-cursor", {
        method: "POST",
        body: JSON.stringify({
          providerId: "google",
          sourceId: "gmail:stale@example.com",
          hasMore: false,
          cursor: { historyId: 1 },
          wipeEpoch: 0,
        }),
      })
    ).json()) as Record<string, unknown>;
    expect(stale).toMatchObject({ ingested: 0, reconciledDeleted: 0, rejected: true });
  });

  test("normalizes meta.icon at the write boundary (SVG → PNG data URI)", async () => {
    // A raw inline SVG data URI should land as a PNG data URI in
    // `sync_state.icon` — mirrors the older `POST /sync-state/:sourceId`
    // path that the portal/iOS rely on for uniform icon rendering.
    const svgDataUri =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
      ).toString("base64");

    const res = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        hasMore: false,
        cursor: { historyId: 2 },
        meta: { icon: svgDataUri, label: "Gmail" },
      }),
    });
    expect(res.status).toBe(200);

    const stored = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get("gmail");
    // normalizeIcon rasterizes SVG → PNG data URI. The exact bytes are
    // not deterministic across systems, but the prefix is.
    expect(stored?.icon).toMatch(/^data:image\/png;base64,/);
    expect(stored?.icon).not.toEqual(svgDataUri);
  });

  test("does not persist an unnormalizable icon from documents/with-cursor", async () => {
    const safeIcon = "data:image/png;base64,iVBORw0KGgo=";
    for (const icon of [safeIcon, "not a usable icon"]) {
      const res = await req("/documents/with-cursor", {
        method: "POST",
        body: JSON.stringify({
          providerId: "google",
          sourceId: "gmail",
          hasMore: false,
          cursor: { historyId: icon === safeIcon ? 1 : 2 },
          meta: { icon, label: "Gmail" },
        }),
      });
      expect(res.status).toBe(200);
    }

    const stored = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get("gmail");
    expect(stored?.icon).toBe(safeIcon);

    const freshRes = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "google-calendar",
        hasMore: false,
        cursor: {},
        meta: { icon: "not a usable icon" },
      }),
    });
    expect(freshRes.status).toBe(200);
    const fresh = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get("google-calendar");
    expect(fresh?.icon).toBeNull();
  });

  test("invalidates the URL-pattern cache when meta.urlPatterns is set", async () => {
    // Seed a doc with a URL that matches the about-to-be-installed pattern.
    // Pre-pattern install: cache has a "no patterns" view; post-install:
    // resolving the URL should pick up the new pattern. The invalidation
    // call is what bridges the two — if it's missing, the cache hangs
    // onto the stale empty pattern list until the next process restart.
    const patternsRes = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        hasMore: false,
        cursor: { historyId: 3 },
        meta: {
          urlPatterns: [
            { regex: "^https://mail\\.google\\.com/mail/u/0/#inbox/([^/]+)$", idGroup: 1 },
          ],
        },
      }),
    });
    expect(patternsRes.status).toBe(200);

    // The DB row holds the pattern JSON the route just wrote.
    const stored = db
      .prepare<
        [string],
        { url_patterns: string | null }
      >("SELECT url_patterns FROM sync_state WHERE source_id = ?")
      .get("gmail");
    const parsed = JSON.parse(stored!.url_patterns!);
    expect(parsed[0].regex).toContain("mail\\.google\\.com");
    // (The cache-invalidation side-effect itself is process-internal;
    //  asserting on the absence of a regression here is sufficient —
    //  the regression would be `urlPatterns` not landing at all.)
  });
});

describe("POST /documents/delete-all/source/:sourceId", () => {
  test("deletes all documents for a specific source", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          makeDocPayload("msg-2"),
          { ...makeDocPayload("cal-1"), sourceId: "google-calendar" },
        ],
      }),
    });

    const res = await req("/documents/delete-all/source/gmail", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(2);
  });

  test("an incompatible collector cannot erase a multi-device source", async () => {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const type = SourceType("wipe-contract-synth");
    const owner = createDevice(db, {
      name: `wipe-owner-${randomUUID()}`,
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [type],
        multiDeviceModes: { [type]: "replicated" },
        syncLease: true,
      },
    });
    const legacy = createDevice(db, {
      name: `wipe-legacy-${randomUUID()}`,
      kind: "collector",
      capabilities: { hostableSourceTypes: [type] },
    });
    const source = createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: owner.id,
      multiDeviceMode: "replicated",
    });
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      source.id,
      legacy.id,
      Date.now(),
    );
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("kept", type, source.id)],
      }),
    });
    const token = createToken(db, legacy.id, [SCOPE_WRITE_ALL]).token;

    const res = await app.request(`/documents/delete-all/source/${encodeURIComponent(source.id)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" });
    expect(
      db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM documents WHERE source_id = ?")
        .get(source.id)?.count,
    ).toBe(1);
  });

  test("does not affect documents from other sources", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          { ...makeDocPayload("cal-1"), sourceId: "google-calendar" },
        ],
      }),
    });

    await req("/documents/delete-all/source/gmail", { method: "POST" });

    const countRes = await req("/documents/count/google-calendar");
    const countData = await countRes.json();
    expect(countData.count).toBe(1);
  });

  // Regression for the people-resolution audit: provider discovery
  // caches keyed off the cursor (Notion's databases provider especially)
  // would survive a resync if we deleted documents but left sync_state
  // behind. The DB-layer `deleteAllBySource` clears sync_state in the
  // same transaction as the documents wipe; this test pins that
  // behavior at the HTTP boundary so a future refactor can't silently
  // drop it.
  test("clears sync_state for the source so the next sync re-discovers from scratch", async () => {
    // Seed a cursor — pretend a previous sync left a watermark + a
    // provider-internal discovery cache.
    const setRes = await req("/sync-state/gmail", {
      method: "POST",
      body: JSON.stringify({
        cursor: { historyId: "12345", discoveryCache: { dbs: ["a", "b"] } },
      }),
    });
    expect(setRes.status).toBe(200);

    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          { ...makeDocPayload("cal-1"), sourceId: "google-calendar" },
        ],
      }),
    });

    // Sanity: cursor is there before the wipe.
    const beforeRes = await req("/sync-state/gmail");
    const beforeData = await beforeRes.json();
    expect(beforeData.cursor).toEqual({
      historyId: "12345",
      discoveryCache: { dbs: ["a", "b"] },
    });

    const delRes = await req("/documents/delete-all/source/gmail", {
      method: "POST",
    });
    expect(delRes.status).toBe(200);

    // Cursor wiped — the next sync starts fresh, re-discovering anything
    // the provider had cached internally. The wipe also bumped the source's
    // wipe epoch to 1, so an in-flight sync's stale cursor write is rejected
    // rather than resurrecting the old cursor.
    const afterRes = await req("/sync-state/gmail");
    const afterData = await afterRes.json();
    expect(afterData).toEqual({ cursor: null, lastSyncedAt: null, wipeEpoch: 1 });

    // Other sources' cursors must be untouched.
    await req("/sync-state/google-calendar", {
      method: "POST",
      body: JSON.stringify({ cursor: { syncToken: "abc" } }),
    });
    await req("/documents/delete-all/source/gmail", { method: "POST" });
    const calRes = await req("/sync-state/google-calendar");
    const calData = await calRes.json();
    expect(calData.cursor).toEqual({ syncToken: "abc" });
  });

  // document_people rows for the source must cascade out with the docs.
  // Without this the people graph keeps stale per-doc role rows
  // pointing at deleted document ids. We seed the row directly because
  // people resolution runs in a separate backfill worker that the
  // server-test harness doesn't spin up; the cascade we're verifying is
  // the FK on `document_people.document_id`, which fires the moment
  // `documents` rows are dropped.
  test("clears document_people rows for the source via cascade", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("msg-1")] }),
    });

    const docRow = db
      .prepare<[], { id: string }>("SELECT id FROM documents WHERE source_id = 'gmail' LIMIT 1")
      .get();
    expect(docRow).toBeTruthy();

    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2024-01-15T10:00:00Z', '2024-01-15T10:00:00Z', '2024-01-15T10:00:00Z', '2024-01-15T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO document_people (document_id, person_id, role, source_id)
       VALUES (?, 'p1', 'sender', 'gmail')`,
    ).run(docRow!.id);

    const countDocPeople = (sourceId: string): number =>
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_people WHERE source_id = ?")
        .get(sourceId)?.n ?? 0;
    expect(countDocPeople("gmail")).toBe(1);

    const res = await req("/documents/delete-all/source/gmail", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    expect(countDocPeople("gmail")).toBe(0);
  });
});

describe("POST /documents/delete-all/provider/:providerId", () => {
  test("deletes all documents for a specific provider", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          { ...makeDocPayload("wa-1"), providerId: "whatsapp", sourceId: "whatsapp-messages" },
        ],
      }),
    });

    const res = await req("/documents/delete-all/provider/google", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(1);
  });

  test("does not affect documents from other providers", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          makeDocPayload("msg-1"),
          { ...makeDocPayload("wa-1"), providerId: "whatsapp", sourceId: "whatsapp-messages" },
        ],
      }),
    });

    await req("/documents/delete-all/provider/google", { method: "POST" });

    const countRes = await req("/documents/count/whatsapp-messages");
    const countData = await countRes.json();
    expect(countData.count).toBe(1);
  });
});

describe("GET /documents/count/:sourceId", () => {
  test("returns 0 for unknown source", async () => {
    const res = await req("/documents/count/nonexistent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(0);
  });

  test("returns correct count after ingesting documents", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2"), makeDocPayload("msg-3")],
      }),
    });

    const res = await req("/documents/count/gmail");
    const data = await res.json();
    expect(data.count).toBe(3);
  });
});

describe("GET /documents/search", () => {
  test("returns 400 when q parameter is missing", async () => {
    const res = await req("/documents/search");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("q parameter required");
  });

  test("matches documents by content", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("msg-1"), content: "Meeting with Alice about project" },
          { ...makeDocPayload("msg-2"), content: "Grocery shopping list" },
          { ...makeDocPayload("msg-3"), content: "Alice sent the report" },
        ],
      }),
    });

    const res = await req("/documents/search?q=Alice");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  test("filters results by sources parameter", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("msg-1"), content: "Hello world from email" },
          {
            ...makeDocPayload("cal-1"),
            sourceId: "google-calendar",
            content: "Hello world from calendar",
          },
        ],
      }),
    });

    const res = await req("/documents/search?q=Hello&sources=gmail");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.results[0].source_id).toBe("gmail");
  });

  test("routes through the io gate when one is wired, forwarding a well-formed LikeSearchArgs", async () => {
    // With a gate present the route must delegate the scan off the main thread:
    // it surfaces the gate's rows verbatim and never touches `db` for the scan.
    const stubRows = [
      {
        id: "gate-1",
        title: "Quarterly budget memo",
        source_id: "gmail:self",
        source_created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const likeSearchDocuments = vi.fn(async () => stubRows);
    const gate = {
      likeSearchDocuments,
      browsePeople: vi.fn(),
      enrichedMergeCandidates: vi.fn(),
      snapshotAbsencePlan: vi.fn(),
    } as unknown as IComputeScheduler;
    const gateApp = createServer(db, undefined, { ioGate: gate });

    const res = await gateApp.request(
      "/documents/search?q=budget&sources=gmail:self,notion:self&limit=7",
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // Surfaced the gate's rows unchanged.
    expect(data.results).toEqual(stubRows);
    expect(data.total).toBe(1);
    // Forwarded a well-formed args object: parsed sources, parsed limit, and the
    // main-thread-computed hidden-source list.
    expect(likeSearchDocuments).toHaveBeenCalledTimes(1);
    const args = likeSearchDocuments.mock.calls[0]![0] as {
      query: string;
      sourceIds?: string[];
      hiddenSourceIds: string[];
      limit: number;
    };
    expect(args.query).toBe("budget");
    expect(args.sourceIds).toEqual(["gmail:self", "notion:self"]);
    expect(args.limit).toBe(7);
    expect(Array.isArray(args.hiddenSourceIds)).toBe(true);
  });
});

describe("GET /documents/:id", () => {
  test("returns 404 for nonexistent document", async () => {
    const res = await req("/documents/nonexistent-id-abc123");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Document not found");
  });

  test("returns document by ID prefix", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("msg-1")] }),
    });

    // Get the actual ID from the database
    const row = db.prepare<[], { id: string }>("SELECT id FROM documents LIMIT 1").get();
    const fullId = row!.id;

    const res = await req(`/documents/${fullId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(fullId);
    expect(data.title).toBe("Test Email");
  });

  test("returns the partition stream's device identity", async () => {
    const device = createDevice(db, { name: "Studio-Mini", kind: "collector" });
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("partitioned-detail")] }),
    });
    const row = db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM documents WHERE external_id = 'partitioned-detail'")
      .get()!;
    db.prepare("UPDATE documents SET stream_id = ? WHERE id = ?").run(device.id, row.id);

    const res = await req(`/documents/${row.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stream_id).toBe(device.id);
    expect(data.device_name).toBe("Studio-Mini");
  });

  test("returns 400 for ambiguous ID prefix", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    // Use an empty prefix to match all documents (ambiguous)
    // We need a prefix that matches multiple docs. Use a very short common prefix.
    // All UUIDs share no guaranteed prefix, so we use a trick: query with empty string-like prefix
    const rows = db
      .prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id LIMIT 2")
      .all();
    // Find common prefix between the two IDs
    const id1 = rows[0].id;
    const id2 = rows[1].id;
    let commonPrefix = "";
    for (let i = 0; i < Math.min(id1.length, id2.length); i++) {
      if (id1[i] === id2[i]) {
        commonPrefix += id1[i];
      } else {
        break;
      }
    }

    // If there's no common prefix between the two UUIDs, we need another approach:
    // Insert docs with known IDs by manipulating DB directly
    if (commonPrefix.length === 0) {
      // Directly insert two docs with similar IDs for testing
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES ('aaa-001', 'google', 'gmail', 'x1', 'T1', 'c1', 'h1', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                ('aaa-002', 'google', 'gmail', 'x2', 'T2', 'c2', 'h2', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
      ).run();
      const res = await req("/documents/aaa");
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Ambiguous");
    } else {
      const res = await req(`/documents/${commonPrefix}`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Ambiguous");
    }
  });
});

describe("GET /documents/ids", () => {
  test("returns all document IDs", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/documents/ids");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ids).toHaveLength(2);
    // Each ID should be a string
    expect(typeof data.ids[0]).toBe("string");
    expect(typeof data.ids[1]).toBe("string");
  });
});

describe("recent documents endpoint", () => {
  test("returns recent documents sorted by date descending", async () => {
    // Insert 3 docs with different dates
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("old"),
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            ...makeDocPayload("new"),
            sourceCreatedAt: "2024-03-01T00:00:00Z",
            sourceUpdatedAt: "2024-03-01T00:00:00Z",
          },
          {
            ...makeDocPayload("mid"),
            sourceCreatedAt: "2024-02-01T00:00:00Z",
            sourceUpdatedAt: "2024-02-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/documents/recent/gmail");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toHaveLength(3);
    // Newest first
    expect(data.documents[0].sourceCreatedAt).toBe("2024-03-01T00:00:00Z");
    expect(data.documents[1].sourceCreatedAt).toBe("2024-02-01T00:00:00Z");
    expect(data.documents[2].sourceCreatedAt).toBe("2024-01-01T00:00:00Z");
  });

  test("respects limit parameter", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("a"),
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            ...makeDocPayload("b"),
            sourceCreatedAt: "2024-02-01T00:00:00Z",
            sourceUpdatedAt: "2024-02-01T00:00:00Z",
          },
          {
            ...makeDocPayload("c"),
            sourceCreatedAt: "2024-03-01T00:00:00Z",
            sourceUpdatedAt: "2024-03-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/documents/recent/gmail?limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toHaveLength(2);
  });

  test("keyset-pages without duplicates and binds cursors to the source", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: ["a", "b", "c"].map((externalId, index) => ({
          ...makeDocPayload(`page-${externalId}`),
          sourceCreatedAt: `2024-0${index + 1}-01T00:00:00Z`,
          sourceUpdatedAt: `2024-0${index + 1}-01T00:00:00Z`,
        })),
      }),
    });
    const first = await req("/documents/recent/gmail?limit=2");
    const firstBody = await first.json();
    expect(firstBody.documents.map((doc: { externalId: string }) => doc.externalId)).toEqual([
      "page-c",
      "page-b",
    ]);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(firstBody.pageInfo.nextCursor);
    const second = await req(`/documents/recent/gmail?limit=2&cursor=${cursor}`);
    const secondBody = await second.json();
    expect(secondBody.documents.map((doc: { externalId: string }) => doc.externalId)).toEqual([
      "page-a",
    ]);
    expect(secondBody.pageInfo.hasMore).toBe(false);
    expect((await req(`/documents/recent/other-source?cursor=${cursor}`)).status).toBe(400);
  });

  test("returns empty array for unknown source", async () => {
    const res = await req("/documents/recent/nonexistent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toHaveLength(0);
  });

  test("sanitizes non-numeric and negative limit", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("a"),
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            ...makeDocPayload("b"),
            sourceCreatedAt: "2024-02-01T00:00:00Z",
            sourceUpdatedAt: "2024-02-01T00:00:00Z",
          },
          {
            ...makeDocPayload("c"),
            sourceCreatedAt: "2024-03-01T00:00:00Z",
            sourceUpdatedAt: "2024-03-01T00:00:00Z",
          },
        ],
      }),
    });

    // Non-numeric limit must not crash with a SQLite datatype mismatch (500);
    // it falls back to the default and returns a bounded slice.
    const nanRes = await req("/documents/recent/gmail?limit=abc");
    expect(nanRes.status).toBe(200);
    const nanData = await nanRes.json();
    expect(nanData.documents).toHaveLength(3);

    // Negative limit must not become an unbounded SQLite LIMIT (-1) returning
    // the whole source; it falls back to the default.
    const negRes = await req("/documents/recent/gmail?limit=-1");
    expect(negRes.status).toBe(200);
    const negData = await negRes.json();
    expect(negData.documents.length).toBeLessThanOrEqual(10);
  });

  test("returns content preview not full content", async () => {
    const longContent = "x".repeat(500);
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("long"),
            content: longContent,
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/documents/recent/gmail");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents[0].contentPreview.length).toBeLessThanOrEqual(150);
  });

  test("includes documentType from metadata", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("typed"),
            metadata: { documentType: "email", author: "bob" },
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/documents/recent/gmail");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents[0].documentType).toBe("email");
  });

  test("includes the partition stream's friendly device name", async () => {
    const device = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("partitioned-recent")] }),
    });
    db.prepare("UPDATE documents SET stream_id = ? WHERE external_id = ?").run(
      device.id,
      "partitioned-recent",
    );

    const res = await req("/sources/gmail/recent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents[0].deviceId).toBe(device.id);
    expect(data.documents[0].deviceName).toBe("Maya-Laptop");
  });
});

describe("GET /sources/:sourceId/recent", () => {
  test("returns documents kind when source has documents", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("old"),
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            ...makeDocPayload("new"),
            sourceCreatedAt: "2024-03-01T00:00:00Z",
            sourceUpdatedAt: "2024-03-01T00:00:00Z",
          },
          {
            ...makeDocPayload("mid"),
            sourceCreatedAt: "2024-02-01T00:00:00Z",
            sourceUpdatedAt: "2024-02-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/sources/gmail/recent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("documents");
    expect(data.documents).toHaveLength(3);
    expect(data.documents[0].sourceCreatedAt).toBe("2024-03-01T00:00:00Z");
    expect(data.documents[0].title).toBe("Test Email");
  });

  test("respects limit parameter and caps at 100", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("a"),
            sourceCreatedAt: "2024-01-01T00:00:00Z",
            sourceUpdatedAt: "2024-01-01T00:00:00Z",
          },
          {
            ...makeDocPayload("b"),
            sourceCreatedAt: "2024-02-01T00:00:00Z",
            sourceUpdatedAt: "2024-02-01T00:00:00Z",
          },
          {
            ...makeDocPayload("c"),
            sourceCreatedAt: "2024-03-01T00:00:00Z",
            sourceUpdatedAt: "2024-03-01T00:00:00Z",
          },
        ],
      }),
    });

    const res = await req("/sources/gmail/recent?limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("documents");
    expect(data.documents).toHaveLength(2);
    expect(data.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(data.pageInfo.nextCursor);
    const next = await req(`/sources/gmail/recent?limit=2&cursor=${cursor}`);
    const nextData = await next.json();
    expect(nextData.kind).toBe("documents");
    expect(nextData.documents.map((doc: { externalId: string }) => doc.externalId)).toEqual(["a"]);
    expect(nextData.pageInfo.hasMore).toBe(false);
    expect((await req(`/sources/other-source/recent?cursor=${cursor}`)).status).toBe(400);
  });

  test("returns empty kind when source has no documents and no analytics db", async () => {
    const res = await req("/sources/nonexistent/recent");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("empty");
    expect(data.documents).toBeUndefined();
  });

  test("falls back to analytics table when source has no documents", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    await analyticsDb.ensureTable(
      {
        tableName: "strava_activities",
        displayName: "Strava Activities",
        description: "Workouts",
        columns: [
          { name: "id", type: "VARCHAR", description: "Activity ID" },
          { name: "start_time", type: "TIMESTAMPTZ", description: "Start time" },
          { name: "sport_type", type: "VARCHAR", description: "Sport", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "start_time",
        record: { titleColumns: ["sport_type"], keyColumns: ["id", "start_time"] },
      },
      "strava-activities:99999",
    );
    await analyticsDb.insertRecords(
      "strava_activities",
      [
        { id: "1", start_time: "2024-01-01T00:00:00Z", sport_type: "Run" },
        { id: "2", start_time: "2024-03-01T00:00:00Z", sport_type: "Ride" },
        { id: "3", start_time: "2024-02-01T00:00:00Z", sport_type: "Swim" },
      ],
      ["id"],
    );
    await analyticsDb.updateCatalogStats("strava_activities");

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const res = await withAnalytics.request("/sources/strava-activities:99999/recent?limit=2", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("analytics");
    expect(data.table).toBe("strava_activities");
    expect(data.rows).toHaveLength(2);
    // Newest first (2024-03 then 2024-02)
    const startIdx = data.columns.indexOf("start_time");
    expect(String(data.rows[0][startIdx])).toContain("2024-03");
    expect(String(data.rows[1][startIdx])).toContain("2024-02");
    expect(data.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(data.pageInfo.nextCursor);
    const next = await withAnalytics.request(
      `/sources/strava-activities:99999/recent?limit=2&cursor=${cursor}`,
      {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
    );
    const nextData = await next.json();
    expect(nextData.rows).toHaveLength(1);
    expect(String(nextData.rows[0][startIdx])).toContain("2024-01");
    expect(nextData.pageInfo.hasMore).toBe(false);
    expect(
      (
        await withAnalytics.request(`/sources/strava-activities:other/recent?cursor=${cursor}`, {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        })
      ).status,
    ).toBe(400);

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("matches analytics table by source type prefix", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Source type "screen-time" (no account suffix) — common for auto-discovered
    // structured sources on a single device.
    await analyticsDb.ensureTable(
      {
        tableName: "screen_time_daily",
        displayName: "Screen Time Daily",
        description: "Daily app usage",
        columns: [
          { name: "date", type: "DATE", description: "Date" },
          { name: "app", type: "VARCHAR", description: "App" },
        ],
        primaryKey: ["date", "app"],
        semanticTimeColumn: "date",
        record: { titleColumns: ["app"], keyColumns: ["date", "app"] },
      },
      "screen-time",
    );
    await analyticsDb.insertRecords(
      "screen_time_daily",
      [{ date: "2024-03-01", app: "Safari" }],
      ["date", "app"],
    );
    await analyticsDb.updateCatalogStats("screen_time_daily");

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const res = await withAnalytics.request("/sources/screen-time:local/recent", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("analytics");
    expect(data.table).toBe("screen_time_daily");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("prefers documents over analytics when source has both", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    await analyticsDb.ensureTable(
      {
        tableName: "hybrid_table",
        displayName: "Hybrid",
        description: "Has both docs and rows",
        columns: [
          { name: "id", type: "VARCHAR", description: "ID" },
          { name: "date", type: "DATE", description: "Date" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "date",
        record: { titleColumns: ["id"], keyColumns: ["id", "date"] },
      },
      "gmail",
    );
    await analyticsDb.insertRecords("hybrid_table", [{ id: "1", date: "2024-03-01" }], ["id"]);
    await analyticsDb.updateCatalogStats("hybrid_table");

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    await withAnalytics.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ documents: [makeDocPayload("msg-hybrid")] }),
    });

    const res = await withAnalytics.request("/sources/gmail/recent", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = await res.json();
    expect(data.kind).toBe("documents");
    expect(data.documents).toHaveLength(1);

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("returns empty when analytics has no matching table", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Analytics DB exists but has no table for this source.
    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const res = await withAnalytics.request("/sources/totally-unknown:foo/recent", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("empty");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("picks analytics table with highest record count among candidates", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Both tables are owned by the same source type; the one with more rows wins.
    for (const [name, ids] of [
      ["notion_small", ["a"]],
      ["notion_big", ["x", "y", "z", "w"]],
    ] as const) {
      await analyticsDb.ensureTable(
        {
          tableName: name,
          displayName: name,
          description: name,
          columns: [
            { name: "id", type: "VARCHAR", description: "ID" },
            { name: "created_at", type: "TIMESTAMPTZ", description: "Created" },
          ],
          primaryKey: ["id"],
          semanticTimeColumn: "created_at",
          record: { titleColumns: ["id"], keyColumns: ["id", "created_at"] },
        },
        "notion-databases:ws",
      );
      await analyticsDb.insertRecords(
        name,
        ids.map((id) => ({ id, created_at: "2024-01-01T00:00:00Z" })),
        ["id"],
      );
      await analyticsDb.updateCatalogStats(name);
    }

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    const res = await withAnalytics.request("/sources/notion-databases:ws/recent", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = await res.json();
    expect(data.kind).toBe("analytics");
    expect(data.table).toBe("notion_big");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });
});

describe("GET /documents/:id/refs", () => {
  test("returns 404 for nonexistent document", async () => {
    const res = await req("/documents/nonexistent-id-abc123/refs");
    expect(res.status).toBe(404);
  });

  test("returns refs for a document with links", async () => {
    // Insert target doc with sourceUrl
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("target-1"),
            metadata: { sourceUrl: "https://example.com/page" },
          },
        ],
      }),
    });

    // Insert source doc linking to the target
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("source-1"),
            content: "See https://example.com/page for details.",
          },
        ],
      }),
    });

    // Get target doc ID
    const targetRow = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("target-1");
    const sourceRow = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("source-1");

    // Link processing is background-only — manually trigger for test.
    // processDocumentLinks now defers resolution to the periodic compute
    // reconcile pass; we run reconcileUnresolvedLinks here to flush.
    const { processDocumentLinks } = await import("./domain/LinkExtraction.js");
    const { reconcileUnresolvedLinks } = await import("./links.js");
    const stored = db
      .prepare<[string], any>("SELECT * FROM documents WHERE id = ?")
      .get(sourceRow!.id);
    let meta: any;
    try {
      meta = JSON.parse(stored.metadata);
    } catch {
      /* skip */
    }
    processDocumentLinks(
      db,
      stored.id,
      stored.content,
      meta,
      stored.source_id,
      stored.external_id,
      stored.source_url,
    );
    reconcileUnresolvedLinks(db, 1000, true);

    // Check source refs (outbound)
    const sourceRes = await req(`/documents/${sourceRow!.id}/refs`);
    expect(sourceRes.status).toBe(200);
    const sourceData = await sourceRes.json();
    expect(sourceData.outbound).toHaveLength(1);
    expect(sourceData.outbound[0].targetDocId).toBe(targetRow!.id);

    // Check target refs (inbound)
    const targetRes = await req(`/documents/${targetRow!.id}/refs`);
    expect(targetRes.status).toBe(200);
    const targetData = await targetRes.json();
    expect(targetData.inbound).toHaveLength(1);
    expect(targetData.inbound[0].sourceDocId).toBe(sourceRow!.id);
  });

  test("returns empty refs for doc with no links", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("lonely")] }),
    });

    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("lonely");

    const res = await req(`/documents/${row!.id}/refs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.outbound).toHaveLength(0);
    expect(data.inbound).toHaveLength(0);
  });
});

describe("GET /documents/:id/attachments", () => {
  test("children carry their published links, not the canonical matching key", async () => {
    // Non-web links are stored lowercased as the canonical key; the
    // mixed-case original is the one the target app opens.
    const link = "fictional-app://Items/Ab12CdEf";
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { ...makeDocPayload("mail-9"), metadata: { sourceUrl: link } },
          {
            ...makeDocPayload("mail-9/att/0"),
            title: "report.pdf",
            metadata: { sourceUrl: link, appUrl: link, documentType: "attachment" },
          },
        ],
      }),
    });
    const parent = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("mail-9");
    const stored = db
      .prepare<
        [string],
        { source_url: string }
      >("SELECT source_url FROM documents WHERE external_id = ?")
      .get("mail-9/att/0");
    expect(stored!.source_url).not.toBe(link);

    const res = await req(`/documents/${parent!.id}/attachments`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      attachments: Array<{ sourceUrl: string | null; appUrl: string | null }>;
    };
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]).toMatchObject({ sourceUrl: link, appUrl: link });
  });
});

describe("POST /sql", () => {
  test("requires admin scope", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const res = await app.request("/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(403);
  });

  test("returns columns and rows for valid SELECT", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT id, title FROM documents" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.columns).toEqual(["id", "title"]);
    expect(data.rows).toHaveLength(2);
    expect(data.rowCount).toBe(2);
    expect(typeof data.timing).toBe("number");
  });

  test("blocks write operations at the engine layer (read-only handle)", async () => {
    // The /sql endpoint runs against a dedicated read-only better-sqlite3
    // handle. SQLite rejects every write at the engine level — there's
    // no keyword block-list for an attacker to bypass via leading
    // comments, CTE-with-mutation, or trailing-statement smuggling.
    for (const op of [
      "INSERT INTO documents VALUES (1)",
      "DROP TABLE documents",
      "DELETE FROM documents",
      "UPDATE documents SET title='x'",
      "/* leading comment */ INSERT INTO documents VALUES (1)",
      "  CREATE TABLE evil (x INT)",
    ]) {
      const res = await req("/sql", {
        method: "POST",
        body: JSON.stringify({ sql: op }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      // SQLite's engine-level refusal — exact wording can vary across
      // versions, but every accepted phrasing surfaces as a refusal,
      // never a successful write.
      expect(data.error).toMatch(/readonly|read-only|cannot.*write|syntax error/i);
    }
  });

  test("requires auth", async () => {
    const res = await app.request("/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for invalid SQL", async () => {
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM nonexistent_table_xyz" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });

  test("auto-applies LIMIT when not present", async () => {
    // Insert some docs
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2"), makeDocPayload("msg-3")],
      }),
    });

    // Query with explicit low limit to verify auto-limit doesn't break things
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT id FROM documents", limit: 2 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rows.length).toBeLessThanOrEqual(2);
  });

  test("returns columnTypes alongside columns/rows", async () => {
    // The /sql endpoint surfaces SQLite's declared
    // column type so consumers don't have to guess. Real columns
    // (e.g. `id` from `documents`) carry a non-null type; expression
    // columns are typed null.
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("msg-1")] }),
    });
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT id, COUNT(*) AS n FROM documents GROUP BY id" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.columns).toEqual(["id", "n"]);
    expect(Array.isArray(data.columnTypes)).toBe(true);
    expect(data.columnTypes).toHaveLength(2);
    // `id` has a declared type; `COUNT(*) AS n` is an expression so
    // SQLite surfaces a null type.
    expect(data.columnTypes[0]).toMatch(/TEXT|VARCHAR|STRING/i);
    expect(data.columnTypes[1]).toBeNull();
  });

  test("returns 400 when sql field is missing", async () => {
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    // Canonical validation envelope from validateJson():
    //   { error: "Validation failed", code: "VALIDATION_ERROR",
    //     detail: [{ path: "/<field>", message: "..." }, ...] }
    expect(data.error).toBe("Validation failed");
    expect(data.code).toBe("VALIDATION_ERROR");
    expect(data.detail?.[0]?.path).toBe("/sql");
  });

  test("caps response at SQL_ROW_CAP and surfaces truncated:true", async () => {
    // Generate enough rows to exceed the 10 000 row cap. Use a
    // recursive CTE so we don't have to ingest 10 001 documents.
    // The user explicitly asked for `LIMIT 10001` to bypass the
    // auto-LIMIT injection; the post-query truncation should still
    // clamp the response to 10 000 rows and flag it.
    const overCap = 10_001;
    const sql = `
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${overCap}
      )
      SELECT n FROM seq LIMIT ${overCap}
    `;
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rowCount).toBe(10_000);
    expect(data.rows).toHaveLength(10_000);
    expect(data.truncated).toBe(true);
    expect(data.rowCap).toBe(10_000);
  });

  test("does not flag truncated for queries within the cap", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("trunc-1"), makeDocPayload("trunc-2")],
      }),
    });
    const res = await req("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT id FROM documents" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.truncated).toBeUndefined();
    expect(data.rowCap).toBeUndefined();
  });
});

describe("GET /status", () => {
  test("returns gateway status with document counts", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [makeDocPayload("msg-1"), makeDocPayload("msg-2")],
      }),
    });

    const res = await req("/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents.total).toBe(2);
    expect(data.documents.bySource.gmail).toBe(2);
    expect(data.index.enabled).toBe(false);
    expect(typeof data.uptime).toBe("number");
    expect(data.release).toBeNull();
  });

  test("returns the last successful install-aware release check", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const release = {
      currentVersion: "1.4.0",
      latestVersion: "1.5.0",
      installMethod: "source" as const,
      checkedAt: "2026-09-07T12:00:00.000Z",
      updateAvailable: true,
    };
    const releaseApp = createServer(db, dbPath, { getReleaseCheck: () => release });

    const res = await releaseApp.request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).release).toEqual(release);
  });

  test("carries the main database size beside a null diskUsage when no monitor is wired", async () => {
    const data = await (await req("/status")).json();
    expect(data).toHaveProperty("dbSizeBytes");
    expect(data.diskUsage).toBeNull();
  });

  test("serves the disk usage monitor's footprint alongside the unchanged dbSizeBytes", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const usage = {
      totalBytes: 3000,
      measuredAt: "2026-06-04T10:00:00.000Z",
      stores: [
        { id: "documents", label: "Main database", bytes: 1000 },
        { id: "index", label: "Search index", bytes: 2000 },
      ],
    };
    const diskApp = createServer(db, dbPath, { getDiskUsage: () => usage });

    const res = await diskApp.request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    expect(data.diskUsage).toEqual(usage);
    expect(data.dbSizeBytes).toBe(statSync(dbPath).size);
  });

  test("returns empty status when no documents exist", async () => {
    const res = await req("/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents.total).toBe(0);
  });

  test("advertises experimental mode per OMNESIS_EXPERIMENTAL", async () => {
    const original = process.env.OMNESIS_EXPERIMENTAL;
    try {
      delete process.env.OMNESIS_EXPERIMENTAL;
      let data = await (await req("/status")).json();
      expect(data.experimental).toBe(false);

      process.env.OMNESIS_EXPERIMENTAL = "1";
      data = await (await req("/status")).json();
      expect(data.experimental).toBe(true);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = original;
    }
  });

  test("advertises developer mode per OMNESIS_DEV_MODE", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    try {
      delete process.env.OMNESIS_DEV_MODE;
      let data = await (await req("/status")).json();
      expect(data.developer).toBe(false);

      process.env.OMNESIS_DEV_MODE = "1";
      data = await (await req("/status")).json();
      expect(data.developer).toBe(true);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations routes 404 unless OMNESIS_DEV_MODE is on", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    try {
      delete process.env.OMNESIS_DEV_MODE;
      const off = await req("/dev/annotations");
      expect(off.status).toBe(404);
      const offPost = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({ targetType: "route", note: "x" }),
      });
      expect(offPost.status).toBe(404);

      // The gate runs before auth: an unauthenticated request 404s too (the
      // surface is indistinguishable from absent), not 401.
      const offNoAuth = await app.request("/dev/annotations");
      expect(offNoAuth.status).toBe(404);

      process.env.OMNESIS_DEV_MODE = "1";
      const on = await req("/dev/annotations");
      expect(on.status).toBe(200);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations create → list → resolve → delete round-trip", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const created = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({
          targetType: "document",
          targetId: "doc-xyz",
          note: "Sender name mis-parsed.",
          context: { label: "Q4 budget review" },
          deepLink: "/portal/doc/doc-xyz",
          client: "portal",
        }),
      });
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: string; status: string; targetId: string };
      expect(row.status).toBe("open");
      expect(row.targetId).toBe("doc-xyz");

      const listed = await (await req("/dev/annotations?status=open")).json();
      expect(listed.annotations.map((a: { id: string }) => a.id)).toContain(row.id);

      const resolved = await req(`/dev/annotations/${row.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: "Fixed the parser." }),
      });
      expect(resolved.status).toBe(200);
      expect((await resolved.json()).status).toBe("resolved");

      // Resolved notes drop out of the default (open) list.
      const openAfter = await (await req("/dev/annotations")).json();
      expect(openAfter.annotations.map((a: { id: string }) => a.id)).not.toContain(row.id);

      const removed = await req(`/dev/annotations/${row.id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      const removeAgain = await req(`/dev/annotations/${row.id}`, { method: "DELETE" });
      expect(removeAgain.status).toBe(404);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations create rejects a non-route target without a targetId (400)", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const res = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({ targetType: "document", note: "no id" }),
      });
      expect(res.status).toBe(400);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations accept the idless agent_notes singleton without a targetId", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const res = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({ targetType: "agent_notes", note: "standing notes are stale" }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).targetId).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations accept the android client with platform/version context", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const created = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({
          targetType: "route",
          note: "Stale brief on the agent screen.",
          context: {
            label: "General note — agent",
            platform: "android",
            appVersion: "0.4.6",
            appBuild: "1",
          },
          deepLink: "agent",
          client: "android",
        }),
      });
      expect(created.status).toBe(201);
      const row = (await created.json()) as {
        id: string;
        client: string;
        context: Record<string, unknown>;
      };
      expect(row.client).toBe("android");
      expect(row.context).toMatchObject({
        platform: "android",
        appVersion: "0.4.6",
        appBuild: "1",
      });

      const listed = await (await req("/dev/annotations?status=open")).json();
      const found = (listed.annotations as (typeof row)[]).find((a) => a.id === row.id);
      expect(found?.context).toMatchObject({ platform: "android" });
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations still accept legacy portal/ios bodies without metadata", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      // A body predating the client-metadata change: no version keys, and one
      // with no client/context at all. Widening the `client` enum must not
      // break what older clients already file.
      for (const body of [
        {
          targetType: "brief",
          targetId: "b-1",
          note: "Stale numbers.",
          context: { label: "Brief b-1" },
          client: "ios",
        },
        { targetType: "route", note: "General note." },
      ]) {
        const created = await req("/dev/annotations", {
          method: "POST",
          body: JSON.stringify(body),
        });
        expect(created.status).toBe(201);
      }
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations round-trip a portal user-agent context", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const created = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({
          targetType: "route",
          note: "Sidebar overlaps the composer.",
          context: {
            label: "General note — /portal/settings",
            platform: "portal",
            userAgent: "TestBrowser/1.0",
          },
          deepLink: "/portal/settings",
          client: "portal",
        }),
      });
      expect(created.status).toBe(201);
      const row = (await created.json()) as {
        id: string;
        context: Record<string, unknown>;
      };
      expect(row.context).toMatchObject({ platform: "portal", userAgent: "TestBrowser/1.0" });
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations reject an unknown client (400)", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const res = await req("/dev/annotations", {
        method: "POST",
        body: JSON.stringify({ targetType: "route", note: "x", client: "watch" }),
      });
      expect(res.status).toBe(400);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("dev-annotations reject a read-scope-less token", async () => {
    const original = process.env.OMNESIS_DEV_MODE;
    process.env.OMNESIS_DEV_MODE = "1";
    try {
      const { token } = mintToken([SCOPE_WRITE_ALL]);
      const res = await app.request("/dev/annotations", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    } finally {
      if (original === undefined) delete process.env.OMNESIS_DEV_MODE;
      else process.env.OMNESIS_DEV_MODE = original;
    }
  });

  test("latestActivityBySource includes analytics-only sources via DuckDB catalog", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const { AccountId, SourceType } = await import("@omnesis/core");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Mirror an exclusive-ownership source: catalog source_id = full
    // `<type>:<account>`. Use a single timestamp column so updateCatalogStats
    // populates `latest_date`.
    await analyticsDb.ensureTable(
      {
        tableName: "screen_time_daily",
        displayName: "Screen Time Daily",
        description: "Daily app usage",
        columns: [
          { name: "id", type: "VARCHAR", description: "ID" },
          { name: "date", type: "DATE", description: "Day" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "date",
        record: { titleColumns: ["id"], keyColumns: ["id", "date"] },
      },
      "screen-time:local",
    );
    await analyticsDb.insertRecords(
      "screen_time_daily",
      [
        { id: "1", date: "2024-03-10" },
        { id: "2", date: "2024-03-12" },
        { id: "3", date: "2024-03-11" },
      ],
      ["id"],
    );
    await analyticsDb.updateCatalogStats("screen_time_daily");

    const dev = createDevice(db, { name: "screen-time-dev", kind: "collector" });
    createSource(db, {
      type: SourceType("screen-time"),
      accountId: AccountId("local"),
      deviceId: dev.id,
    });

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    // The status cache computes the activity map on its first refresh,
    // which runs off the request path; wait for it rather than for a clock.
    const entry = await vi.waitFor(
      async () => {
        const res = await withAnalytics.request("/status", {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        const found = data.latestActivityBySource["screen-time:local"];
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(entry.kind).toBe("analytics");
    expect(entry.tableName).toBe("screen_time_daily");
    expect(entry.tableDisplayName).toBe("Screen Time Daily");
    // Latest of the three dates is 2024-03-12; ISO normalisation gives midnight UTC.
    expect(entry.latestActivityAt).toBe("2024-03-12T00:00:00.000Z");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("latestActivityBySource matches analytics catalog by bare source type when sibling sources share a table", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const { AccountId, SourceType } = await import("@omnesis/core");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Catalog source_id stored as the bare type — matches multi-account
    // (browser-history, apple-health with siblings) ownership pattern.
    await analyticsDb.ensureTable(
      {
        tableName: "health_activity",
        displayName: "Activity & Movement",
        description: "Steps, distance, etc.",
        columns: [
          { name: "id", type: "VARCHAR", description: "ID" },
          { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "start_time",
        record: { titleColumns: ["id"], keyColumns: ["id", "start_time"] },
      },
      "apple-health",
    );
    await analyticsDb.insertRecords(
      "health_activity",
      [{ id: "1", start_time: "2024-04-15T08:00:00Z" }],
      ["id"],
    );
    await analyticsDb.updateCatalogStats("health_activity");

    const dev = createDevice(db, { name: "iphone", kind: "ios" });
    createSource(db, {
      type: SourceType("apple-health"),
      accountId: AccountId("local"),
      deviceId: dev.id,
    });

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    // The status cache computes the activity map on its first refresh,
    // which runs off the request path; wait for it rather than for a clock.
    const entry = await vi.waitFor(
      async () => {
        const res = await withAnalytics.request("/status", {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        const data = await res.json();
        const found = data.latestActivityBySource["apple-health:local"];
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(entry.kind).toBe("analytics");
    expect(entry.tableName).toBe("health_activity");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("latestActivityBySource picks the most recent sample across multiple analytics tables for one source", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const { AccountId, SourceType } = await import("@omnesis/core");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    // Two tables for the same source — newer sample wins, regardless of
    // catalog order. Apple Health emits 8 sibling tables in production;
    // this collapses that into the smallest scenario that exercises the
    // MAX-across-tables behaviour.
    for (const [table, ts] of [
      ["health_body", "2024-01-05T00:00:00Z"],
      ["health_activity", "2024-06-10T00:00:00Z"],
    ] as const) {
      await analyticsDb.ensureTable(
        {
          tableName: table,
          displayName: table,
          description: table,
          columns: [
            { name: "id", type: "VARCHAR", description: "ID" },
            { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
          ],
          primaryKey: ["id"],
          semanticTimeColumn: "start_time",
          record: { titleColumns: ["id"], keyColumns: ["id", "start_time"] },
        },
        "apple-health:local",
      );
      await analyticsDb.insertRecords(table, [{ id: "1", start_time: ts }], ["id"]);
      await analyticsDb.updateCatalogStats(table);
    }

    const dev = createDevice(db, { name: "iphone", kind: "ios" });
    createSource(db, {
      type: SourceType("apple-health"),
      accountId: AccountId("local"),
      deviceId: dev.id,
    });

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    // The status cache computes the activity map on its first refresh,
    // which runs off the request path; wait for it rather than for a clock.
    const entry = await vi.waitFor(
      async () => {
        const res = await withAnalytics.request("/status", {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        const data = await res.json();
        const found = data.latestActivityBySource["apple-health:local"];
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(entry.kind).toBe("analytics");
    expect(entry.tableName).toBe("health_activity");
    expect(entry.latestActivityAt).toBe("2024-06-10T00:00:00.000Z");

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });

  test("latestActivityBySource prefers document-based activity over analytics for hybrid sources", async () => {
    const { AnalyticsDb } = await import("./analytics-db.js");
    const { createSource } = await import("./data/repositories/SourceRepository.js");
    const { upsertDocuments } = await import("./db.js");
    const { AccountId, SourceType } = await import("@omnesis/core");
    const analyticsPath = `/tmp/omnesis-analytics-test-${randomUUID()}.db`;
    const analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();

    await analyticsDb.ensureTable(
      {
        tableName: "hybrid_table",
        displayName: "Hybrid",
        description: "Has both",
        columns: [
          { name: "id", type: "VARCHAR", description: "ID" },
          { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "start_time",
        record: { titleColumns: ["id"], keyColumns: ["id", "start_time"] },
      },
      "gmail",
    );
    await analyticsDb.insertRecords(
      "hybrid_table",
      [{ id: "1", start_time: "2099-01-01T00:00:00Z" }],
      ["id"],
    );
    await analyticsDb.updateCatalogStats("hybrid_table");

    const dev = createDevice(db, { name: "collector", kind: "collector" });
    createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("gmail"),
      deviceId: dev.id,
    });
    // Seed the doc directly so source_stats.latest_* is populated before
    // we spin the server — the createServer sync-prime then sees a
    // ready document-based entry without waiting for the 2s cache tick.
    upsertDocuments(db, [
      {
        providerId: "google",
        sourceId: "gmail",
        externalId: "hybrid-msg",
        title: "Hybrid email",
        content: "body",
        contentHash: "h-hybrid",
        metadata: {},
        sourceCreatedAt: "2024-01-15T10:00:00Z",
        sourceUpdatedAt: "2024-01-15T10:00:00Z",
      },
    ]);

    const withAnalytics = createServer(db, undefined, { analyticsDb });
    // Allow the async analytics-cache prime to finish.
    await new Promise((r) => setTimeout(r, 100));

    const res = await withAnalytics.request("/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = await res.json();
    const entry = data.latestActivityBySource["gmail"];
    expect(entry).toBeDefined();
    // Document-based wins even though the analytics row's timestamp is in 2099.
    expect(entry.kind).toBe("document");
    expect(entry.docId).toBeDefined();

    await analyticsDb.close();
    for (const suffix of ["", ".wal"]) {
      if (existsSync(analyticsPath + suffix)) unlinkSync(analyticsPath + suffix);
    }
  });
});

describe("GET /links/stats", () => {
  test("returns stats with zero links", async () => {
    const res = await req("/links/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalLinks).toBe(0);
    expect(data.resolvedLinks).toBe(0);
    expect(data.unresolvedLinks).toBe(0);
  });

  test("returns stats after link processing", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            ...makeDocPayload("stats-1"),
            content: "Link to https://example.com and https://other.com",
          },
        ],
      }),
    });

    // Link processing is background-only — manually trigger for test
    const { processDocumentLinks } = await import("./domain/LinkExtraction.js");
    const stored = db
      .prepare<[string], any>("SELECT * FROM documents WHERE external_id = ?")
      .get("stats-1");
    // URL links are stored only if they could ever resolve. Register a
    // permissive url-id pattern so the two example links are kept (the gate's
    // drop path is covered directly in links.test.ts).
    const { setSyncState, invalidateUrlIdPatternCache } = await import("./db.js");
    setSyncState(db, stored.source_id, {}, { urlPatterns: [{ regex: "(https?://.+)" }] });
    invalidateUrlIdPatternCache();
    let meta: any;
    try {
      meta = JSON.parse(stored.metadata);
    } catch {
      /* skip */
    }
    processDocumentLinks(
      db,
      stored.id,
      stored.content,
      meta,
      stored.source_id,
      stored.external_id,
      stored.source_url,
    );

    const res = await req("/links/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalLinks).toBe(2);
    expect(data.byType.url.total).toBe(2);
  });
});

describe("SQLite catalog endpoints", () => {
  test("GET /sqlite/catalog returns tables with descriptions and counts", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("cat-1"), makeDocPayload("cat-2")] }),
    });

    const res = await req("/sqlite/catalog");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(Array.isArray(data.tables)).toBe(true);
    const docsEntry = data.tables.find((t: any) => t.tableName === "documents");
    expect(docsEntry).toBeDefined();
    expect(docsEntry.displayName).toBe("Documents");
    expect(docsEntry.description).toContain("indexed documents");
    expect(docsEntry.recordCount).toBe(2);
    expect(docsEntry.columns.length).toBeGreaterThan(5);
    expect(docsEntry.primaryKey).toEqual(["id"]);
    expect(docsEntry.exampleQueries.length).toBeGreaterThan(0);

    // Sync state + tokens + sessions always exist after createDatabase
    expect(data.tables.some((t: any) => t.tableName === "sync_state")).toBe(true);
    expect(data.tables.some((t: any) => t.tableName === "tokens")).toBe(true);
  });

  test("GET /sqlite/catalog/:table returns detail + preview rows", async () => {
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [makeDocPayload("cat-3")] }),
    });

    const res = await req("/sqlite/catalog/documents");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.catalog.tableName).toBe("documents");
    expect(data.sampleColumns).toContain("title");
    // previewColumns excludes the full `content` blob
    expect(data.sampleColumns).not.toContain("content");
    expect(data.sampleRows.length).toBe(1);
    expect(data.sampleRows[0].length).toBe(data.sampleColumns.length);
  });

  test("GET /sqlite/catalog/:table returns 404 for unknown table", async () => {
    const res = await req("/sqlite/catalog/not_a_real_table");
    expect(res.status).toBe(404);
  });

  // Locks the catalog against schema drift on the auth tables. The
  // previous catalog declared a `scope` (singular) column that was
  // renamed to `scopes` (JSON array) by the next-gen-architecture
  // migration; the preview SELECT then 500'd in the portal.
  test("GET /sqlite/catalog/:table returns 200 for tokens and sessions (matches actual DB schema)", async () => {
    for (const table of ["tokens", "sessions"]) {
      const res = await req(`/sqlite/catalog/${table}`);
      expect(res.status, `${table} should not 500`).toBe(200);
      const data = await res.json();
      const colNames = data.catalog.columns.map((c: any) => c.name);
      expect(colNames).toContain("scopes");
      expect(colNames).not.toContain("scope");
    }
  });

  // sessions.session_hash and tokens.token_hash are SHA-256 hashes of
  // live bearer credentials. Neither should ever appear verbatim in
  // the data preview, even though the user is authenticated to view
  // them via /sqlite/catalog. Schema descriptions stay visible so
  // users still know the columns exist.
  test("GET /sqlite/catalog/:table redacts sensitive columns (session hashes, token hashes)", async () => {
    const sessions = await (await req("/sqlite/catalog/sessions")).json();
    const sessIdCol = sessions.catalog.columns.find((c: any) => c.name === "id");
    expect(sessIdCol.sensitive).not.toBe(true);
    const sessHashCol = sessions.catalog.columns.find((c: any) => c.name === "session_hash");
    expect(sessHashCol.sensitive).toBe(true);
    const sessionHashIdx = sessions.sampleColumns.indexOf("session_hash");
    for (const row of sessions.sampleRows) {
      // Either redacted, or NULL if the row genuinely had no id (won't
      // happen in practice since `id` is PK NOT NULL, but be permissive).
      expect(row[sessionHashIdx] === "<redacted>" || row[sessionHashIdx] == null).toBe(true);
    }

    const tokens = await (await req("/sqlite/catalog/tokens")).json();
    const hashCol = tokens.catalog.columns.find((c: any) => c.name === "token_hash");
    expect(hashCol.sensitive).toBe(true);
    // token_hash must appear in the preview (so the redaction is visibly
    // demonstrated) AND every value must be the redaction marker — not
    // absent, not null, not the real hash.
    const hashIdx = tokens.sampleColumns.indexOf("token_hash");
    expect(hashIdx, "token_hash should be in sampleColumns").toBeGreaterThanOrEqual(0);
    expect(tokens.sampleRows.length).toBeGreaterThan(0);
    for (const row of tokens.sampleRows) {
      expect(row[hashIdx]).toBe("<redacted>");
    }
    // tokens.id is *not* sensitive — distinguishes rows in the preview.
    const idIdxT = tokens.sampleColumns.indexOf("id");
    const someIdRow = tokens.sampleRows.find((r: any[]) => r[idIdxT]);
    if (someIdRow) expect(someIdRow[idIdxT]).not.toBe("<redacted>");
  });

  // Portal renders typed links (document/person/source/url) based on the
  // `references` field set on each ColumnDefinition. Lock that wiring here
  // so a later edit can't silently strip the annotation and re-introduce
  // the regex-based linking that 404'd on health/people ids.
  test("GET /sqlite/catalog/:table exposes column references for portal link rendering", async () => {
    const get = async (table: string) => {
      const r = await req(`/sqlite/catalog/${table}`);
      const d = await r.json();
      const byName: Record<string, any> = {};
      for (const c of d.catalog.columns) byName[c.name] = c;
      return byName;
    };

    const documents = await get("documents");
    expect(documents.id.references).toBe("document");
    expect(documents.source_id.references).toBe("source");
    expect(documents.source_url.references).toBe("url");
    expect(documents.title.references).toBeUndefined();

    const people = await get("people");
    // people.id is a *person* id — must NOT be tagged as document, or the
    // portal would route /portal/doc/<personId> (404).
    expect(people.id.references).toBe("person");
    expect(people.merged_into.references).toBe("person");

    const docPeople = await get("document_people");
    expect(docPeople.document_id.references).toBe("document");
    expect(docPeople.person_id.references).toBe("person");
    expect(docPeople.source_id.references).toBe("source");

    const links = await get("document_links");
    expect(links.source_doc_id.references).toBe("document");
    expect(links.target_doc_id.references).toBe("document");

    const aliases = await get("person_aliases");
    expect(aliases.person_id.references).toBe("person");
    // alias-row id has no portal page — must stay unset.
    expect(aliases.id.references).toBeUndefined();
  });

  test("GET /sqlite/activity/:table returns per-day row counts", async () => {
    const now = new Date().toISOString();
    await req("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: [{ ...makeDocPayload("act-1"), sourceCreatedAt: now, sourceUpdatedAt: now }],
      }),
    });

    const res = await req("/sqlite/activity/documents?days=7");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.days).toBe(7);
    expect(Array.isArray(data.points)).toBe(true);
    expect(data.points.length).toBeGreaterThan(0);
    expect(data.points[0]).toHaveProperty("day");
    expect(data.points[0]).toHaveProperty("count");
  });

  test("GET /sqlite/activity/:table with unknown table returns empty", async () => {
    const res = await req("/sqlite/activity/bogus?days=7");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.points).toEqual([]);
  });
});

describe("admin config endpoints", () => {
  let configDir: string;
  let configPath: string;
  let configStore: import("./config-store.js").ConfigStore;
  let cfgApp: ReturnType<typeof createServer>;
  let cfgToken: string;

  async function cfgReq(path: string, options: RequestInit = {}) {
    return cfgApp.request(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfgToken}`,
        ...options.headers,
      },
    });
  }

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { ConfigStore } = await import("./config-store.js");
    configDir = mkdtempSync(join(tmpdir(), "omnesis-config-api-"));
    configPath = join(configDir, "omnesis.json");
    configStore = new ConfigStore({ filePath: configPath, watchDebounceMs: 40 });
    await configStore.load();
    cfgToken = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]).token;
    cfgApp = createServer(db, undefined, { configDir, configStore });
  });

  afterEach(() => {
    configStore.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  // `/config` is the read-scope view. Its `resolvedSearch` is what a caller
  // recording the settings behind a measurement reads (the eval runner's
  // system snapshot), so the contract is pinned here: present and populated
  // even when the operator has overridden nothing.
  test("GET /config carries the resolved search settings, not just the overrides", async () => {
    const res = await cfgReq("/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { search?: unknown };
      resolvedSearch: { params: { rrfK: number; resultLimit: number }; boosts: unknown };
    };
    // Nothing overridden — the raw config says nothing about search…
    expect(body.config.search).toBeUndefined();
    // …but the resolved view still reports what the pipeline runs with.
    expect(body.resolvedSearch.params.rrfK).toBe(DEFAULT_SEARCH_PARAMS.rrfK);
    expect(body.resolvedSearch.params.resultLimit).toBe(DEFAULT_SEARCH_PARAMS.resultLimit);
    expect(body.resolvedSearch.boosts).toEqual(DEFAULT_SEARCH_BOOSTS);
  });

  test("GET /config layers an operator override onto the resolved search settings", async () => {
    const patched = await cfgReq("/admin/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search: { params: { rrfK: 17 } } }),
    });
    expect(patched.status).toBe(200);

    const res = await cfgReq("/config");
    const body = (await res.json()) as {
      resolvedSearch: { params: { rrfK: number; resultLimit: number } };
    };
    expect(body.resolvedSearch.params.rrfK).toBe(17);
    // Untouched knobs keep their defaults rather than vanishing.
    expect(body.resolvedSearch.params.resultLimit).toBe(DEFAULT_SEARCH_PARAMS.resultLimit);
  });

  test("GET /admin/config returns empty config initially", async () => {
    const res = await cfgReq("/admin/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: unknown; version: number };
    expect(body.config).toEqual({});
    expect(body.version).toBe(0);
  });

  test("PATCH /admin/config applies a merge patch and persists", async () => {
    const res = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ indexer: { cycleInterval: "10m" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changedPaths: string[]; version: number };
    expect(body.ok).toBe(true);
    expect(body.changedPaths).toEqual(["/indexer/cycleInterval"]);
    expect(body.version).toBe(1);

    // Second GET reflects the change.
    const getRes = await cfgReq("/admin/config");
    const getBody = (await getRes.json()) as { config: { indexer?: { cycleInterval?: string } } };
    expect(getBody.config.indexer?.cycleInterval).toBe("10m");
  });

  test("PATCH /admin/config stores inference backend apiKey as a config secret reference", async () => {
    const res = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              type: "http",
              url: "https://api.example.com",
              apiKey: "sk-example",
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        inference?: { backends?: { openai?: { apiKey?: string; apiKeySecret?: string } } };
      };
    };

    const backend = body.config.inference?.backends?.openai;
    expect(backend?.apiKey).toBeUndefined();
    expect(backend?.apiKeySecret).toMatch(/^config-secret:inference\.backend\./);

    const rawRes = await cfgReq("/admin/config/raw");
    const raw = await rawRes.text();
    expect(raw).not.toContain("sk-example");
    expect(raw).toContain("apiKeySecret");

    const { readConfigSecretRefSync } = await import("@omnesis/core");
    expect(readConfigSecretRefSync(backend!.apiKeySecret!, { configDir })).toBe("sk-example");
  });

  test("PATCH /admin/config replacing an apiKey removes the old config secret", async () => {
    const { configSecretPath, readConfigSecretRefSync } = await import("@omnesis/core");

    const first = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              type: "http",
              url: "https://api.example.com",
              apiKey: "sk-example-one",
            },
          },
        },
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      config: { inference?: { backends?: { openai?: { apiKeySecret?: string } } } };
    };
    const firstRef = firstBody.config.inference?.backends?.openai?.apiKeySecret;
    expect(firstRef).toBeDefined();
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(true);

    const second = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              type: "http",
              url: "https://api.example.com",
              apiKey: "sk-example-two",
            },
          },
        },
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      config: { inference?: { backends?: { openai?: { apiKeySecret?: string } } } };
    };
    const secondRef = secondBody.config.inference?.backends?.openai?.apiKeySecret;

    expect(secondRef).toBeDefined();
    expect(secondRef).not.toBe(firstRef);
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(false);
    expect(readConfigSecretRefSync(secondRef!, { configDir })).toBe("sk-example-two");
  });

  test("PATCH /admin/config replacing a legacy inline apiKey deletes the plaintext key", async () => {
    const { readConfigSecretRefSync } = await import("@omnesis/core");
    await configStore.put({
      inference: {
        backends: {
          openai: {
            type: "http",
            url: "https://api.example.com",
            apiKey: "sk-legacy",
          },
        },
      },
    });

    const res = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              apiKey: "sk-replacement",
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        inference?: { backends?: { openai?: { apiKey?: string; apiKeySecret?: string } } };
      };
    };
    const backend = body.config.inference?.backends?.openai;

    expect(backend?.apiKey).toBeUndefined();
    expect(backend?.apiKeySecret).toMatch(/^config-secret:inference\.backend\./);
    const raw = await (await cfgReq("/admin/config/raw")).text();
    expect(raw).not.toContain("sk-legacy");
    expect(raw).not.toContain("sk-replacement");
    expect(readConfigSecretRefSync(backend!.apiKeySecret!, { configDir })).toBe("sk-replacement");
  });

  test("PATCH /admin/config deleting a backend removes its config secret", async () => {
    const { configSecretPath } = await import("@omnesis/core");
    const first = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              type: "http",
              url: "https://api.example.com",
              apiKey: "sk-delete-me",
            },
          },
        },
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      config: { inference?: { backends?: { openai?: { apiKeySecret?: string } } } };
    };
    const firstRef = firstBody.config.inference?.backends?.openai?.apiKeySecret;
    expect(firstRef).toBeDefined();
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(true);

    const res = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { backends: { openai: null } } }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(false);
  });

  test("PUT /admin/config removes config secrets omitted from the replacement", async () => {
    const { configSecretPath } = await import("@omnesis/core");
    const first = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: {
          backends: {
            openai: {
              type: "http",
              url: "https://api.example.com",
              apiKey: "sk-replace-me",
            },
          },
        },
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      config: { inference?: { backends?: { openai?: { apiKeySecret?: string } } } };
    };
    const firstRef = firstBody.config.inference?.backends?.openai?.apiKeySecret;
    expect(firstRef).toBeDefined();
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(true);

    const res = await cfgReq("/admin/config", {
      method: "PUT",
      body: JSON.stringify({ indexer: { cycleInterval: "15m" } }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(configSecretPath(firstRef!, configDir))).toBe(false);
  });

  test("PATCH rejects invalid input with schema errors", async () => {
    const res = await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ sources: { default: { syncInterval: "invalid" } } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { path: string }[] };
    expect(body.error).toBe("Validation failed");
    expect(body.detail[0].path).toBe("/sources/default/syncInterval");
  });

  test("PUT /admin/config replaces wholesale", async () => {
    await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ indexer: { cycleInterval: "10m" } }),
    });
    const res = await cfgReq("/admin/config", {
      method: "PUT",
      body: JSON.stringify({ search: { params: { rrfK: 42 } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { indexer?: unknown; search?: { params?: { rrfK?: number } } };
    };
    expect(body.config.indexer).toBeUndefined();
    expect(body.config.search?.params?.rrfK).toBe(42);
  });

  test("PATCH with invalid JSON returns 400", async () => {
    const res = await cfgApp.request("/admin/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfgToken}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("GET /admin/config/raw returns the file text", async () => {
    await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ indexer: { cycleInterval: "10m" } }),
    });
    const res = await cfgReq("/admin/config/raw");
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = JSON.parse(text);
    expect(parsed.indexer.cycleInterval).toBe("10m");
  });

  test("GET /admin/config/status reports ok state + version", async () => {
    await cfgReq("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ indexer: { cycleInterval: "10m" } }),
    });
    const res = await cfgReq("/admin/config/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number; lastError: unknown };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
    expect(body.lastError).toBeNull();
  });

  test("GET /admin/config/events streams config changes and requires admin", async () => {
    const readOnlyToken = mintToken([SCOPE_READ]).token;
    const denied = await cfgApp.request("/admin/config/events", {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    });
    expect(denied.status).toBe(403);

    const ac = new AbortController();
    const streamRes = await cfgApp.request("/admin/config/events", {
      headers: { Authorization: `Bearer ${cfgToken}` },
      signal: ac.signal,
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      await reader.read(); // initial heartbeat
      await cfgReq("/admin/config", {
        method: "PATCH",
        body: JSON.stringify({ indexer: { cycleInterval: "10m" } }),
      });
      const deadline = Date.now() + 1000;
      while (!text.includes("/indexer/cycleInterval")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        if (Date.now() > deadline) throw new Error("timed out waiting for config SSE");
      }
    } finally {
      ac.abort();
      reader.releaseLock();
    }
    expect(text).toContain('"changedPaths":["/indexer/cycleInterval"]');
  });

  test("GET /admin/config/schema returns the descriptor tree that drives the form", async () => {
    const res = await cfgReq("/admin/config/schema");
    expect(res.status).toBe(200);
    const root = (await res.json()) as {
      kind: string;
      children: Array<{ key: string; kind: string; ownedBy?: { page: string } }>;
    };
    expect(root.kind).toBe("object");
    const sections = new Map(root.children.map((c) => [c.key, c]));
    // Top-level sections that the structured form renders.
    expect(sections.has("indexer")).toBe(true);
    expect(sections.has("search")).toBe(true);
    // inference is owned by the Models tab — present but flagged, not rendered.
    expect(sections.get("inference")?.ownedBy?.page).toBe("Models");
  });

  test("GET /admin/config/schema requires admin scope", async () => {
    const readOnlyToken = mintToken([SCOPE_READ]).token;
    const res = await cfgApp.request("/admin/config/schema", {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("admin scope is required", async () => {
    const readOnlyToken = mintToken([SCOPE_READ]).token;
    const res = await cfgApp.request("/admin/config", {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("no configStore → endpoints not registered (404)", async () => {
    const plainApp = createServer(db);
    for (const path of ["/admin/config", "/admin/config/schema", "/admin/config/events"]) {
      const res = await plainApp.request(path, {
        headers: { Authorization: `Bearer ${cfgToken}` },
      });
      expect(res.status, `${path} should 404 without a configStore`).toBe(404);
    }
  });

  test("POST /admin/sources mirrors config into the file", async () => {
    const devRes = await cfgReq("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "laptop", kind: "collector", scopes: ["read", "write:*"] }),
    });
    const { device } = (await devRes.json()) as { device: { id: string } };

    const addRes = await cfgReq("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "test@example.com",
        deviceId: device.id,
        config: { syncInterval: "2m", extractAttachments: true, legacyScratchField: "ignore-me" },
      }),
    });
    expect(addRes.status).toBe(200);

    const cfgRes = await cfgReq("/admin/config");
    const cfg = (
      (await cfgRes.json()) as {
        config: {
          sources?: Record<
            string,
            { syncInterval?: string; extractAttachments?: boolean; legacyScratchField?: string }
          >;
        };
      }
    ).config;
    expect(cfg.sources?.["gmail:test@example.com"]?.syncInterval).toBe("2m");
    expect(cfg.sources?.["gmail:test@example.com"]?.extractAttachments).toBe(true);
    // Non-schema keys are filtered out so validation doesn't reject the patch.
    expect(cfg.sources?.["gmail:test@example.com"]?.legacyScratchField).toBeUndefined();
  });

  test("PATCH /admin/sources/:id updates the config file for config fields only", async () => {
    const devRes = await cfgReq("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "laptop", kind: "collector", scopes: ["read"] }),
    });
    const { device } = (await devRes.json()) as { device: { id: string } };
    await cfgReq("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "x@y.com",
        deviceId: device.id,
        config: { syncInterval: "5m" },
      }),
    });
    const patchRes = await cfgReq("/admin/sources/gmail:x@y.com", {
      method: "PATCH",
      body: JSON.stringify({ config: { syncInterval: "1m", extractAttachments: true } }),
    });
    expect(patchRes.status).toBe(200);

    const cfg = (
      (await (await cfgReq("/admin/config")).json()) as {
        config: {
          sources?: Record<string, { syncInterval?: string; extractAttachments?: boolean }>;
        };
      }
    ).config;
    expect(cfg.sources?.["gmail:x@y.com"]?.syncInterval).toBe("1m");
    expect(cfg.sources?.["gmail:x@y.com"]?.extractAttachments).toBe(true);
  });

  test("source config mirroring replaces one source without retaining omitted params", async () => {
    const devRes = await cfgReq("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "laptop", kind: "collector", scopes: ["read"] }),
    });
    const { device } = (await devRes.json()) as { device: { id: string } };
    await cfgReq("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "primary@example.com",
        deviceId: device.id,
        config: {
          syncInterval: "5m",
          params: { legacyLocalPath: "/srv/fictional-primary/archive" },
        },
      }),
    });
    await cfgReq("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "sibling@example.com",
        deviceId: device.id,
        config: {
          syncInterval: "10m",
          params: { sharedLabel: "fictional-sibling" },
        },
      }),
    });

    const patchRes = await cfgReq("/admin/sources/gmail:primary@example.com", {
      method: "PATCH",
      body: JSON.stringify({ config: { syncInterval: "1m" } }),
    });
    expect(patchRes.status).toBe(200);

    const cfg = (
      (await (await cfgReq("/admin/config")).json()) as {
        config: {
          sources?: Record<string, { params?: Record<string, string>; syncInterval?: string }>;
        };
      }
    ).config;
    expect(cfg.sources?.["gmail:primary@example.com"]).toEqual({ syncInterval: "1m" });
    expect(cfg.sources?.["gmail:sibling@example.com"]).toEqual({
      syncInterval: "10m",
      params: { sharedLabel: "fictional-sibling" },
    });
  });

  test("POST /devices/sources/bulk-upsert mirrors config into the file", async () => {
    // The collector-side path: /admin/sources/add → ws → collector
    // sourceManager.addSources → gateway.bulkUpsertSources → THIS endpoint.
    // Without this mirror, portal/CLI Add Source created the gateway DB
    // row but left the file blank, and reconcileConfig pruned the row's
    // params on the next gateway restart.
    const devRes = await cfgReq("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "collector", kind: "collector", scopes: ["read", "write:*"] }),
    });
    const { device, token } = (await devRes.json()) as { device: { id: string }; token: string };

    const upsertRes = await cfgApp.request("/devices/sources/bulk-upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sources: [
          {
            type: "obsidian-notes",
            accountId: "vault-1",
            config: { params: { vaultPath: "/Users/me/Documents/Notes" }, syncInterval: "10m" },
            enabled: true,
          },
        ],
      }),
    });
    expect(upsertRes.status).toBe(200);
    expect(((await upsertRes.json()) as { count: number }).count).toBe(1);

    // The config file (read via /admin/config) should now carry the params.
    const cfg = (
      (await (await cfgReq("/admin/config")).json()) as {
        config: {
          sources?: Record<string, { params?: Record<string, string>; syncInterval?: string }>;
        };
      }
    ).config;
    expect(cfg.sources?.["obsidian-notes:vault-1"]?.params?.vaultPath).toBe(
      "/Users/me/Documents/Notes",
    );
    expect(cfg.sources?.["obsidian-notes:vault-1"]?.syncInterval).toBe("10m");

    // Touch the device variable so TS doesn't complain about it being unused.
    expect(device.id).toBeDefined();
  });

  test("DELETE /admin/sources/:id erases the settings block from the file", async () => {
    const devRes = await cfgReq("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "laptop", kind: "collector", scopes: ["read"] }),
    });
    const { device } = (await devRes.json()) as { device: { id: string } };
    await cfgReq("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "x@y.com",
        deviceId: device.id,
        config: { syncInterval: "5m" },
      }),
    });

    const delRes = await cfgReq("/admin/sources/gmail:x@y.com", { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const cfg = (
      (await (await cfgReq("/admin/config")).json()) as {
        config: { sources?: Record<string, unknown> };
      }
    ).config;
    expect(cfg.sources?.["gmail:x@y.com"]).toBeUndefined();
  });
});

describe("POST /admin/index/reindex-missing", () => {
  test("returns 503 when indexerControl is not wired (no indexer worker)", async () => {
    const res = await req("/admin/index/reindex-missing", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not available/i);
  });

  test("invokes indexerControl.reindexMissing and returns the result", async () => {
    let called = 0;
    const customApp = createServer(db, undefined, {
      indexerControl: {
        reindexMissing: async () => {
          called++;
          return { indexed: 7, errors: 2 };
        },
      },
    });

    const res = await customApp.request("/admin/index/reindex-missing", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, indexed: 7, errors: 2 });
    expect(called).toBe(1);
  });

  test("surfaces indexerControl errors as a sanitized 500", async () => {
    const customApp = createServer(db, undefined, {
      indexerControl: {
        reindexMissing: async () => {
          throw new Error("indexer worker not ready — check /index/stats for state");
        },
      },
    });

    const res = await customApp.request("/admin/index/reindex-missing", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    // The message is sanitized — operator correlates via
    // the request id (logged server-side); the inner err.message must NOT
    // leak to the client.
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /admin/index/rebuild", () => {
  test("returns 503 when rebuild is not wired (no indexer worker)", async () => {
    const res = await req("/admin/index/rebuild", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not available/i);
  });

  test("invokes indexerControl.rebuild and returns ok", async () => {
    let called = 0;
    const customApp = createServer(db, undefined, {
      indexerControl: {
        reindexMissing: async () => ({ indexed: 0, errors: 0 }),
        rebuild: async () => {
          called++;
        },
      },
    });

    const res = await customApp.request("/admin/index/rebuild", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    // Defaults to a graceful swap when no mode is sent, echoed back.
    expect(await res.json()).toEqual({ ok: true, mode: "graceful" });
    expect(called).toBe(1);
  });

  test("surfaces unexpected rebuild errors as a sanitized 500", async () => {
    const customApp = createServer(db, undefined, {
      indexerControl: {
        reindexMissing: async () => ({ indexed: 0, errors: 0 }),
        rebuild: async () => {
          throw new Error("disk full");
        },
      },
    });

    const res = await customApp.request("/admin/index/rebuild", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});

describe("/admin/sync/status canonical state", () => {
  // /admin/sync/status returns canonical display state — a single mapping
  // applied server-side so portal and CLI render identical pills. We
  // exercise all five states + restart-recovery here.

  test("returns synced for a source that previously saved a cursor (no in-memory event)", async () => {
    const { setSyncState } = await import("./db.js");
    const { SyncStatusRegistry } = await import("./sync-status.js");
    setSyncState(db, "gmail:x@y.com", { historyId: "1" });

    // Fresh in-memory registry — simulates a gateway restart.
    const reg = new SyncStatusRegistry();
    const customApp = createServer(db, undefined, { syncStatus: reg });

    const res = await customApp.request("/admin/sync/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ sourceId: string; state: string; lastSyncAt: string | null }>;
    };
    const row = body.items.find((s) => s.sourceId === "gmail:x@y.com")!;
    expect(row.state).toBe("synced");
    expect(row.lastSyncAt).toBeTruthy();
  });

  test("returns syncing when the in-memory event says syncing — even if persisted state is synced", async () => {
    const { setSyncState } = await import("./db.js");
    const { SyncStatusRegistry } = await import("./sync-status.js");
    const { SourceId } = await import("@omnesis/core");
    setSyncState(db, "gmail:x@y.com", { historyId: "1" });

    const reg = new SyncStatusRegistry();
    reg.update({
      sourceId: SourceId("gmail:x@y.com"),
      state: "syncing",
      lastUpdated: Date.now(),
    });
    const customApp = createServer(db, undefined, { syncStatus: reg });

    const res = await customApp.request("/admin/sync/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await res.json()) as { items: Array<{ state: string }> };
    expect(body.items[0].state).toBe("syncing");
  });

  test("error state survives gateway restart via persisted last_error", async () => {
    const { setSyncState, setSyncError } = await import("./db.js");
    const { SyncStatusRegistry } = await import("./sync-status.js");
    setSyncState(db, "gmail:x@y.com", { historyId: "1" });
    setSyncError(db, "gmail:x@y.com", "rate limited");

    const reg = new SyncStatusRegistry(); // fresh — restart simulated
    const customApp = createServer(db, undefined, { syncStatus: reg });

    const res = await customApp.request("/admin/sync/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await res.json()) as {
      items: Array<{ state: string; errorMessage?: string; erroredAt?: string }>;
    };
    const row = body.items[0];
    expect(row.state).toBe("error");
    expect(row.errorMessage).toBe("rate limited");
    expect(row.erroredAt).toBeTruthy();
  });

  test("idle for a source that's registered but has never successfully synced", async () => {
    const { listSources } = await import("./data/repositories/SourceRepository.js");
    const dev = createDevice(db, { name: "lap", kind: "collector" });
    // Register a source row but never call setSyncState.
    const customApp = createServer(db, undefined, {});
    const res0 = await customApp.request("/admin/sources", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "gmail", accountId: "z@y.com", deviceId: dev.id }),
    });
    expect(res0.status).toBe(200);
    expect(listSources(db).length).toBeGreaterThan(0);

    const res = await customApp.request("/admin/sync/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await res.json()) as {
      items: Array<{ sourceId: string; state: string; lastSyncAt: string | null }>;
    };
    const row = body.items.find((s) => s.sourceId === "gmail:z@y.com")!;
    expect(row.state).toBe("idle");
    expect(row.lastSyncAt).toBeNull();
  });

  test("paused overrides everything (registered with enabled=false → state=paused)", async () => {
    const { setSyncState } = await import("./db.js");
    const { SyncStatusRegistry } = await import("./sync-status.js");
    const { SourceId } = await import("@omnesis/core");

    const dev = createDevice(db, { name: "lap2", kind: "collector" });
    setSyncState(db, "gmail:dis@y.com", { historyId: "1" });

    const reg = new SyncStatusRegistry();
    reg.update({
      sourceId: SourceId("gmail:dis@y.com"),
      state: "syncing",
      lastUpdated: Date.now(),
    });
    const customApp = createServer(db, undefined, { syncStatus: reg });

    // Register with enabled=false
    const r0 = await customApp.request("/admin/sources", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "gmail",
        accountId: "dis@y.com",
        deviceId: dev.id,
        enabled: false,
      }),
    });
    expect(r0.status).toBe(200);

    const res = await customApp.request("/admin/sync/status", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await res.json()) as { items: Array<{ sourceId: string; state: string }> };
    const row = body.items.find((s) => s.sourceId === "gmail:dis@y.com")!;
    expect(row.state).toBe("paused");
  });
});

describe("admin endpoints synchronous cache invalidation (A)", () => {
  // The server keeps in-memory caches of /admin/sources, /admin/devices,
  // and /admin/sync/status backing data, refreshed on a 2s background
  // tick. Mutations call `bumpAdminCaches()` SYNCHRONOUSLY so the
  // immediate next read sees the post-mutation state — no
  // 2s-tick window where the user sees their just-added device
  // missing from the list.

  test("POST /admin/devices is reflected on next GET /admin/devices (no tick wait)", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "freshly-paired", kind: "cli", scopes: ["admin"] }),
    });
    expect(create.status).toBe(200);

    const list = await req("/admin/devices");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ name: string }> };
    expect(body.items.some((d) => d.name === "freshly-paired")).toBe(true);
  });

  test("DELETE /admin/devices/:id is reflected on next GET (no tick wait)", async () => {
    const create = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "to-revoke", kind: "cli", scopes: ["admin"] }),
    });
    const { device } = (await create.json()) as { device: { id: string } };

    const del = await req(`/admin/devices/${device.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // Revocation keeps the row; the very next read must already show it
    // revoked rather than waiting for the cache's background tick.
    const list = await req("/admin/devices");
    const body = (await list.json()) as { items: Array<{ id: string; revokedAt: number | null }> };
    expect(body.items.find((d) => d.id === device.id)?.revokedAt).not.toBeNull();
  });

  test("POST /admin/sources is reflected on next GET /admin/sources", async () => {
    // Create a device to host the source.
    const dev = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "src-host", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await dev.json()) as { device: { id: string } };

    const create = await req("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "freshly-added@example.com",
        deviceId: device.id,
        config: {},
        enabled: true,
      }),
    });
    expect(create.status).toBe(200);

    const list = await req("/admin/sources");
    const body = (await list.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((s) => s.id === "gmail:freshly-added@example.com")).toBe(true);
  });

  test("DELETE /admin/sources/:id removes from cache immediately", async () => {
    const dev = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "src-host-2", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await dev.json()) as { device: { id: string } };

    await req("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "to-remove@example.com",
        deviceId: device.id,
        config: {},
        enabled: true,
      }),
    });

    const del = await req("/admin/sources/gmail%3Ato-remove%40example.com", { method: "DELETE" });
    expect(del.status).toBe(200);

    const list = await req("/admin/sources");
    const body = (await list.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((s) => s.id === "gmail:to-remove@example.com")).toBe(false);
  });

  test("PATCH /admin/sources/:id (update enabled) is reflected on next GET", async () => {
    const dev = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "src-host-3", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await dev.json()) as { device: { id: string } };

    await req("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "to-toggle@example.com",
        deviceId: device.id,
        config: {},
        enabled: true,
      }),
    });

    const update = await req("/admin/sources/gmail%3Ato-toggle%40example.com", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(update.status).toBe(200);

    const list = await req("/admin/sources");
    const body = (await list.json()) as { items: Array<{ id: string; enabled: boolean }> };
    const row = body.items.find((s) => s.id === "gmail:to-toggle@example.com");
    expect(row?.enabled).toBe(false);
  });

  // Pause / resume round-trip — exercises the same wire path the CLI
  // (`omnesis pause` / `omnesis resume`) and portal kebab menu both call.
  // Wire field stays `enabled` for backward compat; user-facing label is
  // pause/resume. The display state on /admin/sync/status flips to
  // "paused" (was "disabled") when enabled=false.
  test("pause then resume round-trip — display state flips paused → synced", async () => {
    const dev = await req("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "src-host-pr", kind: "collector", scopes: ["write:*"] }),
    });
    const { device } = (await dev.json()) as { device: { id: string } };

    await req("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "gmail",
        accountId: "pause-resume@example.com",
        deviceId: device.id,
        config: {},
        enabled: true,
      }),
    });

    // Seed a persisted last_synced_at via setSyncState so the post-resume
    // state is "synced", not "idle" — tests that pause preserves cursor
    // history (the entire point of pause vs remove). setSyncState stamps
    // `now()` as last_synced_at; we just need any non-null value preserved
    // across the round-trip.
    const { setSyncState } = await import("./db.js");
    setSyncState(db, "gmail:pause-resume@example.com", { historyId: "1" });

    // Pause — the PATCH bumps the admin cache so /admin/sync/status now
    // sees both the seeded sync_state AND the enabled=false flag.
    const pause = await req("/admin/sources/gmail%3Apause-resume%40example.com", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);

    let statusRes = await req("/admin/sync/status");
    let statusBody = (await statusRes.json()) as {
      items: Array<{ sourceId: string; state: string; lastSyncAt: string | null }>;
    };
    let row = statusBody.items.find((s) => s.sourceId === "gmail:pause-resume@example.com")!;
    expect(row.state).toBe("paused");
    // Pause must NOT erase the persisted timestamp — that's the value
    // pause provides over remove.
    expect(row.lastSyncAt).not.toBeNull();
    const pausedLastSyncAt = row.lastSyncAt;

    // /admin/sources also reports enabled=false after pause
    const sourcesPaused = await req("/admin/sources");
    const sourcesPausedBody = (await sourcesPaused.json()) as {
      items: Array<{ id: string; enabled: boolean }>;
    };
    expect(
      sourcesPausedBody.items.find((s) => s.id === "gmail:pause-resume@example.com")?.enabled,
    ).toBe(false);

    // Resume
    const resume = await req("/admin/sources/gmail%3Apause-resume%40example.com", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(resume.status).toBe(200);

    statusRes = await req("/admin/sync/status");
    statusBody = (await statusRes.json()) as {
      items: Array<{ sourceId: string; state: string; lastSyncAt: string | null }>;
    };
    row = statusBody.items.find((s) => s.sourceId === "gmail:pause-resume@example.com")!;
    expect(row.state).toBe("synced");
    // Same timestamp survives both pause AND resume — neither operation
    // touches sync_state.
    expect(row.lastSyncAt).toBe(pausedLastSyncAt);

    // /admin/sources reports enabled=true after resume
    const sourcesResumed = await req("/admin/sources");
    const sourcesResumedBody = (await sourcesResumed.json()) as {
      items: Array<{ id: string; enabled: boolean }>;
    };
    expect(
      sourcesResumedBody.items.find((s) => s.id === "gmail:pause-resume@example.com")?.enabled,
    ).toBe(true);
  });
});

describe("GET /admin/scheduler-metrics", () => {
  test("returns 503 when scheduler is not configured", async () => {
    const res = await req("/admin/scheduler-metrics");
    expect(res.status).toBe(503);
  });

  test("returns the snapshot from the injected scheduler stub", async () => {
    const fakeSnapshot = {
      windowSeconds: 300,
      generatedAt: "2026-04-28T00:00:00.000Z",
      userSla: {
        p50: 12,
        p95: 80,
        p99: 150,
        p999: 400,
        violations: 2,
        count: 100,
        budgetMs: 200,
      },
      perRunner: [
        {
          runner: "writer" as const,
          queueDepthByPriority: { user: 0, realtime: 1, background: 4 },
          queueAgeMaxByPriority: { user: 0, realtime: 12, background: 800 },
          inFlight: 1,
        },
      ],
      perTask: [
        {
          name: "documents.upsert",
          countByPriority: { user: 42, realtime: 0, background: 0 },
          runner: "writer" as const,
          count: 42,
          p50: 5,
          p95: 18,
          p99: 30,
          max: 55,
          slowOpCount: 0,
          yieldCount: 0,
          errorCount: 0,
          totalExecMs: 220,
        },
      ],
    };

    let received = -1;
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot: (windowSeconds: number) => {
          received = windowSeconds;
          return { ...fakeSnapshot, windowSeconds };
        },
      },
    });

    const res = await customApp.request("/admin/scheduler-metrics?window=120", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(received).toBe(120);
    const body = await res.json();
    expect(body).toEqual({ ...fakeSnapshot, windowSeconds: 120 });
  });

  test("clamps window to [10, 3600] and defaults to 300", async () => {
    const seen: number[] = [];
    const stub = {
      snapshot: (windowSeconds: number) => {
        seen.push(windowSeconds);
        return {
          windowSeconds,
          generatedAt: new Date().toISOString(),
          userSla: { p50: 0, p95: 0, p99: 0, p999: 0, violations: 0, count: 0, budgetMs: 200 },
          perRunner: [],
          perTask: [],
        };
      },
    };
    const customApp = createServer(db, undefined, { scheduler: stub });
    const headers = { Authorization: `Bearer ${TEST_TOKEN}` };

    await customApp.request("/admin/scheduler-metrics", { headers });
    await customApp.request("/admin/scheduler-metrics?window=1", { headers });
    await customApp.request("/admin/scheduler-metrics?window=99999", { headers });
    await customApp.request("/admin/scheduler-metrics?window=garbage", { headers });

    expect(seen).toEqual([300, 10, 3600, 300]);
  });
});

describe("POST /admin/background/run/:taskName", () => {
  let previousSynthetic: string | undefined;

  beforeEach(() => {
    previousSynthetic = process.env.OMNESIS_SYNTHETIC;
    process.env.OMNESIS_SYNTHETIC = "1";
  });

  afterEach(() => {
    if (previousSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
    else process.env.OMNESIS_SYNTHETIC = previousSynthetic;
  });

  const snapshot = () => ({
    windowSeconds: 300,
    generatedAt: new Date().toISOString(),
    userSla: { p50: 0, p95: 0, p99: 0, p999: 0, violations: 0, count: 0, budgetMs: 200 },
    perRunner: [],
    perTask: [],
  });

  test("returns the exact kicked periodic result", async () => {
    const kickPeriodicAndWait = vi.fn(async () => ({
      idle: false,
      successful: true,
      inserted: 2,
    }));
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => false,
        kickPeriodicAndWait,
        quiescePeriodics: vi.fn(),
      },
    });

    const res = await customApp.request("/admin/background/run/backfill.autoDetect", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(kickPeriodicAndWait).toHaveBeenCalledWith("backfill.autoDetect", 120_000);
    expect(await res.json()).toEqual({
      result: { idle: false, successful: true, inserted: 2 },
    });
  });

  test.each(["nearDup.inboxFlush", "backfill.nearDupDfRefresh", "backfill.nearDupCompute"])(
    "allows the synthetic near-duplicate stage %s",
    async (taskName) => {
      const kickPeriodicAndWait = vi.fn(async () => ({ idle: false }));
      const customApp = createServer(db, undefined, {
        scheduler: {
          snapshot,
          pauseBackground: vi.fn(),
          resumeBackground: vi.fn(),
          isBackgroundPaused: () => false,
          kickPeriodicAndWait,
          quiescePeriodics: vi.fn(),
        },
      });

      const res = await customApp.request(`/admin/background/run/${taskName}?timeoutMs=30000`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(kickPeriodicAndWait).toHaveBeenCalledWith(taskName, 30_000);
    },
  );

  test("defaults and clamps synthetic periodic timeouts", async () => {
    const seen: number[] = [];
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => false,
        kickPeriodicAndWait: vi.fn(async (_taskName: string, timeoutMs: number) => {
          seen.push(timeoutMs);
          return { idle: false };
        }),
        quiescePeriodics: vi.fn(),
      },
    });
    const headers = { Authorization: `Bearer ${TEST_TOKEN}` };

    await customApp.request("/admin/background/run/backfill.nearDupCompute", {
      method: "POST",
      headers,
    });
    await customApp.request("/admin/background/run/backfill.nearDupCompute?timeoutMs=garbage", {
      method: "POST",
      headers,
    });
    await customApp.request("/admin/background/run/backfill.nearDupCompute?timeoutMs=0", {
      method: "POST",
      headers,
    });
    await customApp.request("/admin/background/run/backfill.nearDupCompute?timeoutMs=999999", {
      method: "POST",
      headers,
    });

    expect(seen).toEqual([120_000, 120_000, 1, 120_000]);
  });

  test("maps an unknown periodic to a bad request", async () => {
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => false,
        kickPeriodicAndWait: vi.fn(async () => {
          throw new Error('no live periodic registered as "missing"');
        }),
        quiescePeriodics: vi.fn(),
      },
    });

    const res = await customApp.request("/admin/background/run/missing", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  test("rejects a run while background dispatch is paused", async () => {
    const kickPeriodicAndWait = vi.fn();
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => true,
        kickPeriodicAndWait,
        quiescePeriodics: vi.fn(),
      },
    });

    const res = await customApp.request("/admin/background/run/backfill.peopleCountsRefresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(503);
    expect(kickPeriodicAndWait).not.toHaveBeenCalled();
  });

  test("is hidden outside synthetic mode", async () => {
    delete process.env.OMNESIS_SYNTHETIC;
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => false,
        kickPeriodicAndWait: vi.fn(),
        quiescePeriodics: vi.fn(),
      },
    });

    const res = await customApp.request("/admin/background/run/backfill.peopleCountsRefresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("quiesces periodic roots without pausing background dispatch", async () => {
    const quiescePeriodics = vi.fn();
    const customApp = createServer(db, undefined, {
      scheduler: {
        snapshot,
        pauseBackground: vi.fn(),
        resumeBackground: vi.fn(),
        isBackgroundPaused: () => false,
        kickPeriodicAndWait: vi.fn(),
        quiescePeriodics,
      },
    });

    const res = await customApp.request("/admin/background/quiesce-periodics", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quiesced: true });
    expect(quiescePeriodics).toHaveBeenCalledOnce();
  });
});

// CORS is wired before app.onError and before auth, so it must answer
// preflight unauthenticated and emit its headers on error responses too.
describe("CORS middleware (wired in createServer)", () => {
  const CORS_ORIGIN = "https://omnesis.example.com";

  async function withCorsServer(
    fn: (corsApp: ReturnType<typeof createServer>) => Promise<void>,
  ): Promise<void> {
    const { ConfigStore, defaultConfigPath } = await import("./config-store.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = `/tmp/omnesis-cors-test-${randomUUID()}`;
    mkdirSync(dir, { recursive: true });
    const cfgPath = defaultConfigPath(dir);
    writeFileSync(
      cfgPath,
      JSON.stringify({ gateway: { cors: { allowedOrigins: [CORS_ORIGIN] } } }),
    );
    const store = new ConfigStore({ filePath: cfgPath });
    await store.load();
    const corsApp = createServer(db, undefined, { configStore: store });
    try {
      await fn(corsApp);
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("OPTIONS preflight returns 204 with CORS headers when allowedOrigins is set", async () => {
    await withCorsServer(async (corsApp) => {
      const res = await corsApp.request("/documents", {
        method: "OPTIONS",
        headers: { Origin: CORS_ORIGIN, "Access-Control-Request-Method": "GET" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CORS_ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });
  });

  test("CORS headers appear on a 401 error response (middleware precedes onError)", async () => {
    await withCorsServer(async (corsApp) => {
      // No Authorization header → /whoami 401s; CORS headers must still be set.
      const res = await corsApp.request("/whoami", { headers: { Origin: CORS_ORIGIN } });
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CORS_ORIGIN);
    });
  });

  test("the app still constructs and serves with the new global middlewares (no configStore)", async () => {
    // The shared `app` is built without a configStore — both middlewares are
    // inert, and a normal request still succeeds with no CORS headers.
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("/status configHealth projection (C15a fail-loud gate)", () => {
  test("surfaces degraded inference roles + lastConfigError when getConfigHealth reports them", async () => {
    const { token } = mintToken([SCOPE_READ]);
    const degradedApp = createServer(db, dbPath, {
      getConfigHealth: () => ({
        degradedRoles: [{ role: "agent", reason: 'Unknown backend "missing-backend"' }],
        lastConfigError: 'Inference config degraded: agent (Unknown backend "missing-backend")',
      }),
    });
    const res = await degradedApp.request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configHealth: {
        degradedRoles: Array<{ role: string; reason: string }>;
        lastConfigError: string | null;
      };
    };
    expect(body.configHealth.degradedRoles).toHaveLength(1);
    expect(body.configHealth.degradedRoles[0]!.role).toBe("agent");
    expect(body.configHealth.degradedRoles[0]!.reason).toMatch(/missing-backend/);
    expect(body.configHealth.lastConfigError).toMatch(/agent/);
  });

  test("reports a healthy configHealth when no getConfigHealth is wired", async () => {
    // The shared `app` was built without an inference registry.
    const res = await req("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configHealth: { degradedRoles: unknown[]; lastConfigError: string | null };
    };
    expect(body.configHealth.degradedRoles).toEqual([]);
    expect(body.configHealth.lastConfigError).toBeNull();
  });
});

describe("POST /admin/sources/:id/resync", () => {
  const PARTITIONED = SourceType("visits-synth");
  const REPLICATED = SourceType("notes-synth");
  const EXCLUSIVE = SourceType("gmail-synth");
  const modes = { [PARTITIONED]: "partitioned" as const, [REPLICATED]: "replicated" as const };

  /** Two collectors hosting every type; a fake WS server that knows who is online. */
  async function fixture() {
    const { createSource, addSourceMember } =
      await import("./data/repositories/SourceRepository.js");
    const host = (name: string) =>
      createDevice(db, {
        name: `${name}-${randomUUID()}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [PARTITIONED, REPLICATED, EXCLUSIVE],
          multiDeviceModes: modes,
          memberScopedParams: {
            [PARTITIONED]: [],
            [REPLICATED]: [],
            [EXCLUSIVE]: [],
          },
          syncLease: true,
        },
      });
    const alpha = host("alpha");
    const beta = host("beta");
    const online = new Set<string>([alpha.id, beta.id]);
    const sendCommand = vi.fn(async (_deviceId: string, _type: string, _payload: unknown) => ({
      ok: true,
      triggered: 1,
    }));
    const wsServer = {
      isConnected: (id: string) => online.has(id),
      sendCommand,
    } as unknown as DeviceWsServer;
    const server = createServer(db, undefined, { wsServer });
    const as =
      (token: string) =>
      (path: string, init: RequestInit = {}) =>
        server.request(path, {
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
    const admin = as(TEST_TOKEN);
    const tokenOf = (deviceId: DeviceId) =>
      createToken(db, deviceId, [SCOPE_WRITE_ALL, SCOPE_READ]).token;
    const asAlpha = as(tokenOf(alpha.id));
    const asBeta = as(tokenOf(beta.id));
    const seed = (type: SourceType, member = true) => {
      const source = createSource(db, {
        type,
        accountId: AccountId("local"),
        deviceId: alpha.id,
        multiDeviceMode: modes[type] ?? "exclusive",
      });
      if (member) addSourceMember(db, source.id, beta.id);
      return source;
    };
    /** Each device pushes its own days and records a cursor on its own row. */
    const populate = async (sourceId: string) => {
      for (const push of [asAlpha, asBeta]) {
        const docs = ["day-1", "day-2"].map((id) => makeDocPayload(id, "synth", sourceId));
        expect(
          await (
            await push("/documents", { method: "POST", body: JSON.stringify({ documents: docs }) })
          ).json(),
        ).toMatchObject({ ingested: 2 });
        expect(
          (
            await push(`/sync-state/${encodeURIComponent(sourceId)}`, {
              method: "POST",
              body: JSON.stringify({ cursor: { page: 1 } }),
            })
          ).status,
        ).toBe(200);
      }
    };
    const count = async (sourceId: string) =>
      (
        (await (await admin(`/documents/count/${encodeURIComponent(sourceId)}`)).json()) as {
          count: number;
        }
      ).count;
    const syncState = async (
      push: typeof asAlpha,
      sourceId: string,
    ): Promise<{ cursor: unknown; wipeEpoch: number }> =>
      (await (await push(`/sync-state/${encodeURIComponent(sourceId)}`)).json()) as {
        cursor: unknown;
        wipeEpoch: number;
      };
    const rowOf = (sourceId: string, deviceId: string) =>
      db
        .prepare<
          [string, string],
          { cursor: string; last_synced_at: string | null }
        >("SELECT cursor, last_synced_at FROM sync_state WHERE source_id = ? AND device_id = ?")
        .get(sourceId, deviceId);
    const resync = async (sourceId: string, body: Record<string, unknown>) => {
      const res = await admin(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return {
      alpha,
      beta,
      online,
      sendCommand,
      asAlpha,
      asBeta,
      seed,
      populate,
      count,
      syncState,
      rowOf,
      resync,
    };
  }

  test("a device on a partitioned source: its stream and cursor go, the sibling's stay, the sync reaches it if online", async () => {
    const f = await fixture();
    const source = f.seed(PARTITIONED);
    await f.populate(source.id);
    expect(await f.count(source.id)).toBe(4);
    const betaBefore = await f.syncState(f.asBeta, source.id);
    expect(betaBefore.cursor).toEqual({ page: 1 });

    const { status, body } = await f.resync(source.id, { deviceId: f.beta.id });

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      scope: "stream",
      deviceIds: [f.beta.id],
      restarting: [],
      skipped: [],
      disabled: [],
    });
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(f.sendCommand).toHaveBeenCalledWith(f.beta.id, "source.sync", {
      sourceId: source.id,
      restart: true,
    });
    expect(await f.count(source.id)).toBe(2);
    // Beta's row is kept with no cursor and a fresh epoch, so it bootstraps
    // instead of adopting the shared row; alpha's row is untouched.
    const betaAfter = await f.syncState(f.asBeta, source.id);
    expect(betaAfter.cursor).toBeNull();
    expect(betaAfter.wipeEpoch).toBeGreaterThan(betaBefore.wipeEpoch);
    expect(f.rowOf(source.id, f.beta.id)).toEqual({ cursor: "{}", last_synced_at: null });
    expect((await f.syncState(f.asAlpha, source.id)).cursor).toEqual({ page: 1 });

    // Offline: the wipe still happens and the response names nobody.
    f.online.delete(f.alpha.id);
    f.sendCommand.mockClear();
    const offline = await f.resync(source.id, { deviceId: f.alpha.id });
    expect(offline).toEqual({
      status: 200,
      body: { ok: true, scope: "stream", deviceIds: [], restarting: [], skipped: [], disabled: [] },
    });
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(await f.count(source.id)).toBe(0);
  });

  test("a device on a replicated source: only its cursor is reset; the documents stay", async () => {
    const f = await fixture();
    const source = f.seed(REPLICATED);
    await f.populate(source.id);
    // Both devices upsert the same external ids onto the one stream.
    expect(await f.count(source.id)).toBe(2);
    const betaBefore = await f.syncState(f.asBeta, source.id);

    const { status, body } = await f.resync(source.id, { deviceId: f.beta.id });

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      scope: "cursor",
      deviceIds: [f.beta.id],
      restarting: [],
      skipped: [],
      disabled: [],
    });
    expect(await f.count(source.id)).toBe(2);
    const betaAfter = await f.syncState(f.asBeta, source.id);
    expect(betaAfter.cursor).toBeNull();
    expect(betaAfter.wipeEpoch).toBeGreaterThan(betaBefore.wipeEpoch);
    expect(f.rowOf(source.id, f.beta.id)).toEqual({ cursor: "{}", last_synced_at: null });
    expect((await f.syncState(f.asAlpha, source.id)).cursor).toEqual({ page: 1 });
  });

  test("no device: the whole source is wiped and every member is triggered", async () => {
    const f = await fixture();
    const source = f.seed(PARTITIONED);
    await f.populate(source.id);

    const { status, body } = await f.resync(source.id, {});

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, scope: "source" });
    expect([...(body.deviceIds as string[])].sort()).toEqual([f.alpha.id, f.beta.id].sort());
    expect(await f.count(source.id)).toBe(0);
    expect((await f.syncState(f.asAlpha, source.id)).cursor).toBeNull();
    expect((await f.syncState(f.asBeta, source.id)).cursor).toBeNull();
  });

  test("refuses an unknown source or device, a non-member, and a device on a shared-cursor source", async () => {
    const f = await fixture();
    const exclusive = f.seed(EXCLUSIVE, false);
    const partitioned = f.seed(PARTITIONED, false);
    const stranger = createDevice(db, { name: `stranger-${randomUUID()}`, kind: "collector" });

    expect(await f.resync("visits-synth:nobody", {})).toMatchObject({
      status: 404,
      body: { code: "SOURCE_NOT_FOUND" },
    });
    expect(
      await f.resync(partitioned.id, { deviceId: "00000000-0000-4000-8000-000000000009" }),
    ).toMatchObject({ status: 404, body: { code: "DEVICE_NOT_FOUND" } });
    expect(await f.resync(partitioned.id, { deviceId: "not a device id" })).toMatchObject({
      status: 404,
      body: { code: "DEVICE_NOT_FOUND" },
    });
    expect(await f.resync(partitioned.id, { deviceId: stranger.id })).toMatchObject({
      status: 409,
      body: { code: "DEVICE_NOT_MEMBER" },
    });
    const shared = await f.resync(exclusive.id, { deviceId: f.alpha.id });
    expect(shared).toMatchObject({ status: 400, body: { code: "RESYNC_NOT_PER_DEVICE" } });
    expect(shared.body.error).toContain("exclusive");
    expect(f.sendCommand).not.toHaveBeenCalled();

    // Without a WS server nothing is wiped.
    const noWs = await req(`/admin/sources/${encodeURIComponent(partitioned.id)}/resync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noWs.status).toBe(503);
  });
});
