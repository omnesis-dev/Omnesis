// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writing an identifier and recording who vouches for it.
 *
 * The pairing is the whole point: `person_aliases` is `INSERT OR IGNORE`, so
 * its `source_id` names only the first source to see an identifier. An alias
 * written without an assertion is one no removal can reason about — and the
 * direction it fails in is the bad one, because the withdrawal of a source
 * that DID vouch finds no other voucher and takes the row.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { aliasWriter } from "./PersonAliasRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-alias-writer-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES ('p1', 'Alice', 'gmail', ?, ?, ?, ?)`,
  ).run(
    "2026-04-01T00:00:00Z",
    "2026-04-01T00:00:00Z",
    "2026-04-01T00:00:00Z",
    "2026-04-01T00:00:00Z",
  );
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

const vouchers = (alias: string): string[] =>
  db
    .prepare<[string], { source_id: string }>(
      `SELECT a.source_id FROM person_alias_assertions a
         JOIN person_aliases al ON al.id = a.alias_id
        WHERE al.alias = ? ORDER BY a.source_id`,
    )
    .all(alias)
    .map((r) => r.source_id);

describe("claiming an identifier", () => {
  test("writes the alias and the assertion together", () => {
    aliasWriter(db, "gmail", "2026-04-01T00:00:00Z").claim("p1", "email", "alice@example.com");
    expect(vouchers("alice@example.com")).toEqual(["gmail"]);
  });

  test("a second source's claim is recorded even though its insert is ignored", () => {
    aliasWriter(db, "gmail", "2026-04-01T00:00:00Z").claim("p1", "email", "alice@example.com");
    aliasWriter(db, "google-calendar", "2026-04-02T00:00:00Z").claim(
      "p1",
      "email",
      "alice@example.com",
    );

    // One row, two vouchers. The row's own `source_id` still says `gmail`,
    // which is exactly why it cannot be the ledger.
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_aliases").get()!.n).toBe(
      1,
    );
    expect(vouchers("alice@example.com")).toEqual(["gmail", "google-calendar"]);
  });

  test("reports whether the person gained an identifier, not whether the vouch is new", () => {
    const first = aliasWriter(db, "gmail", "2026-04-01T00:00:00Z");
    expect(first.claim("p1", "email", "alice@example.com")).toBe(true);
    expect(first.claim("p1", "email", "alice@example.com")).toBe(false);
    expect(
      aliasWriter(db, "google-calendar", "2026-04-02T00:00:00Z").claim(
        "p1",
        "email",
        "alice@example.com",
      ),
    ).toBe(false);
  });

  test("re-claiming is one row, and writes nothing the second time", () => {
    // The table answers whether a source vouches for an identifier, and that
    // does not change on seeing it again. People resolution reaches here per
    // identifier per mention per document, so an update on every observation
    // would dirty a page on the single writer for each of them.
    aliasWriter(db, "gmail", "2026-04-01T00:00:00Z").claim("p1", "email", "alice@example.com");
    aliasWriter(db, "gmail", "2026-04-09T00:00:00Z").claim("p1", "email", "alice@example.com");
    const row = db
      .prepare<
        [],
        { n: number; first_seen: string; last_seen: string }
      >("SELECT COUNT(*) AS n, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM person_alias_assertions")
      .get()!;
    expect(row.n).toBe(1);
    expect(row.first_seen).toBe("2026-04-01T00:00:00Z");
    expect(row.last_seen).toBe("2026-04-01T00:00:00Z");
  });

  test("vouching alone records a claim on an alias another statement inserted", () => {
    // The name path keeps its own INSERT for the occurrence tally.
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at, occurrence_count, is_primary)
       VALUES (?, 'p1', 'Alice', 'name', 'gmail', ?, 1, 1)`,
    ).run(randomUUID(), "2026-04-01T00:00:00Z");
    aliasWriter(db, "gmail", "2026-04-01T00:00:00Z").vouch("p1", "name", "Alice");
    expect(vouchers("Alice")).toEqual(["gmail"]);
  });

  test("a vouch for an identifier that does not exist writes nothing", () => {
    aliasWriter(db, "gmail", "2026-04-01T00:00:00Z").vouch("p1", "email", "ghost@example.com");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM person_alias_assertions").get()!.n,
    ).toBe(0);
  });
});
