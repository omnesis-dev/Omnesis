// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Person references on open loops (`actors[]` / `involved[]`) — the
 * resolution boundary that keeps those fields canonical person ids.
 *
 * The Cognition Steward learns about people from document metadata, where they
 * appear as email addresses, so left unchecked it writes emails into the
 * person fields — values no person surface can link to. Every write path
 * funnels through {@link partitionPersonRefs}: a ref that is a known
 * person id is walked to its canonical merge root; a ref that looks like
 * an email is resolved through `person_aliases` (and then to the root);
 * anything else is dropped and reported back to the model instead of
 * being persisted as a dangling reference — the same contract the tool
 * layer already applies to `docs[]` and `blockedBy[]`.
 *
 * The read side ({@link displayPersonRefs}) applies the same resolution
 * so rows written before this boundary existed still render as people
 * where possible; a value that resolves to nothing keeps its raw string
 * with `name: null`, and the read surfaces render it as plain text
 * rather than a dead person link.
 */

import { normalizeEmail } from "@omnesis/core";
import { resolvePersonId } from "../domain/PeopleResolutionService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * Resolve one agent-supplied person ref to a canonical person id, or null
 * when it matches no known person. An existing person id is walked up its
 * `merged_into` chain; an email is normalized and matched against the
 * email aliases, accepting the resolution only when every owning alias
 * lands on the SAME canonical root (an ambiguous email — two distinct
 * people sharing it — resolves to nothing rather than guessing).
 */
export function resolveLoopPersonRef(db: Db, ref: string): string | null {
  const exists = db
    .prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?")
    .get(ref);
  if (exists) return resolvePersonId(db, ref);

  if (!ref.includes("@")) return null;
  const owners = db
    .prepare<
      [string],
      { person_id: string }
    >("SELECT person_id FROM person_aliases WHERE alias_type = 'email' AND alias = ?")
    .all(normalizeEmail(ref));
  if (owners.length === 0) return null;
  const canonicals = new Set(owners.map((o) => resolvePersonId(db, o.person_id)));
  if (canonicals.size !== 1) return null;
  return canonicals.values().next().value ?? null;
}

/**
 * Split agent-supplied person refs into resolved canonical ids (deduped,
 * order-preserving) and the raw values that matched no known person.
 */
export function partitionPersonRefs(
  db: Db,
  refs: readonly string[],
): { known: string[]; dropped: string[] } {
  const known: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const ref of refs) {
    const id = resolveLoopPersonRef(db, ref);
    if (id === null) {
      dropped.push(ref);
    } else if (!seen.has(id)) {
      seen.add(id);
      known.push(id);
    }
  }
  return { known, dropped };
}

/**
 * A person ref enriched for loop-detail and operator debug read surfaces.
 */
export interface PersonRef {
  /** Canonical person id when resolvable, else the raw stored value. */
  id: string;
  /** The person's canonical name; null when the ref matches no person. */
  name: string | null;
}

/**
 * Enrich stored person refs to `{ id, name }` for the read surfaces
 * (product loop detail + operator debug), applying the same resolution
 * as the write boundary so legacy rows written before it existed still
 * display as people. Order follows the input; an unresolvable value
 * keeps its raw string with `name: null`.
 */
export function displayPersonRefs(db: Db, refs: readonly string[]): PersonRef[] {
  const nameStmt = db.prepare<[string], { canonical_name: string }>(
    "SELECT canonical_name FROM people WHERE id = ?",
  );
  return refs.map((ref) => {
    const id = resolveLoopPersonRef(db, ref);
    if (id === null) return { id: ref, name: null };
    return { id, name: nameStmt.get(id)?.canonical_name ?? null };
  });
}

/** The write-gate slice the normalization sweep drives. */
export interface PersonRefSweepWriteOps {
  rewriteOpenLoopPeople(
    id: string,
    actors: readonly string[],
    involved: readonly string[],
  ): Promise<boolean>;
}

/**
 * One idempotent pass over every open-loop row (any state), re-resolving
 * its person refs and rewriting the rows whose stored values are not
 * already canonical person ids — the self-heal for loops written before
 * the write boundary existed. Values that resolve to nothing are LEFT IN
 * PLACE (the read surface renders them as plain text): dropping them here
 * would silently destroy the agent's record of who a loop concerns.
 * Rewrites go through the dedicated `rewriteOpenLoopPeople` op, which
 * deliberately does NOT bump `last_update` or reset decay bookkeeping —
 * this is data hygiene, not agent activity.
 */
export async function normalizeOpenLoopPersonRefs(deps: {
  db: Db;
  writeGate: PersonRefSweepWriteOps;
  log: { info(msg: string): void };
}): Promise<number> {
  const rows = deps.db
    .prepare<
      [],
      { id: string; actors_json: string; involved_json: string }
    >("SELECT id, actors_json, involved_json FROM open_loops")
    .all();
  let rewritten = 0;
  for (const row of rows) {
    const actors = JSON.parse(row.actors_json) as string[];
    const involved = JSON.parse(row.involved_json) as string[];
    const fix = (refs: string[]): { values: string[]; changed: boolean } => {
      const out: string[] = [];
      const seen = new Set<string>();
      let changed = false;
      for (const ref of refs) {
        const id = resolveLoopPersonRef(deps.db, ref) ?? ref;
        if (id !== ref) changed = true;
        if (seen.has(id)) {
          changed = true; // resolution collapsed two refs onto one person
          continue;
        }
        seen.add(id);
        out.push(id);
      }
      return { values: out, changed };
    };
    const a = fix(actors);
    const i = fix(involved);
    if (!a.changed && !i.changed) continue;
    if (await deps.writeGate.rewriteOpenLoopPeople(row.id, a.values, i.values)) rewritten += 1;
  }
  if (rewritten > 0) {
    deps.log.info(`open-loop person refs normalized: ${rewritten} loop(s) rewritten`);
  }
  return rewritten;
}
