// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { seedPackagedSourceScopes } from "./packaged-source-scopes.js";
import { getSourceScopes, upsertSourceScopes } from "./scope-descriptors.js";
import { backfillDocumentScopes } from "./scope-backfill.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import type { ScopePolicy } from "@omnesis/types";
import type Database from "better-sqlite3";

describe("packaged source scope contracts", () => {
  let directory: string;
  let db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omnesis-packaged-scopes-"));
    db = createDatabase(join(directory, "corpus.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("ships an exact generated projection of pure provider-owned declarations", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    expect(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/generate-source-scopes.mjs", "--check"],
        { cwd: root },
      ),
    ).not.toThrow();
  });

  it("backfills old conversation and email metadata without a collector publication", () => {
    db.exec(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES ('00000000-0000-4000-8000-000000000001','Legacy synthetic collector','collector',1)",
    );
    const cases: Array<{
      type: string;
      metadata: object;
      ref: ScopePolicy["rules"][number]["match"][number];
    }> = [
      {
        type: "whatsapp-messages",
        metadata: {
          documentType: "conversation",
          extra: { conversationId: "legacy-chat", chatName: "Fictional chat" },
        },
        ref: { kind: "conversation", id: "legacy-chat" },
      },
      {
        type: "apple-imessage",
        metadata: {
          documentType: "conversation",
          extra: { conversationId: "legacy-chat", chatName: "Fictional chat" },
        },
        ref: { kind: "conversation", id: "legacy-chat" },
      },
      {
        type: "gmail",
        metadata: {
          documentType: "email",
          people: [
            {
              id: "email:fictional@example.org",
              name: "Fictional sender",
              role: "sender",
              emails: ["fictional@example.org"],
            },
          ],
        },
        ref: {
          kind: "participant",
          label: "Fictional sender",
          identifiers: [{ type: "email", value: "fictional@example.org" }],
        },
      },
    ];
    for (const entry of cases) {
      db.prepare(
        `INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at)
        VALUES (?,?,'legacy','00000000-0000-4000-8000-000000000001',1,1)`,
      ).run(`${entry.type}:legacy`, entry.type);
      db.prepare(
        `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
        source_created_at,source_updated_at,ingested_at,updated_at) VALUES (?, 'fictional',?,'legacy','Fictional document','Invented content','hash',?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
      ).run(entry.type, `${entry.type}:legacy`, JSON.stringify(entry.metadata));
    }
    seedPackagedSourceScopes(db);
    for (let i = 0; i < 8; i++) backfillDocumentScopes(db, 10);
    for (const entry of cases) {
      const sourceId = `${entry.type}:legacy`;
      const policy: ScopePolicy = {
        sourceId,
        audience: { accessLevel: "level", capability: "direct" },
        rules: [{ action: "share", match: [entry.ref] }],
        otherwise: "hide",
      };
      const decision = sourceScopeInclusionSql([policy], "d.id", "d.source_id");
      expect(
        db
          .prepare(`SELECT d.id FROM documents d WHERE d.source_id=? AND (${decision.sql})`)
          .all(sourceId, ...decision.params),
      ).toEqual([{ id: entry.type }]);
    }
  });

  it("preserves an unreadable future contract and revokes old completeness on rollback", () => {
    seedPackagedSourceScopes(db);
    const future = {
      ...getSourceScopes(db, "whatsapp-messages"),
      revision: 3,
      futureMembership: "reserved",
    };
    db.prepare("UPDATE source_scope_descriptors SET scopes_json=? WHERE source_type=?").run(
      JSON.stringify(future),
      "whatsapp-messages",
    );
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES (?,?,?,1)",
    ).run("fictional:legacy", "whatsapp-messages", "{}");
    seedPackagedSourceScopes(db);
    expect(getSourceScopes(db, "whatsapp-messages")).toBeNull();
    expect(
      db.prepare("SELECT ready FROM scope_fact_backfill WHERE source_id=?").get("fictional:legacy"),
    ).toEqual({ ready: 0 });
    expect(
      db
        .prepare("SELECT scopes_json FROM source_scope_descriptors WHERE source_type=?")
        .get("whatsapp-messages"),
    ).toEqual({ scopes_json: JSON.stringify(future) });
  });

  it("keeps conflicting same-revision meanings unavailable until a newer declaration resolves them", () => {
    seedPackagedSourceScopes(db);
    const current = getSourceScopes(db, "whatsapp-messages")!;
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES (?,?,?,1)",
    ).run("fictional:legacy", "whatsapp-messages", "{}");
    upsertSourceScopes(
      db,
      [
        {
          sourceType: "whatsapp-messages",
          scopes: {
            ...current,
            legacyProjection: {
              ...current.legacyProjection,
              conversationIdPath: ["extra", "otherId"],
            },
          },
        },
      ],
      1,
    );
    expect(getSourceScopes(db, "whatsapp-messages")).toBeNull();
    expect(
      db.prepare("SELECT ready FROM scope_fact_backfill WHERE source_id=?").get("fictional:legacy"),
    ).toEqual({ ready: 0 });
    seedPackagedSourceScopes(db);
    expect(getSourceScopes(db, "whatsapp-messages")).toBeNull();
    upsertSourceScopes(
      db,
      [
        {
          sourceType: "whatsapp-messages",
          scopes: { ...current, revision: current.revision! + 1 },
        },
      ],
      2,
    );
    expect(getSourceScopes(db, "whatsapp-messages")?.revision).toBe(current.revision! + 1);
  });

  it("does not let an older collector replace a newer packaged declaration", () => {
    seedPackagedSourceScopes(db);
    const current = getSourceScopes(db, "whatsapp-messages")!;
    expect(current.revision).toBeGreaterThan(1);
    const older = {
      items: current.items,
      legacyProjection: { conversationIdPath: ["extra", "retiredConversationId"] },
    };
    upsertSourceScopes(db, [{ sourceType: "whatsapp-messages", scopes: older }], 1);
    expect(getSourceScopes(db, "whatsapp-messages")).toEqual(current);
    const newer = { ...current, revision: current.revision! + 1 };
    upsertSourceScopes(db, [{ sourceType: "whatsapp-messages", scopes: newer }], 2);
    seedPackagedSourceScopes(db);
    expect(getSourceScopes(db, "whatsapp-messages")).toEqual(newer);
  });
});
