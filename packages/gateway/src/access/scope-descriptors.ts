// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";
import { PERSON_ROLES, type SourceScopes } from "@omnesis/types";
import { createScopeFactsSchema } from "./scope-schema.js";
import type { Db } from "../data/types.js";

const text = z.string().min(1).max(512);
const entityItem = z.strictObject({
  kind: z.enum(["conversation", "label", "folder"]),
  noun: z.strictObject({ one: text, many: text }),
  picker: z.enum(["search", "tree"]),
  link: z.enum(["fixed", "changes", "hierarchy"]),
  liveSearch: z.boolean().optional(),
  keep: z.literal("before-cache").optional(),
});
export const sourceScopesSchema = z.strictObject({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  items: z
    .array(
      z.union([
        entityItem,
        z.strictObject({
          kind: z.literal("participant"),
          identifiers: z
            .array(z.enum(["phone", "email", "domain"]))
            .min(1)
            .max(3),
          link: z.enum(["fixed", "changes"]),
        }),
      ]),
    )
    .min(1)
    .max(4)
    .refine((items) => new Set(items.map((item) => item.kind)).size === items.length),
  legacyProjection: z
    .strictObject({
      conversationIdPath: z
        .array(text.refine((value) => !["__proto__", "constructor", "prototype"].includes(value)))
        .min(1)
        .max(8)
        .optional(),
      conversationLabelPath: z
        .array(text.refine((value) => !["__proto__", "constructor", "prototype"].includes(value)))
        .min(1)
        .max(8)
        .optional(),
      participants: z
        .strictObject({
          roles: z
            .array(z.enum(PERSON_ROLES).exclude(["mentioned"]))
            .min(1)
            .max(PERSON_ROLES.length),
          membership: z.enum(["document", "conversation"]),
          maxPeople: z.number().int().positive().optional(),
          snapshotPath: z
            .array(
              text.refine((value) => !["__proto__", "constructor", "prototype"].includes(value)),
            )
            .min(1)
            .max(8)
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface SourceScopesEntry {
  sourceType: string;
  scopes: SourceScopes;
}

export function createScopeDescriptorsSchema(db: Db): void {
  createScopeFactsSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS source_scope_descriptors (
    source_type TEXT PRIMARY KEY,
    scopes_json TEXT NOT NULL,
    published_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_scope_descriptor_conflicts (
    source_type TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`);
}

/** Display wording does not alter authorization; projection recipes and identifiers do. */
function scopeMeaning(scopes: SourceScopes): string {
  const projection = scopes.legacyProjection;
  return JSON.stringify({
    items: scopes.items
      .map((item) => ({
        kind: item.kind,
        link: item.link,
        ...(item.kind === "participant"
          ? { identifiers: [...new Set(item.identifiers)].sort() }
          : {}),
      }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
    ...(projection
      ? {
          projection: {
            conversationIdPath: projection.conversationIdPath,
            ...(projection.participants
              ? {
                  participants: {
                    roles: [...new Set(projection.participants.roles)].sort(),
                    membership: projection.participants.membership,
                    maxPeople: projection.participants.maxPeople,
                    snapshotPath: projection.participants.snapshotPath,
                  },
                }
              : {}),
          },
        }
      : {}),
  });
}

/** Merge source types: a collector cannot erase a sibling's platform-only sources. */
export function upsertSourceScopes(
  db: Db,
  entries: readonly SourceScopesEntry[],
  publishedAt: number,
): { stored: number } {
  const seen = new Set<string>();
  const parsed = entries.map((entry) => {
    if (seen.has(entry.sourceType)) throw new Error("Duplicate scope source type.");
    seen.add(entry.sourceType);
    return {
      sourceType: text.parse(entry.sourceType),
      scopes: sourceScopesSchema.parse(entry.scopes),
    };
  });
  const insert = db.prepare(`INSERT INTO source_scope_descriptors VALUES (?, ?, ?)
    ON CONFLICT(source_type) DO UPDATE SET scopes_json = excluded.scopes_json,
      published_at = excluded.published_at`);
  let written = 0;
  db.transaction(() => {
    for (const entry of parsed) {
      const conflict = db
        .prepare<[string], { revision: number }>(
          "SELECT revision FROM source_scope_descriptor_conflicts WHERE source_type=?",
        )
        .get(entry.sourceType);
      if (conflict && (entry.scopes.revision ?? 1) <= conflict.revision) continue;
      const stored = db
        .prepare<[string], { scopes_json: string }>(
          "SELECT scopes_json FROM source_scope_descriptors WHERE source_type = ?",
        )
        .get(entry.sourceType);
      if (stored) {
        let previous: unknown;
        try {
          previous = JSON.parse(stored.scopes_json);
        } catch {
          previous = null;
        }
        const revision =
          previous && typeof previous === "object" && "revision" in previous
            ? previous.revision
            : 1;
        const validRevision =
          typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;
        const parsedPrevious = sourceScopesSchema.safeParse(previous);
        const readable = parsedPrevious.success;
        if (
          parsedPrevious.success &&
          validRevision &&
          revision >= 2 &&
          revision === (entry.scopes.revision ?? 1) &&
          scopeMeaning(parsedPrevious.data) !== scopeMeaning(entry.scopes)
        ) {
          db.prepare(
            "INSERT INTO source_scope_descriptor_conflicts VALUES (?,?) ON CONFLICT(source_type) DO UPDATE SET revision=excluded.revision",
          ).run(entry.sourceType, revision);
          db.prepare("UPDATE scope_fact_backfill SET ready=0 WHERE source_type=? AND ready<>0").run(
            entry.sourceType,
          );
          continue;
        }
        // Unknown future contracts cannot be silently replaced by older code.
        if (!readable)
          db.prepare("UPDATE scope_fact_backfill SET ready=0 WHERE source_type=? AND ready<>0").run(
            entry.sourceType,
          );
        if (
          !validRevision ||
          (entry.scopes.revision ?? 1) < revision ||
          (!readable && (entry.scopes.revision ?? 1) <= revision)
        )
          continue;
      }
      db.prepare("DELETE FROM source_scope_descriptor_conflicts WHERE source_type=?").run(
        entry.sourceType,
      );
      const serialized = JSON.stringify(entry.scopes);
      // A declaration's meaning changed: old completeness cannot authorize a
      // filtered source until the bounded backfill has visited every document.
      db.prepare(
        `UPDATE scope_fact_backfill SET descriptor_json = ?, cursor_rowid = 0,
        processed = 0, ready = 0 WHERE source_type = ? AND descriptor_json <> ?`,
      ).run(serialized, entry.sourceType, serialized);
      db.prepare(
        `UPDATE source_scope_kind_readiness SET ready = 0 WHERE source_id IN
        (SELECT source_id FROM scope_fact_backfill WHERE source_type = ? AND ready = 0)`,
      ).run(entry.sourceType);
      insert.run(entry.sourceType, serialized, publishedAt);
      written++;
    }
  })();
  return { stored: written };
}

/** Unreadable declarations deny new policies; existing policies still enforce. */
export function getSourceScopes(db: Db, sourceType: string): SourceScopes | null {
  if (
    db
      .prepare("SELECT 1 FROM source_scope_descriptor_conflicts WHERE source_type=?")
      .get(sourceType)
  )
    return null;
  const row = db
    .prepare<[string], { scopes_json: string }>(
      "SELECT scopes_json FROM source_scope_descriptors WHERE source_type = ?",
    )
    .get(sourceType);
  if (!row) return null;
  try {
    const result = sourceScopesSchema.safeParse(JSON.parse(row.scopes_json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function listSourceScopes(db: Db): SourceScopesEntry[] {
  const rows = db
    .prepare<[], { source_type: string }>(
      "SELECT source_type FROM source_scope_descriptors ORDER BY source_type",
    )
    .all();
  return rows.flatMap((row) => {
    const scopes = getSourceScopes(db, row.source_type);
    return scopes ? [{ sourceType: row.source_type, scopes }] : [];
  });
}
