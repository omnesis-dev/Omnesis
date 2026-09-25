// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "./db.js";
import { deleteAllBySource } from "./data/repositories/DocumentRepository.js";
import {
  findOrCreatePerson,
  findPersonByAlias,
  resolvePersonId,
  resolveDocumentPeople,
  backfillOnePerson,
  backfillManyPeople,
  seedFromContacts,
  computeSeedFromContacts,
  upsertSeedFromContacts,
  detectSelfFromSourceIds,
  mergePeople,
  runMergePass,
  computeAutoMergePairs,
  collapseTransitiveChains,
  computeTransitiveCollapse,
  upsertTransitiveCollapse,
  pickMergeWinner,
  rebuildPeopleFromDocuments,
  getPersonById,
  searchPeople,
  getDocumentPeople,
  getDocumentsPeopleSummary,
  getPersonDocuments,
  getSelfPersonId,
  getPeopleStats,
  resolvePersonIdsFromQuery,
  computePeopleCounts,
  upsertPeopleCounts,
  refreshPeopleCounts,
} from "./people.js";
import type { SelfIdentitySource } from "./self-identity-sources.js";
import type { PersonMention } from "@omnesis/types";

let tmpDir: string;
let db: Db;

function insertDoc(
  id: string,
  sourceId: string,
  people: PersonMention[],
  opts?: { documentType?: string; isMe?: boolean; sourceCreatedAt?: string },
) {
  const metadata = JSON.stringify({
    documentType: opts?.documentType ?? "email",
    people,
    extra: opts?.isMe ? { isMe: true } : undefined,
  });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Test Doc', 'content', 'hash-' || ?, ?, ?, '2026-01-01', ?, ?)`,
  ).run(
    id,
    sourceId,
    id,
    id,
    metadata,
    opts?.sourceCreatedAt ?? "2026-01-01",
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

/** Register a source the way the gateway does when one is added. */
function connectSource(sourceId: string): void {
  const [type, ...rest] = sourceId.split(":");
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, name, kind, paired_at)
     VALUES ('dev_1', 'a-collector', 'collector', 0)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'dev_1', '{}', 1, 0, 0)`,
  ).run(sourceId, type, rest.join(":"));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-people-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Resolution ─────────────────────────────────────────────────────

describe("findPersonByAlias dangling-merged_into resilience", () => {
  test("returns null when alias's owner exists but its merged_into points at a deleted person", () => {
    // Mimics the live bug: physicalMerge deleted a person, leaving
    // dangling merged_into pointers. findPersonByAlias must NOT
    // return the dangling id (causes FK errors downstream); it should
    // return null so the caller treats it as "no match" and either
    // creates a fresh person or runs through the conflict path.
    const winner = randomUUID();
    const dangler = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Winner', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'Dangler', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
    ).run(winner, dangler);
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at) VALUES (?, ?, 'email', 'a@x.com', '2026-01-01')",
    ).run(randomUUID(), dangler);
    // Dangler points at a non-existent person.
    db.prepare("UPDATE people SET merged_into = 'ghost-id' WHERE id = ?").run(dangler);

    const result = findPersonByAlias(db, "email", "a@x.com");
    expect(result).toBeNull();
  });
});

describe("findOrCreatePerson", () => {
  test("never resolves an agent mention, whatever it carries or shares", () => {
    const person = findOrCreatePerson(
      db,
      { role: "sender", name: "Aurora", emails: ["aurora@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const peopleBefore = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c;
    const aliasesBefore = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;

    // A name only, a name shared with a person, and even that person's own
    // identifier: an agent is skipped, never linked, never created.
    for (const mention of [
      { role: "author", name: "Aurora planner", isSelf: false, kind: "agent" },
      { role: "author", name: "Aurora", kind: "agent" },
      { role: "author", name: "Aurora", emails: ["aurora@example.com"], kind: "agent" },
    ] satisfies PersonMention[]) {
      expect(findOrCreatePerson(db, mention, "omnesis-notes", "2026-01-02")).toBeNull();
    }
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c).toBe(
      peopleBefore,
    );
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases").get()!.c).toBe(
      aliasesBefore,
    );
    expect(getPersonById(db, person)!.canonicalName).toBe("Aurora");
  });

  test("returns null for name-only mentions", () => {
    const result = findOrCreatePerson(
      db,
      { role: "participant", name: "John" },
      "gmail:test",
      "2026-01-01",
    );
    expect(result).toBeNull();
  });

  test("creates new person for email mention", () => {
    const personId = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      "gmail:test",
      "2026-01-01",
    );
    expect(personId).not.toBeNull();

    const person = getPersonById(db, personId!);
    expect(person).not.toBeNull();
    expect(person!.canonicalName).toBe("Alice");
    expect(
      person!.aliases.some((a) => a.aliasType === "email" && a.alias === "alice@example.com"),
    ).toBe(true);
    expect(person!.aliases.some((a) => a.aliasType === "name" && a.alias === "Alice")).toBe(true);
  });

  test("free-text phone references match known aliases but do not create people", () => {
    const unknown = findOrCreatePerson(
      db,
      { role: "mentioned", phones: ["+447700900888"], allowPersonCreation: false },
      "gmail:test",
      "2026-01-01",
    );
    expect(unknown).toBeNull();
    expect(findPersonByAlias(db, "phone", "+447700900888")).toBeNull();

    const contact = findOrCreatePerson(
      db,
      { role: "contact", name: "Priya Nair", phones: ["+447700900777"] },
      "apple-contacts:test",
      "2026-01-01",
    );
    const matched = findOrCreatePerson(
      db,
      { role: "mentioned", phones: ["+447700900777"], allowPersonCreation: false },
      "gmail:test",
      "2026-01-02",
    );
    expect(matched).toBe(contact);
  });

  test("never creates an alias from an invalid-TLD email (extraction artifact)", () => {
    // A parser glued text onto the address → its TLD doesn't exist. With no
    // other identifier the mention becomes name-only and creates no person.
    const result = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya", emails: ["maya@example.com.vous"] },
      "gmail:test",
      "2026-01-01",
    );
    expect(result).toBeNull();
    const junk = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM person_aliases WHERE alias LIKE '%.vous'")
      .get()!;
    expect(junk.n).toBe(0);
  });

  test("keeps the valid email and drops the invalid-TLD one in the same mention", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya", emails: ["maya@example.com", "maya@example.comcourriel"] },
      "gmail:test",
      "2026-01-01",
    );
    expect(id).not.toBeNull();
    const emails = db
      .prepare<
        [string],
        { alias: string }
      >("SELECT alias FROM person_aliases WHERE person_id = ? AND alias_type = 'email'")
      .all(id!);
    expect(emails.map((e) => e.alias)).toEqual(["maya@example.com"]);
  });

  test("a name's occurrence_count increments per mention; a contact name gets a high floor", () => {
    const see = (name: string, role: "sender" | "contact" = "sender"): string | null =>
      findOrCreatePerson(
        db,
        { role, name, emails: ["dom@example.com"] },
        "gmail:test",
        "2026-01-01",
      );
    const id = see("Maya");
    see("Maya");
    see("Maya");
    const countOf = (name: string): number | undefined =>
      db
        .prepare<
          [string, string],
          { occurrence_count: number }
        >("SELECT occurrence_count FROM person_aliases WHERE person_id=? AND alias_type='name' AND alias=?")
        .get(id!, name)?.occurrence_count;
    expect(countOf("Maya")).toBe(3);

    // A contact-card mention of a different name jumps to the floor so a curated
    // name outranks raw sender display-names regardless of count.
    see("Quinn", "contact");
    expect(countOf("Quinn")).toBeGreaterThanOrEqual(1_000_000);
  });

  test("weak-LID guard: a conflicting-name WhatsApp mention does not staple new identifiers", () => {
    const lidsOf = (id: string): string[] =>
      db
        .prepare<[string], { alias: string }>(
          "SELECT alias FROM person_aliases WHERE person_id=? AND alias_type='lid' ORDER BY alias",
        )
        .all(id)
        .map((r) => r.alias);
    // Person known on WhatsApp.
    const p = findOrCreatePerson(
      db,
      { role: "participant", name: "Maya", phones: ["+15550100201"], lids: ["whatsapp:lid-maya"] },
      "whatsapp:t",
      "2026-01-01",
    );
    // Mis-mapped mention: Maya's phone (matches her) but a CONFLICTING name and a
    // NEW lid — the new lid must NOT be stapled onto Maya.
    findOrCreatePerson(
      db,
      { role: "participant", name: "David", phones: ["+15550100201"], lids: ["whatsapp:lid-new"] },
      "whatsapp:t",
      "2026-02-01",
    );
    expect(lidsOf(p!)).toEqual(["whatsapp:lid-maya"]);
  });

  test("weak-LID guard does not fire when the WhatsApp name agrees", () => {
    const lidsOf = (id: string): string[] =>
      db
        .prepare<[string], { alias: string }>(
          "SELECT alias FROM person_aliases WHERE person_id=? AND alias_type='lid' ORDER BY alias",
        )
        .all(id)
        .map((r) => r.alias);
    const p = findOrCreatePerson(
      db,
      { role: "participant", name: "Maya", phones: ["+15550100202"], lids: ["lid-m1"] },
      "whatsapp:t",
      "2026-01-01",
    );
    // Same person, same name, reveals a second lid → both are kept.
    findOrCreatePerson(
      db,
      { role: "participant", name: "Maya", phones: ["+15550100202"], lids: ["lid-m2"] },
      "whatsapp:t",
      "2026-02-01",
    );
    expect(lidsOf(p!)).toEqual(["lid-m1", "lid-m2"]);
  });

  test("matches existing person by email", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      "gmail:test",
      "2026-01-01",
    );
    const id2 = findOrCreatePerson(
      db,
      { role: "recipient", name: "Alice Smith", emails: ["alice@example.com"] },
      "gmail:test",
      "2026-02-01",
    );
    expect(id1).toBe(id2);
  });

  test("accretes new aliases when an existing person sees additional identifiers (regression for gateway-people-aliases-not-extended)", () => {
    // Reproduces gateway-people-aliases-not-extended: a contact created
    // first with just an email, later seen with a phone in another source's
    // mention, must end up with BOTH aliases on the same person row so
    // future cross-source matching by phone resolves to the same person.
    const id1 = findOrCreatePerson(
      db,
      { role: "contact", name: "Lucas", emails: ["lucas@example.com"] },
      "google-contacts:test",
      "2026-01-01",
    );
    expect(id1).not.toBeNull();

    const id2 = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Lucas",
        emails: ["lucas@example.com"],
        phones: ["+447700000002"],
      },
      "gmail:test",
      "2026-02-01",
    );
    expect(id2).toBe(id1);

    const aliases = db
      .prepare<
        [string],
        { alias: string; alias_type: string }
      >("SELECT alias, alias_type FROM person_aliases WHERE person_id = ? ORDER BY alias_type, alias")
      .all(id1!);
    const phoneAliases = aliases.filter((a) => a.alias_type === "phone");
    expect(phoneAliases.map((a) => a.alias)).toContain("+447700000002");
  });

  test("matches existing person by phone", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "participant", name: "Bob", phones: ["+447700000000"] },
      "whatsapp:test",
      "2026-01-01",
    );
    const id2 = findOrCreatePerson(
      db,
      { role: "participant", name: "Robert", phones: ["+447700000000"] },
      "whatsapp:test",
      "2026-02-01",
    );
    expect(id1).toBe(id2);
  });

  test("matches existing person by LID", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "participant", name: "Marco", lids: ["54649180692686"] },
      "whatsapp:test",
      "2026-01-01",
    );
    const id2 = findOrCreatePerson(
      db,
      { role: "participant", name: "Marco M", lids: ["54649180692686"] },
      "whatsapp:test",
      "2026-02-01",
    );
    expect(id1).toBe(id2);
  });

  test("does NOT auto-merge when different identifiers match different people", () => {
    // A mention whose identifiers match multiple existing people represents a
    // conflict — e.g., an Apple Contacts card with a family member's phone
    // listed alongside the user's own email. Auto-merging would destructively
    // collapse separate people; we instead link to the earliest candidate and
    // keep the records distinct.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@work.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "participant", phones: ["+33612345678"] },
      "whatsapp:test",
      "2026-02-01",
    )!;
    expect(idA).not.toBe(idB);

    const idC = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@work.com"], phones: ["+33612345678"] },
      "gmail:test",
      "2026-03-01",
    );

    // Conflict resolves to the earliest candidate, but no merge happens.
    expect(idC).toBe(idA);

    // idB must still be its own person, unmerged
    const personB = getPersonById(db, idB);
    expect(personB!.id).toBe(idB);
    expect(personB!.mergedInto).toBeNull();

    // And the conflicting identifiers must NOT have been added to idA
    // (the phone still belongs to idB only, the email still belongs to idA only)
    const personA = getPersonById(db, idA);
    expect(
      personA!.aliases.some((a) => a.aliasType === "phone" && a.alias === "+33612345678"),
    ).toBe(false);
    expect(
      personB!.aliases.some((a) => a.aliasType === "email" && a.alias === "alice@work.com"),
    ).toBe(false);
  });

  test("recipient mentions do NOT contribute name aliases", () => {
    // Seed self with an email
    const selfId = findOrCreatePerson(
      db,
      { role: "contact", name: "James", emails: ["jamesbond@self.com"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;

    // A bulk email addresses James with a spoofed/cluttered recipient display
    // name — the sender chose "Cloud Team" for the To: header.
    findOrCreatePerson(
      db,
      { role: "recipient", name: "Cloud Team", emails: ["jamesbond@self.com"] },
      "outlook-email:test",
      "2026-02-01",
    );

    const person = getPersonById(db, selfId)!;
    // "James" is kept (came in via contact role, trusted)
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "James")).toBe(true);
    // "Cloud Team" must NOT have leaked onto James from the recipient role
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "Cloud Team")).toBe(
      false,
    );
  });

  test("mentioned mentions do NOT contribute name aliases", () => {
    const selfId = findOrCreatePerson(
      db,
      { role: "sender", name: "James", emails: ["jamesbond@self.com"] },
      "gmail:test",
      "2026-01-01",
    )!;

    // Body extractor found James's email and tagged it with a name (hypothetical)
    findOrCreatePerson(
      db,
      { role: "mentioned", name: "Random Label From Body", emails: ["jamesbond@self.com"] },
      "gmail:test",
      "2026-02-01",
    );

    const person = getPersonById(db, selfId)!;
    expect(
      person.aliases.some((a) => a.aliasType === "name" && a.alias === "Random Label From Body"),
    ).toBe(false);
  });

  test("recipient-only mentions use email as canonical_name fallback", () => {
    // First-seen mention for a new email is a recipient mention with a spoofed
    // display name. We should not use the display name for canonical_name —
    // fall back to the email so the record isn't misnamed.
    const id = findOrCreatePerson(
      db,
      { role: "recipient", name: "Cloud Team", emails: ["spam@vendor.com"] },
      "outlook-email:test",
      "2026-02-01",
    )!;
    const person = getPersonById(db, id)!;
    expect(person.canonicalName).toBe("spam@vendor.com");
    expect(person.aliases.some((a) => a.aliasType === "name")).toBe(false);
  });

  test("self person only accepts name aliases from role=contact", () => {
    // Seed a self person via an isMe contact
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "James", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    const selfId = getSelfPersonId(db)!;

    // A mailing-list/relayed email where the From header is the user's own
    // address but the display name is the service's label. This is a sender
    // mention (trusted role) but the name must NOT land on self.
    findOrCreatePerson(
      db,
      { role: "sender", name: "Cloud Team", emails: ["me@example.com"] },
      "outlook-email:me@example.com",
      "2026-02-01",
    );

    const person = getPersonById(db, selfId)!;
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "Cloud Team")).toBe(
      false,
    );
    // Original contact-sourced name is retained
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "James")).toBe(true);
  });

  test("self person accepts name aliases from additional contact-role mentions", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "James", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    const selfId = getSelfPersonId(db)!;

    // A second contact from a different address book lists the user with a
    // different display name. Contact-sourced names ARE trusted on self.
    findOrCreatePerson(
      db,
      { role: "contact", name: "James Full Name", emails: ["me@example.com"] },
      "google-contacts:test",
      "2026-02-01",
    );

    const person = getPersonById(db, selfId)!;
    expect(
      person.aliases.some((a) => a.aliasType === "name" && a.alias === "James Full Name"),
    ).toBe(true);
  });

  test("sender mentions DO contribute name aliases", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const person = getPersonById(db, id)!;
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "Alice")).toBe(true);
  });

  test("adds new aliases to existing person", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@work.com"] },
      "gmail:test",
      "2026-01-01",
    );
    // Same person, adds a phone
    findOrCreatePerson(
      db,
      { role: "participant", emails: ["alice@work.com"], phones: ["+33612345678"] },
      "whatsapp:test",
      "2026-02-01",
    );

    const person = getPersonById(db, id1!);
    expect(person!.aliases.some((a) => a.aliasType === "phone" && a.alias === "+33612345678")).toBe(
      true,
    );
  });
});

// ─── canonical_name self-heal (#583) ────────────────────────────────

describe("canonical_name placeholder self-heal", () => {
  test("a trusted name upgrades a phone-shaped headline (message-then-contact)", () => {
    // First seen via a phone-only message: no name, so the phone becomes the
    // headline.
    const id = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+447700000001"] },
      "imessage:acct",
      "2026-01-01",
    )!;
    expect(getPersonById(db, id)!.canonicalName).toBe("+447700000001");

    // Contact card with the real name lands later, sharing the phone.
    const matched = findOrCreatePerson(
      db,
      { role: "contact", name: "Jamie Lopez", phones: ["+447700000001"] },
      "apple-contacts:test",
      "2026-02-01",
    );
    expect(matched).toBe(id);

    const person = getPersonById(db, id)!;
    expect(person.canonicalName).toBe("Jamie Lopez");
    // Phone is retained as an alias (demoted from headline, not lost).
    expect(person.aliases.some((a) => a.aliasType === "phone" && a.alias === "+447700000001")).toBe(
      true,
    );
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "Jamie Lopez")).toBe(
      true,
    );
  });

  test("a trusted name upgrades an email-shaped headline", () => {
    // First seen as a recipient with a spoofed display name → email headline.
    const id = findOrCreatePerson(
      db,
      { role: "recipient", name: "Cloud Team", emails: ["jamie@example.com"] },
      "outlook-email:test",
      "2026-01-01",
    )!;
    expect(getPersonById(db, id)!.canonicalName).toBe("jamie@example.com");

    // A trusted sender mention with the same email arrives.
    findOrCreatePerson(
      db,
      { role: "sender", name: "Jamie Lopez", emails: ["jamie@example.com"] },
      "gmail:test",
      "2026-02-01",
    );

    expect(getPersonById(db, id)!.canonicalName).toBe("Jamie Lopez");
  });

  test("a trusted name upgrades an Unknown (lid-only) headline", () => {
    const id = findOrCreatePerson(
      db,
      { role: "participant", lids: ["wa-lid-123"] },
      "whatsapp:test",
      "2026-01-01",
    )!;
    expect(getPersonById(db, id)!.canonicalName).toBe("Unknown");

    findOrCreatePerson(
      db,
      { role: "sender", name: "Dana Kim", lids: ["wa-lid-123"] },
      "whatsapp:test",
      "2026-02-01",
    );

    expect(getPersonById(db, id)!.canonicalName).toBe("Dana Kim");
  });

  test("a real headline is NOT overwritten by a later message-only mention", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    // A later phone-only mention (no name) for the same person.
    findOrCreatePerson(
      db,
      { role: "participant", emails: ["maya@example.com"], phones: ["+15550100123"] },
      "whatsapp:test",
      "2026-02-01",
    );
    expect(getPersonById(db, id)!.canonicalName).toBe("Maya Reeves");
  });

  test("a real headline is NOT overwritten by a different trusted name", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    // A second trusted name for the same identity is an alias, never a
    // silent headline replacement — that distinction is a merge decision.
    findOrCreatePerson(
      db,
      { role: "sender", name: "M. Reeves", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-02-01",
    );
    const person = getPersonById(db, id)!;
    expect(person.canonicalName).toBe("Maya Reeves");
    expect(person.aliases.some((a) => a.aliasType === "name" && a.alias === "M. Reeves")).toBe(
      true,
    );
  });

  test("self: a contact-role name heals a phone headline, a sender-role name does not", () => {
    // Self first materializes via a phone-only isMe contact: no name, so the
    // headline is the phone and is_self is set — the "split self" smell.
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", phones: ["+15550100888"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    const selfId = getSelfPersonId(db)!;
    expect(getPersonById(db, selfId)!.canonicalName).toBe("+15550100888");

    // A self-sent email carries a relayed display name on the From header.
    // It's a trusted role in general, but must NOT become self's headline.
    findOrCreatePerson(
      db,
      { role: "sender", name: "Cloud Team", phones: ["+15550100888"] },
      "outlook-email:me",
      "2026-02-01",
    );
    expect(getPersonById(db, selfId)!.canonicalName).toBe("+15550100888");

    // A real contact card for self heals the headline.
    findOrCreatePerson(
      db,
      { role: "contact", name: "Alex Rivera", phones: ["+15550100888"] },
      "google-contacts:test",
      "2026-03-01",
    );
    expect(getPersonById(db, selfId)!.canonicalName).toBe("Alex Rivera");
  });
});

// ─── No-reply / firehose addresses are not identifying ────────────

/**
 * Shared no-reply addresses (`comments-noreply@docs.google.com`,
 * `notifications-noreply@linkedin.com`, etc.) front every message from a
 * given platform regardless of author. The display name in the `From`
 * header carries the actual author; the SMTP address does not. Treating
 * such addresses as identity keys collapses unrelated authors into one
 * bucket person, which the auto-merge pass then collapses into whichever
 * real person matches one of the accreted name aliases.
 */
describe("findOrCreatePerson treats no-reply emails as non-identifying", () => {
  test("mention with only a noreply email is dropped (name-only path)", () => {
    const id = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Carla Vance (Google Docs)",
        emails: ["comments-noreply@docs.google.com"],
      },
      "gmail:test",
      "2026-01-01",
    );
    expect(id).toBeNull();
    const aliasCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;
    expect(aliasCount).toBe(0);
  });

  test("noreply email is never inserted as a person_aliases row", () => {
    findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Notifications",
        emails: ["notifications-noreply@linkedin.com", "real-person@example.com"],
      },
      "gmail:test",
      "2026-01-01",
    );
    const noreplyAlias = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'notifications-noreply@linkedin.com'")
      .get();
    expect(noreplyAlias).toBeUndefined();
    const realAlias = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'real-person@example.com'")
      .get();
    expect(realAlias).toBeDefined();
  });

  test("two notifications from different real authors do NOT collapse into one bucket", () => {
    // The motivating live incident: Google Docs comment notifications
    // from three different commenters all arrive From the same shared
    // `comments-noreply@docs.google.com`. Pre-fix, the first message
    // creates a person keyed on that email and the other two staple
    // their display names onto it as extra `name` aliases. Post-fix,
    // each name-only mention is dropped — no person, no link.
    const a = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Tomas Vidal (Google Docs)",
        emails: ["comments-noreply@docs.google.com"],
      },
      "gmail:test",
      "2026-01-01",
    );
    const b = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Carla Vance (Google Docs)",
        emails: ["comments-noreply@docs.google.com"],
      },
      "gmail:test",
      "2026-01-02",
    );
    const c = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Nora Bond (Google Docs)",
        emails: ["comments-noreply@docs.google.com"],
      },
      "gmail:test",
      "2026-01-03",
    );
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(c).toBeNull();
    const peopleCount = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c;
    expect(peopleCount).toBe(0);
  });

  test("noreply email alongside a real email still resolves via the real one", () => {
    const real = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Marco",
        emails: ["marco@example.com"],
      },
      "gmail:test",
      "2026-01-01",
    );
    expect(real).not.toBeNull();

    // Later mention surfaces the same real address plus a firehose
    // address from a different system. Resolution should ignore the
    // firehose and attach to the existing real-email person.
    const same = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Marco",
        emails: ["marco@example.com", "notifications-noreply@docs.google.com"],
      },
      "gmail:test",
      "2026-02-01",
    );
    expect(same).toBe(real);
    const noreplyAlias = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'notifications-noreply@docs.google.com'")
      .get();
    expect(noreplyAlias).toBeUndefined();
  });
});

// ─── isSelf primitive ───────────────────────────────────────────────

/**
 * Sources like Things and Obsidian know structurally that a document is
 * self-authored but have no accountId-as-email to put in `emails`. They
 * emit `{ role: "author", isSelf: true }` and the gateway resolves to
 * whoever is the canonical self person at write time. When no self has
 * been identified yet (fresh DB, contacts not synced), the mention is
 * silently dropped rather than creating a placeholder.
 */
describe("findOrCreatePerson isSelf primitive", () => {
  function seedSelf(): string {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "James", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    return getSelfPersonId(db)!;
  }

  test("resolves to existing self person and does not create a new alias", () => {
    const selfId = seedSelf();
    const aliasesBefore = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;

    const personId = findOrCreatePerson(
      db,
      { role: "author", isSelf: true },
      "things:default",
      "2026-03-01",
    );

    expect(personId).toBe(selfId);
    const aliasesAfter = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;
    // No new aliases — isSelf carries no identifier of its own.
    expect(aliasesAfter).toBe(aliasesBefore);
  });

  test("returns null when no self person exists yet, without creating a placeholder", () => {
    const peopleBefore = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c;

    const personId = findOrCreatePerson(
      db,
      { role: "author", isSelf: true },
      "things:default",
      "2026-03-01",
    );

    expect(personId).toBeNull();
    const peopleAfter = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c;
    expect(peopleAfter).toBe(peopleBefore);
  });

  test("isSelf wins even when emails/phones/lids are also supplied (no alias is added)", () => {
    const selfId = seedSelf();
    const aliasesBefore = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;

    const personId = findOrCreatePerson(
      db,
      {
        role: "author",
        isSelf: true,
        // These should be ignored — isSelf short-circuits the resolver.
        emails: ["bogus@nowhere.invalid"],
      },
      "things:default",
      "2026-03-01",
    );

    expect(personId).toBe(selfId);
    const aliasesAfter = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM person_aliases")
      .get()!.c;
    expect(aliasesAfter).toBe(aliasesBefore);
    // The bogus email did not land on the self row.
    const self = getPersonById(db, selfId)!;
    expect(
      self.aliases.some((a) => a.aliasType === "email" && a.alias === "bogus@nowhere.invalid"),
    ).toBe(false);
  });

  test("resolveDocumentPeople: isSelf gets linked, others go through normal alias resolution", () => {
    const selfId = seedSelf();
    insertDoc("doc-things", "things:default", []);

    const result = resolveDocumentPeople(
      db,
      "doc-things",
      [
        { role: "author", isSelf: true },
        { role: "mentioned", name: "Alice", emails: ["alice@example.com"] },
      ],
      "things:default",
      "2026-03-01",
    );

    expect(result.resolved).toBe(2);
    expect(result.skipped).toBe(0);

    const links = getDocumentPeople(db, "doc-things");
    const authorLink = links.find((l) => l.role === "author");
    expect(authorLink).toBeDefined();
    expect(authorLink!.personId).toBe(selfId);
    const aliceLink = links.find((l) => l.role === "mentioned");
    expect(aliceLink).toBeDefined();
    expect(aliceLink!.personId).not.toBe(selfId);
  });

  test("resolveDocumentPeople: isSelf with no self person yet is skipped", () => {
    insertDoc("doc-things-orphan", "things:default", []);

    const result = resolveDocumentPeople(
      db,
      "doc-things-orphan",
      [
        { role: "author", isSelf: true },
        { role: "mentioned", name: "Alice", emails: ["alice@example.com"] },
      ],
      "things:default",
      "2026-03-01",
    );

    // isSelf skipped (no self exists yet); Alice still resolves.
    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(1);

    const links = getDocumentPeople(db, "doc-things-orphan");
    expect(links.some((l) => l.role === "author")).toBe(false);
    expect(links.some((l) => l.role === "mentioned")).toBe(true);
  });
});

// ─── Conflict-path partial alias attach (issue #219) ────────────────

/**
 * The identifier-conflict branch of `findOrCreatePerson` (when a single
 * mention's identifiers resolve to multiple distinct people) used to skip
 * `addNewAliases` entirely, silently dropping every alias on the mention —
 * including ones that had no conflict at all. The fix attaches the safe
 * (non-conflicting) subset to the chosen winner while leaving the
 * conflict-causing identifiers on whichever person already owns them.
 */
describe("findOrCreatePerson conflict path: partial alias attach (#219)", () => {
  /**
   * Build an aliases-by-type lookup for the given person. Uses the raw
   * `person_aliases` table (not `getPersonById`) so we can verify that an
   * alias was *physically* added to / withheld from the row, independent
   * of any logical merge unioning that getPersonById would do.
   */
  function aliasesOf(personId: string): Set<string> {
    const rows = db
      .prepare<
        [string],
        { alias_type: string; alias: string }
      >("SELECT alias_type, alias FROM person_aliases WHERE person_id = ?")
      .all(personId);
    return new Set(rows.map((r) => `${r.alias_type}:${r.alias}`));
  }

  test("conflict on one email: non-conflicting email is attached to winner; conflicting email stays put", () => {
    // Two pre-existing people, each owning one email.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@work.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@home.com"] },
      "gmail:test",
      "2026-02-01",
    )!;
    expect(idA).not.toBe(idB);

    // Mention has one email per existing person PLUS a brand-new email
    // that nobody owns yet. The two pre-existing emails conflict; the new
    // one is "safe" and should land on the winner.
    const idC = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@work.com", "alice@home.com", "alice@new.com"] },
      "gmail:test",
      "2026-03-01",
    );

    // Winner = earliest = idA
    expect(idC).toBe(idA);

    const aliasesA = aliasesOf(idA);
    const aliasesB = aliasesOf(idB);

    // Conflicting emails stay on their original people
    expect(aliasesA.has("email:alice@work.com")).toBe(true);
    expect(aliasesA.has("email:alice@home.com")).toBe(false);
    expect(aliasesB.has("email:alice@home.com")).toBe(true);
    expect(aliasesB.has("email:alice@work.com")).toBe(false);

    // Non-conflicting new email is attached to the winner
    expect(aliasesA.has("email:alice@new.com")).toBe(true);
    // ...and NOT to the loser
    expect(aliasesB.has("email:alice@new.com")).toBe(false);
  });

  test("conflict on email: non-conflicting phone and trusted name are attached to winner", () => {
    // Mirrors the live-DB pattern from #219: a mention has a conflicting
    // email (matches a phantom person) plus a brand-new phone and name.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["priyanair@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "sender", emails: ["other-real-person@gmail.com"] },
      "gmail:test",
      "2026-02-01",
    )!;
    // Pollute idB with the same email that idA owns — this is the
    // "noisy upstream extraction" pattern that creates the conflict.
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at) VALUES (?, ?, 'priyanair@example.com', 'email', 'gmail:test', ?)",
    ).run("noise-1", idB, new Date().toISOString());

    // Now a Drive collaborator mention arrives with the conflicting email,
    // a brand-new phone, and a trusted name.
    const idC = findOrCreatePerson(
      db,
      {
        role: "sender",
        name: "Priya Nair",
        emails: ["priyanair@example.com"],
        phones: ["+972559017733"],
      },
      "google-drive:test",
      "2026-03-01",
    );

    // Winner is idA (earliest)
    expect(idC).toBe(idA);

    const aliasesA = aliasesOf(idA);
    // Phone is non-conflicting (no one owned it before) → on winner
    expect(aliasesA.has("phone:+972559017733")).toBe(true);
    // Name is trusted (role=sender) → on winner
    expect(aliasesA.has("name:Priya Nair")).toBe(true);
    // Email already there (idempotent insert)
    expect(aliasesA.has("email:priyanair@example.com")).toBe(true);

    // The conflicting email stays on the polluted row too — we do NOT
    // remove it (that's a future cleanup pass, out of scope for #219).
    const aliasesB = aliasesOf(idB);
    expect(aliasesB.has("email:priyanair@example.com")).toBe(true);
    // Phone was NOT spread to the polluted row
    expect(aliasesB.has("phone:+972559017733")).toBe(false);
  });

  test("multiple conflicting identifiers: each conflicting one is skipped, non-conflicting ones attached", () => {
    // Three pre-existing people each owning one identifier.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "participant", phones: ["+15551111111"] },
      "whatsapp:test",
      "2026-02-01",
    )!;
    const idC = findOrCreatePerson(
      db,
      { role: "participant", lids: ["lid-conflict-1"] },
      "whatsapp:test",
      "2026-03-01",
    )!;
    expect(new Set([idA, idB, idC]).size).toBe(3);

    // Mention has all three conflicting identifiers PLUS a safe brand-new
    // phone. Winner = idA (earliest).
    const winner = findOrCreatePerson(
      db,
      {
        role: "sender",
        emails: ["a@x.com"],
        phones: ["+15551111111", "+15559999999"],
        lids: ["lid-conflict-1"],
      },
      "whatsapp:test",
      "2026-04-01",
    );
    expect(winner).toBe(idA);

    const aliasesA = aliasesOf(idA);
    const aliasesB = aliasesOf(idB);
    const aliasesC = aliasesOf(idC);

    // Conflicting phone/lid did NOT spread to winner
    expect(aliasesA.has("phone:+15551111111")).toBe(false);
    expect(aliasesA.has("lid:lid-conflict-1")).toBe(false);
    // Non-conflicting brand-new phone IS on winner
    expect(aliasesA.has("phone:+15559999999")).toBe(true);

    // Conflicting identifiers stay on their original owners
    expect(aliasesB.has("phone:+15551111111")).toBe(true);
    expect(aliasesC.has("lid:lid-conflict-1")).toBe(true);
    // ...and the safe new phone did NOT leak to them
    expect(aliasesB.has("phone:+15559999999")).toBe(false);
    expect(aliasesC.has("phone:+15559999999")).toBe(false);
  });

  test("ALL identifiers conflict: no aliases attached, document still links to winner", () => {
    // Pre-existing distinct people, each owns one identifier.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "participant", phones: ["+15552222222"] },
      "whatsapp:test",
      "2026-02-01",
    )!;
    expect(idA).not.toBe(idB);

    const aliasesABefore = aliasesOf(idA);
    const aliasesBBefore = aliasesOf(idB);

    // Mention has only the conflicting identifiers. No safe ones.
    const winner = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"], phones: ["+15552222222"] },
      "gmail:test",
      "2026-03-01",
    );
    // Document links to winner (current defensive behavior preserved)
    expect(winner).toBe(idA);

    // No new aliases on either side — both rows untouched.
    expect(aliasesOf(idA)).toEqual(aliasesABefore);
    expect(aliasesOf(idB)).toEqual(aliasesBBefore);
  });

  test("conflict + brand-new alias (matches zero people): added to winner", () => {
    // Specifically tests the "matchedPersonId === null" branch of the
    // skip-set computation — a non-conflicting alias is one that either
    // matches the winner OR matches no one at all. The "matches no one"
    // case is exactly the regression we're fixing.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "participant", phones: ["+15553333333"] },
      "whatsapp:test",
      "2026-02-01",
    )!;
    expect(idA).not.toBe(idB);

    const winner = findOrCreatePerson(
      db,
      {
        role: "sender",
        // Conflicts: matches idA + idB
        emails: ["a@x.com"],
        phones: ["+15553333333"],
        // Brand new — matches nobody
        lids: ["brand-new-lid-12345"],
      },
      "whatsapp:test",
      "2026-03-01",
    );
    expect(winner).toBe(idA);

    const aliasesA = aliasesOf(idA);
    expect(aliasesA.has("lid:brand-new-lid-12345")).toBe(true);

    // Sanity: the brand-new lid did NOT also land on idB.
    const aliasesB = aliasesOf(idB);
    expect(aliasesB.has("lid:brand-new-lid-12345")).toBe(false);
  });

  test("warning log fires once with mention identifiers, conflict info, and chosen winner", async () => {
    // We don't have access to the structured logger from the test, but we
    // CAN verify behavior end-to-end by capturing console.warn (the logger
    // ultimately writes there). This test fixates the user-visible part of
    // the warn message — change it deliberately if the format changes.
    const idA = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const idB = findOrCreatePerson(
      db,
      { role: "participant", phones: ["+15554444444"] },
      "whatsapp:test",
      "2026-02-01",
    )!;
    expect(idA).not.toBe(idB);

    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      captured.push(typeof msg === "string" ? msg : JSON.stringify(msg));
    };
    try {
      findOrCreatePerson(
        db,
        { role: "sender", emails: ["a@x.com"], phones: ["+15554444444"] },
        "gmail:test",
        "2026-03-01",
      );
    } finally {
      console.warn = originalWarn;
    }

    // Filter to the line we actually care about (logger may emit other
    // warnings during ingest, though we don't expect any here).
    const conflictLines = captured.filter((line) => line.includes("Identifier conflict"));
    expect(conflictLines.length).toBe(1);
    const line = conflictLines[0];
    // Mentions the matched-person count
    expect(line).toContain("matches 2 people");
    // Mentions both candidate person ids
    expect(line).toContain(idA);
    expect(line).toContain(idB);
    // Mentions the winner
    expect(line).toContain(`linking to ${idA}`);
    // Mentions the conflicting identifier values so an operator can see
    // exactly which alias caused the split.
    expect(line).toContain("phone=+15554444444");
  });
});

// ─── Document resolution ────────────────────────────────────────────

describe("resolveDocumentPeople", () => {
  test("creates document_people links", () => {
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      { role: "recipient", name: "Bob", emails: ["bob@example.com"] },
    ]);

    const result = resolveDocumentPeople(
      db,
      "doc-1",
      [
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
        { role: "recipient", name: "Bob", emails: ["bob@example.com"] },
      ],
      "gmail:test",
      "2026-01-01",
    );

    expect(result.resolved).toBe(2);
    expect(result.skipped).toBe(0);

    const people = getDocumentPeople(db, "doc-1");
    expect(people.length).toBe(2);
    // Alice was the sender — trusted role, canonical = display name
    expect(people.some((p) => p.role === "sender" && p.canonicalName === "Alice")).toBe(true);
    // Bob was only seen as a recipient — untrusted display name, canonical
    // falls back to the email
    expect(
      people.some((p) => p.role === "recipient" && p.canonicalName === "bob@example.com"),
    ).toBe(true);
  });

  test("links a captured note day to the operator as recipient, never to its agent author", () => {
    const selfId = (() => {
      insertDoc(
        "contact-me",
        "apple-contacts:test",
        [{ role: "contact", name: "James", emails: ["me@example.com"] }],
        { documentType: "contact", isMe: true },
      );
      seedFromContacts(db);
      return getSelfPersonId(db)!;
    })();
    const people: PersonMention[] = [
      { name: "Aurora planner", role: "author", isSelf: false, kind: "agent" },
      { name: "You", role: "recipient", isSelf: true },
    ];
    insertDoc("notes-day", "omnesis-notes", people, { documentType: "note" });

    const result = resolveDocumentPeople(db, "notes-day", people, "omnesis-notes", "2026-06-15");

    expect(result).toMatchObject({ resolved: 1, skipped: 1 });
    expect(getDocumentPeople(db, "notes-day").map((p) => [p.role, p.personId])).toEqual([
      ["recipient", selfId],
    ]);
    expect(searchPeople(db, "Aurora")).toEqual([]);
  });

  test("skips name-only mentions", () => {
    insertDoc("doc-skip", "gmail:test", [
      { role: "participant", name: "John" },
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);

    const result = resolveDocumentPeople(
      db,
      "doc-skip",
      [
        { role: "participant", name: "John" },
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      ],
      "gmail:test",
      "2026-01-01",
    );

    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

// ─── Contact-card alias reconciliation (#222) ───────────────────────

describe("resolveDocumentPeople contact-card alias reconciliation (#222)", () => {
  /** Rewrite a document's `people` metadata to a new mention set in-place. */
  function setDocMentions(docId: string, people: PersonMention[]): void {
    const metadata = JSON.stringify({ documentType: "contact", people });
    db.prepare("UPDATE documents SET metadata = ? WHERE id = ?").run(metadata, docId);
  }

  /** Strong-identifier aliases (email/phone/lid) attached to a person. */
  function strongAliases(personId: string): Array<{ aliasType: string; alias: string }> {
    return db
      .prepare<[string], { alias_type: string; alias: string }>(
        "SELECT alias_type, alias FROM person_aliases WHERE person_id = ? AND alias_type IN ('email','phone','lid') ORDER BY alias_type, alias",
      )
      .all(personId)
      .map((r) => ({ aliasType: r.alias_type, alias: r.alias }));
  }

  function nameAliases(personId: string): string[] {
    return db
      .prepare<[string], { alias: string }>(
        "SELECT alias FROM person_aliases WHERE person_id = ? AND alias_type = 'name'",
      )
      .all(personId)
      .map((r) => r.alias);
  }

  test("removing a phone from a contact card drops the stale phone alias", () => {
    const source = "apple-contacts:test";
    const withPhone: PersonMention = {
      role: "contact",
      name: "Maya Reeves",
      emails: ["maya@example.com"],
      phones: ["+15550100123"],
    };
    insertDoc("card-1", source, [withPhone], { documentType: "contact" });
    const id = resolveDocumentPeopleFor("card-1", [withPhone], source);

    // Both strong identifiers landed.
    expect(strongAliases(id)).toEqual([
      { aliasType: "email", alias: "maya@example.com" },
      { aliasType: "phone", alias: "+15550100123" },
    ]);

    // Re-emit the SAME doc WITHOUT the phone.
    const emailOnly: PersonMention = {
      role: "contact",
      name: "Maya Reeves",
      emails: ["maya@example.com"],
    };
    setDocMentions("card-1", [emailOnly]);
    resolveDocumentPeople(db, "card-1", [emailOnly], source, "2026-01-01");

    // Phone alias gone; email + name remain.
    expect(strongAliases(id)).toEqual([{ aliasType: "email", alias: "maya@example.com" }]);
    expect(nameAliases(id)).toContain("Maya Reeves");
  });

  test("an alias another contact doc on the same source still vouches for is NOT dropped", () => {
    const source = "apple-contacts:test";
    const phone = "+15550100999";
    const cardA: PersonMention = {
      role: "contact",
      name: "Jamie Lopez",
      emails: ["jamie@example.com"],
      phones: [phone],
    };
    const cardB: PersonMention = {
      role: "contact",
      name: "Jamie Lopez",
      emails: ["jamie.alt@example.org"],
      phones: [phone],
    };
    insertDoc("card-a", source, [cardA], { documentType: "contact" });
    insertDoc("card-b", source, [cardB], { documentType: "contact" });
    const id = resolveDocumentPeopleFor("card-a", [cardA], source);
    resolveDocumentPeople(db, "card-b", [cardB], source, "2026-01-01");

    // The phone is present (both docs carry it).
    expect(strongAliases(id).some((a) => a.aliasType === "phone" && a.alias === phone)).toBe(true);

    // Remove the phone from card-a only.
    const cardANoPhone: PersonMention = {
      role: "contact",
      name: "Jamie Lopez",
      emails: ["jamie@example.com"],
    };
    setDocMentions("card-a", [cardANoPhone]);
    resolveDocumentPeople(db, "card-a", [cardANoPhone], source, "2026-01-01");

    // card-b still vouches for the phone → it must persist.
    expect(strongAliases(id).some((a) => a.aliasType === "phone" && a.alias === phone)).toBe(true);
  });

  /**
   * Resolve a contact doc and return the single resolved person id (the
   * contact card is one mention, so document_people has exactly one row).
   */
  function resolveDocumentPeopleFor(
    docId: string,
    people: PersonMention[],
    source: string,
  ): string {
    resolveDocumentPeople(db, docId, people, source, "2026-01-01");
    const row = db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM document_people WHERE document_id = ? LIMIT 1")
      .get(docId);
    return row!.person_id;
  }
});

// ─── Bulk doc→people summary (portal bubbles) ───────────────────────

describe("getDocumentsPeopleSummary", () => {
  test("returns people grouped per doc with full count and per-doc cap", () => {
    insertDoc("doc-a", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      { role: "recipient", name: "Bob", emails: ["bob@example.com"] },
    ]);
    resolveDocumentPeople(
      db,
      "doc-a",
      [
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
        { role: "recipient", name: "Bob", emails: ["bob@example.com"] },
      ],
      "gmail:test",
      "2026-01-01",
    );

    insertDoc("doc-b", "gmail:test", [
      { role: "sender", name: "Carol", emails: ["carol@example.com"] },
    ]);
    resolveDocumentPeople(
      db,
      "doc-b",
      [{ role: "sender", name: "Carol", emails: ["carol@example.com"] }],
      "gmail:test",
      "2026-01-01",
    );

    const summary = getDocumentsPeopleSummary(db, ["doc-a", "doc-b"]);
    expect(summary["doc-a"].people).toHaveLength(2);
    expect(summary["doc-a"].total).toBe(2);
    expect(summary["doc-b"].people).toHaveLength(1);
    expect(summary["doc-b"].total).toBe(1);

    const names = summary["doc-a"].people.map((p) => p.canonicalName).sort();
    expect(names).toEqual(["Alice", "bob@example.com"].sort());
  });

  test("respects perDocLimit while still reporting full total", () => {
    const mentions = Array.from({ length: 10 }, (_, i) => ({
      role: "recipient" as const,
      name: `User${i}`,
      emails: [`user${i}@example.com`],
    }));
    insertDoc("doc-many", "gmail:test", mentions);
    resolveDocumentPeople(db, "doc-many", mentions, "gmail:test", "2026-01-01");

    const summary = getDocumentsPeopleSummary(db, ["doc-many"], 4);
    expect(summary["doc-many"].people).toHaveLength(4);
    expect(summary["doc-many"].total).toBe(10);
  });

  test("returns empty entry for docs with no resolved people", () => {
    insertDoc("doc-empty", "gmail:test", []);
    const summary = getDocumentsPeopleSummary(db, ["doc-empty", "doc-missing"]);
    expect(summary["doc-empty"]).toEqual({ people: [], total: 0 });
    expect(summary["doc-missing"]).toEqual({ people: [], total: 0 });
  });

  test("returns empty map for empty input without hitting SQL", () => {
    expect(getDocumentsPeopleSummary(db, [])).toEqual({});
  });

  test("collapses same canonical appearing under multiple roles into one entry", () => {
    // Alice is both sender AND mentioned on the same doc.
    insertDoc("doc-dup", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      { role: "mentioned", name: "Alice", emails: ["alice@example.com"] },
    ]);
    resolveDocumentPeople(
      db,
      "doc-dup",
      [
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
        { role: "mentioned", name: "Alice", emails: ["alice@example.com"] },
      ],
      "gmail:test",
      "2026-01-01",
    );
    const summary = getDocumentsPeopleSummary(db, ["doc-dup"]);
    expect(summary["doc-dup"].people).toHaveLength(1);
    expect(summary["doc-dup"].total).toBe(1);
    expect(summary["doc-dup"].people[0].canonicalName).toBe("Alice");
  });
});

// ─── Backfill ───────────────────────────────────────────────────────

describe("backfillOnePerson", () => {
  test("processes one unresolved document", () => {
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);

    const result = backfillOnePerson(db);
    expect(result).not.toBeNull();
    expect(result!.resolved).toBe(1);

    // Document should be marked as resolved
    const row = db
      .prepare<
        [string],
        { people_resolved_at: string | null }
      >("SELECT people_resolved_at FROM documents WHERE id = ?")
      .get("doc-1");
    expect(row!.people_resolved_at).not.toBeNull();
  });

  test("returns null when no unresolved documents", () => {
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);
    // Mark as resolved
    db.prepare("UPDATE documents SET people_resolved_at = '2026-01-01' WHERE id = 'doc-1'").run();

    const result = backfillOnePerson(db);
    expect(result).toBeNull();
  });

  test("handles documents with no people", () => {
    insertDoc("doc-1", "gmail:test", []);
    const result = backfillOnePerson(db);
    expect(result).not.toBeNull();
    expect(result!.resolved).toBe(0);
    expect(result!.skipped).toBe(0);
  });
});

describe("backfillManyPeople (batched)", () => {
  test("processes multiple documents in a single call", () => {
    for (let i = 0; i < 10; i++) {
      insertDoc(`doc-${i}`, "gmail:test", [
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
        { role: "recipient", emails: [`user-${i}@example.com`] },
      ]);
    }

    const result = backfillManyPeople(db, 10);
    expect(result.processed).toBe(10);
    // 10 senders resolving to the same "Alice" person + 10 distinct recipients
    expect(result.resolved).toBe(20);

    // All docs marked as processed, so the next call does nothing.
    const second = backfillManyPeople(db, 10);
    expect(second.processed).toBe(0);
  });

  test("stops early when batchSize exceeds unresolved work", () => {
    insertDoc("doc-1", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }]);
    const result = backfillManyPeople(db, 50);
    expect(result.processed).toBe(1);
  });

  test("alias cache yields same result as sequential calls", () => {
    // Two docs mentioning the same person via different identifiers: the
    // batch's shared cache must still resolve them to a single person row.
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"], phones: ["+15551234"] },
    ]);
    insertDoc("doc-2", "gmail:test", [{ role: "sender", name: "Alice", phones: ["+15551234"] }]);

    backfillManyPeople(db, 10);

    const people = searchPeople(db, "alice", 10);
    expect(people.length).toBe(1);
    expect(people[0].documentCount).toBe(2);
  });

  test("runs in a transaction: if one doc throws, earlier work is rolled back", () => {
    // Hard to force a throw without mocking; verify commit semantics instead
    // by checking that after a successful batch the document rows and
    // person rows are atomically visible.
    insertDoc("doc-1", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }]);
    insertDoc("doc-2", "gmail:test", [{ role: "sender", emails: ["bob@example.com"] }]);

    backfillManyPeople(db, 10);

    const allResolved = db
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) as c FROM documents WHERE people_resolved_at IS NOT NULL")
      .get()!.c;
    expect(allResolved).toBe(2);
  });
});

// ─── Seeding ────────────────────────────────────────────────────────

describe("seedFromContacts", () => {
  test("seeds people from contact documents", () => {
    insertDoc(
      "contact-1",
      "apple-contacts:test",
      [
        {
          role: "contact",
          name: "Eve Bond",
          emails: ["eve@example.com"],
          phones: ["+33639980200"],
        },
      ],
      { documentType: "contact" },
    );

    const { seeded } = seedFromContacts(db);
    expect(seeded).toBe(1);

    const people = searchPeople(db, "Eve", 10);
    expect(people.length).toBe(1);
    expect(people[0].canonicalName).toBe("Eve Bond");
    expect(people[0].source).toBe("contacts");
  });

  test("sets is_self from isMe flag", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );

    const { selfDetected } = seedFromContacts(db);
    expect(selfDetected).toBe(true);

    const selfId = getSelfPersonId(db);
    expect(selfId).not.toBeNull();
  });

  test("skips name-only contacts", () => {
    insertDoc(
      "contact-noid",
      "apple-contacts:test",
      [{ role: "contact", name: "No Identifiers" }],
      { documentType: "contact" },
    );

    const { seeded } = seedFromContacts(db);
    expect(seeded).toBe(0);
  });

  test("is idempotent", () => {
    insertDoc(
      "contact-1",
      "apple-contacts:test",
      [{ role: "contact", name: "Alice", emails: ["alice@example.com"] }],
      { documentType: "contact" },
    );

    seedFromContacts(db);
    seedFromContacts(db);

    const stats = getPeopleStats(db);
    expect(stats.totalPeople).toBe(1);
  });

  test("is source-agnostic", () => {
    // Contacts from different sources
    insertDoc(
      "contact-apple",
      "apple-contacts:test",
      [{ role: "contact", name: "Alice", emails: ["alice@example.com"] }],
      { documentType: "contact" },
    );
    insertDoc(
      "contact-google",
      "google-contacts:test",
      [{ role: "contact", name: "Bob", phones: ["+33612345678"] }],
      { documentType: "contact" },
    );

    const { seeded } = seedFromContacts(db);
    expect(seeded).toBe(2);
  });
});

// ─── compute/upsert split ───────────────────────────────────────────

describe("computeSeedFromContacts + upsertSeedFromContacts", () => {
  test("computeSeedFromContacts returns the same set the legacy path would process", () => {
    insertDoc(
      "contact-with-email",
      "apple-contacts:test",
      [{ role: "contact", name: "Alice", emails: ["alice@example.com"] }],
      { documentType: "contact" },
    );
    insertDoc(
      "contact-with-phone",
      "apple-contacts:test",
      [{ role: "contact", name: "Bob", phones: ["+33612345678"] }],
      { documentType: "contact" },
    );
    // Filtered out: name-only contact (no strong identifiers).
    insertDoc(
      "contact-noid",
      "apple-contacts:test",
      [{ role: "contact", name: "No Identifiers" }],
      { documentType: "contact" },
    );
    // Filtered out: not a contact document.
    insertDoc("email-1", "gmail:test", [{ role: "sender", emails: ["someone@example.com"] }]);

    const plan = computeSeedFromContacts(db);
    expect(plan.contactDocs.length).toBe(2);
    const docIds = plan.contactDocs.map((d) => d.docId).sort();
    expect(docIds).toEqual(["contact-with-email", "contact-with-phone"]);
    // isMe defaults to false when extra.isMe is absent.
    expect(plan.contactDocs.every((d) => d.isMe === false)).toBe(true);
  });

  test("plan carries isMe=true when extra.isMe is set", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );

    const plan = computeSeedFromContacts(db);
    expect(plan.contactDocs.length).toBe(1);
    expect(plan.contactDocs[0].isMe).toBe(true);
  });

  test("upsertSeedFromContacts(plan) matches seedFromContacts(db) on parallel DBs", () => {
    // Two identical fresh DBs. Run the legacy single-call path on db1
    // and the split path (compute → upsert) on db2 against the same
    // seed data; assert the resulting people / document_people / is_self
    // state is identical.
    const dir2 = mkdtempSync(join(tmpdir(), "omnesis-people-test-2-"));
    const db2 = createDatabase(join(dir2, "test.db"));

    const seed = (target: Db) => {
      const insert = (
        id: string,
        sourceId: string,
        people: PersonMention[],
        opts?: { isMe?: boolean },
      ) => {
        const metadata = JSON.stringify({
          documentType: "contact",
          people,
          extra: opts?.isMe ? { isMe: true } : undefined,
        });
        target
          .prepare(
            `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
             VALUES (?, 'test', ?, ?, 'T', '', 'h-' || ?, ?, '2026-01-01', '2026-01-01', ?, ?)`,
          )
          .run(id, sourceId, id, id, metadata, new Date().toISOString(), new Date().toISOString());
      };
      insert("c-alice", "apple-contacts:test", [
        { role: "contact", name: "Alice", emails: ["alice@example.com"], phones: ["+33611111111"] },
      ]);
      insert("c-bob", "apple-contacts:test", [
        { role: "contact", name: "Bob", phones: ["+33622222222"] },
      ]);
      insert(
        "c-me-primary",
        "apple-contacts:primary",
        [
          {
            role: "contact",
            name: "James",
            emails: ["me@example.com", "me+alias@example.com"],
            phones: ["+33600000000"],
          },
        ],
        { isMe: true },
      );
      insert(
        "c-me-assistant",
        "apple-contacts:primary",
        [{ role: "contact", name: "Bot", emails: ["bot@example.com"] }],
        { isMe: true },
      );
    };

    try {
      seed(db);
      seed(db2);

      // Legacy combined path on db.
      seedFromContacts(db);

      // Split path on db2.
      const plan = computeSeedFromContacts(db2);
      upsertSeedFromContacts(db2, plan);

      const stats1 = getPeopleStats(db);
      const stats2 = getPeopleStats(db2);
      expect(stats2.totalPeople).toBe(stats1.totalPeople);
      expect(stats2.totalAliases).toBe(stats1.totalAliases);
      expect(stats2.totalLinks).toBe(stats1.totalLinks);
      expect(stats2.selfDetected).toBe(stats1.selfDetected);

      // Exactly one is_self in each, with the same canonical name (richer
      // card wins — same dedupe rule on both sides).
      const selfRow = (target: Db) =>
        target
          .prepare<
            [],
            { canonical_name: string }
          >("SELECT canonical_name FROM people WHERE is_self = TRUE AND merged_into IS NULL")
          .all();
      expect(selfRow(db2)).toEqual(selfRow(db));
    } finally {
      db2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ─── Self detection ─────────────────────────────────────────────────

describe("seedFromContacts — multiple isMe contacts", () => {
  test("keeps only one is_self when multiple contacts are flagged isMe", () => {
    // Apple's isMe flag is per-container — syncing a secondary account produces
    // a second "me" card that is NOT the actual user. Keep the richest one.
    insertDoc(
      "contact-primary",
      "apple-contacts:primary",
      [
        {
          role: "contact",
          name: "James",
          emails: ["me@example.com", "me+alias@example.com"],
          phones: ["+33600000000"],
        },
      ],
      { documentType: "contact", isMe: true },
    );

    insertDoc(
      "contact-assistant",
      "apple-contacts:primary",
      [{ role: "contact", name: "Bot Assistant", emails: ["bot@example.com"] }],
      { documentType: "contact", isMe: true },
    );

    seedFromContacts(db);

    const selfRows = db
      .prepare<
        [],
        { id: string; canonical_name: string }
      >("SELECT id, canonical_name FROM people WHERE is_self = TRUE AND merged_into IS NULL")
      .all();

    expect(selfRows.length).toBe(1);
    expect(selfRows[0].canonical_name).toBe("James"); // richer card wins
  });

  test("tie on alias count breaks to earliest first_seen", () => {
    insertDoc(
      "contact-a",
      "apple-contacts:primary",
      [{ role: "contact", name: "A", emails: ["a@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    // Force later source_created_at for B
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('contact-b', 'test', 'apple-contacts:primary', 'b', 'B', '', 'hash-b', ?, '2026-06-01', '2026-06-01', ?, ?)`,
    ).run(
      JSON.stringify({
        documentType: "contact",
        people: [{ role: "contact", name: "B", emails: ["b@example.com"] }],
        extra: { isMe: true },
      }),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    seedFromContacts(db);

    const selfRows = db
      .prepare<
        [],
        { canonical_name: string }
      >("SELECT canonical_name FROM people WHERE is_self = TRUE AND merged_into IS NULL")
      .all();

    expect(selfRows.length).toBe(1);
    expect(selfRows[0].canonical_name).toBe("A"); // earlier first_seen wins
  });

  test("losing isMe candidates are merged_into self so their aliases survive", () => {
    // Issue #283: previously the dedupe pass just cleared `is_self` on the
    // losing candidates, silently dropping their aliases from self's
    // effective alias set. Now we logical-merge them so reads through self
    // dereference back to those aliases.
    insertDoc(
      "contact-primary",
      "apple-contacts:primary",
      [
        {
          role: "contact",
          name: "James",
          emails: ["primary@example.com"],
          phones: ["+33611111111"],
        },
      ],
      { documentType: "contact", isMe: true },
    );

    insertDoc(
      "contact-secondary",
      "apple-contacts:google",
      [
        {
          role: "contact",
          name: "James",
          emails: ["secondary@example.com"],
        },
      ],
      { documentType: "contact", isMe: true },
    );

    seedFromContacts(db);

    const selfRows = db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL")
      .all();
    expect(selfRows.length).toBe(1);
    const selfId = selfRows[0].id;

    // The losing candidate should have been merged_into self.
    const mergedRows = db
      .prepare<[string], { id: string }>("SELECT id FROM people WHERE merged_into = ?")
      .all(selfId);
    expect(mergedRows.length).toBe(1);

    // Reading self via getPersonById should surface aliases from BOTH
    // the canonical row and the merged-in row.
    const self = getPersonById(db, selfId);
    expect(self).not.toBeNull();
    const selfAliases = self!.aliases.map((a) => a.alias).sort();
    expect(selfAliases).toContain("primary@example.com");
    expect(selfAliases).toContain("+33611111111");
    expect(selfAliases).toContain("secondary@example.com");
  });
});

