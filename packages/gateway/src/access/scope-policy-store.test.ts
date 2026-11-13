// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { reconcileLegacyScopeBoundaries } from "./scope-storage-floor.js";
import { createAccessLevel, updateAccessLevel, setConnectionLevel } from "./store-levels.js";
import { getGrantCapabilities, getLevelCapabilities } from "./store-rules.js";
import { loadAccessLevelSummary } from "./store-level-summaries.js";
import { createGrantOnLevel } from "./store-level-writes.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { resolveDeviceAnswerScope } from "./device-answer-scope.js";
import { lookupPrincipalAccessToken } from "./store-credentials.js";
import { hashSecret } from "./store-helpers.js";
import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
  parseCorpusAuthorization,
} from "./corpus-authorization.js";
import { requestRule } from "./test-utils.js";
import type { ScopePolicy, SourceScopes } from "@omnesis/types";
import type { AccessGrantRuleInput } from "./types.js";

const NOW = 1_800_000_000_000;
const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
  ],
};
let db: Database.Database;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  const device = createDevice(db, { name: "Synthetic collector", kind: "collector" }).id;
  const insert = db.prepare(
    "INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at) VALUES (?, 'test-chat', ?, ?, 1, 1)",
  );
  for (const source of ["chat:one", "chat:two", "chat:three"]) insert.run(source, source, device);
  upsertSourceScopes(db, [{ sourceType: "test-chat", scopes }], NOW);
  db.prepare(
    "INSERT INTO scope_fact_backfill (source_id, source_type, descriptor_json, cursor_rowid, processed, ready) VALUES (?, 'test-chat', ?, 0, 0, 1)",
  ).run("chat:one", JSON.stringify(scopes));
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

