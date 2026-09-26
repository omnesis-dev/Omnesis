// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test } from "vitest";

import { createDevice, revokeDevice } from "../data/repositories/DeviceRepository.js";
import { createToken, DeviceKindScopeError } from "../data/repositories/TokenRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import { currentDeviceAnswerOwner, resolveDeviceAnswerScope } from "./device-answer-scope.js";
import {
  createAccessLevel,
  deleteAccessLevel,
  listAccessOverview,
  setDeviceLevel,
  updateAccessLevel,
} from "./store.js";
import type { Scope } from "@omnesis/types";
import type { Db } from "../data/types.js";
import type { AccessGrantRuleInput } from "./types.js";

const NOW = 1_800_000_000_000;
const ACTOR = "portal-token";
const DIRECT_RULES: AccessGrantRuleInput[] = [
  { capability: "direct", sources: { mode: "all", sourceIds: [] } },
];
const ANSWER_RULES: AccessGrantRuleInput[] = [
  {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    release: { mode: "reviewed", policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
  },
];

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  commitPrivacyPolicy(db, {
    policy: "# Test policy\n\nAllow fictional summaries.\n",
    digest: "a".repeat(64),
    revision: "b".repeat(64),
    expectedRevision: null,
    action: "bootstrap",
    revertedFromGeneration: null,
    createdAt: NOW - 1,
  });
  const host = createDevice(db, { name: "notes-host", kind: "collector" }).id;
  createToken(db, host, ["read", "write:*"] as Scope[], "initial");
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
     VALUES ('src-notes', 'notes', 'fictional', ?, 1, 1)`,
  ).run(host);
});

function level(name: string, rules: AccessGrantRuleInput[]) {
  const created = createAccessLevel(db, { name, rules, actorTokenId: ACTOR }, NOW);
  if (!created.ok) throw new Error(`level not created: ${created.error}`);
  return created.value;
}

/** An integration holding one answer token. */
function device(name: string, scopes: string[] = ["answer"]) {
  const id = createDevice(db, { name, kind: "integration" }).id;
  createToken(db, id, scopes as Scope[], "initial");
  return id;
}

function put(deviceId: string, levelId: string | null, expectedLevelRevision?: number) {
  return setDeviceLevel(
    db,
    {
      deviceId,
      levelId,
      actorTokenId: ACTOR,
      ...(expectedLevelRevision === undefined ? {} : { expectedLevelRevision }),
    },
    NOW + 10,
  );
}

function auditDetails(eventType: string): Record<string, unknown>[] {
  return db
    .prepare<[string], { detail: string }>(
      "SELECT detail FROM access_audit_events WHERE event_type = ? ORDER BY occurred_at, id",
    )
    .all(eventType)
    .map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

describe("putting a device on a level", () => {
  test("puts it on, takes it off, and audits each change once", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");

    expect(put(id, answers.id)).toMatchObject({
      ok: true,
      value: {
        deviceId: id,
        level: { id: answers.id, devices: [{ id, name: "voice-desk", kind: "integration" }] },
      },
    });
    expect(put(id, answers.id)).toMatchObject({ ok: true });
    expect(put(id, null)).toEqual({ ok: true, value: { deviceId: id, level: null } });

    const audited = auditDetails("device-level-changed");
    expect(audited).toHaveLength(2);
    expect(audited).toEqual(
      expect.arrayContaining([
        { deviceId: id, deviceName: "voice-desk", levelId: answers.id, previousLevelId: null },
        { deviceId: id, deviceName: "voice-desk", levelId: null, previousLevelId: answers.id },
      ]),
    );
  });

  test("refuses a level that cannot answer, a stale or missing level, and a missing device", () => {
    const reading = level("Reading only", DIRECT_RULES);
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");

    expect(put(id, reading.id)).toEqual({ ok: false, error: "invalid-selection" });
    expect(put(id, answers.id, 7)).toEqual({ ok: false, error: "stale-revision" });
    expect(put(id, "00000000-0000-4000-8000-00000000abcd")).toEqual({
      ok: false,
      error: "inactive-grant",
    });
    expect(put("00000000-0000-4000-8000-00000000dcba", answers.id)).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(auditDetails("device-level-changed")).toEqual([]);
  });

  test("only an integration can be put on one", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const own = createDevice(db, { name: "own-cli", kind: "cli" }).id;
    createToken(db, own, ["answer"] as Scope[], "initial");
    expect(put(own, answers.id)).toEqual({ ok: false, error: "device-not-integration" });
    expect(put(device("voice-desk"), answers.id)).toMatchObject({ ok: true });
  });

  test("an integration is never given a token that reads around its level", () => {
    const id = device("voice-desk");
    for (const scopes of [["admin"], ["read"], ["answer", "read:bulk"], ["subscriptions:answer"]]) {
      expect(() => createToken(db, id as never, scopes as Scope[], "wide")).toThrow(
        DeviceKindScopeError,
      );
    }
    expect(() =>
      createToken(db, id as never, ["answer", "push:claim", "write:notes"] as Scope[], "second"),
    ).not.toThrow();
  });

  test("a revoked device can be taken off its level but not put on one", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");
    expect(put(id, answers.id)).toMatchObject({ ok: true });
    revokeDevice(db, id as never);

    expect(put(id, answers.id)).toEqual({ ok: false, error: "not-found" });
    expect(put(id, null)).toEqual({ ok: true, value: { deviceId: id, level: null } });
  });
});

describe("a level with devices on it", () => {
  test("cannot be deleted while a live device uses it; a revoked device does not hold it", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");
    put(id, answers.id);

    expect(deleteAccessLevel(db, { levelId: answers.id, actorTokenId: ACTOR }, NOW + 20)).toEqual({
      ok: false,
      error: "level-in-use",
    });
    revokeDevice(db, id as never);
    expect(deleteAccessLevel(db, { levelId: answers.id, actorTokenId: ACTOR }, NOW + 30)).toEqual({
      ok: true,
      value: null,
    });
    // The revoked device keeps the reference, and answers nothing through it.
    expect(resolveDeviceAnswerScope(db, id, "token-1")).toEqual({
      kind: "unavailable",
      levelId: answers.id,
    });
  });

  test("cannot lose Answer while a device uses it, but can take any other edit", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    put(device("voice-desk"), answers.id);

    expect(
      updateAccessLevel(
        db,
        { levelId: answers.id, expectedRevision: 1, rules: DIRECT_RULES, actorTokenId: ACTOR },
        NOW + 20,
      ),
    ).toEqual({ ok: false, error: "level-in-use" });

    const narrowed: AccessGrantRuleInput[] = [
      { ...ANSWER_RULES[0]!, sources: { mode: "allowlist", sourceIds: ["src-notes"] } },
    ];
    expect(
      updateAccessLevel(
        db,
        { levelId: answers.id, expectedRevision: 1, rules: narrowed, actorTokenId: ACTOR },
        NOW + 30,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2, rules: narrowed } });
  });

  test("the overview lists each level's live devices by name", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const quiet = level("Quiet answers", ANSWER_RULES);
    const zulu = device("zulu-speaker");
    const alpha = device("alpha-speaker");
    const gone = device("gone-speaker");
    put(zulu, answers.id);
    put(alpha, answers.id);
    put(gone, answers.id);
    revokeDevice(db, gone as never);

    const levels = listAccessOverview(db, NOW + 40).levels;
    expect(levels.find((entry) => entry.id === answers.id)?.devices).toEqual([
      { id: alpha, name: "alpha-speaker", kind: "integration" },
      { id: zulu, name: "zulu-speaker", kind: "integration" },
    ]);
    expect(levels.find((entry) => entry.id === quiet.id)?.devices).toEqual([]);
  });
});

describe("resolving what a device is answered from", () => {
  test("the operator's own devices answer under the default", () => {
    const own = createDevice(db, { name: "own-cli", kind: "cli" }).id;
    expect(resolveDeviceAnswerScope(db, own, "token-1")).toEqual({ kind: "default" });
  });

  test("an integration on no level is answered nothing", () => {
    const id = device("voice-desk");
    expect(resolveDeviceAnswerScope(db, id, "token-1")).toEqual({ kind: "unassigned" });
    expect(currentDeviceAnswerOwner(db, id, "token-1")).toBeNull();
  });

  test("a device on a level answers under that level's Answer rule, read fresh", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");
    put(id, answers.id);

    const wide = resolveDeviceAnswerScope(db, id, "token-1");
    expect(wide).toMatchObject({ kind: "level", levelId: answers.id });
    if (wide.kind !== "level") throw new Error("unreachable");
    expect(wide.authorization).toMatchObject({
      capability: "answer",
      releaseMode: "reviewed",
      policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
      policyRevision: "b".repeat(64),
      restricted: false,
      accessTokenId: "token-1",
    });

    updateAccessLevel(
      db,
      {
        levelId: answers.id,
        expectedRevision: 1,
        rules: [{ ...ANSWER_RULES[0]!, sources: { mode: "allowlist", sourceIds: ["src-notes"] } }],
        actorTokenId: ACTOR,
      },
      NOW + 20,
    );
    const narrow = resolveDeviceAnswerScope(db, id, "token-1");
    if (narrow.kind !== "level") throw new Error("expected a level scope");
    expect(narrow.authorization.restricted).toBe(true);
    expect(narrow.authorization.allowsSource("src-notes")).toBe(true);
    expect(narrow.authorization.allowsSource("src-mail")).toBe(false);
    expect(narrow.authorization.digest).not.toBe(wide.authorization.digest);
  });

  test("an unreviewed level answers without a policy", () => {
    const open = level("Open answers", [
      {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        release: { mode: "unreviewed" },
      },
    ]);
    const id = device("voice-desk");
    put(id, open.id);
    const scope = resolveDeviceAnswerScope(db, id, "token-1");
    expect(scope).toMatchObject({
      kind: "level",
      authorization: { releaseMode: "unreviewed", policyFamilyId: null },
    });
  });

  test("a level whose privacy policy is gone can no longer answer", () => {
    const answers = level("Voice answers", ANSWER_RULES);
    const id = device("voice-desk");
    put(id, answers.id);
    db.prepare("UPDATE privacy_policy_families SET archived_at = ? WHERE id = ?").run(
      NOW + 20,
      DEFAULT_PRIVACY_POLICY_FAMILY_ID,
    );
    expect(resolveDeviceAnswerScope(db, id, "token-1")).toEqual({
      kind: "unavailable",
      levelId: answers.id,
    });
  });
});

describe("rules that can read nothing", () => {
  const rulesFor = (sources: AccessGrantRuleInput["sources"]): AccessGrantRuleInput[] => [
    { capability: "direct", sources },
  ];

  test("a read rule that names every connected source away is refused", () => {
    const create = (name: string, sources: AccessGrantRuleInput["sources"]) =>
      createAccessLevel(db, { name, rules: rulesFor(sources), actorTokenId: ACTOR }, NOW);
    expect(create("Everything denied", { mode: "denylist", sourceIds: ["src-notes"] })).toEqual({
      ok: false,
      error: "invalid-selection",
    });
    expect(create("One allowed", { mode: "allowlist", sourceIds: ["src-notes"] }).ok).toBe(true);
    expect(create("All sources", { mode: "all", sourceIds: [] }).ok).toBe(true);
  });

  test("with no source connected, a rule that admits every source is still kept", () => {
    db.prepare("DELETE FROM sources").run();
    expect(
      createAccessLevel(
        db,
        {
          name: "Future only",
          rules: rulesFor({ mode: "all", sourceIds: [] }),
          actorTokenId: ACTOR,
        },
        NOW,
      ).ok,
    ).toBe(true);
  });
});