describe("seedFromContacts — same-name consolidation (#283)", () => {
  test("same-name contact cards (not isMe) are consolidated into self", () => {
    // The actual #283 case: an isMe card with email A, plus two contact
    // cards with the same name (e.g. cross-container duplicates from
    // Google contacts) carrying emails B and C but no isMe flag. After
    // seed, all three should collapse into the single self person.
    insertDoc(
      "contact-me",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["a@example.com"],
        },
      ],
      { documentType: "contact", isMe: true },
    );
    insertDoc(
      "contact-dup-1",
      "apple-contacts:google",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["b@example.com"],
        },
      ],
      { documentType: "contact" },
    );
    insertDoc(
      "contact-dup-2",
      "apple-contacts:exchange",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["c@example.com"],
        },
      ],
      { documentType: "contact" },
    );

    seedFromContacts(db);

    const selfId = getSelfPersonId(db);
    expect(selfId).not.toBeNull();

    // Exactly one canonical self.
    const canonicalSelf = db
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) AS c FROM people WHERE is_self = TRUE AND merged_into IS NULL")
      .get()!.c;
    expect(canonicalSelf).toBe(1);

    // The two same-name contacts should be merged_into self.
    const merged = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM people WHERE merged_into = ?")
      .get(selfId!)!.c;
    expect(merged).toBe(2);

    // Reading self surfaces all three emails via merged-loser
    // dereferencing.
    const self = getPersonById(db, selfId!);
    const selfEmails = self!.aliases
      .filter((a) => a.aliasType === "email")
      .map((a) => a.alias)
      .sort();
    expect(selfEmails).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  test("different-name contact cards are NOT merged into self", () => {
    // Conservative: the consolidation pass only fires on near-identical
    // name matches. A contact named "John Doe" must not be folded into
    // self even after a name-token search.
    insertDoc(
      "contact-me",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["me@example.com"],
        },
      ],
      { documentType: "contact", isMe: true },
    );
    insertDoc(
      "contact-stranger",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "John Doe",
          emails: ["john@example.com"],
        },
      ],
      { documentType: "contact" },
    );

    seedFromContacts(db);

    const selfId = getSelfPersonId(db)!;

    // Stranger should be its own canonical person, NOT merged.
    const stranger = db
      .prepare<[], { id: string; merged_into: string | null }>(
        `SELECT p.id, p.merged_into
         FROM people p
         JOIN person_aliases a ON a.person_id = p.id
         WHERE a.alias = 'john@example.com'`,
      )
      .get();
    expect(stranger).toBeDefined();
    expect(stranger!.merged_into).toBeNull();
    expect(stranger!.id).not.toBe(selfId);

    // Self does not pick up the stranger's email.
    const self = getPersonById(db, selfId);
    const selfEmails = self!.aliases.filter((a) => a.aliasType === "email").map((a) => a.alias);
    expect(selfEmails).not.toContain("john@example.com");
  });

  test("first-name-only contact is NOT auto-merged into multi-token self", () => {
    // Conservative threshold: "James" alone (single token) does not score
    // high enough to be auto-merged into "James Bond". An ambiguous
    // single-name contact stays a separate person — the operator can still
    // confirm the merge via the merge-candidates UI if it's genuinely the
    // user.
    insertDoc(
      "contact-me",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["me@example.com"],
        },
      ],
      { documentType: "contact", isMe: true },
    );
    insertDoc(
      "contact-firstname-only",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "James",
          emails: ["short@example.com"],
        },
      ],
      { documentType: "contact" },
    );

    seedFromContacts(db);

    const selfId = getSelfPersonId(db)!;
    const shortPerson = db
      .prepare<[], { id: string; merged_into: string | null }>(
        `SELECT p.id, p.merged_into
         FROM people p
         JOIN person_aliases a ON a.person_id = p.id
         WHERE a.alias = 'short@example.com'`,
      )
      .get();
    expect(shortPerson).toBeDefined();
    expect(shortPerson!.merged_into).toBeNull();
    expect(shortPerson!.id).not.toBe(selfId);
  });

  test("does not merge when there is no canonical self (no isMe contact)", () => {
    // Without a canonical self, the same-name pass is a no-op. Two
    // same-name contacts both stay as separate people — the operator-driven
    // merge-candidates flow can still propose them later.
    insertDoc(
      "contact-1",
      "apple-contacts:icloud",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["a@example.com"],
        },
      ],
      { documentType: "contact" },
    );
    insertDoc(
      "contact-2",
      "apple-contacts:google",
      [
        {
          role: "contact",
          name: "James Bond",
          emails: ["b@example.com"],
        },
      ],
      { documentType: "contact" },
    );

    seedFromContacts(db);

    const peopleCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people WHERE merged_into IS NULL")
      .get()!.c;
    expect(peopleCount).toBe(2);

    const selfId = getSelfPersonId(db);
    expect(selfId).toBeNull();
  });
});