function create(
  sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] } = {
    mode: "all",
    sourceIds: [],
  },
) {
  const result = createAccessLevel(
    db,
    { name: "Synthetic level", rules: [{ capability: "direct", sources }], actorTokenId: "owner" },
    NOW,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function policy(levelId: string, capability: "direct" | "answer" = "direct"): ScopePolicy {
  return {
    sourceId: "chat:one",
    audience: { accessLevel: levelId, capability },
    rules: [{ match: [{ kind: "conversation", id: "allowed-chat" }], action: "share" }],
    otherwise: "hide",
  };
}
function addFilter(levelId: string) {
  const level = loadAccessLevelSummary(db, levelId, NOW)!;
  const rule = requestRule(level.rules[0]!);
  const result = updateAccessLevel(
    db,
    {
      levelId,
      expectedRevision: level.revision,
      rules: [{ ...rule, scopePolicies: [policy(levelId)] }],
      actorTokenId: "owner",
    },
    NOW + 1,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function grant(levelId: string) {
  db.prepare(
    "INSERT INTO access_principals (id, name, kind, created_at, updated_at) VALUES ('principal', 'Synthetic client', 'interactive', ?, ?)",
  ).run(NOW, NOW);
  return createGrantOnLevel(db, "principal", "Synthetic grant", levelId, null, NOW);
}

describe("persistent per-source capability policies", () => {
  test("whole-source levels retain their exact legacy capability shape", () => {
    const level = create();
    expect(level.rules).toEqual([
      { capability: "direct", sources: { mode: "all", sourceIds: [] } },
    ]);
    expect(getLevelCapabilities(db, level.id)[0]).not.toHaveProperty("filterRevision");
    expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual([]);
  });

  test.each([
    [{ mode: "all", sourceIds: [] }, "denylist", ["chat:one"]],
    [{ mode: "allowlist", sourceIds: ["chat:one", "chat:two"] }, "allowlist", ["chat:two"]],
    [{ mode: "denylist", sourceIds: ["chat:three"] }, "denylist", ["chat:one", "chat:three"]],
  ] as const)(
    "keeps canonical %j access while rollback rows deny filtered sources",
    (sources, mode, ids) => {
      const level = create({ mode: sources.mode, sourceIds: [...sources.sourceIds] });
      const connection = grant(level.id);
      const updated = addFilter(level.id);
      // The served rule carries the real boundary beside the one an unaware client may copy.
      expect(updated.rules[0]!.scopeSources).toEqual(sources);
      expect(updated.rules[0]!.sources).toEqual({ mode, sourceIds: [...ids] });
      expect(updated.rules[0]!.filterRevision).toBe(1);
      for (const [table, column, id] of [
        ["access_level_capabilities", "level_id", level.id],
        ["access_grant_capabilities", "grant_id", connection.id],
      ]) {
        const legacy = db
          .prepare(`SELECT source_mode, source_ids FROM ${table} WHERE ${column} = ?`)
          .get(id) as { source_mode: string; source_ids: string };
        expect(legacy.source_mode).toBe(mode);
        expect(JSON.parse(legacy.source_ids)).toEqual(ids);
      }
      expect(getGrantCapabilities(db, connection.id)).toEqual(getLevelCapabilities(db, level.id));
      db.prepare(
        `INSERT INTO principal_credentials
        (id,grant_id,oauth_client_id,kind,status,label,created_at)
        VALUES ('scoped-credential',?,'fictional-client','interactive','active','Scoped fixture',?)`,
      ).run(connection.id, NOW);
      db.prepare(
        `INSERT INTO oauth_access_tokens
        (id,credential_id,token_hash,audience,scope,grant_revision,created_at,expires_at)
        SELECT 'scoped-token','scoped-credential',?,'https://example.com/mcp','omnesis:access',revision,?,?
        FROM access_grants WHERE id=?`,
      ).run(hashSecret("fictional-scoped-token"), NOW, NOW + 10000, connection.id);
      const resolved = lookupPrincipalAccessToken(
        db,
        "fictional-scoped-token",
        "https://example.com/mcp",
        NOW + 2,
      );
      expect(resolved?.capabilities).toEqual(getGrantCapabilities(db, connection.id));
      const authorization = createCorpusAuthorization(
        {
          principalId: "principal",
          grantId: connection.id,
          grantRevision: 2,
          credentialId: "credential",
          accessTokenId: "token",
        },
        getGrantCapabilities(db, connection.id),
        "direct",
      )!;
      expect(authorization.restricted).toBe(true);
      expect(
        parseCorpusAuthorization(serializeCorpusAuthorization(authorization)).scopePolicies,
      ).toEqual([policy(level.id)]);
    },
  );

  test("refuses old editors even with the current numeric level revision", () => {
    const level = addFilter(create().id);
    expect(
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
          actorTokenId: "old-editor",
        },
        NOW + 2,
      ),
    ).toEqual({ ok: false, error: "stale-revision" });
    expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toEqual([policy(level.id)]);
  });

  test("clearing filters retains its revision fence and restores whole-source access", () => {
    const level = addFilter(create().id);
    const result = updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: level.revision,
        rules: [{ ...requestRule(level.rules[0]!), scopePolicies: [] }],
        actorTokenId: "owner",
      },
      NOW + 2,
    );
    expect(result.ok).toBe(true);
    const capability = getLevelCapabilities(db, level.id)[0]!;
    expect(capability.filterRevision).toBe(2);
    expect(capability.scopePolicies).toEqual([]);
    expect(
      db
        .prepare("SELECT source_mode FROM access_level_capabilities WHERE level_id = ?")
        .get(level.id),
    ).toEqual({ source_mode: "all" });
  });

  test("explicit revision map permits removing a filtered capability atomically", () => {
    const level = addFilter(create().id);
    const rules: AccessGrantRuleInput[] = [
      {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        release: { mode: "unreviewed" },
      },
    ];
    expect(
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          expectedFilterRevisions: { direct: 1 },
          rules,
          actorTokenId: "owner",
        },
        NOW + 2,
      ).ok,
    ).toBe(true);
    expect(
      db.prepare("SELECT * FROM access_scope_capabilities WHERE owner_id = ?").all(level.id),
    ).toEqual([]);
  });

  test("copies and rebinds filtered policies when a connection creates a new level", () => {
    const level = create();
    const connection = grant(level.id);
    addFilter(level.id);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    const moved = setConnectionLevel(
      db,
      {
        connectionId: "principal",
        expectedGrantRevision: 2,
        newLevel: { name: "Copied level" },
        actorTokenId: "owner",
      },
      NOW + 2,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.level.rules[0]!.scopePolicies![0]!.audience).toEqual({
      accessLevel: moved.value.level.id,
      capability: "direct",
    });
    expect(getGrantCapabilities(db, connection.id)[0]!.scopePolicies).toEqual(
      moved.value.level.rules[0]!.scopePolicies,
    );
  });

  test("policy edits require the experimental gate but stored filters survive its removal", () => {
    const level = addFilter(create().id);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toEqual([policy(level.id)]);
    expect(
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [{ ...requestRule(level.rules[0]!), scopePolicies: [] }],
          actorTokenId: "owner",
        },
        NOW + 2,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });

  test("a stale filter revision is refused as stale, a real refusal as an invalid selection", () => {
    const level = addFilter(create().id);
    const save = (expectedFilterRevisions: { direct: number }, sourceId: string) =>
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          expectedFilterRevisions,
          rules: [
            { ...requestRule(level.rules[0]!), scopePolicies: [{ ...policy(level.id), sourceId }] },
          ],
          actorTokenId: "owner",
        },
        NOW + 2,
      );
    expect(save({ direct: 7 }, "chat:one")).toEqual({ ok: false, error: "stale-revision" });
    expect(save({ direct: 1 }, "chat:missing")).toEqual({ ok: false, error: "invalid-selection" });
    expect(getLevelCapabilities(db, level.id)[0]!.filterRevision).toBe(1);
  });

  describe("without experimental mode", () => {
    function filtered(sources: Parameters<typeof create>[0]) {
      const level = addFilter(create(sources).id);
      vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
      return level;
    }
    function save(
      level: ReturnType<typeof addFilter>,
      sources: NonNullable<Parameters<typeof create>[0]>,
      scopePolicies: ScopePolicy[],
    ) {
      return updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [{ ...requestRule(level.rules[0]!), sources, scopePolicies }],
          actorTokenId: "owner",
        },
        NOW + 2,
      );
    }

    test("a filter can leave together with its source", () => {
      const level = filtered({ mode: "allowlist", sourceIds: ["chat:one", "chat:two"] });
      expect(save(level, { mode: "allowlist", sourceIds: ["chat:two"] }, []).ok).toBe(true);
      expect(getLevelCapabilities(db, level.id)[0]).toMatchObject({
        sourceMode: "allowlist",
        sourceIds: ["chat:two"],
        filterRevision: 2,
        scopePolicies: [],
      });
    });

    test("a denylist can take a filtered source away with its filter", () => {
      const level = filtered({ mode: "denylist", sourceIds: ["chat:three"] });
      expect(save(level, { mode: "denylist", sourceIds: ["chat:one", "chat:three"] }, []).ok).toBe(
        true,
      );
      expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toEqual([]);
    });

    test("a filter cannot be dropped while its source stays readable", () => {
      const level = filtered({ mode: "allowlist", sourceIds: ["chat:one", "chat:two"] });
      expect(save(level, { mode: "allowlist", sourceIds: ["chat:one"] }, [])).toEqual({
        ok: false,
        error: "invalid-selection",
      });
      expect(save(level, { mode: "all", sourceIds: [] }, [])).toEqual({
        ok: false,
        error: "invalid-selection",
      });
      expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toEqual([policy(level.id)]);
    });

    test("a filter cannot be altered or added", () => {
      const level = filtered({ mode: "all", sourceIds: [] });
      const altered = { ...policy(level.id), otherwise: "share" as const };
      expect(save(level, { mode: "all", sourceIds: [] }, [altered])).toEqual({
        ok: false,
        error: "invalid-selection",
      });
      db.prepare(
        "INSERT INTO scope_fact_backfill (source_id, source_type, descriptor_json, ready) VALUES ('chat:two', 'test-chat', ?, 1)",
      ).run(JSON.stringify(scopes));
      const added = { ...policy(level.id), sourceId: "chat:two" };
      expect(save(level, { mode: "all", sourceIds: [] }, [policy(level.id), added])).toEqual({
        ok: false,
        error: "invalid-selection",
      });
    });

    test("the filter of a source that no longer exists can be dropped", () => {
      const level = filtered({ mode: "all", sourceIds: [] });
      db.prepare("DELETE FROM sources WHERE id = 'chat:one'").run();
      expect(save(level, { mode: "all", sourceIds: [] }, []).ok).toBe(true);
      expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toEqual([]);
    });
  });

  test.each(["1", "0"])(
    "a saved filter left alone never blocks another edit (experimental %s)",
    (experimental) => {
      const level = addFilter(create({ mode: "denylist", sourceIds: ["chat:three"] }).id);
      const connection = grant(level.id);
      vi.stubEnv("OMNESIS_EXPERIMENTAL", experimental);
      const edit = (revision: number, sourceIds: string[]) =>
        updateAccessLevel(
          db,
          {
            levelId: level.id,
            expectedRevision: revision,
            rules: [{ ...requestRule(level.rules[0]!), sources: { mode: "denylist", sourceIds } }],
            actorTokenId: "owner",
          },
          NOW + 2,
        );
      db.prepare("UPDATE scope_fact_backfill SET ready = 0 WHERE source_id = 'chat:one'").run();
      const preparing = edit(level.revision, ["chat:two", "chat:three"]);
      expect(preparing.ok).toBe(true);
      db.prepare("DELETE FROM sources WHERE id = 'chat:one'").run();
      const gone = edit(level.revision + 1, ["chat:two"]);
      expect(gone.ok).toBe(true);
      expect(getLevelCapabilities(db, level.id)[0]).toMatchObject({
        sourceIds: ["chat:two"],
        filterRevision: 1,
        scopePolicies: [policy(level.id)],
      });
      expect(getGrantCapabilities(db, connection.id)).toEqual(getLevelCapabilities(db, level.id));
    },
  );

  test("integration devices receive their level's exact Answer policies", () => {
    const level = create();
    const rule: AccessGrantRuleInput = {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      release: { mode: "unreviewed" },
      scopePolicies: [policy(level.id, "answer")],
    };
    expect(
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [rule],
          actorTokenId: "owner",
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    const device = createDevice(db, { name: "Synthetic integration", kind: "integration" }).id;
    db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run(level.id, device);
    const scope = resolveDeviceAnswerScope(db, device, "token");
    expect(scope.kind).toBe("level");
    if (scope.kind === "level")
      expect(scope.authorization.scopePolicies).toEqual([policy(level.id, "answer")]);
  });
  test("new filtered levels bind the new audience and reject excluded sources", () => {
    const excluded = createAccessLevel(
      db,
      {
        name: "Excluded",
        rules: [
          {
            capability: "direct",
            sources: { mode: "allowlist", sourceIds: ["chat:two"] },
            scopePolicies: [policy("new")],
          },
        ],
        actorTokenId: "owner",
      },
      NOW,
    );
    expect(excluded).toEqual({ ok: false, error: "invalid-selection" });
    const included = createAccessLevel(
      db,
      {
        name: "Included",
        rules: [
          {
            capability: "direct",
            sources: { mode: "all", sourceIds: [] },
            scopePolicies: [policy("new")],
          },
        ],
        actorTokenId: "owner",
      },
      NOW,
    );
    expect(included.ok).toBe(true);
    if (included.ok)
      expect(included.value.rules[0]!.scopePolicies).toEqual([policy(included.value.id)]);
  });

  test("refuses filter saves until the source backfill is complete", () => {
    const level = create();
    db.prepare("UPDATE scope_fact_backfill SET ready = 0 WHERE source_id = ?").run("chat:one");
    const result = updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: level.revision,
        rules: [{ ...requestRule(level.rules[0]!), scopePolicies: [policy(level.id)] }],
        actorTokenId: "owner",
      },
      NOW + 1,
    );
    expect(result).toEqual({ ok: false, error: "invalid-selection" });
    expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toBeUndefined();
  });

  test("label filters need explicit source refresh readiness", () => {
    const declared: SourceScopes = {
      items: [
        {
          kind: "label",
          noun: { one: "label", many: "labels" },
          picker: "search",
          link: "changes",
        },
      ],
    };
    upsertSourceScopes(db, [{ sourceType: "test-chat", scopes: declared }], NOW + 1);
    db.prepare("UPDATE scope_fact_backfill SET ready = 1 WHERE source_id = ?").run("chat:one");
    const level = create();
    const labelPolicy = {
      ...policy(level.id),
      rules: [{ action: "share" as const, match: [{ kind: "label" as const, id: "label-one" }] }],
    };
    const save = () =>
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [{ ...requestRule(level.rules[0]!), scopePolicies: [labelPolicy] }],
          actorTokenId: "owner",
        },
        NOW + 2,
      );
    expect(save()).toEqual({ ok: false, error: "invalid-selection" });
    db.prepare(
      "INSERT INTO source_scope_kind_readiness (source_id, kind, ready) VALUES (?, 'label', 1)",
    ).run("chat:one");
    expect(save().ok).toBe(true);
  });
  test("callers cannot invent revisions or turn empty filter fields into repeated writes", () => {
    const level = create();
    const save = (filterRevision: number) =>
      updateAccessLevel(
        db,
        {
          levelId: level.id,
          expectedRevision: level.revision,
          rules: [{ ...requestRule(level.rules[0]!), filterRevision, scopePolicies: [] }],
          actorTokenId: "owner",
        },
        NOW + 1,
      );
    expect(save(999)).toEqual({ ok: false, error: "stale-revision" });
    const unchanged = save(0);
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) expect(unchanged.value.revision).toBe(level.revision);
    expect(getLevelCapabilities(db, level.id)[0]!).not.toHaveProperty("filterRevision");
  });
  test("deleting parent grant rows clears their scope overlay", () => {
    const level = addFilter(create().id);
    const connection = grant(level.id);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM access_scope_capabilities WHERE owner_kind = 'grant'")
        .get(),
    ).toEqual({ n: 1 });
    db.prepare("DELETE FROM access_grants WHERE id = ?").run(connection.id);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM access_scope_capabilities WHERE owner_kind = 'grant'")
        .get(),
    ).toEqual({ n: 0 });
  });
});

