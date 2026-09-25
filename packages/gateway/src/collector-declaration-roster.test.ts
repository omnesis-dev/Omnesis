// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_WRITE_ALL } from "@omnesis/types";
import {
  collectorDeclarationKey,
  collectorRosterRevisionMatches,
  collectorRosterSnapshot,
  connectCollectorDeclarations,
  disconnectCollectorDeclarations,
  refreshCollectorDeclarationRoster,
  resetConnectedCollectorDeclarations,
} from "./collector-declaration-roster.js";
import {
  getKnownUrlPatternSources,
  knownUrlPatternsReady,
  resetKnownUrlPatterns,
  setKnownUrlPatterns,
} from "./known-url-patterns.js";
import {
  getUrlTraversalHubSources,
  resetUrlGraphRoles,
  setUrlGraphRoles,
  urlGraphRolesReady,
} from "./url-graph-roles.js";
import { runSchemaSetup } from "./data/schema.js";
import { runMigrations } from "./data/migrations.js";
import {
  beginLinkDeclarationUpdate,
  finishLinkDeclarationUpdate,
  installCollectorRosterRevision,
} from "./data/list-revisions.js";
import { updateCollectorDeclarationPresence } from "./domain/LinkDeclarationService.js";
import { directWriteGate } from "./write-gate.js";

describe("collector declaration roster", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revoked_at INTEGER)");
  });

  afterEach(() => {
    resetConnectedCollectorDeclarations();
    resetKnownUrlPatterns();
    resetUrlGraphRoles();
    db.close();
  });

  test("offline paired collectors do not block connected collectors", () => {
    db.prepare("INSERT INTO devices (id, kind) VALUES ('collector-a', 'collector')").run();
    expect(refreshCollectorDeclarationRoster()).toEqual([]);
    connectCollectorDeclarations("collector-a");
    setKnownUrlPatterns("collector-a", [{ regex: "a[.]example" }]);
    setUrlGraphRoles("collector-a", ["history-a"], [], []);
    expect(knownUrlPatternsReady()).toBe(true);
    expect(urlGraphRolesReady()).toBe(true);

    db.prepare("INSERT INTO devices (id, kind) VALUES ('collector-b', 'collector')").run();
    expect(refreshCollectorDeclarationRoster()).toEqual(["collector-a"]);
    expect(knownUrlPatternsReady()).toBe(true);
    expect(urlGraphRolesReady()).toBe(true);

    connectCollectorDeclarations("collector-b");
    expect(knownUrlPatternsReady()).toBe(false);
    expect(urlGraphRolesReady()).toBe(false);

    setKnownUrlPatterns("collector-b", [{ regex: "b[.]example" }]);
    setUrlGraphRoles("collector-b", ["history-b"], [], []);
    expect(knownUrlPatternsReady()).toBe(true);
    expect(urlGraphRolesReady()).toBe(true);
  });

  test("last disconnect removes a collector's stale declarations", () => {
    db.exec(
      "INSERT INTO devices (id, kind) VALUES ('collector-a', 'collector'), ('collector-b', 'collector')",
    );
    connectCollectorDeclarations("collector-a");
    connectCollectorDeclarations("collector-b");
    setKnownUrlPatterns("collector-a", [{ regex: "a[.]example" }]);
    setKnownUrlPatterns("collector-b", [{ regex: "b[.]example" }]);
    setUrlGraphRoles("collector-a", ["history-a"], [], []);
    setUrlGraphRoles("collector-b", ["history-b"], [], []);

    disconnectCollectorDeclarations("collector-a");
    expect(getKnownUrlPatternSources()).toEqual(["b[.]example"]);
    expect(getUrlTraversalHubSources()).not.toContain("history-a");
    expect(getUrlTraversalHubSources()).toContain("history-b");
  });

  test("only collectors or explicit admin authority may declare", () => {
    db.exec(
      "INSERT INTO devices (id, kind) VALUES ('phone-a', 'ios'), ('collector-a', 'collector')",
    );
    connectCollectorDeclarations("collector-a");
    expect(() => collectorDeclarationKey(db, "phone-a", [SCOPE_WRITE_ALL])).toThrow();
    expect(collectorDeclarationKey(db, "collector-a", [SCOPE_WRITE_ALL])).toBe("collector-a");
    expect(collectorDeclarationKey(db, "collector-a", [SCOPE_ADMIN])).toBe("collector-a");
    expect(() => collectorDeclarationKey(db, "collector-a", [SCOPE_ADMIN], false)).toThrow(
      "a connected collector device token is required",
    );
    expect(() => collectorDeclarationKey(db, "phone-a", [SCOPE_ADMIN])).toThrow();
    expect(collectorDeclarationKey(db, null, [SCOPE_ADMIN])).toBe("admin");
  });

  test("a collector revoked after authentication cannot fall through to admin", () => {
    db.prepare("INSERT INTO devices (id, kind) VALUES ('collector-a', 'collector')").run();
    connectCollectorDeclarations("collector-a");
    const authenticatedDeviceId = "collector-a";
    const authenticatedScopes = [SCOPE_ADMIN];

    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = 'collector-a'").run();

    expect(() => collectorDeclarationKey(db, authenticatedDeviceId, authenticatedScopes)).toThrow(
      "a connected collector device token is required",
    );
  });
});