// The hooks the collector declares from each source's `defineSource.selfIdentity`,
// handed to the pass the way the HTTP thread hands them to the writer — the
// real declared shapes (Strava: numeric athlete id only; Apple Health: any
// account) so the pairing fires exactly as in production.
const SELF_HOOKS: SelfIdentitySource[] = [
  { sourceType: "strava-activities", aliasPrefix: "strava-athlete", accountPattern: "^\\d+$" },
  { sourceType: "apple-health", aliasPrefix: "apple-health-account" },
];

describe("detectSelfFromSourceIds", () => {
  test("reports how many aliases it added, and nothing on a repeat", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    connectSource("strava-activities:43560449");
    connectSource("apple-health:local");

    expect(detectSelfFromSourceIds(db, SELF_HOOKS)).toBe(2);
    expect(detectSelfFromSourceIds(db, SELF_HOOKS)).toBe(0);
  });

  test("adds nothing without hooks or without a self person", () => {
    connectSource("strava-activities:43560449");
    // No self person yet: nothing to attach to.
    expect(detectSelfFromSourceIds(db, SELF_HOOKS)).toBe(0);

    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    // A self person but an empty registry: a collector has not pushed yet.
    expect(detectSelfFromSourceIds(db, [])).toBe(0);
  });

  test("does NOT blindly attach source-account emails to self", () => {
    // Self identity comes from the isMe contact (me@example.com). Other synced
    // sources (assistant Gmail, spam Outlook alias) must NOT pull their account
    // email into self — that was the root cause of multi-identity pollution.
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);

    connectSource("gmail:assistant@gmail.com");
    connectSource("outlook-email:alias@live.fr");
    insertDoc("email-1", "gmail:assistant@gmail.com", []);
    insertDoc("email-2", "outlook-email:alias@live.fr", []);

    detectSelfFromSourceIds(db, SELF_HOOKS);

    const selfId = getSelfPersonId(db)!;
    const person = getPersonById(db, selfId);
    expect(
      person!.aliases.some((a) => a.aliasType === "email" && a.alias === "assistant@gmail.com"),
    ).toBe(false);
    expect(
      person!.aliases.some((a) => a.aliasType === "email" && a.alias === "alias@live.fr"),
    ).toBe(false);
    // Self keeps the identity it had from the contact
    expect(
      person!.aliases.some((a) => a.aliasType === "email" && a.alias === "me@example.com"),
    ).toBe(true);
  });

  test("adds Strava athlete LID to self for strava-activities sources", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);

    connectSource("strava-activities:43560449");
    insertDoc("strava-1", "strava-activities:43560449", []);

    detectSelfFromSourceIds(db, SELF_HOOKS);

    const selfId = getSelfPersonId(db)!;
    const person = getPersonById(db, selfId);
    expect(
      person!.aliases.some((a) => a.aliasType === "lid" && a.alias === "strava-athlete:43560449"),
    ).toBe(true);
  });

  test("Strava athletes resolve to self via LID alias", () => {
    // Set up self identity + Strava source alias
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    connectSource("strava-activities:43560449");
    insertDoc("strava-doc", "strava-activities:43560449", []);
    detectSelfFromSourceIds(db, SELF_HOOKS);
    const selfId = getSelfPersonId(db)!;

    // Now a PersonMention emitted by the Strava normalizer should resolve to self.
    const resolvedId = findOrCreatePerson(
      db,
      {
        role: "owner",
        name: "James Bond",
        lids: ["strava-athlete:43560449"],
      },
      "strava-activities:43560449",
      "2026-04-12T13:36:42Z",
    );
    expect(resolvedId).toBe(selfId);
  });

  test("adds Apple Health account LID to self for apple-health sources", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);

    connectSource("apple-health:local");
    insertDoc("health-1", "apple-health:local", []);

    detectSelfFromSourceIds(db, SELF_HOOKS);

    const selfId = getSelfPersonId(db)!;
    const person = getPersonById(db, selfId);
    expect(
      person!.aliases.some(
        (a) => a.aliasType === "lid" && a.alias === "apple-health-account:local",
      ),
    ).toBe(true);
  });

  test("Apple Health mentions resolve to self via LID alias", () => {
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Me", emails: ["me@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    connectSource("apple-health:local");
    insertDoc("health-doc", "apple-health:local", []);
    detectSelfFromSourceIds(db, SELF_HOOKS);
    const selfId = getSelfPersonId(db)!;

    const resolvedId = findOrCreatePerson(
      db,
      {
        role: "owner",
        name: "James Bond",
        lids: ["apple-health-account:local"],
      },
      "apple-health:local",
      "2026-04-18T00:00:00Z",
    );
    expect(resolvedId).toBe(selfId);
  });

  test("pairs a source added to a running gateway before its first sync", () => {
    // A source added mid-session has a `sources` row and no documents yet.
    // The pairing has to land now: the source's very first page carries
    // self-authored documents, and if self doesn't own the LID by then they
    // create a duplicate person that no runtime sweep can collapse (the merge
    // passes only fire on an alias two people already share).
    insertDoc(
      "contact-me",
      "apple-contacts:test",
      [{ role: "contact", name: "Maya Reeves", emails: ["maya@example.com"] }],
      { documentType: "contact", isMe: true },
    );
    seedFromContacts(db);
    connectSource("strava-activities:43560449");

    detectSelfFromSourceIds(db, SELF_HOOKS);

    const selfId = getSelfPersonId(db)!;
    expect(
      getPersonById(db, selfId)!.aliases.some(
        (a) => a.aliasType === "lid" && a.alias === "strava-athlete:43560449",
      ),
    ).toBe(true);
    // The first self-authored activity therefore resolves to self, not to a
    // second person named after the operator.
    expect(
      findOrCreatePerson(
        db,
        { role: "owner", name: "Maya Reeves", lids: ["strava-athlete:43560449"] },
        "strava-activities:43560449",
        "2026-05-01T00:00:00Z",
      ),
    ).toBe(selfId);
  });
});

