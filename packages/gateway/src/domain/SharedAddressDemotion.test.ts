// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../db.js";
import { findOrCreatePerson } from "../people.js";
import { loadNonIdentifyingEmails } from "../data/repositories/PersonRepository.js";
import { pruneNoreplyAliases } from "../bootstrap/prune-noreply-aliases.js";
import {
  demoteSharedAddresses,
  DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
  DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
} from "./SharedAddressDemotion.js";
import type Database from "better-sqlite3";

/** A name count comfortably over the demotion threshold. */
const OVER_THRESHOLD = DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD + 5;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-shared-address-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface MakePersonOpts {
  source?: string;
  isSelf?: boolean;
  mergedInto?: string | null;
}

function makePerson(canonicalName: string, opts: MakePersonOpts = {}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
     VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(
    id,
    canonicalName,
    opts.source ?? "extracted",
    opts.isSelf ? 1 : 0,
    opts.mergedInto ?? null,
  );
  return id;
}

function addAlias(personId: string, aliasType: string, alias: string): void {
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, 'gmail:test', '2026-01-01')`,
  ).run(randomUUID(), personId, alias, aliasType);
}

/** Attach `count` distinct fictional name aliases to a person. */
function addNames(personId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    addAlias(personId, "name", `Fictional Sender ${i}`);
  }
}

function insertDoc(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, people_resolved_at)
     VALUES (?, 'google', 'gmail:test', ?, 'T', 'c', 'h-' || ?, '{}', '2026-01-01', '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
  ).run(id, id, id);
}

function linkDoc(docId: string, personId: string, role = "sender"): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, 'gmail:test')`,
  ).run(docId, personId, role);
}

function personExists(id: string): boolean {
  return db.prepare("SELECT 1 FROM people WHERE id = ?").get(id) !== undefined;
}

describe("demoteSharedAddresses", () => {
  test("no-op on a clean database", () => {
    expect(demoteSharedAddresses(db)).toEqual({ demoted: 0, emailsBlocked: 0 });
  });

  test("demotes a one-email / many-name bucket, blocklists the email, cascades links", () => {
    const bucket = makePerson("queue@example.com");
    addAlias(bucket, "email", "queue@example.com");
    addNames(bucket, DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD);
    insertDoc("doc-1");
    linkDoc("doc-1", bucket);

    const result = demoteSharedAddresses(db);
    expect(result).toEqual({ demoted: 1, emailsBlocked: 1 });

    // Person + its aliases + its document_people links are gone (cascade).
    expect(personExists(bucket)).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM person_aliases WHERE person_id = ?").get(bucket),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM document_people WHERE person_id = ?").get(bucket),
    ).toBeUndefined();

    // Email recorded in the learned blocklist.
    expect(loadNonIdentifyingEmails(db).has("queue@example.com")).toBe(true);
  });

  test("deletes a statically-caught monster but does NOT blocklist its email", () => {
    const bucket = makePerson("LinkedIn");
    addAlias(bucket, "email", "invitations@linkedin.com");
    addNames(bucket, OVER_THRESHOLD);

    const result = demoteSharedAddresses(db);
    expect(result.demoted).toBe(1);
    // invitations@ is already covered by the static heuristic — not persisted.
    expect(result.emailsBlocked).toBe(0);
    expect(loadNonIdentifyingEmails(db).has("invitations@linkedin.com")).toBe(false);
    expect(personExists(bucket)).toBe(false);
  });

  test("does NOT demote a normal person with few names", () => {
    const p = makePerson("Maya Reeves");
    addAlias(p, "email", "maya.reeves@example.com");
    addNames(p, 3);

    expect(demoteSharedAddresses(db)).toEqual({ demoted: 0, emailsBlocked: 0 });
    expect(personExists(p)).toBe(true);
  });

  test("does NOT demote an address-book (contacts) person, even with many names", () => {
    const p = makePerson("Jamie Lopez", { source: "contacts" });
    addAlias(p, "email", "jamie.lopez@example.com");
    addNames(p, OVER_THRESHOLD);

    expect(demoteSharedAddresses(db).demoted).toBe(0);
    expect(personExists(p)).toBe(true);
  });

  test("does NOT demote the self person", () => {
    const p = makePerson("Me", { isSelf: true });
    addAlias(p, "email", "me@example.com");
    addNames(p, OVER_THRESHOLD);

    expect(demoteSharedAddresses(db).demoted).toBe(0);
    expect(personExists(p)).toBe(true);
  });

  test("does NOT demote a canonical that other people merged into (no-orphan guard)", () => {
    const canonical = makePerson("queue@example.com");
    addAlias(canonical, "email", "queue@example.com");
    addNames(canonical, OVER_THRESHOLD);
    // A real identity folded into the bucket by a merge.
    const loser = makePerson("David Lin", { mergedInto: canonical });
    addAlias(loser, "email", "david.lin@example.com");

    expect(demoteSharedAddresses(db).demoted).toBe(0);
    expect(personExists(canonical)).toBe(true);
    expect(personExists(loser)).toBe(true);
  });

  test("does NOT demote a bucket with many emails (not a single shared address)", () => {
    const p = makePerson("Hub");
    for (let i = 0; i < 8; i++) addAlias(p, "email", `hub${i}@example.com`);
    addNames(p, OVER_THRESHOLD);

    expect(demoteSharedAddresses(db).demoted).toBe(0);
    expect(personExists(p)).toBe(true);
  });

  test("email-count guard is inclusive at its upper bound", () => {
    const p = makePerson("queue@example.com");
    for (let i = 0; i < DEFAULT_SHARED_ADDRESS_MAX_EMAILS; i++) {
      addAlias(p, "email", `queue${i}@example.com`);
    }
    addNames(p, OVER_THRESHOLD);

    expect(demoteSharedAddresses(db).demoted).toBe(1);
    expect(personExists(p)).toBe(false);
  });

  test("threshold is inclusive at the boundary", () => {
    const below = makePerson("below@example.com");
    addAlias(below, "email", "below@example.com");
    addNames(below, DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD - 1);

    expect(demoteSharedAddresses(db).demoted).toBe(0);
    expect(personExists(below)).toBe(true);

    addAlias(below, "name", "One More Distinct Name"); // now exactly at the threshold
    expect(demoteSharedAddresses(db).demoted).toBe(1);
    expect(personExists(below)).toBe(false);
  });

  test("honors custom nameThreshold and maxEmails arguments", () => {
    // A bucket below the default name threshold but above a lowered one.
    const p = makePerson("queue@example.com");
    addAlias(p, "email", "queue@example.com");
    addNames(p, 5);

    // Default threshold (15) leaves it alone.
    expect(demoteSharedAddresses(db).demoted).toBe(0);
    // Lowered threshold (5) demotes it.
    expect(demoteSharedAddresses(db, 5).demoted).toBe(1);
    expect(personExists(p)).toBe(false);

    // A bucket with 3 emails is excluded when maxEmails is tightened to 2.
    const q = makePerson("Hub");
    for (let i = 0; i < 3; i++) addAlias(q, "email", `hub${i}@example.com`);
    addNames(q, OVER_THRESHOLD);
    expect(demoteSharedAddresses(db, DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD, 2).demoted).toBe(0);
    expect(personExists(q)).toBe(true);
  });

  test("idempotent on a second run", () => {
    const bucket = makePerson("queue@example.com");
    addAlias(bucket, "email", "queue@example.com");
    addNames(bucket, OVER_THRESHOLD);

    expect(demoteSharedAddresses(db).demoted).toBe(1);
    expect(demoteSharedAddresses(db)).toEqual({ demoted: 0, emailsBlocked: 0 });
  });
});

