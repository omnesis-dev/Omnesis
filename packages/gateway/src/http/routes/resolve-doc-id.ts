// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError, NotFoundError } from "../errors.js";
import { matchDocumentIdPrefix } from "../../data/like-prefix-seek.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export function resolveDocId(db: Db, idOrPrefix: string): string {
  const matches = matchDocumentIdPrefix(db, idOrPrefix);
  if (matches.length === 0) throw new NotFoundError(`Document not found: ${idOrPrefix}`);
  if (matches.length > 1) {
    throw new BadRequestError(`Ambiguous ID prefix: ${idOrPrefix}`, { matches });
  }
  return matches[0]!;
}

export function resolveSeeds(db: Db, firstId: string, extraIdsRaw: string): string[] {
  const extraIds = extraIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const rawId of [firstId, ...extraIds]) {
    const resolved = resolveDocId(db, rawId);
    if (seenIds.has(resolved)) continue;
    seenIds.add(resolved);
    seedIds.push(resolved);
  }
  return seedIds;
}

export function parseIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
