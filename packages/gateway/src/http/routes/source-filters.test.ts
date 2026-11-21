// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner's filter routes over the real reads: who may call them, what
 * each returns while its counts are taken and once they land, and how a
 * request is checked before anything is read.
 *
 * All fixture data is invented.
 */

import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DeviceId,
  TokenId,
  SCOPE_ADMIN,
  SCOPE_ANSWER,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  type SourceFilter,
} from "@omnesis/types";
import { runMigrations } from "../../data/migrations.js";
import { runSchemaSetup } from "../../data/schema.js";
import { directWriteGate } from "../../write-gate.js";
import { AccessService } from "../../access/service.js";
import {
  PARLEY_PROFILE,
  insertDocument,
  publishList,
  publishProfile,
} from "../../access/filter-test-utils.js";
import { SOURCE_FILTER_READS } from "../../access/source-filter-editor.js";
import { directReadPort } from "../../scheduler/read-port.js";
import { SourceFilterService } from "../services/SourceFilterService.js";
import { HttpError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountSourceFilterRoutes } from "./source-filters.js";
import type { Db } from "../../data/types.js";
import type { AppEnv, AuthContext } from "./types.js";

const PHONE = DeviceId("00000000-0000-4000-8000-000000000001");
const COLLECTOR = DeviceId("00000000-0000-4000-8000-000000000003");
const INTEGRATION = DeviceId("00000000-0000-4000-8000-000000000004");
const TOKEN = TokenId("00000000-0000-4000-8000-000000000002");
const SOURCE = "parley:studio";
const CSRF = "invented-csrf";

const policy: SourceFilter = {
  sourceId: SOURCE,
  audience: { accessLevel: "new", capability: "direct" },
  rules: [
    {
      match: [{ capability: "membership", field: "extra.chatId", id: "c-team" }],
      action: "share",
    },
  ],
  otherwise: "hide",
};

const native: AuthContext = {
  authMethod: "bearer",
  deviceId: PHONE,
  tokenId: TOKEN,
  scopes: [SCOPE_ADMIN, SCOPE_READ],
};
const portal: AuthContext = {
  authMethod: "portal-session",
  deviceId: null,
  credentialDeviceId: null,
  tokenId: TOKEN,
  scopes: [SCOPE_ADMIN],
  csrfToken: CSRF,
};
/** An MCP connection's OAuth access token. */
const oauth: AuthContext = {
  authMethod: "principal-oauth",
  deviceId: null,
  tokenId: null,
  scopes: [],
  accessTokenId: "invented-access-token",
  principalId: "invented-principal",
  principalName: "Invented notebook",
  grantId: "invented-grant",
  grantRevision: 1,
  credentialId: "invented-credential",
  oauthClientId: "invented-client",
  executionDeviceId: null,
  capabilities: [],
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const integration: AuthContext = {
  authMethod: "bearer",
  deviceId: INTEGRATION,
  tokenId: TOKEN,
  scopes: [SCOPE_ANSWER],
};
const collector: AuthContext = {
  authMethod: "bearer",
  deviceId: COLLECTOR,
  tokenId: TOKEN,
  scopes: [SCOPE_READ, SCOPE_WRITE_ALL],
};

let db: Database.Database;

beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  runMigrations(db);
  const device = db.prepare("INSERT INTO devices(id,name,kind,paired_at) VALUES(?,?,?,1)");
  device.run(PHONE, "Invented phone", "ios");
  device.run(COLLECTOR, "Invented collector", "collector");
  device.run(INTEGRATION, "Invented harness", "integration");
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'parley','studio',?,1,1)",
  ).run(SOURCE, COLLECTOR);
  publishProfile(db as unknown as Db, "parley", 1, PARLEY_PROFILE);
  publishList(db as unknown as Db, { sourceId: SOURCE, field: "extra.chatId" }, [
    { id: "c-team", label: "Studio team", members: [{ type: "phone", value: "+15550100123" }] },
    { id: "c-family", label: "Family", members: [{ type: "phone", value: "+15550100456" }] },
  ]);
  for (const [id, chat] of [
    ["team-day", "c-team"],
    ["family-day", "c-family"],
  ] as const) {
    insertDocument(db as unknown as Db, {
      id,
      sourceId: SOURCE,
      metadata: { documentType: "day", people: [], extra: { chatId: chat } },
    });
  }
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