describe("demote → prune boot ordering", () => {
  test("demote deletes the monster whole; prune then cleans co-senders sharing the blocklisted email", () => {
    // The monster: one shared (non-static) address, many names.
    const monster = makePerson("helpdesk@example.com");
    addAlias(monster, "email", "helpdesk@example.com");
    addNames(monster, OVER_THRESHOLD);
    insertDoc("doc-monster");
    linkDoc("doc-monster", monster);

    // A separate, below-threshold person that also carries the shared
    // address as one of its email aliases.
    const coSender = makePerson("Sarah Mendez");
    addAlias(coSender, "email", "sarah.mendez@example.com");
    addAlias(coSender, "email", "helpdesk@example.com");
    insertDoc("doc-co");
    linkDoc("doc-co", coSender);

    // Boot order: demote first, then prune (mirrors runBootDataMigrations).
    const demoted = demoteSharedAddresses(db);
    expect(demoted).toEqual({ demoted: 1, emailsBlocked: 1 });

    // Monster removed whole — no leftover husk of name aliases.
    expect(personExists(monster)).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM person_aliases WHERE person_id = ?").get(monster),
    ).toBeUndefined();

    const pruned = pruneNoreplyAliases(db);
    // Prune consumes the blocklist demote wrote and strips the shared
    // address from the co-sender, re-backfilling its document.
    expect(pruned.aliasesRemoved).toBe(1);
    expect(pruned.documentsToRebackfill).toBe(1);
    expect(
      db.prepare("SELECT 1 FROM person_aliases WHERE alias = 'helpdesk@example.com'").get(),
    ).toBeUndefined();
    // The co-sender's real identifying email is untouched.
    expect(
      db.prepare("SELECT 1 FROM person_aliases WHERE alias = 'sarah.mendez@example.com'").get(),
    ).toBeDefined();
  });
});

describe("resolution drops blocklisted emails", () => {
  test("a blocklisted email becomes name-only and creates no person", () => {
    db.prepare(
      `INSERT INTO non_identifying_emails (email, reason, name_count, detected_at)
       VALUES ('helpdesk@example.com', 'shared_address_cardinality', 64, '2026-01-01')`,
    ).run();
    const blocklist = loadNonIdentifyingEmails(db);

    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves via Helpdesk", emails: ["helpdesk@example.com"] },
      "gmail:test",
      "2026-01-01",
      undefined,
      blocklist,
    );
    expect(id).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 0 });
  });

  test("a statically non-identifying email creates no person without any blocklist", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Jamie Lopez", emails: ["invitations@linkedin.com"] },
      "gmail:test",
      "2026-01-01",
    );
    expect(id).toBeNull();
  });
});