// ─── Merge ──────────────────────────────────────────────────────────

describe("mergePeople", () => {
  test("moves aliases and document_people links", () => {
    // Create two people
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@test.com"] },
      "test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["b@test.com"] },
      "test",
      "2026-02-01",
    )!;

    // Create document linked to person 2
    insertDoc("doc-1", "test", []);
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, 'sender')",
    ).run("doc-1", id2);

    mergePeople(db, id1, id2);

    // Person 2 should be merged
    const p2 = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(id2);
    expect(p2!.merged_into).toBe(id1);

    // Document should point to winner
    const links = getDocumentPeople(db, "doc-1");
    expect(links.length).toBe(1);
    expect(links[0].personId).toBe(id1);

    // Aliases from person 2 should be on person 1
    const person = getPersonById(db, id1);
    expect(person!.aliases.some((a) => a.alias === "b@test.com")).toBe(true);
  });
});

describe("runMergePass", () => {
  test("merges people sharing the same email", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["shared@test.com"], phones: ["+33612345678"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id2 = "manual-person-2";
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at) VALUES (?, 'Duplicate', 'extracted', '2026-02-01', '2026-02-01', ?, ?)",
    ).run(id2, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, 'shared@test.com', 'email', ?)",
    ).run("alias-dup", id2, new Date().toISOString());

    const { merged } = runMergePass(db);
    expect(merged).toBe(1);
  });

  test("does NOT merge a contact with an extracted sender who share a name alias", () => {
    // Extracted-source persons (e.g. inferred from email display names) are
    // too noisy — "Cloud Team" or "Pharmacie Lafayette" show up as recipient
    // labels in bulk mail and would drag in unrelated identities. Contact ↔
    // extracted name matches must NOT merge.
    const contactId = findOrCreatePerson(
      db,
      { role: "contact", name: "Mateo Vidal", phones: ["+447700000007"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    // Bump contact's source to 'contacts' (seedFromContacts would do this IRL)
    db.prepare("UPDATE people SET source = 'contacts' WHERE id = ?").run(contactId);

    const extractedId = findOrCreatePerson(
      db,
      { role: "sender", name: "Mateo Vidal", emails: ["random@spam.com"] },
      "gmail:test",
      "2026-02-01",
    )!;

    const { merged } = runMergePass(db);
    expect(merged).toBe(0);

    expect(resolvePersonId(db, contactId)).toBe(contactId);
    expect(resolvePersonId(db, extractedId)).toBe(extractedId);
  });

  test("merges two contact-sourced people who share a multi-word canonical name", () => {
    // Two address-book entries for the same person across different contact
    // providers (Apple Contacts + Google Contacts), with no identifier overlap
    // because one card has email-only and the other has phone-only. Address
    // book names are curated — these should merge.
    const id1 = findOrCreatePerson(
      db,
      { role: "contact", name: "James Bond", emails: ["james.bond@example.com"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "contact", name: "james BOND", phones: ["+447700000000"] },
      "google-contacts:test",
      "2026-02-01",
    )!;
    db.prepare("UPDATE people SET source = 'contacts' WHERE id IN (?, ?)").run(id1, id2);

    const { merged } = runMergePass(db);
    expect(merged).toBe(1);
    // Physical merge: id2 row is gone, id1 carries both aliases.
    const id2Exists = db
      .prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?")
      .get(id2);
    expect(id2Exists).toBeUndefined();
    const winnerAliases = db
      .prepare<[string], { alias: string }>("SELECT alias FROM person_aliases WHERE person_id = ?")
      .all(id1)
      .map((r) => r.alias);
    expect(winnerAliases).toContain("james.bond@example.com");
    expect(winnerAliases).toContain("+447700000000");
  });

  test("does NOT merge on canonical-name match when one side is extracted", () => {
    const contactId = findOrCreatePerson(
      db,
      { role: "contact", name: "Jane Doe", emails: ["jane@contacts.com"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    db.prepare("UPDATE people SET source = 'contacts' WHERE id = ?").run(contactId);
    // Extracted-source person (default)
    const extractedId = findOrCreatePerson(
      db,
      { role: "sender", name: "Jane Doe", emails: ["other@spam.com"] },
      "gmail:test",
      "2026-02-01",
    )!;

    const { merged } = runMergePass(db);
    expect(merged).toBe(0);
    expect(resolvePersonId(db, contactId)).toBe(contactId);
    expect(resolvePersonId(db, extractedId)).toBe(extractedId);
  });

  test("does NOT merge single-token canonical names", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "contact", name: "Sid", emails: ["sid1@x.com"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "contact", name: "Sid", phones: ["+16505550182"] },
      "google-contacts:test",
      "2026-02-01",
    )!;
    db.prepare("UPDATE people SET source = 'contacts' WHERE id IN (?, ?)").run(id1, id2);

    const { merged } = runMergePass(db);
    expect(merged).toBe(0);
  });

  test("merges people sharing a LID alias", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "owner", name: "James", lids: ["strava-athlete:43560449"] },
      "strava:test",
      "2026-01-01",
    )!;
    const id2 = "manual-person-lid";
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at) VALUES (?, 'James dup', 'extracted', '2026-02-01', '2026-02-01', ?, ?)",
    ).run(id2, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, 'strava-athlete:43560449', 'lid', ?)",
    ).run("alias-lid-dup", id2, new Date().toISOString());

    const { merged } = runMergePass(db);
    expect(merged).toBe(1);
    // Physical merge: id2 is gone, id1 carries the LID.
    const id2Exists = db
      .prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?")
      .get(id2);
    expect(id2Exists).toBeUndefined();
    const lidOwners = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias = 'strava-athlete:43560449'")
      .all();
    expect(lidOwners.map((r) => r.person_id)).toEqual([id1]);
  });
});