function app(auth: AuthContext | null, service?: SourceFilterService) {
  const access = new AccessService(db, directWriteGate(db));
  service ??= new SourceFilterService(directReadPort(SOURCE_FILTER_READS, db), (id) =>
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

type Call = { method: "GET" | "POST"; path: string; body?: unknown };

const ROUTES: Call[] = [
  { method: "GET", path: `/admin/access/source-filters/${SOURCE}` },
  { method: "GET", path: `/admin/access/source-filters/${SOURCE}/options?field=extra.chatId` },
  { method: "POST", path: `/admin/access/source-filters/${SOURCE}/preview`, body: { policy } },
  {
    method: "POST",
    path: "/admin/access/source-filters/identifiers",
    body: { type: "email", value: "maya@example.org" },
  },
  { method: "GET", path: "/admin/documents/team-day/filter-details" },
  { method: "GET", path: "/admin/documents/team-day/access" },
];

function send(target: Hono<AppEnv>, call: Call, headers: Record<string, string> = {}) {
  return target.request(call.path, {
    method: call.method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
}

/** Ask until nothing is pending, letting the background passes land in between. */
async function untilReady(ask: () => Response | Promise<Response>): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await ask();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    if (body.retryAfterMs === undefined && body.status !== "pending") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The counts never landed.");
}

describe("who may call the owner's filter routes", () => {
  test.each(ROUTES)("$method $path refuses every external agent's credential", async (call) => {
    expect((await send(app(null), call)).status).toBe(401);
    for (const auth of [oauth, integration, collector]) {
      const status = (await send(app(auth), call)).status;
      expect([401, 403]).toContain(status);
    }
  });

  test.each(ROUTES)(
    "$method $path serves the portal and a paired owner phone, never cached",
    async (call) => {
      for (const [auth, headers] of [
        [native, {}],
        [portal, { "X-Omnesis-CSRF": CSRF }],
      ] as const) {
        const response = await send(app(auth), call, headers);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    },
  );

  test("a portal change needs its synchronizer token, and a phone that is not the owner's is refused", async () => {
    const preview = ROUTES[2]!;
    expect((await send(app(portal), preview)).status).toBe(403);
    expect((await send(app(portal), preview, { "X-Omnesis-CSRF": "incorrect" })).status).toBe(403);
    expect((await send(app({ ...native, scopes: [SCOPE_READ] }), preview)).status).toBe(403);
    expect((await send(app({ ...native, deviceId: null }), preview)).status).toBe(403);
    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(PHONE);
    expect((await send(app(native), preview)).status).toBe(403);
  });
});

describe("what the routes return", () => {
  test("the editor answers at once, then with its counts", async () => {
    const target = app(native);
    const first = (await (await send(target, ROUTES[0]!)).json()) as Record<string, any>;
    expect(first).toMatchObject({
      sourceId: SOURCE,
      sourceType: "parley",
      connected: true,
      profile: "declared",
      retryAfterMs: expect.any(Number),
      fields: [
        { field: "extra.chatId", capability: "membership", state: { status: "ready" } },
        { field: "$people", capability: "person", state: { status: "ready" } },
      ],
    });
    expect(first.fields[0].counts).toEqual({ status: "pending" });
    expect(first).not.toHaveProperty("resync");
    const ready = await untilReady(() => send(target, ROUTES[0]!));
    expect(ready.fields.map((field: { counts: unknown }) => field.counts)).toEqual([
      { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null },
      { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null },
    ]);
  });

  test("an account whose field waits on a resync says so in one sentence", async () => {
    // Chat ids arrive from source version 2; the account was read at version 1.
    const profile = structuredClone(PARLEY_PROFILE) as unknown as {
      metadataFields: Array<{ filter: { minVersion: number } }>;
    };
    profile.metadataFields[0]!.filter.minVersion = 2;
    publishProfile(db as unknown as Db, "parley", 3, profile as unknown as typeof PARLEY_PROFILE);
    db.prepare(
      "INSERT INTO sync_state (source_id, device_id, source_version) VALUES (?, '', 3)",
    ).run(SOURCE);
    const editor = (await (await send(app(native), ROUTES[0]!)).json()) as Record<string, any>;
    expect(editor.fields[0].state.status).toBe("needs-resync");
    expect(editor.resync).toMatchObject({
      state: "needs-resync",
      fields: expect.arrayContaining(["extra.chatId"]),
      text: expect.stringContaining("resynced"),
    });
  });

  test("the picker lists the chats, then their counts", async () => {
    const target = app(native);
    const first = (await (await send(target, ROUTES[1]!)).json()) as Record<string, any>;
    expect(first.items.map((item: { label: string }) => item.label).sort()).toEqual([
      "Family",
      "Studio team",
    ]);
    expect(first.items.every((item: { count: unknown }) => item.count === null)).toBe(true);
    const ready = await untilReady(() => send(target, ROUTES[1]!));
    expect(ready.items.map((item: { count: number }) => item.count)).toEqual([1, 1]);
  });

  test("a preview is pending, then counts what the draft shares", async () => {
    const target = app(native);
    const first = (await (await send(target, ROUTES[2]!)).json()) as Record<string, any>;
    expect(first).toEqual({ status: "pending", retryAfterMs: expect.any(Number) });
    const ready = await untilReady(() => send(target, ROUTES[2]!));
    expect(ready).toMatchObject({
      status: "ready",
      sourceId: SOURCE,
      connected: true,
      total: 2,
      visible: 1,
      hidden: 1,
      items: [{ label: "Studio team", count: 1 }],
    });
  });

  test("the identifier check returns the canonical identifier or the sentence to show", async () => {
    const check = (body: unknown) =>
      send(app(native), { method: "POST", path: "/admin/access/source-filters/identifiers", body });
    expect(await (await check({ type: "phone", value: "00 1 (555) 010-0142" })).json()).toEqual({
      identifier: { type: "phone", value: "+15550100142" },
    });
    const refused = await check({ type: "phone", value: "+44 (0)7700 900123" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      error: "Enter a valid phone number. Include the international country code.",
    });
    expect((await check({ type: "handle", value: "maya" })).status).toBe(400);
  });

  test("a document's filter details and who can read it, or 404 for a document that does not exist", async () => {
    const target = app(native);
    const details = (await (await send(target, ROUTES[4]!)).json()) as Record<string, any>;
    expect(details).toMatchObject({
      documentId: "team-day",
      fields: expect.arrayContaining([
        expect.objectContaining({
          field: "extra.chatId",
          state: "present",
          items: [{ id: "c-team", label: "Studio team", listed: true }],
        }),
      ]),
    });
    expect(details).not.toHaveProperty("sourceId");
    const audit = (await (await send(target, ROUTES[5]!)).json()) as Record<string, any>;
    expect(audit).toMatchObject({
      documentId: "team-day",
      sourceId: SOURCE,
      sourceName: "parley",
      accountLabel: "studio",
      levels: [],
    });
    expect(audit.notes.owner).toContain("never available to an external agent");
    for (const path of [
      "/admin/documents/no-such-document/filter-details",
      "/admin/documents/no-such-document/access",
    ])
      expect((await send(target, { method: "GET", path })).status).toBe(404);
  });

  test("who can read a document names its account the way the account's source labels it", async () => {
    const phoneAccount = "parley:+15550100123";
    db.prepare(
      "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'parley','+15550100123',?,1,1)",
    ).run(phoneAccount, COLLECTOR);
    db.prepare(
      "INSERT INTO source_family_meta (source_type, label, updated_at) VALUES ('parley', 'Parley', 'now')",
    ).run();
    db.prepare("INSERT INTO sync_state (source_id, device_id, label) VALUES (?, '', ?)").run(
      phoneAccount,
      "+1 (555) 010-0123",
    );
    insertDocument(db as unknown as Db, {
      id: "phone-day",
      sourceId: phoneAccount,
      metadata: { documentType: "day", people: [], extra: { chatId: "c-team" } },
    });
    const audit = (await (
      await send(app(native), { method: "GET", path: "/admin/documents/phone-day/access" })
    ).json()) as Record<string, any>;
    expect(audit).toMatchObject({
      sourceId: phoneAccount,
      sourceName: "Parley",
      accountLabel: "+1 (555) 010-0123",
    });
  });

  test("a request is checked before anything is read", async () => {
    const target = app(native);
    for (const invalid of [
      { ...policy, maxAge: "90d" },
      { ...policy, rules: [{ match: [], action: "ask" }] },
      { ...policy, rules: [{ match: [{ kind: "conversation", id: "c-team" }], action: "share" }] },
    ])
      expect((await send(target, { ...ROUTES[2]!, body: { policy: invalid } })).status).toBe(400);
    // A draft for another account is refused once its pass has run.
    const elsewhere = { ...ROUTES[2]!, body: { policy: { ...policy, sourceId: "parley:other" } } };
    let status = 200;
    for (let attempt = 0; attempt < 20 && status === 200; attempt++) {
      status = (await send(target, elsewhere)).status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status).toBe(400);
    const options = (query: string, source = SOURCE) =>
      send(target, {
        method: "GET",
        path: `/admin/access/source-filters/${source}/options?${query}`,
      });
    expect((await options("field=extra.unknown")).status).toBe(400);
    expect((await options("kind=conversation")).status).toBe(400);
    expect((await options("field=extra.chatId&cursor=not-a-cursor")).status).toBe(400);
    expect((await options("field=extra.chatId", "invalid:too:many")).status).toBe(400);
    expect((await options("field=extra.chatId", "parley:unknown")).status).toBe(404);
  });
});

describe("saved filters and filter editing switched off", () => {
  async function saveFilter() {
    const access = new AccessService(db, directWriteGate(db));
    const created = await access.createLevel({
      name: "Invented saved level",
      rules: [
        { capability: "direct", sources: { mode: "all", sourceIds: [] }, scopePolicies: [policy] },
      ],
      actorTokenId: TOKEN,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    return created.value.rules[0]!.scopePolicies![0]!;
  }

  test("an account with a saved filter stays inspectable when new editing is off", async () => {
    await saveFilter();
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    const target = app(native);
    for (const call of ROUTES) expect((await send(target, call)).status).toBe(200);
    db.prepare(
      "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES('parley:other','parley','other',?,1,1)",
    ).run(COLLECTOR);
    expect(
      (
        await send(target, {
          method: "GET",
          path: "/admin/access/source-filters/parley:other/options?field=extra.chatId",
        })
      ).status,
    ).toBe(404);
  });

  test("a gone account a saved filter still names answers 200, names its entries and counts nothing", async () => {
    const saved = await saveFilter();
    db.prepare("DELETE FROM sources WHERE id = ?").run(SOURCE);
    const target = app(native);
    const editor = await send(target, ROUTES[0]!);
    expect(editor.status).toBe(200);
    const body = (await editor.json()) as Record<string, any>;
    expect(body).toMatchObject({ sourceId: SOURCE, connected: false });
    expect(body).not.toHaveProperty("retryAfterMs");
    expect(body.fields.map((field: { state: { status: string } }) => field.state.status)).toEqual(
      body.fields.map(() => "disconnected"),
    );
    const preview = await send(target, { ...ROUTES[2]!, body: { policy: saved } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      status: "ready",
      connected: false,
      total: 0,
      items: [{ label: "Studio team", count: 0 }],
    });
    expect(
      (await send(target, { method: "GET", path: "/admin/access/source-filters/parley:never" }))
        .status,
    ).toBe(404);
  });

  test("filter editing switched off answers 404, and a missing read worker 503", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect((await send(app(native), ROUTES[2]!)).status).toBe(404);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const response = await send(app(native, new SourceFilterService(undefined)), ROUTES[1]!);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("read worker") });
  });
});
