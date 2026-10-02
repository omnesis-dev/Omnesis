// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toolResultSchema, type SearchProvenance } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountSearchRoutes } from "./search.js";
import type { SearchPipeline } from "../../search/pipeline.js";
import type { SearchPort, SearchPortInput } from "@omnesis/agent";
import type { AppEnv, AuthContext } from "./types.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type Database from "better-sqlite3";

const PATH = "/admin/search/agent-context";
const provenance: SearchProvenance = {
  summary: "Indexed on Example laptop.",
  copies: [
    {
      documentId: "example-file",
      sourceId: "archive:example",
      deviceName: "Example laptop",
      url: "https://example.org/file",
    },
  ],
  paths: [],
  truncated: false,
  stopReasons: [],
};
const hit = {
  documentId: "example-file",
  sourceId: "archive:example",
  documentType: "file",
  title: "Invented equipment agreement",
  sourceCreatedAt: "2025-02-01T09:00:00Z",
  chunkText: "Invented agreement content.",
  score: 1,
  provenance,
};
let db: Database.Database;
let dbPath: string;
beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});
function pipeline(enabled: boolean) {
  return {
    agentSearchV2Enabled: enabled,
    search: vi.fn().mockResolvedValue({
      results: [hit],
      timing: { totalMs: 2, bm25Candidates: 4, vectorCandidates: 3 },
    }),
  } as unknown as SearchPipeline;
}
function token(scopes: readonly Scope[]) {
  const device = createDevice(db, { name: "Example CLI", kind: "cli" });
  return createToken(db, device.id, scopes).token;
}
function request(body: unknown, bearer?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe("operator agent search context", () => {
  test.each([undefined, false, true])(
    "advertises portal graph context only with an enabled pipeline: %s",
    async (enabled) => {
      const app = createServer(db, dbPath, {
        searchPipeline: enabled === undefined ? undefined : pipeline(enabled),
      });
      const response = await app.request("/search/readiness", {
        headers: { Authorization: `Bearer ${token([SCOPE_ADMIN, SCOPE_READ])}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        indexer: { status: "ready" },
        ...(enabled ? { agentContextAvailable: true, graphContextAvailable: true } : {}),
      });
    },
  );

  test("does not advertise operator diagnostics to a read-only caller", async () => {
    const app = createServer(db, dbPath, { searchPipeline: pipeline(true) });
    const response = await app.request("/search/readiness", {
      headers: { Authorization: `Bearer ${token([SCOPE_READ])}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      indexer: { status: "ready" },
      graphContextAvailable: true,
    });
  });

  test.each([undefined, false])("is absent without an enabled pipeline: %s", async (enabled) => {
    const app = createServer(db, dbPath, {
      searchPipeline: enabled === undefined ? undefined : pipeline(enabled),
    });
    expect(
      (await app.request(PATH, request({ text: "agreement" }, token([SCOPE_ADMIN, SCOPE_READ]))))
        .status,
    ).toBe(404);
  });

  test("requires authentication", async () => {
    const app = createServer(db, dbPath, { searchPipeline: pipeline(true) });
    expect((await app.request(PATH, request({ text: "agreement" }))).status).toBe(401);
  });

  test.each([[SCOPE_ADMIN], [SCOPE_READ]])("requires both scopes: %j", async (...scopes) => {
    const app = createServer(db, dbPath, { searchPipeline: pipeline(true) });
    expect((await app.request(PATH, request({ text: "agreement" }, token(scopes)))).status).toBe(
      403,
    );
  });

  test("uses the canonical port projection and preserves its provenance", async () => {
    const searchPipeline = pipeline(true);
    const app = createServer(db, dbPath, { searchPipeline });
    const response = await app.request(
      PATH,
      request({ text: "agreement", limit: 7 }, token([SCOPE_ADMIN, SCOPE_READ])),
    );
    expect(response.status).toBe(200);
    const wire = await response.json();
    expect(wire).not.toHaveProperty("totalCandidates");
    const result = toolResultSchema.parse(wire);
    expect(result).toMatchObject({
      kind: "search.results",
      query: "agreement",
      durationMs: 2,
      candidates: 7,
      results: [
        { documentId: hit.documentId, sourceType: "archive", snippet: hit.chunkText, provenance },
      ],
    });
    expect(searchPipeline.search).toHaveBeenCalledWith(
      expect.objectContaining({ text: "agreement", limit: 7 }),
      undefined,
      expect.any(Object),
    );
  });

  test.each([
    { text: "" },
    { text: "   " },
    { text: 1 },
    { text: "agreement", limit: 0 },
    { text: "agreement", limit: 101 },
    { text: "agreement", limit: 1.5 },
    { text: "agreement", agentContext: true },
    { text: "agreement", filters: { sourceIds: [] } },
  ])("rejects invalid or extra body fields: %j", async (body) => {
    const searchPipeline = pipeline(true);
    const app = createServer(db, dbPath, { searchPipeline });
    expect((await app.request(PATH, request(body, token([SCOPE_ADMIN, SCOPE_READ])))).status).toBe(
      400,
    );
    expect(searchPipeline.search).not.toHaveBeenCalled();
  });

  test("leaves the public search route on its existing projection", async () => {
    const searchPipeline = pipeline(true);
    const app = createServer(db, dbPath, { searchPipeline });
    expect(
      (await app.request("/search", request({ text: "agreement" }, token([SCOPE_READ])))).status,
    ).toBe(200);
    expect(searchPipeline.search).toHaveBeenCalledWith({ text: "agreement" });
  });

  test("read-only mobile requests opt into graph facts while retaining the search response", async () => {
    const searchPipeline = pipeline(true);
    const app = createServer(db, dbPath, { searchPipeline });
    const response = await app.request(
      "/search",
      request({ text: "agreement", verbose: true, includeGraphContext: true }, token([SCOPE_READ])),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [hit],
      timing: { totalMs: 2, bm25Candidates: 4, vectorCandidates: 3 },
    });
    expect(searchPipeline.search).toHaveBeenCalledWith(
      { text: "agreement", verbose: true },
      undefined,
      { graphContext: true },
    );
  });

  test.each([false, undefined])(
    "disabled or omitted opt-in keeps the legacy call: %s",
    async (includeGraphContext) => {
      const searchPipeline = pipeline(true);
      const app = createServer(db, dbPath, { searchPipeline });
      const response = await app.request(
        "/search",
        request({ text: "agreement", includeGraphContext }, token([SCOPE_READ])),
      );
      expect(response.status).toBe(200);
      expect(searchPipeline.search).toHaveBeenCalledWith({ text: "agreement" });
    },
  );

  test("a disabled gateway ignores the graph opt-in", async () => {
    const searchPipeline = pipeline(false);
    const app = createServer(db, dbPath, { searchPipeline });
    const response = await app.request(
      "/search",
      request({ text: "agreement", includeGraphContext: true }, token([SCOPE_READ])),
    );
    expect(response.status).toBe(200);
    expect(searchPipeline.search).toHaveBeenCalledWith({ text: "agreement" });
  });

  test.each(["true", 1, {}])(
    "rejects invalid graph opt-in values: %j",
    async (includeGraphContext) => {
      const searchPipeline = pipeline(true);
      const app = createServer(db, dbPath, { searchPipeline });
      expect(
        (
          await app.request(
            "/search",
            request({ text: "agreement", includeGraphContext }, token([SCOPE_READ])),
          )
        ).status,
      ).toBe(400);
      expect(searchPipeline.search).not.toHaveBeenCalled();
    },
  );
});

function injectedApp(auth: AuthContext, port: SearchPort, searchPipeline?: SearchPipeline) {
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      (error instanceof HttpError ? error.status : 500) as ContentfulStatusCode,
    ),
  );
  mountSearchRoutes(app, { db, agentSearchPort: port, searchPipeline });
  return app;
}
describe("agent context restricted identity and cancellation", () => {
  test("shares the existing public search rate limit instead of adding another allowance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const search = vi.fn().mockResolvedValue({ query: "agreement", durationMs: 1, results: [] });
    const app = injectedApp(
      { authMethod: "bearer", deviceId: null, tokenId: null, scopes: [SCOPE_ADMIN, SCOPE_READ] },
      { search },
      pipeline(true),
    );
    for (let n = 0; n < 120; n++) {
      expect((await app.request("/search", request({ text: "agreement" }))).status).toBe(200);
    }
    const response = await app.request(PATH, request({ text: "agreement" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(search).not.toHaveBeenCalled();
  });

  test("denies OAuth principals even if an identity carries broad legacy scopes", async () => {
    const search = vi.fn();
    const searchPipeline = pipeline(true);
    const app = injectedApp(
      {
        authMethod: "principal-oauth",
        deviceId: null,
        tokenId: null,
        scopes: [SCOPE_ADMIN, SCOPE_READ],
        accessTokenId: "example",
        principalId: "example",
        principalName: "Fictional client",
        grantId: "example",
        grantRevision: 1,
        credentialId: "example",
        oauthClientId: "example",
        executionDeviceId: null,
        capabilities: [
          {
            capability: "direct",
            sourceMode: "all",
            sourceIds: [],
            releaseMode: null,
            policyFamilyId: null,
            policyRevision: null,
            privacyPolicy: null,
          },
        ],
        expiresAt: Date.now() + 60_000,
      },
      { search },
      searchPipeline,
    );
    expect((await app.request(PATH, request({ text: "agreement" }))).status).toBe(403);
    const readiness = await app.request("/search/readiness");
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).not.toHaveProperty("agentContextAvailable");
    expect(await (await app.request("/search/readiness")).json()).not.toHaveProperty(
      "graphContextAvailable",
    );
    expect(
      (await app.request("/search", request({ text: "agreement", includeGraphContext: true })))
        .status,
    ).toBe(200);
    expect(searchPipeline.search).toHaveBeenCalledWith({ text: "agreement" });
    expect(search).not.toHaveBeenCalled();
  });

  test("forwards cancellation and never releases a result after the caller aborts", async () => {
    const controller = new AbortController();
    const search = vi.fn(async (_input: SearchPortInput, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { query: "agreement", durationMs: 1, results: [] };
    });
    const app = injectedApp(
      { authMethod: "bearer", deviceId: null, tokenId: null, scopes: [SCOPE_ADMIN, SCOPE_READ] },
      { search },
    );
    const response = await app.request(PATH, {
      ...request({ text: "agreement" }),
      signal: controller.signal,
    });
    expect(search).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("results");
  });
});