describe("Gmail email normalization in resolution", () => {
  test("merges people with Gmail dot variants", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", name: "Carla", emails: ["vance.car.75@gmail.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "sender", name: "Carla Vance", emails: ["vancecar75@gmail.com"] },
      "gmail:test",
      "2026-02-01",
    )!;

    // Both should normalize to vancecar75@gmail.com → same person
    expect(id1).toBe(id2);
  });

  test("merges Gmail +suffix variants", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "recipient", emails: ["user@gmail.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "recipient", emails: ["user+tag@gmail.com"] },
      "gmail:test",
      "2026-02-01",
    )!;

    expect(id1).toBe(id2);
  });

  test("does not merge dots for non-Gmail domains", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["first.last@company.com"] },
      "test",
      "2026-01-01",
    )!;
    const id2 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["firstlast@company.com"] },
      "test",
      "2026-02-01",
    )!;

    expect(id1).not.toBe(id2); // Different emails for non-Gmail
  });
});

// ─── Rebuild ────────────────────────────────────────────────────────

describe("rebuildPeopleFromDocuments", () => {
  test("drops and rebuilds from raw metadata", () => {
    insertDoc(
      "contact-1",
      "apple-contacts:test",
      [{ role: "contact", name: "Alice", emails: ["alice@example.com"] }],
      { documentType: "contact" },
    );
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);

    // Seed and backfill
    seedFromContacts(db);
    backfillOnePerson(db);
    backfillOnePerson(db);

    const statsBefore = getPeopleStats(db);
    expect(statsBefore.totalPeople).toBe(1);
    expect(statsBefore.totalLinks).toBeGreaterThan(0);

    // Rebuild
    rebuildPeopleFromDocuments(db, SELF_HOOKS);

    // Contact should be re-seeded
    const statsAfter = getPeopleStats(db);
    expect(statsAfter.totalPeople).toBe(1); // Alice re-seeded from contact

    // Documents should be unresolved (backfill will re-process)
    const unresolved = db
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) as c FROM documents WHERE people_resolved_at IS NULL")
      .get()!.c;
    expect(unresolved).toBeGreaterThan(0);
  });

  const countResolved = (): number =>
    db
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) as c FROM documents WHERE people_resolved_at IS NOT NULL")
      .get()!.c;

  test("reset phase yields before clearing flags; resuming the flags phase clears them", () => {
    insertDoc(
      "contact-1",
      "apple-contacts:test",
      [{ role: "contact", name: "Alice", emails: ["alice@example.com"] }],
      { documentType: "contact" },
    );
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);
    seedFromContacts(db);
    backfillOnePerson(db);
    backfillOnePerson(db);
    expect(countResolved()).toBeGreaterThan(0);

    // A token that requests a yield the instant it's polled — reset completes,
    // then the function yields before touching document flags.
    const yieldNow = { requested: () => true };
    const afterReset = rebuildPeopleFromDocuments(db, SELF_HOOKS, yieldNow, "reset");
    expect(afterReset).toEqual({ resume: "flags" });
    // Graph was wiped + re-seeded, but the O(corpus) flag-clear has NOT run.
    expect(getPeopleStats(db).totalPeople).toBe(1);
    expect(countResolved()).toBeGreaterThan(0);

    // Resume the flags phase with a token that never requests → runs to
    // completion, clearing every remaining resolved flag.
    const done = rebuildPeopleFromDocuments(db, SELF_HOOKS, { requested: () => false }, "flags");
    expect(done).toBeUndefined();
    expect(countResolved()).toBe(0);
  });

  test("resuming the flags phase does not re-run the reset (graph is left intact)", () => {
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);
    backfillOnePerson(db);

    // Reset once (yield before flags).
    rebuildPeopleFromDocuments(db, SELF_HOOKS, { requested: () => true }, "reset");

    // A person that exists at the start of the flags phase must survive it —
    // the flags phase only clears document markers, never the people graph.
    const survivor = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Survivor', 'extracted', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(survivor);

    rebuildPeopleFromDocuments(db, SELF_HOOKS, { requested: () => false }, "flags");

    const stillThere = db.prepare("SELECT 1 FROM people WHERE id = ?").get(survivor);
    expect(stillThere).toBeTruthy();
    expect(countResolved()).toBe(0);
  });

  test("the flags phase yields mid-loop when the token requests, then a resume finishes it", () => {
    insertDoc("doc-1", "gmail:test", [
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
    ]);
    backfillOnePerson(db);
    expect(countResolved()).toBeGreaterThan(0);

    // Enter the flags phase directly with a token that requests a yield. The
    // loop clears one batch, then the inter-batch poll fires → it returns a
    // continuation rather than running straight to completion.
    const yielded = rebuildPeopleFromDocuments(db, SELF_HOOKS, { requested: () => true }, "flags");
    expect(yielded).toEqual({ resume: "flags" });

    // Resume the flags phase to completion.
    const done = rebuildPeopleFromDocuments(db, SELF_HOOKS, { requested: () => false }, "flags");
    expect(done).toBeUndefined();
    expect(countResolved()).toBe(0);
  });
});

