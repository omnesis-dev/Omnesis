// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopeDescriptorsSchema, upsertSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import { applySourceScopeUpdates } from "./scope-updates.js";
import { drainNativeScopeReprojections } from "./scope-native-reprojection.js";
import {
  applyConversationScopeUpdates,
  drainConversationScopeRebuilds,
} from "./scope-conversations.js";
import { sourceScopeInclusionSql, scopePolicyKnownSql } from "./scope-sql.js";
import type {
  DocumentMetadata,
  PersonMention,
  ScopePolicy,
  SourceScopeConversationUpdate,
  SourceScopes,
} from "@omnesis/types";

const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
    { kind: "participant", identifiers: ["phone", "email"], link: "changes" },
  ],
  legacyProjection: {
    conversationIdPath: ["extra", "conversationId"],
    participants: {
      roles: ["participant"],
      membership: "conversation",
      snapshotPath: ["extra", "scopeConversation"],
    },
  },
};
const maya: PersonMention = { role: "participant", phones: ["+12025550101"] };
const jamie: PersonMention = { role: "participant", phones: ["+12025550102"] };
const opaque: PersonMention = { role: "participant", lids: ["whatsapp:scope-opaque"] };
const mapped: PersonMention = { ...opaque, phones: maya.phones };
const context = {
  sourceId: "chat:one",
  providerId: "chat",
  streamId: "",
  writeEpoch: 1,
  snapshotAuthority: true,
};
const update = (
  sequence: number,
  participants: PersonMention[],
  epoch = "native-one",
): SourceScopeConversationUpdate => ({
  id: "cedar",
  participants,
  mode: "snapshot",
  observedAt: "2026-01-01T00:00:00.000Z",
  revision: { epoch, sequence },
});