test("quarantine fences cached level drafts and linked grants exactly once while retaining reviewed filters", () => {
  const level = create();
  addFilter(level.id);
  const linked = grant(level.id);
  const cached = loadAccessLevelSummary(db, level.id, NOW)!;
  const oldGrantRevision = db
    .prepare<[string], { revision: number }>("SELECT revision FROM access_grants WHERE id=?")
    .get(linked.id)!.revision;
  db.exec("DROP TRIGGER scope_legacy_grant_update");
  db.prepare("UPDATE access_grant_capabilities SET source_ids=? WHERE grant_id=?").run(
    JSON.stringify(["chat:one", "chat:two"]),
    linked.id,
  );
  reconcileLegacyScopeBoundaries(db);
  const current = loadAccessLevelSummary(db, level.id, NOW)!;
  expect(current.revision).toBe(cached.revision + 1);
  expect(current.rules[0]).toMatchObject({
    sources: { mode: "allowlist", sourceIds: [] },
    scopePolicies: [policy(level.id)],
  });
  expect(getGrantCapabilities(db, linked.id)[0]).toMatchObject({
    sourceMode: "allowlist",
    sourceIds: [],
    scopePolicies: [policy(level.id)],
  });
  expect(db.prepare("SELECT revision FROM access_grants WHERE id=?").get(linked.id)).toEqual({
    revision: oldGrantRevision + 1,
  });
  const copied = createGrantOnLevel(db, "principal", "Quarantined copy", level.id, null, NOW);
  expect(getGrantCapabilities(db, copied.id)[0]).toMatchObject({
    sourceMode: "allowlist",
    sourceIds: [],
    scopePolicies: [policy(level.id)],
  });
  reconcileLegacyScopeBoundaries(db);
  expect(loadAccessLevelSummary(db, level.id, NOW)!.revision).toBe(current.revision);
  expect(
    updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: cached.revision,
        rules: cached.rules.map(requestRule),
        actorTokenId: "owner",
      },
      NOW + 5,
    ),
  ).toEqual({ ok: false, error: "stale-revision" });
});

