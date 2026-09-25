// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "./corpus-authorization.js";
import { permittedSourceIds } from "./permitted-sources.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-permitted-sources-"));
  db = createDatabase(join(tmpDir, "test.db"));
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Test device', 'desktop', 1)",
  ).run();
  for (const id of ["mail:alpha", "mail:beta", "files:gamma"]) {
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
       VALUES (?, ?, ?, '00000000-0000-4000-8000-000000000001', 1, 1)`,
    ).run(id, id.split(":")[0], id.split(":")[1]);
  }
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function authorization(mode: "all" | "allowlist" | "denylist", sourceIds: string[]) {
  return createCorpusAuthorization(
    {
      principalId: "principal-example",
      grantId: "grant-example",
      grantRevision: 1,
      credentialId: "credential-example",
      accessTokenId: "token-example",
    },
    [
      {
        capability: "direct",
        sourceMode: mode,
        sourceIds,
        releaseMode: null,
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
      },
    ],
    "direct",
  )!;
}

describe("permittedSourceIds", () => {
  test("an unrestricted authorization needs no set", () => {
    expect(permittedSourceIds(db, authorization("all", []))).toBeNull();
  });

  test("an allowlist is the listed configured sources", () => {
    expect([...permittedSourceIds(db, authorization("allowlist", ["mail:beta"]))!]).toEqual([
      "mail:beta",
    ]);
  });

  test("a denylist is the configured sources minus the listed ones, never unlisted unconfigured ids", () => {
    const permitted = permittedSourceIds(db, authorization("denylist", ["mail:beta"]))!;
    expect([...permitted].sort()).toEqual(["files:gamma", "mail:alpha"]);
    expect(permitted.has("omnesis-chat")).toBe(false);
    expect(permitted.has("open-loops")).toBe(false);
  });

  test("a rule naming a source that is no longer configured yields an empty set", () => {
    expect(permittedSourceIds(db, authorization("allowlist", ["mail:gone"]))!.size).toBe(0);
  });
});
