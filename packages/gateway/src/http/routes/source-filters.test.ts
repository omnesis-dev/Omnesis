// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeviceId, TokenId, SCOPE_ADMIN, SCOPE_READ, type ScopePolicy } from "@omnesis/types";
import { runSchemaSetup } from "../../data/schema.js";
import { directWriteGate } from "../../write-gate.js";
import { AccessService } from "../../access/service.js";
import { upsertSourceScopes } from "../../access/scope-descriptors.js";
import { SOURCE_SCOPE_EDITOR_READS } from "../../access/scope-editor-reads.js";
import { directReadPort } from "../../scheduler/read-port.js";
import { SourceFilterService } from "../services/SourceFilterService.js";
import { HttpError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountSourceFilterRoutes } from "./source-filters.js";
import type { AppEnv, AuthContext } from "./types.js";

const deviceId = DeviceId("00000000-0000-4000-8000-000000000001");
const tokenId = TokenId("00000000-0000-4000-8000-000000000002");
const sourceId = "fictional:one";
const policy: ScopePolicy = {
  sourceId,
  audience: { accessLevel: "new", capability: "direct" },
  rules: [{ match: [{ kind: "conversation", id: "invented" }], action: "share" }],
  otherwise: "hide",
};
const native: AuthContext = { authMethod: "bearer", deviceId, tokenId, scopes: [SCOPE_ADMIN] };
const portal: AuthContext = {
  authMethod: "portal-session",
  deviceId: null,
  credentialDeviceId: null,
  tokenId,
  scopes: [SCOPE_ADMIN],
  csrfToken: "invented-csrf",
};

describe("owner source filter API", () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    db = new Database(":memory:");
    runSchemaSetup(db);
    db.prepare(
      "INSERT INTO devices(id,name,kind,paired_at) VALUES(?,'Fictional phone','ios',1)",
    ).run(deviceId);
    db.prepare(
      "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'fictional','one',?,1,1)",
    ).run(sourceId, deviceId);
    upsertSourceScopes(
      db,
      [
        {
          sourceType: "fictional",
          scopes: {
            items: [
              {
                kind: "conversation",
                noun: { one: "conversation", many: "conversations" },
                picker: "search",
                link: "fixed",
              },
            ],
          },
        },
      ],
      1,
    );
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional','{}',1)",
    ).run(sourceId);
    db.prepare(
      "INSERT INTO scope_entities(source_id,kind,entity_id,label) VALUES(?,'conversation','invented','Invented group')",
    ).run(sourceId);
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });
  function app(auth: AuthContext | null, service?: SourceFilterService) {
    const access = new AccessService(db, directWriteGate(db));
    service ??= new SourceFilterService(directReadPort(SOURCE_SCOPE_EDITOR_READS, db), (id) =>
      access.hasSavedSourceFilters(id),
    );
    const value = strictRoute(new Hono<AppEnv>());
    value.onError((error, c) => {
      if (error instanceof HttpError) return errorResponse(c, error);
      throw error;
    });
    value.use("*", async (c, next) => {
      if (auth) c.set("auth", auth);
      await next();
    });
    mountSourceFilterRoutes(value, { service, access });
    return value;
  }
  function preview(
    auth: AuthContext | null,
    body: unknown = { policy },
    headers: Record<string, string> = {},
  ) {
    return app(auth).request(`/admin/access/source-filters/${sourceId}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  test("native owners receive descriptor options and exact previews without a portal cookie", async () => {
    const options = await app(native).request(
      `/admin/access/source-filters/${sourceId}/options?kind=conversation`,
    );
    expect(options.status).toBe(200);
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(await options.json()).toMatchObject({
      sourceId,
      items: [{ label: "Invented group", count: 0 }],
    });
    const result = await preview(native);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      sourceId,
      total: 0,
      visible: 0,
      hidden: 0,
      unknown: 0,
      items: [{ ref: { kind: "conversation", id: "invented" } }],
    });
  });
  test("rejects anonymous, read-only, bootstrap and non-owner-device mutations", async () => {
    expect((await preview(null)).status).toBe(401);
    expect((await preview({ ...native, scopes: [SCOPE_READ] })).status).toBe(403);
    expect((await preview({ ...native, deviceId: null })).status).toBe(403);
    db.prepare("UPDATE devices SET kind='collector' WHERE id=?").run(deviceId);
    expect((await preview(native)).status).toBe(403);
    db.prepare("UPDATE devices SET kind='ios',revoked_at=1 WHERE id=?").run(deviceId);
    expect((await preview(native)).status).toBe(403);
  });
  test("portal preview retains synchronizer-token protection", async () => {
    expect((await preview(portal)).status).toBe(403);
    expect((await preview(portal, { policy }, { "X-Omnesis-CSRF": "incorrect" })).status).toBe(403);
    expect((await preview(portal, { policy }, { "X-Omnesis-CSRF": "invented-csrf" })).status).toBe(
      200,
    );
  });
  test("validates V1 policy, account binding and picker parameters before reading", async () => {
    for (const invalid of [
      { ...policy, sourceId: "fictional:two" },
      { ...policy, maxAge: "90d" },
      { ...policy, rules: [{ match: [], action: "ask" }] },
    ])
      expect((await preview(native, { policy: invalid })).status).toBe(400);
    expect(
      (await app(native).request(`/admin/access/source-filters/${sourceId}/options?kind=calendar`))
        .status,
    ).toBe(400);
    expect(
      (
        await app(native).request(
          `/admin/access/source-filters/invalid:too:many/options?kind=conversation`,
        )
      ).status,
    ).toBe(400);
  });
  test("saved restrictions remain inspectable when new authoring is disabled", async () => {
    const access = new AccessService(db, directWriteGate(db));
    const created = await access.createLevel({
      name: "Invented saved level",
      rules: [
        { capability: "direct", sources: { mode: "all", sourceIds: [] }, scopePolicies: [policy] },
      ],
      actorTokenId: tokenId,
    });
    expect(created.ok).toBe(true);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect((await preview(native)).status).toBe(200);
    expect(
      (
        await app(native).request(
          `/admin/access/source-filters/${sourceId}/options?kind=conversation`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app(native).request(
          "/admin/access/source-filters/fictional:other/options?kind=conversation",
        )
      ).status,
    ).toBe(404);
  });
  test("authoring gate and missing read workers produce explicit unavailable responses", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect((await preview(native)).status).toBe(404);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const response = await app(native, new SourceFilterService()).request(
      `/admin/access/source-filters/${sourceId}/options?kind=conversation`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("read worker") });
  });
});
