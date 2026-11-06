// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "./corpus-authorization.js";
import { permittedSourceIds, permittedAnalyticsSourceIds } from "./permitted-sources.js";
import type { ScopePolicy } from "@omnesis/types";
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

function authorization(
  mode: "all" | "allowlist" | "denylist",
  sourceIds: string[],
  scopePolicies: ScopePolicy[] = [],
) {
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
        ...(scopePolicies.length ? { filterRevision: 1, scopePolicies } : {}),
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

describe("permittedAnalyticsSourceIds", () => {
  test("keeps legacy unrestricted analytics unchanged", () => {
    expect(permittedAnalyticsSourceIds(db, authorization("all", []))).toBeNull();
  });

  test("excludes only the filtered account, retaining unfiltered sibling sources", () => {
    const auth = authorization(
      "all",
      [],
      [
        {
          sourceId: "mail:alpha",
          audience: { accessLevel: "fictional-level", capability: "direct" },
          rules: [{ action: "hide", match: [{ kind: "label", id: "private" }] }],
          otherwise: "share",
        },
      ],
    );
    expect([...permittedAnalyticsSourceIds(db, auth)!].sort()).toEqual([
      "files",
      "files:gamma",
      "mail:beta",
    ]);
    expect(permittedSourceIds(db, auth)).toBeNull();
  });
});

test("shared catalog owners survive only an all-source boundary with no filtered account of their type", () => {
  const policy: ScopePolicy = {
    sourceId: "mail:alpha",
    audience: { accessLevel: "fictional-level", capability: "direct" },
    rules: [{ action: "hide", match: [{ kind: "label", id: "private" }] }],
    otherwise: "share",
  };
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) SELECT 'files:delta','files','delta',device_id,1,1 FROM sources LIMIT 1",
  ).run();
  // Historical accountless source ids must not accidentally authorize the
  // ambiguous shared catalog owner once another account is filtered.
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) SELECT 'mail','mail','legacy-accountless',device_id,1,1 FROM sources LIMIT 1",
  ).run();
  const all = permittedAnalyticsSourceIds(db, authorization("all", [], [policy]))!;
  expect([...all].sort()).toEqual(["files", "files:delta", "files:gamma", "mail:beta"]);
  expect(all.has("mail")).toBe(false);
  expect(all.has("unconfigured")).toBe(false);
  for (const mode of ["allowlist", "denylist"] as const) {
    const ids = mode === "allowlist" ? ["files:gamma", "files:delta", "mail:alpha"] : ["mail:beta"];
    const restricted = permittedAnalyticsSourceIds(db, authorization(mode, ids, [policy]))!;
    expect(restricted.has("files:gamma")).toBe(true);
    expect(restricted.has("files:delta")).toBe(true);
    expect(restricted.has("files")).toBe(false);
    expect(restricted.has("mail")).toBe(false);
    expect(restricted.has("mail:alpha")).toBe(false);
  }
});