test.each(["level", "grant"] as const)(
  "cleared %s overlays retain revision while respecting later legacy source changes",
  (owner) => {
    const level = create();
    addFilter(level.id);
    const linked = grant(level.id);
    const summary = loadAccessLevelSummary(db, level.id, NOW)!;
    const result = updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: summary.revision,
        expectedFilterRevisions: { direct: 1 },
        rules: [
          {
            capability: "direct",
            sources: { mode: "all", sourceIds: [] },
            filterRevision: 1,
            scopePolicies: [],
          },
        ],
        actorTokenId: "owner",
      },
      NOW + 2,
    );
    expect(result.ok).toBe(true);
    const id = owner === "level" ? level.id : linked.id;
    db.prepare(
      `UPDATE access_${owner}_capabilities SET source_mode='denylist',source_ids='["chat:two"]' WHERE ${owner}_id=?`,
    ).run(id);
    reconcileLegacyScopeBoundaries(db);
    const caps = owner === "level" ? getLevelCapabilities(db, id) : getGrantCapabilities(db, id);
    expect(caps[0]).toMatchObject({
      sourceMode: "denylist",
      sourceIds: ["chat:two"],
      filterRevision: 2,
      scopePolicies: [],
    });
    if (owner === "level")
      expect(loadAccessLevelSummary(db, id, NOW)!.rules[0]).toMatchObject({
        sources: { mode: "denylist", sourceIds: ["chat:two"] },
        filterRevision: 2,
        scopePolicies: [],
      });
  },
);