describe("conversation scope membership", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,type TEXT,multi_device_mode TEXT);INSERT INTO sources VALUES('chat:one','chat','exclusive');
      CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,stream_id TEXT,external_id TEXT,metadata TEXT,updated_at TEXT);
      CREATE UNIQUE INDEX docs_external ON documents(provider_id,source_id,stream_id,external_id)`);
    createScopeDescriptorsSchema(db);
    upsertSourceScopes(db, [{ sourceType: "chat", scopes }], 1);
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES('chat:one','chat','{}',1)",
    ).run();
  });
  afterEach(() => db.close());
  function document(
    id: string,
    people: PersonMention[] | undefined,
    options: { streamId?: string; metadata?: DocumentMetadata; historical?: boolean } = {},
  ) {
    const metadata: DocumentMetadata = options.metadata ?? {
      documentType: "conversation",
      people,
      extra: { conversationId: "cedar" },
    };
    const streamId = options.streamId ?? "";
    db.prepare(
      "INSERT INTO documents VALUES(?, 'chat:one','chat',?,?,?, '2026-01-01') ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
    ).run(id, streamId, id, JSON.stringify(metadata));
    projectStoredDocumentScopes(
      db,
      {
        id,
        sourceId: "chat:one",
        providerId: "chat",
        streamId,
        externalId: id,
        metadata,
        historical: options.historical,
      },
      scopes,
    );
  }
  function policy(mode: "only" | "except" = "only"): ScopePolicy {
    return {
      sourceId: "chat:one",
      audience: { accessLevel: "level", capability: "direct" },
      rules: [
        {
          match: [
            {
              kind: "participant",
              label: "Maya",
              identifiers: [{ type: "phone", value: "+12025550101" }],
            },
          ],
          action: mode === "only" ? "share" : "hide",
        },
      ],
      otherwise: mode === "only" ? "hide" : "share",
    };
  }
  function visible(mode: "only" | "except" = "only") {
    const restriction = sourceScopeInclusionSql([policy(mode)], "d.id", "d.source_id");
    return db
      .prepare<string[], { id: string }>(
        `SELECT d.id FROM documents d WHERE ${restriction.sql} ORDER BY d.id`,
      )
      .all(...restriction.params)
      .map((row) => row.id);
  }
  function known() {
    const restriction = scopePolicyKnownSql(policy(), "d.id");
    return db
      .prepare<string[], { id: string }>(
        `SELECT d.id FROM documents d WHERE ${restriction.sql} ORDER BY d.id`,
      )
      .all(...restriction.params)
      .map((row) => row.id);
  }

  it("an unmapped legacy day revokes shared native authority until explicit roster refresh", () => {
    document("day-one", [maya]);
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES('chat:one','participant','current')",
    ).run();
    const snapshot = { ...update(1, [maya]), refreshEpoch: "current" };
    applyConversationScopeUpdates(db, context, [snapshot]);
    expect(visible()).toEqual(["day-one"]);
    db.prepare(
      "INSERT INTO documents VALUES('legacy-day','chat:one','chat','','legacy-day',?,'2026-01-02')",
    ).run(
      JSON.stringify({
        documentType: "conversation",
        extra: { conversationId: "cedar" },
        people: [jamie],
      }),
    );
    expect(known()).toEqual([]);
    expect(drainNativeScopeReprojections(db, 1)).toBe(1);
    expect(known()).toEqual([]);
    expect(
      db.prepare("SELECT * FROM scope_native_refresh_witnesses WHERE kind='participant'").all(),
    ).toEqual([]);
    applyConversationScopeUpdates(db, context, [snapshot]);
    expect(visible()).toEqual(["day-one", "legacy-day"]);
  });

  it("staged native rosters publish proof only after the last chunk, and legacy roster writes invalidate it", () => {
    document("day-one", [maya]);
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES('chat:one','participant','current')",
    ).run();
    const members = Array.from({ length: 150 }, (_, index) => ({
      role: "participant" as const,
      phones: [`+1555010${String(index).padStart(4, "0")}`],
    }));
    const snapshot = { ...update(1, members), refreshEpoch: "current" };
    applyConversationScopeUpdates(db, context, [snapshot]);
    expect(
      db.prepare("SELECT * FROM scope_native_refresh_witnesses WHERE kind='participant'").all(),
    ).toEqual([]);
    let rounds = 0;
    for (;;) {
      const result = drainConversationScopeRebuilds(db, context);
      expect(result.processed).toBeLessThanOrEqual(128);
      if (!result.pending) break;
      expect(known()).toEqual([]);
      if (++rounds > 20) throw new Error("Roster did not converge");
    }
    expect(known()).toEqual(["day-one"]);
    db.prepare(
      "UPDATE scope_conversation_members SET complete=0 WHERE member_key=(SELECT member_key FROM scope_conversation_members LIMIT 1)",
    ).run();
    expect(known()).toEqual([]);
    expect(
      db.prepare("SELECT * FROM scope_native_desired_witnesses WHERE kind='participant'").all(),
    ).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_publication_context").all()).toEqual([]);
  });

  it("uses historical native speaker union for every day without display-name matching", () => {
    document("day-one", [maya]);
    document("silent-day", [jamie, { role: "mentioned", emails: ["body-only@example.org"] }]);
    expect(visible()).toEqual(["day-one", "silent-day"]);
    document("day-one", [{ ...maya, name: "Changed display" }], { historical: true });
    expect(visible()).toEqual(["day-one", "silent-day"]);
    expect(visible("except")).toEqual([]);
  });
  it("hides both modes for an unresolved participant and resolves native LID-to-phone without aliases", () => {
    document("day-one", [opaque]);
    document("silent-day", [jamie]);
    expect(visible()).toEqual([]);
    expect(visible("except")).toEqual([]);
    expect(known()).toEqual([]);
    document("mapping-day", [mapped]);
    expect(visible()).toEqual(["day-one", "mapping-day", "silent-day"]);
    document("day-one", [opaque], { historical: true });
    expect(visible()).toHaveLength(3);
  });
  it("treats conflicting native opaque mappings as unknown, never choosing a merged contact", () => {
    document("one", [mapped]);
    document("two", [{ ...opaque, phones: jamie.phones }]);
    expect(known()).toEqual([]);
    expect(visible("except")).toEqual([]);
    document("one", [mapped], { historical: true });
    expect(known()).toEqual([]);
  });
  it("uses current silent roster members and removes departed historical speakers", () => {
    document("day-one", [maya]);
    document("silent-day", [jamie]);
    applyConversationScopeUpdates(db, context, [update(1, [jamie])]);
    expect(visible()).toEqual([]);
    expect(visible("except")).toEqual(["day-one", "silent-day"]);
    applyConversationScopeUpdates(db, context, [update(2, [maya, jamie])]);
    expect(visible()).toEqual(["day-one", "silent-day"]);
    applyConversationScopeUpdates(db, context, [update(3, [jamie])]);
    document("day-one", [maya], { historical: true });
    expect(visible()).toEqual([]);
    expect(visible("except")).toEqual(["day-one", "silent-day"]);
  });
  it("ignores stale causal replay, hides equal conflicts and never orders competing replicas by clocks", () => {
    document("day", [jamie]);
    applyConversationScopeUpdates(db, context, [update(2, [jamie])]);
    applyConversationScopeUpdates(db, context, [update(1, [maya])]);
    expect(visible()).toEqual([]);
    expect(known()).toEqual(["day"]);
    applyConversationScopeUpdates(db, context, [update(2, [maya])]);
    expect(known()).toEqual([]);
    applyConversationScopeUpdates(db, context, [update(3, [jamie])]);
    expect(known()).toEqual(["day"]);
    applyConversationScopeUpdates(db, context, [
      { ...update(900, [maya], "competing-native"), observedAt: "2099-01-01T00:00:00.000Z" },
    ]);
    expect(known()).toEqual([]);
    expect(visible()).toEqual([]);
    applyConversationScopeUpdates(db, { ...context, writeEpoch: 2 }, [
      update(1, [jamie], "new-owner-native"),
    ]);
    expect(known()).toEqual(["day"]);
    applyConversationScopeUpdates(db, context, [update(1000, [maya], "native-one")]);
    expect(known()).toEqual(["day"]);
    expect(visible()).toEqual([]);
  });
  it("threads verified actor authority through metadata updates and compares epochs per lease holder", () => {
    document("day", [jamie]);
    applySourceScopeUpdates(
      db,
      { ...context, authorityId: "holder-a", writeEpoch: 100 },
      { conversations: [update(20, [maya], "holder-a-native")] },
    );
    expect(visible()).toEqual(["day"]);
    applySourceScopeUpdates(
      db,
      { ...context, authorityId: "holder-b", writeEpoch: 1 },
      { conversations: [update(1, [jamie], "holder-b-native")] },
    );
    expect(visible()).toEqual([]);
    expect(known()).toEqual(["day"]);
    applySourceScopeUpdates(
      db,
      { ...context, authorityId: "holder-a", writeEpoch: 200, snapshotAuthority: false },
      { conversations: [update(1000, [maya], "holder-a-native")] },
    );
    expect(visible()).toEqual([]);
    expect(known()).toEqual(["day"]);
    expect(db.prepare("SELECT authority_id,write_epoch FROM scope_conversations").get()).toEqual({
      authority_id: "holder-b",
      write_epoch: 1,
    });
  });

  it("requires verified snapshot authority and keeps missing or unresolved native facts hidden", () => {
    document("one", [maya]);
    document("missing", undefined);
    expect(known()).toEqual([]);
    applyConversationScopeUpdates(db, { ...context, snapshotAuthority: false }, [
      update(1, [maya]),
    ]);
    expect(known()).toEqual([]);
    applyConversationScopeUpdates(db, context, [update(2, [opaque])]);
    expect(known()).toEqual([]);
    applyConversationScopeUpdates(db, context, [update(3, [mapped])]);
    expect(visible()).toEqual(["missing", "one"]);
  });
  it("isolates the same native conversation ID across streams and attachments follow the parent", () => {
    document("allowed", [maya]);
    document("other-stream", [jamie], { streamId: "phone-two" });
    document("attachment", undefined, {
      metadata: { documentType: "file", people: [jamie], extra: { parentExternalId: "allowed" } },
    });
    expect(visible()).toEqual(["allowed", "attachment"]);
    expect(visible("except")).toEqual(["other-stream"]);
    db.prepare("DELETE FROM documents WHERE id='allowed'").run();
    expect(visible()).toEqual([]);
  });
  it("an old collector cannot leave an authoritative roster current after new unproven membership arrives", () => {
    document("one", [jamie]);
    applyConversationScopeUpdates(db, context, [update(1, [jamie])]);
    document("old-collector-day", [jamie]);
    expect(known()).toEqual([]);
    applyConversationScopeUpdates(db, context, [update(2, [jamie])]);
    expect(known()).toEqual(["old-collector-day", "one"]);
  });
  it("resumes large snapshots within identifier budgets and stays unknown until publication", () => {
    document("day", [maya]);
    const roster: PersonMention[] = Array.from({ length: 300 }, (_, index) => ({
      role: "participant",
      emails: [`member${index}@example.org`],
    }));
    applyConversationScopeUpdates(db, context, [update(1, roster)]);
    expect(known()).toEqual([]);
    const first = drainConversationScopeRebuilds(db, context, 128);
    expect(first.pending).toBe(true);
    expect(first.processed).toBeGreaterThan(0);
    expect(first.processed).toBeLessThanOrEqual(128);
    let rounds = 0;
    let pending = true;
    while (pending && rounds < 30) {
      expect(known()).toEqual([]);
      const result = drainConversationScopeRebuilds(db, context, 128);
      expect(result.processed).toBeGreaterThan(0);
      expect(result.processed).toBeLessThanOrEqual(128);
      pending = result.pending;
      rounds += 1;
    }
    expect(pending).toBe(false);
    expect(known()).toEqual(["day"]);
    applyConversationScopeUpdates(db, context, [update(2, [maya])]);
    expect(known()).toEqual([]);
    pending = true;
    rounds = 0;
    while (pending && rounds < 30) {
      const result = drainConversationScopeRebuilds(db, context, 128);
      expect(result.processed).toBeGreaterThan(0);
      expect(result.processed).toBeLessThanOrEqual(128);
      pending = result.pending;
      rounds += 1;
    }
    expect(pending).toBe(false);
    expect(visible()).toEqual(["day"]);
  });
});
