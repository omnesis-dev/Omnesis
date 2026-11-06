// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  SourceType,
  writeScope,
  type Scope,
} from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";

const entry = {
  sourceType: "fictional-chat",
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
};
let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createServer>;
let path: string;
beforeEach(() => {
  path = `/tmp/omnesis-scope-contract-${randomUUID()}.db`;
  db = createDatabase(path);
  app = createServer(db);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
});
function token(scopes: readonly Scope[]): string {
  const device = createDevice(db, { name: `Fictional collector ${randomUUID()}`, kind: "cli" });
  return createToken(db, device.id, scopes).token;
}
function publish(scopes: readonly Scope[], entries: unknown[]) {
  return app.request("/admin/source-scopes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token(scopes)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}
describe("source filter contract publication", () => {
  it("persists broad collector publications across server reconstruction and keeps sibling declarations", async () => {
    expect((await publish([SCOPE_WRITE_ALL], [entry])).status).toBe(200);
    expect((await publish([SCOPE_WRITE_ALL], [])).status).toBe(200);
    app = createServer(db);
    const response = await app.request("/admin/source-scopes", {
      headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [entry] });
  });
  it("restricts publication and catalogue discovery", async () => {
    expect((await publish([writeScope(SourceType("fictional-chat"))], [entry])).status).toBe(403);
    expect((await publish([SCOPE_READ], [entry])).status).toBe(403);
    for (const scopes of [[SCOPE_READ], [SCOPE_WRITE_ALL]]) {
      expect(
        (
          await app.request("/admin/source-scopes", {
            headers: { Authorization: `Bearer ${token(scopes)}` },
          })
        ).status,
      ).toBe(403);
    }
    expect((await app.request("/admin/source-scopes")).status).toBe(401);
  });
  it("rejects duplicate source types and malformed declarations atomically", async () => {
    expect((await publish([SCOPE_WRITE_ALL], [entry, entry])).status).toBe(400);
    expect(
      (
        await publish(
          [SCOPE_WRITE_ALL],
          [entry, { sourceType: "other", scopes: { items: [{ kind: "unknown" }] } }],
        )
      ).status,
    ).toBe(400);
    const response = await app.request("/admin/source-scopes", {
      headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
    });
    expect(await response.json()).toEqual({ entries: [] });
  });
  it("advertises negotiated scope facts in public health and owner compatibility manifest", async () => {
    const health = await (await app.request("/health")).json();
    expect(health.compat.sourceScopes).toEqual({ current: 2, min: 1, max: 2 });
    const manifest = await (
      await app.request("/admin/compat", {
        headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
      })
    ).json();
    expect(manifest.protocols.sourceScopes).toEqual(health.compat.sourceScopes);
  });
});