describe("collector roster revision fence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runSchemaSetup(db);
    runMigrations(db);
  });

  afterEach(() => {
    resetConnectedCollectorDeclarations();
    db.close();
  });

  test("presence publication writes only on the first connect and last disconnect", async () => {
    const writeGate = directWriteGate(db);
    const before = collectorRosterSnapshot(db).revision;

    await updateCollectorDeclarationPresence(writeGate, "collector-a", true);
    expect(collectorRosterSnapshot(db).revision).toBe(before + 2);

    await updateCollectorDeclarationPresence(writeGate, "collector-a", true);
    expect(collectorRosterSnapshot(db).revision).toBe(before + 2);

    await updateCollectorDeclarationPresence(writeGate, "collector-a", false);
    expect(collectorRosterSnapshot(db).revision).toBe(before + 4);

    await updateCollectorDeclarationPresence(writeGate, "collector-a", false);
    expect(collectorRosterSnapshot(db).revision).toBe(before + 4);
  });

  test("only active-collector membership changes advance the monotone revision", () => {
    const initial = collectorRosterSnapshot(db);

    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('phone-a', 'Phone', 'ios', 1)",
    ).run();
    expect(collectorRosterSnapshot(db).revision).toBe(initial.revision);

    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('collector-a', 'Collector', 'collector', 1)",
    ).run();
    const joined = collectorRosterSnapshot(db);
    expect(joined.revision).toBe(initial.revision + 2);

    db.prepare("UPDATE devices SET name = 'Renamed' WHERE id = 'collector-a'").run();
    expect(collectorRosterSnapshot(db).revision).toBe(joined.revision);

    db.prepare("UPDATE devices SET revoked_at = 2 WHERE id = 'collector-a'").run();
    const revoked = collectorRosterSnapshot(db);
    expect(revoked.revision).toBe(joined.revision + 2);
    expect(collectorRosterRevisionMatches(db, joined.revision)).toBe(false);

    db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = 'collector-a'").run();
    expect(collectorRosterSnapshot(db).revision).toBe(revoked.revision + 2);
  });

  test("declaration updates publish an odd in-progress and even stable revision", () => {
    const before = collectorRosterSnapshot(db).revision;
    expect(before % 2).toBe(0);
    expect(beginLinkDeclarationUpdate(db)).toBe(before + 1);
    expect(collectorRosterRevisionMatches(db, before + 1)).toBe(false);
    expect(finishLinkDeclarationUpdate(db)).toBe(before + 2);
    expect(collectorRosterRevisionMatches(db, before + 2)).toBe(true);
  });

  test("startup repairs an abandoned odd declaration revision", () => {
    beginLinkDeclarationUpdate(db);
    expect(collectorRosterSnapshot(db).revision % 2).toBe(1);
    installCollectorRosterRevision(db);
    expect(collectorRosterSnapshot(db).revision % 2).toBe(0);
  });

  test("writer-side revision validation is a singleton lookup and roster reads use the partial index", () => {
    const revisionPlan = db
      .prepare<[string], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT revision FROM mutable_list_revisions WHERE scope = ?",
      )
      .all("link-declarations")
      .map((row) => row.detail);
    expect(
      revisionPlan.some((detail) => detail.includes("sqlite_autoindex_mutable_list_revisions")),
    ).toBe(true);

    const rosterPlan = db
      .prepare<[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM devices WHERE kind = 'collector' AND revoked_at IS NULL ORDER BY id",
      )
      .all()
      .map((row) => row.detail);
    expect(rosterPlan.some((detail) => detail.includes("idx_devices_active_collectors"))).toBe(
      true,
    );
  });
});