test("OAuth token resolution honors legacy narrowing after a filter is cleared", () => {
  const level = create();
  addFilter(level.id);
  const linked = grant(level.id);
  const summary = loadAccessLevelSummary(db, level.id, NOW)!;
  expect(
    updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: summary.revision,
        expectedFilterRevisions: { direct: 1 },
        rules: [
          {
            capability: "direct",
            sources: { mode: "all", sourceIds: [] },
            filterRevision: 1,
            scopePolicies: [],
          },
        ],
        actorTokenId: "owner",
      },
      NOW + 2,
    ).ok,
  ).toBe(true);
  db.prepare(
    "UPDATE access_grant_capabilities SET source_mode='denylist',source_ids='[\"chat:two\"]' WHERE grant_id=?",
  ).run(linked.id);
  db.prepare(
    `INSERT INTO principal_credentials(id,grant_id,oauth_client_id,kind,status,label,created_at) VALUES('cleared-credential',?,'fictional-client','interactive','active','Cleared fixture',?)`,
  ).run(linked.id, NOW);
  db.prepare(
    `INSERT INTO oauth_access_tokens(id,credential_id,token_hash,audience,scope,grant_revision,created_at,expires_at) SELECT 'cleared-token','cleared-credential',?,'https://example.com/mcp','omnesis:access',revision,?,? FROM access_grants WHERE id=?`,
  ).run(hashSecret("fictional-cleared-token"), NOW, NOW + 10000, linked.id);
  expect(
    lookupPrincipalAccessToken(db, "fictional-cleared-token", "https://example.com/mcp", NOW + 3)
      ?.capabilities[0],
  ).toMatchObject({
    sourceMode: "denylist",
    sourceIds: ["chat:two"],
    filterRevision: 2,
    scopePolicies: [],
  });
});
