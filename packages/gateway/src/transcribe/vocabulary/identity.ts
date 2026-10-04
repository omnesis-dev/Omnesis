// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CONTACT_NAME_FLOOR } from "../../domain/PeopleResolutionService.js";
import { cleanVocabularyName } from "./names.js";
import type { Db } from "../../data/types.js";

/**
 * At most one curated name per requested identity. Read a fixed alias page
 * before filtering: even a pathological person's alias set cannot turn a
 * transcription request into an unbounded scan or sort. Names beyond this
 * page are deliberately omitted, never guessed from the display label.
 */
export function contextualVocabularyNames(
  db: Db,
  personIds: readonly string[],
  includeSelf: boolean,
): string[] {
  const ids = new Set<string>();
  if (includeSelf) {
    const self = db
      .prepare("SELECT id FROM people WHERE is_self=TRUE AND merged_into IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    if (self) ids.add(self.id);
  }
  for (const id of personIds.slice(0, 14)) ids.add(id);
  const merged = db.prepare(
    "SELECT id FROM people INDEXED BY idx_people_merged WHERE merged_into=? LIMIT 16",
  );
  const aliases = db.prepare(`SELECT page.alias, page.alias_type, page.occurrence_count,
    EXISTS(SELECT 1 FROM person_alias_assertions a
      WHERE a.alias_id=page.id AND a.source_id='config') AS configured
    FROM (SELECT id,substr(alias,1,81) AS alias,alias_type,occurrence_count
      FROM person_aliases INDEXED BY idx_person_aliases_person
      WHERE person_id=? LIMIT ?) page`);
  const result = new Set<string>();
  for (const id of [...ids].slice(0, 16)) {
    type AliasRow = {
      alias: string;
      alias_type: string;
      occurrence_count: number;
      configured: number;
    };
    const rows: AliasRow[] = [];
    // Merge membership is read live: an unmerge immediately withdraws that
    // person's identity hints without moving or copying their alias records.
    const members = [id, ...(merged.all(id) as Array<{ id: string }>).map((row) => row.id)];
    for (const member of members) {
      const remaining = 128 - rows.length;
      if (remaining <= 0) break;
      rows.push(...(aliases.all(member, remaining) as AliasRow[]));
    }
    const candidates = rows.flatMap((row) => {
      if (
        row.alias_type !== "name" ||
        (!row.configured && row.occurrence_count < CONTACT_NAME_FLOOR)
      )
        return [];
      const name = cleanVocabularyName(row.alias);
      return name ? [{ ...row, name }] : [];
    });
    candidates.sort(
      (a, b) =>
        b.configured - a.configured ||
        Number(b.name.includes(" ")) - Number(a.name.includes(" ")) ||
        b.occurrence_count - a.occurrence_count ||
        a.name.localeCompare(b.name),
    );
    if (candidates[0]) result.add(candidates[0].name);
  }
  return [...result];
}
