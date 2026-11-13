// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceId, SourceType } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createSourceWithId } from "../data/repositories/SourceRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { sourceFiltersInUse } from "./source-filters-in-use.js";
import { createAccessLevel, deleteAccessLevel } from "./store-levels.js";

/**
 * Whether source filters are "in use" decides what every ordinary write costs.
 * These tests hold the line for levels that carry no filter, and for the one
 * way a saved filter stops standing without being edited away: its level is
 * deleted.
 */

const SOURCE = SourceId("fictional-chat:one");

let db: ReturnType<typeof createDatabase>;
let dir: string;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  dir = mkdtempSync(join(tmpdir(), "omnesis-scope-retired-level-"));
  db = createDatabase(join(dir, "test.db"));
  const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
  createSourceWithId(db, SOURCE, {
    type: SourceType("fictional-chat"),
    accountId: AccountId("one"),
    deviceId: device.id,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function scopeRows(): number {
  return ["access_scope_capabilities", "access_scope_policy_sources"].reduce(
    (total, table) =>
      total + db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
    0,
  );
}

describe("a level without a filter, with experimental mode off", () => {
  test("an empty filter list beside a rule is accepted and stores no filter state", () => {
    const level = createAccessLevel(
      db,
      {
        name: "Fictional whole-source level",
        rules: [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
          { capability: "direct", sources: { mode: "all", sourceIds: [] }, scopePolicies: [] },
        ],
        actorTokenId: "owner",
      },
      1,
    );
    expect(level.ok).toBe(true);
    if (!level.ok) return;
    expect(scopeRows()).toBe(0);
    expect(sourceFiltersInUse(db)).toBe(false);
    for (const rule of level.value.rules) {
      expect(Object.keys(rule).sort()).toEqual(
        rule.capability === "answer"
          ? ["capability", "release", "sources"]
          : ["capability", "sources"],
      );
    }
  });
});

describe("a filtered level that is deleted", () => {
  function filteredLevel(): string {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    // A filter can only be saved for a source that declares what it may name
    // and whose stored documents are prepared.
    upsertSourceScopes(
      db,
      [
        {
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
        },
      ],
      1,
    );
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-chat','{}',1)",
    ).run(SOURCE);
    const level = createAccessLevel(
      db,
      {
        name: "Fictional filtered level",
        rules: [
          {
            capability: "direct",
            sources: { mode: "all", sourceIds: [] },
            scopePolicies: [
              {
                sourceId: SOURCE,
                audience: { accessLevel: "new", capability: "direct" },
                rules: [{ match: [{ kind: "conversation", id: "chat-1" }], action: "share" }],
                otherwise: "hide",
              },
            ],
          },
        ],
        actorTokenId: "owner",
      },
      1,
    );
    if (!level.ok) throw new Error(level.error);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    return level.value.id;
  }

  test("its filter no longer keeps source filters in use", () => {
    const levelId = filteredLevel();
    expect(sourceFiltersInUse(db)).toBe(true);
    expect(deleteAccessLevel(db, { levelId, actorTokenId: "owner" }, 2).ok).toBe(true);
    expect(sourceFiltersInUse(db)).toBe(false);
    // The deleted level keeps its filter rows, as it keeps its rules.
    expect(scopeRows()).toBeGreaterThan(0);
  });
});
