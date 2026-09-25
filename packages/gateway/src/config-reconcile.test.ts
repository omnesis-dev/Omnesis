// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;
import { type OmnesisConfig } from "@omnesis/config";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "./db.js";
import {
  addSourceMember,
  createSource,
  getSource,
  getSourceForMember,
  setSourceMemberConfigOverride,
  type SourceRecord,
} from "./data/repositories/SourceRepository.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { initializeOrAssertSourceMemberConfigContract } from "./data/repositories/SourceMemberConfigContractRepository.js";
import { reconcileConfig } from "./config-reconcile.js";
import { directWriteGate, type WriteGate } from "./write-gate.js";
import type Database from "better-sqlite3";

let db: Db;
let dbPath: string;
let w: WriteGate;

beforeEach(() => {
  dbPath = `/tmp/omnesis-reconcile-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  w = directWriteGate(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function mkDevice(name: string, kind: "collector" | "cli" = "collector"): string {
  return createDevice(db, { name, kind }).id;
}

function mkSource(
  deviceId: string,
  type: string,
  account: string,
  initialConfig: Record<string, unknown> = {},
): SourceRecord {
  return createSource(db, {
    type: SourceType(type),
    accountId: AccountId(account),
    deviceId: deviceId as never,
    config: initialConfig,
  });
}

describe("reconcileConfig", () => {
  test("projects per-source settings onto DB row", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "jamesbond@gmail.com");

    const config: OmnesisConfig = {
      sources: {
        "gmail:jamesbond@gmail.com": { syncInterval: "2m", extractAttachments: true },
      },
    };
    const report = await reconcileConfig(db, w, config);
    expect(report.sourcesUpdated).toBe(1);

    const row = getSource(db, "gmail:jamesbond@gmail.com" as never);
    expect(row?.config.syncInterval).toBe("2m");
    expect(row?.config.extractAttachments).toBe(true);
  });

  test("applies sources.default when no per-source block exists", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "jamesbond@gmail.com");
    mkSource(dev, "notion-pages", "workspace-123");

    const config: OmnesisConfig = {
      sources: { default: { syncInterval: "5m", extractAttachments: true } },
    };
    const report = await reconcileConfig(db, w, config);
    expect(report.sourcesUpdated).toBe(2);

    const gmail = getSource(db, "gmail:jamesbond@gmail.com" as never);
    const notion = getSource(db, "notion-pages:workspace-123" as never);
    expect(gmail?.config.syncInterval).toBe("5m");
    expect(gmail?.config.extractAttachments).toBe(true);
    expect(notion?.config.syncInterval).toBe("5m");
  });

  test("per-source overrides sources.default per-field", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "jamesbond@gmail.com");

    const config: OmnesisConfig = {
      sources: {
        default: { syncInterval: "5m", attachmentMaxTextLength: 1000, extractAttachments: false },
        "gmail:jamesbond@gmail.com": { syncInterval: "1m", extractAttachments: true },
      },
    };
    await reconcileConfig(db, w, config);

    const row = getSource(db, "gmail:jamesbond@gmail.com" as never);
    expect(row?.config.syncInterval).toBe("1m"); // overridden
    expect(row?.config.attachmentMaxTextLength).toBe(1000); // inherited from default
    expect(row?.config.extractAttachments).toBe(true); // overridden
  });

  test("removing a schema-owned field from file removes it from DB", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "x@y.com", { syncInterval: "5m", extractAttachments: true });

    // New config only keeps syncInterval, drops extractAttachments entirely.
    const config: OmnesisConfig = {
      sources: { "gmail:x@y.com": { syncInterval: "5m" } },
    };
    await reconcileConfig(db, w, config);

    const row = getSource(db, "gmail:x@y.com" as never);
    expect(row?.config.syncInterval).toBe("5m");
    expect(row?.config.extractAttachments).toBeUndefined();
  });

  test("non-schema-owned keys on the DB row pass through untouched", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "x@y.com", { syncInterval: "5m", legacyField: "keep-me" });

    const config: OmnesisConfig = {
      sources: { "gmail:x@y.com": { syncInterval: "2m" } },
    };
    await reconcileConfig(db, w, config);

    const row = getSource(db, "gmail:x@y.com" as never);
    expect(row?.config.syncInterval).toBe("2m");
    expect(row?.config.legacyField).toBe("keep-me");
  });

  test("no-op when current config already matches", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "x@y.com", { syncInterval: "5m" });

    const config: OmnesisConfig = {
      sources: { "gmail:x@y.com": { syncInterval: "5m" } },
    };
    const report = await reconcileConfig(db, w, config);
    expect(report.sourcesUpdated).toBe(0);
  });

  test("a descriptor-id block projects onto every instance of that type", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "google-drive", "maya@example.com");
    mkSource(dev, "google-drive", "jamie@example.org");
    mkSource(dev, "gmail", "maya@example.com");

    const config: OmnesisConfig = {
      sources: { "google-drive": { syncInterval: "30m" } },
    };
    const report = await reconcileConfig(db, w, config);

    expect(getSource(db, "google-drive:maya@example.com" as never)?.config.syncInterval).toBe(
      "30m",
    );
    expect(getSource(db, "google-drive:jamie@example.org" as never)?.config.syncInterval).toBe(
      "30m",
    );
    expect(getSource(db, "gmail:maya@example.com" as never)?.config.syncInterval).toBeUndefined();
    // The block reaches live rows, so it is not held in reserve.
    expect(report.orphanedSourceBlocks).toEqual([]);
  });

  test("an instance-id block wins over a descriptor-id block", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "google-drive", "maya@example.com");
    mkSource(dev, "google-drive", "jamie@example.org");

    const config: OmnesisConfig = {
      sources: {
        "google-drive": { syncInterval: "30m", extractAttachments: true },
        "google-drive:maya@example.com": { syncInterval: "2m" },
      },
    };
    await reconcileConfig(db, w, config);

    const maya = getSource(db, "google-drive:maya@example.com" as never);
    expect(maya?.config.syncInterval).toBe("2m");
    expect(maya?.config.extractAttachments).toBe(true);
    expect(getSource(db, "google-drive:jamie@example.org" as never)?.config.syncInterval).toBe(
      "30m",
    );
  });

  test("orphaned source blocks are reported", async () => {
    // Config references a source not in the DB.
    const config: OmnesisConfig = {
      sources: { "gmail:ghost@x.com": { syncInterval: "2m" } },
    };
    const report = await reconcileConfig(db, w, config);
    expect(report.orphanedSourceBlocks).toEqual(["gmail:ghost@x.com"]);
  });

  test("empty config leaves DB rows at empty settings", async () => {
    const dev = mkDevice("macbook");
    mkSource(dev, "gmail", "x@y.com", { syncInterval: "5m" });
    const report = await reconcileConfig(db, w, {});
    expect(report.sourcesUpdated).toBe(1);
    const row = getSource(db, "gmail:x@y.com" as never);
    expect(row?.config.syncInterval).toBeUndefined();
  });

  test("a stale file block cannot restore pinned member params or leak them to an empty sibling overlay", async () => {
    const owner = mkDevice("collector-owner");
    const sibling = mkDevice("collector-sibling");
    const source = mkSource(owner, "notes-synth", "fictional-team", {
      syncInterval: "5m",
      params: { sharedLabel: "fictional-team" },
    });
    initializeOrAssertSourceMemberConfigContract(db, source.id, ["sessionsPath"]);
    setSourceMemberConfigOverride(db, source.id, owner as never, {
      params: { sessionsPath: "/srv/fictional-owner/sessions" },
    });
    addSourceMember(db, source.id, sibling as never);

    const report = await reconcileConfig(db, w, {
      sources: {
        [source.id]: {
          syncInterval: "10m",
          params: {
            sharedLabel: "fictional-updated-team",
            sessionsPath: "/srv/stale-file/sessions",
          },
        },
      },
    });

    expect(report.sourcesUpdated).toBe(1);
    expect(getSource(db, source.id)?.config).toEqual({
      syncInterval: "10m",
      params: { sharedLabel: "fictional-updated-team" },
    });
    expect(getSourceForMember(db, source.id, owner as never)?.config.params).toEqual({
      sharedLabel: "fictional-updated-team",
      sessionsPath: "/srv/fictional-owner/sessions",
    });
    expect(getSourceForMember(db, source.id, sibling as never)?.config.params).toEqual({
      sharedLabel: "fictional-updated-team",
    });
  });
});