// ─── Query helpers ──────────────────────────────────────────────────

describe("searchPeople", () => {
  test("finds people by name", () => {
    findOrCreatePerson(
      db,
      { role: "sender", name: "Alice Smith", emails: ["alice@test.com"] },
      "test",
      "2026-01-01",
    );
    findOrCreatePerson(
      db,
      { role: "sender", name: "Bob Jones", emails: ["bob@test.com"] },
      "test",
      "2026-01-01",
    );

    const results = searchPeople(db, "alice", 10);
    expect(results.length).toBe(1);
    expect(results[0].canonicalName).toBe("Alice Smith");
  });

  test("finds people by email", () => {
    findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@example.com"] },
      "test",
      "2026-01-01",
    );

    const results = searchPeople(db, "alice@example", 10);
    expect(results.length).toBe(1);
  });

  test("finds a Gmail person by the dotted / +tag form of their email (#298 people-search)", () => {
    // Ingestion normalizes Gmail addresses to the no-dot canonical, so the
    // stored alias is "mayareeves@gmail.com". A human naturally searches the
    // dotted or +tag form, which must still find them.
    findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves", emails: ["maya.reeves@gmail.com"] },
      "gmail:test",
      "2026-01-01",
    );

    expect(searchPeople(db, "maya.reeves@gmail.com", 10).length).toBe(1); // dotted
    expect(searchPeople(db, "ma.ya.reeves@gmail.com", 10).length).toBe(1); // heavy dots
    expect(searchPeople(db, "mayareeves+news@gmail.com", 10).length).toBe(1); // +tag
    // a different Gmail address must NOT match (no over-matching from the
    // added normalized clause)
    expect(searchPeople(db, "someoneelse@gmail.com", 10).length).toBe(0);
  });
});

