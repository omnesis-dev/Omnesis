// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 174 — a platform identifier says which platform issued it.
 *
 * The `lid` alias type holds identifiers unique on one platform and
 * meaningless off it. Two of the three producers prefixed theirs and one did
 * not, so the type carried `github:jlopez` beside bare digits, and nothing
 * downstream could tell one platform from another.
 *
 * Sharing a `lid` is one of the things that merges two people with no review,
 * so an unprefixed identifier is one collision away from fusing two people
 * silently — and a guard written for the platform whose ids can be re-pointed
 * fires on all three, holding back identifiers from the two whose ids cannot.
 *
 * The bare values are WhatsApp's. That is derivable rather than guessed: it is
 * the only producer that emitted an unprefixed `lid`, which a test in the
 * WhatsApp package pins. Anything that is neither all digits nor already
 * prefixed is left exactly as it is — lookup is exact-match on the
 * value, so an untouched row keeps resolving as it did, and rewriting one on a
 * guess is how an identifier stops matching the person it names.
 *
 * The rewrite reaches three tables, and the third is the one that would hurt.
 * `merge_rules` and `merge_candidates` store an alias pair in canonical
 * lexicographic order and are keyed on it. `229…` sorts before `github:…` and
 * `whatsapp:229…` sorts after, so a `lid`↔`lid` pair can come out of this
 * migration in the wrong order — and a stored row in the wrong order no longer
 * matches the key a detector computes. For a `denied` candidate that is an
 * operator's permanent veto quietly ceasing to veto: the pair is proposed
 * again, and accepting it writes a second rule. So the pairs are re-sorted,
 * and a re-sort that collides with an existing row keeps the veto.
 *
 * Cross-type pairs cannot move: they compare on the alias type, which this
 * migration does not touch. That is the reason the namespace is a value
 * convention rather than a new alias type, and it is what keeps this migration
 * to a handful of rows.
 *
 * Every rewrite here can land on a value that is already stored, because the
 * gateway and the collector are updated separately: a collector that already
 * namespaces its identifiers can write `whatsapp:229…` into a gateway that
 * still holds `229…` for the same person, and then this migration is asked to
 * make one into the other. All three tables constrain that — `person_aliases`
 * on `(alias_type, alias, person_id)`, `merge_rules` on its active pair,
 * `merge_candidates` on its pair — so a collision left unhandled is a
 * constraint failure inside the migration's transaction, which rolls back
 * without stamping the version and fails every subsequent boot the same way.
 * So each rewrite looks for the row it would become and decides which one
 * survives, before writing.
 */

import type { Db } from "./types.js";

/** Values written by the one producer that emitted no platform: all digits. */
const BARE_LID = bareAlias("alias");

/** The same test, qualified — a join needs to say which table's alias it means. */
function bareAlias(column: string): string {
  return `${column} GLOB '[0-9]*' AND ${column} NOT GLOB '*[^0-9]*'`;
}

const bareSide = (side: "a" | "b") =>
  `side_${side}_alias_type = 'lid'
     AND side_${side}_alias GLOB '[0-9]*'
     AND side_${side}_alias NOT GLOB '*[^0-9]*'`;

/**
 * Preserve decisions when a bare pair has a prefixed twin.
 *
 * The pair tables are keyed on all four side columns, so rewriting one side
 * into a value another row already carries fails the unique key — and a
 * migration that throws does not fail once, it fails every boot after.
 * Candidate decisions fold onto the surviving row. Rules retain both audit
 * rows and deactivate only a competing active rule, keeping the older decision.
 */
function foldIntoPrefixedTwin(
  db: Db,
  table: "merge_rules" | "merge_candidates",
  side: "a" | "b",
  ambiguous: string,
) {
  const other = side === "a" ? "b" : "a";
  const twins = db
    .prepare(
      `SELECT bare.id AS bare_id, twin.id AS twin_id
         FROM ${table} bare
         JOIN ${table} twin
           ON twin.id != bare.id
          AND twin.side_${side}_alias_type = bare.side_${side}_alias_type
          AND twin.side_${side}_alias = 'whatsapp:' || bare.side_${side}_alias
          AND twin.side_${other}_alias_type = bare.side_${other}_alias_type
          AND twin.side_${other}_alias = bare.side_${other}_alias
        WHERE ${bareSide(side).replaceAll(`side_${side}_`, `bare.side_${side}_`)}
          AND bare.side_${side}_alias NOT IN (SELECT value FROM json_each(?))`,
    )
    .all(ambiguous) as Array<{ bare_id: string; twin_id: string }>;
  if (twins.length === 0) return;
  if (table === "merge_rules") {
    const read = db.prepare<[string], { active: number; created_at: string }>(
      "SELECT active, created_at FROM merge_rules WHERE id = ?",
    );
    const deactivate = db.prepare(
      "UPDATE merge_rules SET active = 0, deactivated_at = ? WHERE id = ?",
    );
    for (const { bare_id, twin_id } of twins) {
      const bare = read.get(bare_id);
      const twin = read.get(twin_id);
      if (!bare?.active || !twin?.active) continue;
      const loser = bare.created_at <= twin.created_at ? twin_id : bare_id;
      deactivate.run(new Date().toISOString(), loser);
    }
    return;
  }
  if (table === "merge_candidates") {
    // A decision the operator made outlives a spelling. If the bare row is the
    // one that carries it, the survivor inherits it.
    const read = db.prepare("SELECT status FROM merge_candidates WHERE id = ?");
    const setStatus = db.prepare("UPDATE merge_candidates SET status = ? WHERE id = ?");
    for (const { bare_id, twin_id } of twins) {
      const bare = read.get(bare_id) as { status: string } | undefined;
      const twin = read.get(twin_id) as { status: string } | undefined;
      if (bare && twin && RANK[bare.status] > RANK[twin.status]) {
        setStatus.run(bare.status, twin_id);
      }
    }
  }
  const drop = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  for (const { bare_id } of twins) drop.run(bare_id);
}

