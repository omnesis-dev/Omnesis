// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { getNoteEntry } from "./storage.js";
import type Database from "better-sqlite3";

function hashId(parts: string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Stable across sign-ins, isolated from other connections and capture surfaces. */
export function scopedNoteId(principalId: string, captureId: string): string {
  return hashId(["mcp-note", principalId, captureId]);
}

/**
 * Preserve credential-scoped note IDs on upgrade. Historical active credentials
 * remain in the access ledger even after revocation. Resolve on the read handle;
 * the caller still appends through the audited writer boundary on every retry.
 */
export function resolveMcpNoteId(
  db: Database.Database,
  principalId: string,
  captureId: string,
): string {
  const canonicalId = scopedNoteId(principalId, captureId);
  if (getNoteEntry(db, canonicalId)) return canonicalId;
  const credentials = db
    .prepare<[string], { id: string }>(
      `SELECT c.id FROM principal_credentials c
       JOIN access_grants g ON g.id = c.grant_id
       WHERE g.principal_id = ? ORDER BY c.created_at, c.id`,
    )
    .all(principalId);
  for (const credential of credentials) {
    const legacyId = hashId(["mcp-note", principalId, credential.id, captureId]);
    const entry = getNoteEntry(db, legacyId);
    if (entry?.surface === "mcp" && entry.captureContext?.principalId === principalId) {
      return legacyId;
    }
  }
  return canonicalId;
}
