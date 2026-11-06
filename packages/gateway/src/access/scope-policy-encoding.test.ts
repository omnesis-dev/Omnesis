// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { scopePolicyV1Schema } from "./scope-policy.js";
import {
  encodeStoredScopePolicies,
  decodeStoredScopePolicies,
  upgradeScopePolicyEncodingV2,
} from "./scope-policy-encoding.js";
import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
  parseCorpusAuthorization,
} from "./corpus-authorization.js";
import { readScopeState, writeScopeState, createScopePolicyStore } from "./scope-policy-store.js";
import type { ScopePolicy } from "@omnesis/types";

const policy: ScopePolicy = {
  sourceId: "fictional:scope",
  audience: { accessLevel: "fictional-level", capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "conversation", id: "fictional-conversation" }] }],
  otherwise: "hide",
};
const authorization = createCorpusAuthorization(
  {
    principalId: "fictional-principal",
    grantId: "fictional-grant",
    grantRevision: 1,
    credentialId: "fictional-credential",
    accessTokenId: "fictional-token",
  },
  [
    {
      capability: "answer",
      sourceMode: "all",
      sourceIds: [],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
      filterRevision: 1,
      scopePolicies: [policy],
    },
  ],
  "answer",
)!;

test("storage markers reject partial older readers while preserving current canonical authority and digest", () => {
  const encoded = encodeStoredScopePolicies([policy]);
  expect(encoded[0]?.minimumProtocol).toBe(2);
  // The partial older implementation applies this exact strict public schema to stored rows.
  expect(scopePolicyV1Schema.safeParse(encoded[0]).success).toBe(false);
  expect(decodeStoredScopePolicies(encoded)).toEqual([policy]);
  const wire = JSON.parse(serializeCorpusAuthorization(authorization));
  expect(scopePolicyV1Schema.safeParse(wire.scopePolicies[0]).success).toBe(false);
  const restored = parseCorpusAuthorization(JSON.stringify(wire));
  expect(restored.digest).toBe(authorization.digest);
  expect(restored.scopePolicies).toEqual(authorization.scopePolicies);
  expect(restored.allowsSource(policy.sourceId)).toBe(true);
  expect(wire.sourceIds).toContain(policy.sourceId);
  expect(wire.sourceMode).toBe("denylist");
});

test.each([1, 3, "2", null])(
  "unknown or invalid minimum storage protocol %j fails closed",
  (minimumProtocol) => {
    expect(() => decodeStoredScopePolicies([{ ...policy, minimumProtocol }])).toThrow(/protocol/);
  },
);

test("legacy unmarked snapshots remain readable without exposing protocol metadata in DTOs", () => {
  expect(decodeStoredScopePolicies([policy])).toEqual([policy]);
  const wire = JSON.parse(serializeCorpusAuthorization(authorization));
  delete wire.scopePolicies[0].minimumProtocol;
  expect(parseCorpusAuthorization(JSON.stringify(wire)).digest).toBe(authorization.digest);
  expect(scopePolicyV1Schema.safeParse(policy).success).toBe(true);
});

test("upgrade marks capability overlays without rewriting growing task history", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE access_scope_capabilities(owner_kind TEXT,owner_id TEXT,capability TEXT,source_mode TEXT,source_ids TEXT,filter_revision INTEGER,policies TEXT,PRIMARY KEY(owner_kind,owner_id,capability));
      CREATE TABLE answer_task_scope(task_id TEXT PRIMARY KEY,authorization TEXT)`);
    db.prepare(
      "INSERT INTO access_scope_capabilities VALUES('grant','fictional-grant','answer','all','[]',1,?)",
    ).run(JSON.stringify([policy]));
    const oldWire = JSON.parse(serializeCorpusAuthorization(authorization));
    delete oldWire.scopePolicies[0].minimumProtocol;
    db.prepare("INSERT INTO answer_task_scope VALUES('fictional-task',?)").run(
      JSON.stringify(oldWire),
    );
    upgradeScopePolicyEncodingV2(db);
    const raw = db
      .prepare<[], { policies: string }>("SELECT policies FROM access_scope_capabilities")
      .get()!;
    expect(scopePolicyV1Schema.safeParse(JSON.parse(raw.policies)[0]).success).toBe(false);
    expect(readScopeState(db, "grant", "fictional-grant", "answer")?.scopePolicies).toEqual([
      policy,
    ]);
    const snapshot = db
      .prepare<[], { authorization: string }>("SELECT authorization FROM answer_task_scope")
      .get()!;
    expect(snapshot.authorization).toBe(JSON.stringify(oldWire));
    expect(parseCorpusAuthorization(snapshot.authorization).digest).toBe(authorization.digest);
    db.exec(
      "CREATE TABLE access_grants(id TEXT PRIMARY KEY); CREATE TABLE access_levels(id TEXT PRIMARY KEY)",
    );
    createScopePolicyStore(db);
    writeScopeState(db, "grant", "fictional-grant", "answer", {
      sourceMode: "all",
      sourceIds: [],
      filterRevision: 1,
      scopePolicies: [policy],
    });
    expect(
      JSON.parse(
        db
          .prepare<[], { policies: string }>("SELECT policies FROM access_scope_capabilities")
          .get()!.policies,
      )[0].minimumProtocol,
    ).toBe(2);
    upgradeScopePolicyEncodingV2(db);
    expect(readScopeState(db, "grant", "fictional-grant", "answer")?.filterRevision).toBe(1);
  } finally {
    db.close();
  }
});

test("stored policy arrays obey the same aggregate V1 bound as current writer inputs", () => {
  const oversized = Array.from({ length: 257 }, (_, index) => ({
    ...policy,
    sourceId: `fictional:${index}`,
    minimumProtocol: 2,
  }));
  expect(() => decodeStoredScopePolicies(oversized)).toThrow();
  const wide = {
    ...policy,
    rules: [
      {
        action: "share",
        match: Array.from({ length: 256 }, (_, index) => ({
          kind: "label",
          id: `stable-${index}`,
        })),
      },
    ],
    otherwise: "hide",
    minimumProtocol: 2,
  };
  expect(() => decodeStoredScopePolicies([wide, { ...policy, minimumProtocol: 2 }])).toThrow(
    /bound/,
  );
  expect(decodeStoredScopePolicies([wide])).toHaveLength(1);
});