/**
 * Which of two rows for one pair survives.
 *
 * A decision outranks a proposal, and an acceptance outranks a refusal: an
 * accepted candidate is the audit trail of a merge that actually happened and
 * that a `merge_rules` row still points at, while a denial is a veto on a
 * merge that never did.
 */
const RANK: Record<string, number> = { accepted: 3, denied: 2, pending: 1 };

export function namespaceWhatsappLids(db: Db): void {
  const has = (table: string): boolean =>
    (
      db
        .prepare<
          [string],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .all(table) as { name: string }[]
    ).length > 0;

  // A spelling change is not evidence that two existing people are one person.
  // Retain both identities, their provenance and any manual decisions when a
  // prefixed identifier is already owned by a different person. JSON binding
  // keeps this bounded to one SQL parameter even in a large installed graph.
  const ambiguous = JSON.stringify(
    has("person_aliases")
      ? db
          .prepare<[], { alias: string }>(
            `
    SELECT DISTINCT bare.alias FROM person_aliases bare
    JOIN person_aliases prefixed ON prefixed.alias_type = 'lid'
      AND prefixed.alias = 'whatsapp:' || bare.alias
      AND prefixed.person_id != bare.person_id
    WHERE bare.alias_type = 'lid' AND ${bareAlias("bare.alias")}
  `,
          )
          .all()
          .map((row) => row.alias)
      : [],
  );

  if (has("person_aliases")) {
    // A person can already hold both spellings: a collector that namespaces
    // its identifiers writes the prefixed one into a gateway still holding the
    // bare one, because the two are updated separately. Rewriting the bare row
    // into a value that person already has fails the unique key, and a
    // migration that throws is a gateway that never boots again.
    //
    // The prefixed row is the one to keep — it is what every producer writes
    // now — so the bare row's vouchers move onto it and the bare row goes.
    // Moving them rather than dropping them is what stops a source's claim on
    // the identifier disappearing with a row that was only ever a spelling.
    if (has("person_alias_assertions")) {
      db.prepare(
        `INSERT INTO person_alias_assertions (alias_id, source_id, first_seen, last_seen)
               SELECT prefixed.id, a.source_id, a.first_seen, a.last_seen
                 FROM person_alias_assertions a
                 JOIN person_aliases bare ON bare.id = a.alias_id
                 JOIN person_aliases prefixed
                   ON prefixed.person_id = bare.person_id
                  AND prefixed.alias_type = 'lid'
                  AND prefixed.alias = 'whatsapp:' || bare.alias
                WHERE bare.alias_type = 'lid' AND ${bareAlias("bare.alias")}
                  AND bare.alias NOT IN (SELECT value FROM json_each(?))
                  ON CONFLICT(alias_id, source_id) DO UPDATE SET
                    first_seen = MIN(person_alias_assertions.first_seen, excluded.first_seen),
                    last_seen = MAX(person_alias_assertions.last_seen, excluded.last_seen)`,
      ).run(ambiguous);
    }
    db.prepare(
      `DELETE FROM person_aliases
              WHERE alias_type = 'lid' AND ${BARE_LID}
                AND alias NOT IN (SELECT value FROM json_each(?))
                AND EXISTS (
                  SELECT 1 FROM person_aliases other
                   WHERE other.person_id = person_aliases.person_id
                     AND other.alias_type = 'lid'
                     AND other.alias = 'whatsapp:' || person_aliases.alias
                )`,
    ).run(ambiguous);
    // Excluding what is already prefixed makes a re-run — after a crash
    // between the commit and the version stamp — match nothing.
    db.prepare(
      `UPDATE person_aliases
                SET alias = 'whatsapp:' || alias
              WHERE alias_type = 'lid' AND ${BARE_LID}
                AND alias NOT IN (SELECT value FROM json_each(?))`,
    ).run(ambiguous);
  }

  for (const table of ["merge_rules", "merge_candidates"] as const) {
    if (!has(table)) continue;
    for (const side of ["a", "b"] as const) {
      // The prefix pass collides for the same reason the alias pass does: a
      // pair written by an already-namespacing collector sits beside the bare
      // one this is about to rewrite into it. Fold the bare row into its twin
      // first, so the rewrite that follows has nothing to land on.
      foldIntoPrefixedTwin(db, table, side, ambiguous);
      db.prepare(
        `UPDATE ${table}
                  SET side_${side}_alias = 'whatsapp:' || side_${side}_alias
                WHERE ${bareSide(side)}
                  AND side_${side}_alias NOT IN (SELECT value FROM json_each(?))`,
      ).run(ambiguous);
    }
  }

  recanonicalizePairs(db, has);
}