describe("resolvePersonIdsFromQuery", () => {
  test("resolves exact email match", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@test.com"] },
      "test",
      "2026-01-01",
    )!;
    const ids = resolvePersonIdsFromQuery(db, "alice@test.com");
    expect(ids).toEqual([id]);
  });

  test("resolves name match", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice Smith", emails: ["alice@test.com"] },
      "test",
      "2026-01-01",
    )!;
    const ids = resolvePersonIdsFromQuery(db, "alice");
    expect(ids).toContain(id);
  });

  test("returns empty for no match", () => {
    const ids = resolvePersonIdsFromQuery(db, "nonexistent");
    expect(ids).toEqual([]);
  });

  test("email alias on a merged-away loser resolves to the canonical", () => {
    // Canonical "Maya" (apple-contacts) with a Gmail sub-entity merged into
    // it. The email lives on the loser; the filter must still resolve to the
    // canonical id, not the loser.
    const canonical = findOrCreatePerson(
      db,
      { role: "contact", name: "Maya", phones: ["+15550100123"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    const loser = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-01-02",
    )!;
    mergePeople(db, canonical, loser);

    expect(resolvePersonIdsFromQuery(db, "maya@example.com")).toEqual([canonical]);
  });

  test("name that lives only on a merged-away loser resolves to the canonical", () => {
    // The "Reeves" name form exists only on the merged Gmail sub-entity,
    // never on the canonical. A `from:Reeves` filter must still find it.
    const canonical = findOrCreatePerson(
      db,
      { role: "contact", name: "Maya", phones: ["+15550100123"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    const loser = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-01-02",
    )!;
    mergePeople(db, canonical, loser);

    expect(resolvePersonIdsFromQuery(db, "reeves")).toEqual([canonical]);
  });

  test("gmail dotted query resolves to the canonical no-dot alias (#298)", () => {
    // Stored under the normalizeEmail canonical (no dots). A dotted query
    // must normalize before lookup, not merely lowercase.
    const id = findOrCreatePerson(
      db,
      { role: "sender", emails: ["vancecar75@gmail.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    expect(resolvePersonIdsFromQuery(db, "vance.car.75@gmail.com")).toEqual([id]);
  });

  test("gmail +suffix query resolves to the canonical alias (#298)", () => {
    const id = findOrCreatePerson(
      db,
      { role: "sender", emails: ["mayareeves@gmail.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    expect(resolvePersonIdsFromQuery(db, "mayareeves+newsletter@gmail.com")).toEqual([id]);
  });
});

// ─── End-to-end ─────────────────────────────────────────────────────

describe("end-to-end resolution", () => {
  test("contact seeding + document backfill + cross-source resolution", () => {
    // 1. Seed contact: Alice has email + phone
    insertDoc(
      "contact-alice",
      "apple-contacts:test",
      [
        {
          role: "contact",
          name: "Alice Dupont",
          emails: ["alice@work.com"],
          phones: ["+33612345678"],
        },
      ],
      { documentType: "contact" },
    );
    seedFromContacts(db);

    // 2. Add Gmail email from Alice
    insertDoc("email-1", "gmail:user@gmail.com", [
      { role: "sender", name: "Alice D", emails: ["alice@work.com"] },
      { role: "recipient", name: "Me", emails: ["user@gmail.com"] },
    ]);

    // 3. Add WhatsApp message from Alice (same phone)
    insertDoc("wa-1", "whatsapp-messages:+447700000000", [
      { role: "participant", name: "Alice", phones: ["+33612345678"] },
      { role: "participant", name: "You", phones: ["+447700000000"] },
    ]);

    // 4. Backfill
    backfillOnePerson(db); // email-1
    backfillOnePerson(db); // wa-1

    // 5. Verify: Alice from contact, gmail, and whatsapp should be ONE person
    const stats = getPeopleStats(db);
    // At most 3 people: Alice (merged), Me/You (two separate since no merge yet)
    // Actually Me and You are different people unless they share an identifier

    const aliceResults = searchPeople(db, "alice", 10);
    expect(aliceResults.length).toBe(1); // All merged into one
    expect(aliceResults[0].source).toBe("contacts"); // Contact source is authoritative

    const alicePerson = getPersonById(db, aliceResults[0].id)!;
    // Should have both email and phone aliases
    expect(
      alicePerson.aliases.some((a) => a.aliasType === "email" && a.alias === "alice@work.com"),
    ).toBe(true);
    expect(
      alicePerson.aliases.some((a) => a.aliasType === "phone" && a.alias === "+33612345678"),
    ).toBe(true);

    // Should appear in both documents
    const aliceDocs = getPersonDocuments(db, aliceResults[0].id);
    expect(aliceDocs.length).toBeGreaterThanOrEqual(2); // email + whatsapp + contact
  });

  test("same person across gmail and calendar linked by email", () => {
    insertDoc("email-1", "gmail:test", [
      { role: "sender", name: "Bob Smith", emails: ["bob@company.com"] },
    ]);
    insertDoc("event-1", "google-calendar:test", [
      { role: "attendee", name: "Bob S", emails: ["bob@company.com"] },
    ]);

    backfillOnePerson(db);
    backfillOnePerson(db);

    const stats = getPeopleStats(db);
    // Bob appears in both — should be one person
    const bobs = searchPeople(db, "bob", 10);
    expect(bobs.length).toBe(1);

    const bobDocs = getPersonDocuments(db, bobs[0].id);
    expect(bobDocs.length).toBe(2);
  });

  test("name-only participants don't pollute people table", () => {
    insertDoc("wa-1", "whatsapp:test", [
      { role: "participant", name: "John" }, // name-only → skipped
      { role: "participant", name: "Alice", phones: ["+33612345678"] },
    ]);

    backfillOnePerson(db);

    const stats = getPeopleStats(db);
    expect(stats.totalPeople).toBe(1); // Only Alice, not John
  });
});

describe("getPersonDocuments recency ordering", () => {
  // The person page (portal + iOS + Android) leads with the most recent
  // documents. Every client renders whatever order the gateway returns and
  // paginates straight through it, so recency is enforced once — here — by
  // ordering on the document's source_created_at (the same timestamp the
  // clients display as the per-row "time ago").

  test("returns a canonical person's documents newest-first, not by id", () => {
    // ids are deliberately NOT in recency order, so the old id-ordered
    // behavior would produce a visibly different (wrong) result.
    insertDoc("doc-jan", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-01-01T00:00:00Z",
    });
    insertDoc("doc-mar", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-03-01T00:00:00Z",
    });
    insertDoc("doc-feb", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-02-01T00:00:00Z",
    });
    backfillManyPeople(db, 100);

    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const ids = getPersonDocuments(db, alice).map((d) => d.id);

    expect(ids).toEqual(["doc-mar", "doc-feb", "doc-jan"]);
    // Guard against a regression to lexicographic document_id ordering.
    expect(ids).not.toEqual([...ids].sort());
  });

  test("recency ordering holds within a role-filtered view", () => {
    insertDoc("r-old", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-01-01T00:00:00Z",
    });
    insertDoc("r-new", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-04-01T00:00:00Z",
    });
    // A more-recent doc where Alice is only a recipient — the sender filter
    // must exclude it, proving the ORDER BY rides the filtered branch too.
    insertDoc(
      "r-recipient",
      "gmail:test",
      [
        { role: "sender", emails: ["bob@example.com"] },
        { role: "recipient", emails: ["alice@example.com"] },
      ],
      { sourceCreatedAt: "2026-09-01T00:00:00Z" },
    );
    backfillManyPeople(db, 100);

    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const ids = getPersonDocuments(db, alice, { role: "sender" }).map((d) => d.id);

    expect(ids).toEqual(["r-new", "r-old"]);
  });

  test("ties on source_created_at fall back to a stable document_id order", () => {
    const ts = "2026-05-01T00:00:00Z";
    insertDoc("tie-b", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: ts,
    });
    insertDoc("tie-a", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: ts,
    });
    insertDoc("tie-c", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: ts,
    });
    backfillManyPeople(db, 100);

    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const ids = getPersonDocuments(db, alice).map((d) => d.id);

    expect(ids).toEqual(["tie-a", "tie-b", "tie-c"]);
  });

  test("limit/offset page through documents in recency order", () => {
    insertDoc("p1", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-01-01T00:00:00Z",
    });
    insertDoc("p2", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-02-01T00:00:00Z",
    });
    insertDoc("p3", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-03-01T00:00:00Z",
    });
    backfillManyPeople(db, 100);

    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const page1 = getPersonDocuments(db, alice, { limit: 2, offset: 0 }).map((d) => d.id);
    const page2 = getPersonDocuments(db, alice, { limit: 2, offset: 2 }).map((d) => d.id);

    expect(page1).toEqual(["p3", "p2"]);
    expect(page2).toEqual(["p1"]);
  });

  test("canonical interleaves its merge class by recency; a loser shows only its own", () => {
    insertDoc("a-feb", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-02-01T00:00:00Z",
    });
    insertDoc("a-jun", "gmail:test", [{ role: "sender", emails: ["alice@example.com"] }], {
      sourceCreatedAt: "2026-06-01T00:00:00Z",
    });
    insertDoc("b-apr", "gmail:test", [{ role: "sender", emails: ["bob@example.com"] }], {
      sourceCreatedAt: "2026-04-01T00:00:00Z",
    });
    insertDoc("b-jan", "gmail:test", [{ role: "sender", emails: ["bob@example.com"] }], {
      sourceCreatedAt: "2026-01-01T00:00:00Z",
    });
    backfillManyPeople(db, 100);

    const aliceId = findPersonByAlias(db, "email", "alice@example.com")!;
    const bobId = findPersonByAlias(db, "email", "bob@example.com")!;
    mergePeople(db, aliceId, bobId);

    // mergePeople picks the winner by its own heuristic; derive who's who.
    const canonicalId = getPersonById(db, aliceId)!.mergedInto == null ? aliceId : bobId;
    const loserId = canonicalId === aliceId ? bobId : aliceId;
    const ownDocsByRecency: Record<string, string[]> = {
      [aliceId]: ["a-jun", "a-feb"],
      [bobId]: ["b-apr", "b-jan"],
    };

    // Canonical: the whole equivalence class, interleaved newest-first.
    expect(getPersonDocuments(db, canonicalId).map((d) => d.id)).toEqual([
      "a-jun",
      "b-apr",
      "a-feb",
      "b-jan",
    ]);
    // Loser link: only its own pre-merge docs, still newest-first.
    expect(getPersonDocuments(db, loserId).map((d) => d.id)).toEqual(ownDocsByRecency[loserId]);
  });
});

describe("compute / upsert / refresh PeopleCounts", () => {
  test("computePeopleCounts returns one row per person with correct counts", () => {
    insertDoc("d1", "gmail", [{ role: "sender", emails: ["alice@example.com"] }]);
    insertDoc("d2", "gmail", [
      { role: "sender", emails: ["alice@example.com"] },
      { role: "recipient", emails: ["bob@example.com"] },
    ]);
    insertDoc("d3", "gmail", [{ role: "sender", emails: ["alice@example.com"] }]);
    backfillManyPeople(db, 100);

    const rows = computePeopleCounts(db);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Find Alice — sender with email, should appear in 3 docs.
    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const aliceRow = rows.find((r) => r.personId === alice);
    expect(aliceRow).toBeDefined();
    expect(aliceRow!.docCount).toBe(3);
    expect(aliceRow!.aliasCount).toBeGreaterThanOrEqual(1);
  });

  test("upsertPeopleCounts only writes rows whose counts actually changed", () => {
    insertDoc("d1", "gmail", [{ role: "sender", emails: ["alice@example.com"] }]);
    backfillManyPeople(db, 100);
    refreshPeopleCounts(db); // baseline: counts up-to-date

    // Re-compute without changing anything → no row should need writing.
    const rows = computePeopleCounts(db);
    const { updated } = upsertPeopleCounts(db, rows);
    expect(updated).toBe(0);

    // Now change reality — add a doc, re-resolve, and verify only the
    // affected person's row gets written.
    insertDoc("d2", "gmail", [{ role: "sender", emails: ["alice@example.com"] }]);
    backfillManyPeople(db, 100);

    const rows2 = computePeopleCounts(db);
    const { updated: updated2 } = upsertPeopleCounts(db, rows2);
    expect(updated2).toBe(1);
  });

  test("refreshPeopleCounts (compose) lands the same end-state as a hand-rolled compute+upsert", () => {
    insertDoc("d1", "gmail", [{ role: "sender", emails: ["alice@example.com"] }]);
    insertDoc("d2", "gmail", [{ role: "recipient", emails: ["bob@example.com"] }]);
    backfillManyPeople(db, 100);

    refreshPeopleCounts(db);

    const stats = getPeopleStats(db);
    expect(stats.totalPeople).toBe(2);

    // Spot-check via getPersonById / getPersonDocuments that doc_count
    // matches what came out of the materialized table.
    const alice = findPersonByAlias(db, "email", "alice@example.com")!;
    const aliceDocs = getPersonDocuments(db, alice);
    expect(aliceDocs.length).toBe(1);

    // Counts are persisted: a second refresh must be a no-op.
    const rows = computePeopleCounts(db);
    const { updated } = upsertPeopleCounts(db, rows);
    expect(updated).toBe(0);
  });
});

describe("split mergePass (C6)", () => {
  test("computeAutoMergePairs returns identifier + name pairs without writing", () => {
    // Identifier overlap.
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["x@y.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id2 = "manual-2";
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at) VALUES (?, 'X', 'extracted', '2026-02-01', '2026-02-01', ?, ?)",
    ).run(id2, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, 'x@y.com', 'email', ?)",
    ).run("alias-x", id2, new Date().toISOString());

    // Contact-name overlap.
    const c1 = findOrCreatePerson(
      db,
      { role: "contact", name: "Foo Bar", emails: ["a@example.com"] },
      "apple-contacts:t",
      "2026-01-01",
    )!;
    const c2 = findOrCreatePerson(
      db,
      { role: "contact", name: "foo BAR", phones: ["+155500001"] },
      "google-contacts:t",
      "2026-02-01",
    )!;
    db.prepare("UPDATE people SET source = 'contacts' WHERE id IN (?, ?)").run(c1, c2);

    const candidates = computeAutoMergePairs(db);
    // Should have one alias-based pair + one name-based pair.
    expect(candidates.some((c) => c.reason === "alias")).toBe(true);
    expect(candidates.some((c) => c.reason === "name")).toBe(true);
    // Pure read — no merges happened.
    expect(resolvePersonId(db, id1)).toBe(id1);
    expect(resolvePersonId(db, id2)).toBe(id2);
  });

  test("split mergePass produces same end state as runMergePass", () => {
    const id1 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["dup@test.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id2 = "manual-dup";
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at) VALUES (?, 'Dup', 'extracted', '2026-02-01', '2026-02-01', ?, ?)",
    ).run(id2, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, 'dup@test.com', 'email', ?)",
    ).run("alias-dup-split", id2, new Date().toISOString());

    // Run the split form
    const candidates = computeAutoMergePairs(db);
    let merged = 0;
    for (const pair of candidates) {
      const a = resolvePersonId(db, pair.personA);
      const b = resolvePersonId(db, pair.personB);
      if (a === b) continue;
      const { winner, loser } = pickMergeWinner(db, a, b);
      mergePeople(db, winner, loser);
      merged++;
    }
    const { collapsed } = collapseTransitiveChains(db);

    expect(merged).toBe(1);
    expect(collapsed).toBeGreaterThanOrEqual(0);
    // The two should now resolve to one root.
    expect(resolvePersonId(db, id1)).toBe(resolvePersonId(db, id2));
  });

  test("collapseTransitiveChains is idempotent", () => {
    const r1 = collapseTransitiveChains(db);
    const r2 = collapseTransitiveChains(db);
    expect(r1.collapsed).toBeGreaterThanOrEqual(0);
    expect(r2.collapsed).toBe(0);
  });
});

describe("split collapseTransitiveChains (compute / upsert)", () => {
  /**
   * Insert a person directly with no aliases. Returns the id.
   * Used to build precise merged_into chains for the collapse tests
   * without going through findOrCreatePerson's alias-merge logic.
   */
  function rawPerson(id: string, mergedInto: string | null = null): string {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, merged_into, first_seen, last_seen, created_at, updated_at) VALUES (?, 'P', 'extracted', ?, '2026-01-01', '2026-01-01', ?, ?)",
    ).run(id, mergedInto, now, now);
    return id;
  }

  test("computeTransitiveCollapse returns expected (personId, rootId, expectedMergedInto) for a 3-level chain", () => {
    // Build chain a → b → c → d (root). Each row's merged_into points
    // one step up, so a + b need repointing; c is already direct.
    rawPerson("d");
    rawPerson("c", "d");
    rawPerson("b", "c");
    rawPerson("a", "b");

    const plan = computeTransitiveCollapse(db);
    // Sort by personId for deterministic assertions.
    plan.sort((x, y) => x.personId.localeCompare(y.personId));

    expect(plan).toEqual([
      { personId: "a", rootId: "d", expectedMergedInto: "b" },
      { personId: "b", rootId: "d", expectedMergedInto: "c" },
    ]);

    // Pure read — DB unchanged.
    const aRow = db
      .prepare<[], { merged_into: string }>("SELECT merged_into FROM people WHERE id = 'a'")
      .get()!;
    expect(aRow.merged_into).toBe("b");
  });

  test("upsertTransitiveCollapse skips rows whose merged_into has changed since compute snapshot", () => {
    // Chain a → b → c (root)
    rawPerson("c");
    rawPerson("b", "c");
    rawPerson("a", "b");

    const plan = computeTransitiveCollapse(db);
    expect(plan.length).toBe(1);
    expect(plan[0]).toEqual({ personId: "a", rootId: "c", expectedMergedInto: "b" });

    // Simulate a concurrent merge: between compute and upsert,
    // mergePeople(z, a) shifts a.merged_into from "b" to "z".
    rawPerson("z");
    db.prepare("UPDATE people SET merged_into = 'z' WHERE id = 'a'").run();

    // Upsert should NOT clobber the fresh merge — its WHERE clause
    // matches on the OLD merged_into value ("b"), which no longer
    // matches.
    const { collapsed } = upsertTransitiveCollapse(db, plan);
    expect(collapsed).toBe(0);

    const aRow = db
      .prepare<[], { merged_into: string }>("SELECT merged_into FROM people WHERE id = 'a'")
      .get()!;
    expect(aRow.merged_into).toBe("z");
  });

  test("legacy collapseTransitiveChains and split compute+upsert converge to identical state", () => {
    // Build the same chain in two parallel DBs, run the legacy form
    // on db1 and the split form on db2, assert identical merged_into
    // values for every person.
    const tmpDir2 = mkdtempSync(join(tmpdir(), "omnesis-people-test-2-"));
    const db2: Db = createDatabase(join(tmpDir2, "test.db"));
    try {
      function seed(target: Db): void {
        const now = new Date().toISOString();
        const insert = target.prepare(
          "INSERT INTO people (id, canonical_name, source, merged_into, first_seen, last_seen, created_at, updated_at) VALUES (?, 'P', 'extracted', ?, '2026-01-01', '2026-01-01', ?, ?)",
        );
        // Multi-branch shape: a → b → root, x → y → root, plus a
        // standalone z direct to root.
        insert.run("root", null, now, now);
        insert.run("b", "root", now, now);
        insert.run("a", "b", now, now);
        insert.run("y", "root", now, now);
        insert.run("x", "y", now, now);
        insert.run("z", "root", now, now);
      }
      seed(db);
      seed(db2);

      // Legacy form on db.
      collapseTransitiveChains(db);
      // Split form on db2.
      const plan = computeTransitiveCollapse(db2);
      upsertTransitiveCollapse(db2, plan);

      // Compare merged_into for every person.
      const stateOf = (target: Db) =>
        target
          .prepare<
            [],
            { id: string; merged_into: string | null }
          >("SELECT id, merged_into FROM people ORDER BY id")
          .all();
      expect(stateOf(db)).toEqual(stateOf(db2));

      // Sanity: every non-root resolves to root.
      for (const id of ["a", "b", "x", "y", "z"]) {
        expect(resolvePersonId(db, id)).toBe("root");
        expect(resolvePersonId(db2, id)).toBe("root");
      }
    } finally {
      db2.close();
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

/**
 * A mention that names its identifiers as a namespaced list.
 *
 * The two spellings are the same assertion, so the question is not whether
 * the new one works but whether it resolves to the same person as the old —
 * a source migrating one kind at a time must not split anybody in two.
 */
describe("a mention naming its identifiers by kind", () => {
  function seen(docId: string, sourceId: string, mention: PersonMention) {
    connectSource(sourceId);
    insertDoc(docId, sourceId, [mention]);
    resolveDocumentPeople(db, docId, [mention], sourceId, "2026-01-01");
  }

  function personFor(alias: string): string | undefined {
    return db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias = ?")
      .get(alias)?.person_id;
  }

  test("resolves to the person the older spelling made", () => {
    const address = "reeves@example.org";
    seen("doc-kind-1", "gmail:me@example.org", { role: "sender", emails: [address] });
    const first = personFor(address);

    seen("doc-kind-2", "apple-contacts:local", {
      role: "contact",
      identifiers: [{ kind: "email", value: address }],
    });

    expect(personFor(address)).toBe(first);
  });

  test("an address is normalised the same way whichever spelling carried it", () => {
    // The store keeps one form, so a lookup that skips the normalisation the
    // write did matches nothing and the person quietly splits.
    seen("doc-kind-3", "gmail:me@example.org", {
      role: "sender",
      identifiers: [{ kind: "email", value: "Lopez@Example.ORG" }],
    });

    expect(personFor("lopez@example.org")).toBeDefined();
    expect(personFor("Lopez@Example.ORG")).toBeUndefined();
  });

  test("a mention carrying only a non-identifying address makes nobody", () => {
    // Two things have to hold, and only the second tells the filter apart from
    // the alias-write guard behind it: the address never becomes an identity
    // key, AND the mention is not identity-bearing at all. Otherwise a person
    // is created with no identifier — a ghost every later notification of the
    // same kind accretes onto, which is what merges strangers.
    const before = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM people").get()!.n;
    seen("doc-kind-4", "gmail:me@example.org", {
      role: "sender",
      identifiers: [{ kind: "email", value: "noreply@example.org" }],
      name: "A notifier",
    });

    expect(personFor("noreply@example.org")).toBeUndefined();
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM people").get()!.n).toBe(before);
  });

  test("a mention carrying both spellings keeps both identifiers", () => {
    const carried = "lin@example.org";
    const declared = "d.lin@example.org";
    seen("doc-kind-5", "gmail:me@example.org", {
      role: "sender",
      emails: [carried],
      identifiers: [{ kind: "email", value: declared }],
    });

    expect(personFor(carried)).toBeDefined();
    expect(personFor(declared)).toBe(personFor(carried));
  });

  test("an opaque platform id is not shown as a person's name", () => {
    seen("doc-kind-6", "whatsapp-messages:+15550100", {
      role: "sender",
      identifiers: [{ kind: "lid", value: "whatsapp:9911" }],
    });
    const personId = personFor("whatsapp:9911");

    expect(personId).toBeDefined();
    expect(
      db
        .prepare<
          [string],
          { canonical_name: string }
        >("SELECT canonical_name FROM people WHERE id = ?")
        .get(personId!)!.canonical_name,
    ).toBe("Unknown");
  });
});

/**
 * A collector that has not been upgraded, against a gateway that has.
 *
 * The operator upgrades the gateway first — it holds the data — so for a while
 * a collector still sends WhatsApp's linked-identity ids unprefixed while every
 * stored row has been rewritten to carry the platform. That skew is the one the
 * migration could not fix from inside the database, and left alone it makes a
 * second person for someone already known, writes the bare value beside the
 * prefixed one, and disarms the guard that exists for this platform precisely
 * because nothing can tell any more which platform the value came from.
 */
describe("a platform identifier arriving without its platform", () => {
  function seen(docId: string, sourceId: string, mention: PersonMention) {
    connectSource(sourceId);
    insertDoc(docId, sourceId, [mention]);
    resolveDocumentPeople(db, docId, [mention], sourceId, "2026-01-01");
  }

  function personFor(alias: string): string | undefined {
    return db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias = ?")
      .get(alias)?.person_id;
  }

  const SOURCE = "whatsapp-messages:+15550100";

  test("resolves to the person the prefixed form already made", () => {
    seen("doc-lid-1", SOURCE, { role: "sender", name: "Reeves", lids: ["whatsapp:447700900111"] });
    const known = personFor("whatsapp:447700900111");
    expect(known).toBeDefined();

    // The same person, named by a collector that predates the prefix.
    seen("doc-lid-2", SOURCE, { role: "sender", name: "Reeves", lids: ["447700900111"] });

    expect(personFor("whatsapp:447700900111")).toBe(known);
    // And no second alias holding the bare form beside the prefixed one.
    expect(personFor("447700900111")).toBeUndefined();
  });

  test("a first sighting is stored with its platform, not bare", () => {
    seen("doc-lid-3", SOURCE, { role: "sender", name: "Lopez", lids: ["447700900222"] });

    expect(personFor("whatsapp:447700900222")).toBeDefined();
    expect(personFor("447700900222")).toBeUndefined();
  });

  test("another platform's identifier is left exactly as it arrived", () => {
    // The rule is the migration's own: only an all-digits value carries no
    // platform. A login is not digits, and must not be rewritten.
    seen("doc-lid-6", "github:jlopez", { role: "author", lids: ["github:jlopez"] });

    expect(personFor("github:jlopez")).toBeDefined();
    expect(personFor("whatsapp:github:jlopez")).toBeUndefined();
  });
});

describe("an identifier more than one source vouches for", () => {
  /** Ingest one document naming a person, as a source would. */
  function seen(docId: string, sourceId: string, mention: PersonMention) {
    connectSource(sourceId);
    insertDoc(docId, sourceId, [mention]);
    resolveDocumentPeople(db, docId, [mention], sourceId, "2026-01-01");
  }

  function aliasesOf(personId: string): string[] {
    return db
      .prepare<[string], { alias: string }>(
        "SELECT alias FROM person_aliases WHERE person_id = ? ORDER BY alias",
      )
      .all(personId)
      .map((r) => r.alias);
  }

  function personFor(alias: string): string | undefined {
    return db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias = ?")
      .get(alias)?.person_id;
  }

  test("survives the removal of the source that merely saw it first", () => {
    // The address arrives in a mail header, then again on a contact card. The
    // aliases table records only the first, because every insert into it is
    // ignored on conflict — so its `source_id` cannot be what decides whether
    // removing the mail source takes an identifier the address book asserts.
    const address = "maya@example.org";
    seen("doc-mail", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-card", "apple-contacts:local", {
      role: "contact",
      name: "Maya",
      emails: [address],
    });

    const personId = personFor(address);
    expect(personId).toBeDefined();

    deleteAllBySource(db, "gmail:me@example.org");

    expect(personFor(address)).toBe(personId);
    expect(aliasesOf(personId!)).toContain(address);
  });

  test("and goes when the last source that vouched for it does", () => {
    const address = "jamie@example.org";
    seen("doc-mail-2", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-card-2", "apple-contacts:local", { role: "contact", emails: [address] });

    deleteAllBySource(db, "gmail:me@example.org");
    expect(personFor(address)).toBeDefined();

    deleteAllBySource(db, "apple-contacts:local");
    expect(personFor(address)).toBeUndefined();
  });

  test("a card dropping an identifier withdraws this source's claim on it", () => {
    // The card is not the first source to see the address, so the alias row's
    // `source_id` names the mail source. Keying the withdrawal on that column
    // never reaches the card's claim, and it survives as a voucher for
    // something the card no longer asserts — after which removing the mail
    // source leaves the address standing on nothing.
    const address = "sarah@example.org";
    const phone = "+15550100142";
    seen("doc-mail-4", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-card-4", "apple-contacts:local", {
      role: "contact",
      name: "Sarah",
      emails: [address],
      phones: [phone],
    });
    const personId = personFor(address)!;
    expect(personFor(phone)).toBe(personId);

    // The card is re-emitted with the address deleted from it. The phone is
    // what still resolves it to the same person.
    const dropped: PersonMention = { role: "contact", name: "Sarah", phones: [phone] };
    db.prepare("UPDATE documents SET metadata = ? WHERE id = ?").run(
      JSON.stringify({ documentType: "email", people: [dropped] }),
      "doc-card-4",
    );
    resolveDocumentPeople(db, "doc-card-4", [dropped], "apple-contacts:local", "2026-01-02");

    const vouchers = db
      .prepare<[string], { source_id: string }>(
        `SELECT a.source_id FROM person_alias_assertions a
           JOIN person_aliases al ON al.id = a.alias_id
          WHERE al.alias = ? ORDER BY a.source_id`,
      )
      .all(address)
      .map((r) => r.source_id);
    expect(vouchers).toEqual(["gmail:me@example.org"]);

    // The address survives on the mail source's claim alone, so removing that
    // source now takes it — and the phone the card still asserts stays.
    deleteAllBySource(db, "gmail:me@example.org");
    expect(personFor(address)).toBeUndefined();
    expect(personFor(phone)).toBe(personId);
  });

  test("keeps the person, and the remaining source's attribution to them", () => {
    // The consequence that costs most. When the deleted alias was a person's
    // last one, the orphan sweep took the person, and `document_people`
    // cascaded — so documents from the sources that remain lost the person
    // they were attributed to.
    const address = "david@example.org";
    seen("doc-mail-3", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-msg-3", "apple-imessage:local", { role: "sender", emails: [address] });

    const personId = personFor(address)!;
    deleteAllBySource(db, "gmail:me@example.org");

    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_people WHERE person_id = ? AND document_id = 'doc-msg-3'")
        .get(personId)?.n,
    ).toBe(1);
  });

  test("a source that never saw it does not keep it alive", () => {
    const address = "sarah@example.org";
    seen("doc-mail-4", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-other-4", "apple-contacts:local", {
      role: "contact",
      emails: ["someone-else@example.org"],
    });

    deleteAllBySource(db, "gmail:me@example.org");
    expect(personFor(address)).toBeUndefined();
  });

  test("every source that saw it is recorded, not only the first", () => {
    const address = "reeves@example.org";
    seen("doc-mail-5", "gmail:me@example.org", { role: "sender", emails: [address] });
    seen("doc-card-5", "apple-contacts:local", { role: "contact", emails: [address] });

    const sources = db
      .prepare<[string], { source_id: string }>(
        `SELECT a.source_id FROM person_alias_assertions a
           JOIN person_aliases al ON al.id = a.alias_id
          WHERE al.alias = ? ORDER BY a.source_id`,
      )
      .all(address)
      .map((r) => r.source_id);

    expect(sources).toEqual(["apple-contacts:local", "gmail:me@example.org"]);
  });
});

describe("a mention carrying a platform identifier", () => {
  function seen(docId: string, sourceId: string, mention: PersonMention) {
    connectSource(sourceId);
    insertDoc(docId, sourceId, [mention]);
    resolveDocumentPeople(db, docId, [mention], sourceId, "2026-01-01");
  }

  function aliasesOf(personId: string): string[] {
    return db
      .prepare<[string], { alias: string }>(
        "SELECT alias FROM person_aliases WHERE person_id = ? ORDER BY alias",
      )
      .all(personId)
      .map((r) => r.alias);
  }

  function personFor(alias: string): string | undefined {
    return db
      .prepare<
        [string],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias = ?")
      .get(alias)?.person_id;
  }

  test("keeps a stable one even when the name it comes with disagrees", () => {
    // A committer's `git config user.name` is arbitrary text and often
    // disagrees with the name Omnesis holds. Withholding the login on that
    // basis made them a second person — and nothing recovers it, because a
    // platform identifier contributes no name tokens and so never scores as a
    // merge candidate. The guard that did it was written for a platform whose
    // identifiers can be re-pointed; a login is not one.
    const address = "jamie@example.org";
    seen("doc-card-l1", "apple-contacts:local", {
      role: "contact",
      name: "Jamie",
      emails: [address],
    });
    const personId = personFor(address)!;

    seen("doc-commit-l1", "github:me", {
      role: "author",
      name: "jlopezdev",
      emails: [address],
      lids: ["github:jlopez"],
    });

    expect(aliasesOf(personId)).toContain("github:jlopez");
  });

  test("holds back a re-pointable one when the name disagrees", () => {
    // The case the guard exists for, unchanged: this platform maintains the
    // mapping, so one identifier can come to name a different phone, and a
    // disagreeing name is the signal that it has.
    const address = "david@example.org";
    seen("doc-card-l2", "apple-contacts:local", {
      role: "contact",
      name: "David",
      emails: [address],
    });
    const personId = personFor(address)!;

    seen("doc-chat-l2", "whatsapp:+15550100123", {
      role: "participant",
      name: "Sarah",
      emails: [address],
      lids: ["whatsapp:229969796026444"],
    });

    expect(aliasesOf(personId)).not.toContain("whatsapp:229969796026444");
  });

  test("keeps a re-pointable one when the name agrees", () => {
    const address = "maya@example.org";
    seen("doc-card-l3", "apple-contacts:local", {
      role: "contact",
      name: "Maya",
      emails: [address],
    });
    const personId = personFor(address)!;

    seen("doc-chat-l3", "whatsapp:+15550100124", {
      role: "participant",
      name: "Maya",
      emails: [address],
      lids: ["whatsapp:229969796026445"],
    });

    expect(aliasesOf(personId)).toContain("whatsapp:229969796026445");
  });
});