/**
 * Put every stored alias pair back into the order its key is computed in.
 *
 * Written as a general pass rather than as a targeted flip of the rows this
 * migration rewrote: the same comparison decides both, so a pass that fixes
 * any row out of order fixes the ones this migration moved and repairs
 * anything already wrong, and is safe to run twice.
 */
function recanonicalizePairs(db: Db, has: (table: string) => boolean): void {
  const outOfOrder = (a: string, at: string, b: string, bt: string): boolean =>
    (at !== bt ? at.localeCompare(bt) : a.localeCompare(b)) > 0;

  if (has("merge_rules")) {
    const rows = db
      .prepare(
        `SELECT id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, winner_side,
                created_at, active
           FROM merge_rules`,
      )
      .all() as Array<{
      id: string;
      side_a_alias_type: string;
      side_a_alias: string;
      side_b_alias_type: string;
      side_b_alias: string;
      winner_side: string;
      created_at: string;
      active: number;
    }>;
    const swap = db.prepare(
      `UPDATE merge_rules
          SET side_a_alias_type = ?, side_a_alias = ?,
              side_b_alias_type = ?, side_b_alias = ?,
              winner_side = ?
        WHERE id = ?`,
    );
    // The active pair is unique, so a re-sort can land on a rule that is
    // already stored the right way round.
    const findRule = db.prepare(
      `SELECT id, created_at FROM merge_rules
        WHERE active = 1
          AND side_a_alias_type = ? AND side_a_alias = ?
          AND side_b_alias_type = ? AND side_b_alias = ?`,
    );
    const deactivate = db.prepare(
      "UPDATE merge_rules SET active = 0, deactivated_at = ? WHERE id = ?",
    );
    for (const r of rows) {
      if (!outOfOrder(r.side_a_alias, r.side_a_alias_type, r.side_b_alias, r.side_b_alias_type)) {
        continue;
      }
      const existing = findRule.get(
        r.side_b_alias_type,
        r.side_b_alias,
        r.side_a_alias_type,
        r.side_a_alias,
      ) as { id: string; created_at: string } | undefined;
      if (r.active && existing) {
        // Two rules for one pair. The older is the decision that has been in
        // force, so it stays and the newer is deactivated rather than deleted
        // — a merge the operator made is a thing the audit trail should still
        // be able to show.
        const at = new Date().toISOString();
        if (r.created_at < existing.created_at) deactivate.run(at, existing.id);
        else {
          deactivate.run(at, r.id);
        }
      }
      // The winner follows its side across, or the operator's "this one wins"
      // becomes "that one wins".
      swap.run(
        r.side_b_alias_type,
        r.side_b_alias,
        r.side_a_alias_type,
        r.side_a_alias,
        r.winner_side === "a" ? "b" : "a",
        r.id,
      );
    }
  }

  if (!has("merge_candidates")) return;
  const rows = db
    .prepare(
      `SELECT id, status, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias
         FROM merge_candidates`,
    )
    .all() as Array<{
    id: string;
    status: string;
    side_a_alias_type: string;
    side_a_alias: string;
    side_b_alias_type: string;
    side_b_alias: string;
  }>;
  const findRow = db.prepare(
    `SELECT id, status FROM merge_candidates
      WHERE side_a_alias_type = ? AND side_a_alias = ?
        AND side_b_alias_type = ? AND side_b_alias = ?`,
  );
  const drop = db.prepare("DELETE FROM merge_candidates WHERE id = ?");
  const swap = db.prepare(
    `UPDATE merge_candidates
        SET side_a_alias_type = ?, side_a_alias = ?,
            side_b_alias_type = ?, side_b_alias = ?
      WHERE id = ?`,
  );
  for (const r of rows) {
    if (!outOfOrder(r.side_a_alias, r.side_a_alias_type, r.side_b_alias, r.side_b_alias_type)) {
      continue;
    }
    const existing = findRow.get(
      r.side_b_alias_type,
      r.side_b_alias,
      r.side_a_alias_type,
      r.side_a_alias,
    ) as { id: string; status: string } | undefined;
    if (existing) {
      // The pair is already stored the right way round, and only one row may
      // be. Keep whichever carries the stronger decision: an acceptance is an
      // operator's decision that a live merge rule points back at, so dropping
      // it would leave that rule merging two people while the surviving row
      // reads `denied`. A refusal outlives a proposal nobody has answered.
      if (RANK[r.status] > RANK[existing.status]) drop.run(existing.id);
      else {
        drop.run(r.id);
        continue;
      }
    }
    swap.run(r.side_b_alias_type, r.side_b_alias, r.side_a_alias_type, r.side_a_alias, r.id);
  }
}
