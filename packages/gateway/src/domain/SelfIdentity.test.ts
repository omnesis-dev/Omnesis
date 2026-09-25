// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import {
  reconcileSelfIdentity,
  reconcileSelfFromConfig,
  computeSelfCandidate,
} from "./SelfIdentity.js";
import type { Db } from "../data/types.js";

function insertDoc(db: Db, id: string, sourceId: string): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', ?, ?, 't', 'c', 'h', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, sourceId, id);
}

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function selfRow(): { id: string; canonical_name: string } | undefined {
  return db
    .prepare<
      [],
      { id: string; canonical_name: string }
    >("SELECT id, canonical_name FROM people WHERE is_self = TRUE AND merged_into IS NULL")
    .get();
}

function aliasesOf(id: string): Array<{ alias: string; alias_type: string }> {
  return db
    .prepare<
      [string],
      { alias: string; alias_type: string }
    >("SELECT alias, alias_type FROM person_aliases WHERE person_id = ? ORDER BY alias_type, alias")
    .all(id);
}

function vouchersOf(personId: string, alias: string): string[] {
  return db
    .prepare<[string, string], { source_id: string }>(
      `SELECT a.source_id FROM person_alias_assertions a
         JOIN person_aliases al ON al.id = a.alias_id
        WHERE al.person_id = ? AND al.alias = ? ORDER BY a.source_id`,
    )
    .all(personId, alias)
    .map((r) => r.source_id);
}

describe("reconcileSelfIdentity", () => {
  test("records who vouches for the self's identifiers, on create and on enrich", () => {
    // Without this the operator's configured address is invisible to a source
    // removal's bookkeeping — so removing a mail source that also saw the
    // address takes it, and the self loses an identifier it was told.
    const id = reconcileSelfIdentity(
      db,
      { emails: ["me@example.com"], phones: [] },
      "config",
    ) as string;
    expect(vouchersOf(id, "me@example.com")).toEqual(["config"]);

    reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: ["+12025550123"] }, "gmail");
    expect(vouchersOf(id, "me@example.com")).toEqual(["config", "gmail"]);
    expect(vouchersOf(id, "+12025550123")).toEqual(["gmail"]);
  });

  test("creates self from emails/phones (and name) when none exists", () => {
    const id = reconcileSelfIdentity(
      db,
      { name: "Maya", emails: ["me@example.com"], phones: ["+12025550123"] },
      "config",
    );
    expect(id).toBeTruthy();
    const s = selfRow();
    expect(s?.canonical_name).toBe("Maya");
    expect(aliasesOf(id as string)).toEqual(
      expect.arrayContaining([
        { alias: "me@example.com", alias_type: "email" },
        { alias: "+12025550123", alias_type: "phone" },
        { alias: "Maya", alias_type: "name" },
      ]),
    );
  });

  test("a phone-only self uses the phone as the placeholder headline", () => {
    reconcileSelfIdentity(db, { emails: [], phones: ["+12025550123"] }, "config");
    expect(selfRow()?.canonical_name).toBe("+12025550123");
  });

  test("a name alone never materializes a self (nothing to attribute against)", () => {
    expect(
      reconcileSelfIdentity(db, { name: "Maya", emails: [], phones: [] }, "config"),
    ).toBeNull();
    expect(selfRow()).toBeUndefined();
  });

  test("enriches an existing self with identifiers it doesn't yet carry", () => {
    const first = reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: [] }, "config");
    const second = reconcileSelfIdentity(
      db,
      { emails: ["me@example.com", "work@example.org"], phones: ["+447700900123"] },
      "config",
    );
    expect(second).toBe(first);
    expect(aliasesOf(first as string)).toEqual(
      expect.arrayContaining([
        { alias: "me@example.com", alias_type: "email" },
        { alias: "work@example.org", alias_type: "email" },
        { alias: "+447700900123", alias_type: "phone" },
      ]),
    );
  });

  test("is idempotent — re-running with the same identifiers adds nothing", () => {
    const id = reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: [] }, "config");
    const before = aliasesOf(id as string).length;
    reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: [] }, "config");
    expect(aliasesOf(id as string).length).toBe(before);
  });

  test("promotes a raw-identifier headline to a real name on enrich", () => {
    reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: [] }, "config");
    expect(selfRow()?.canonical_name).toBe("me@example.com"); // placeholder = the email
    reconcileSelfIdentity(db, { name: "Maya", emails: [], phones: [] }, "config");
    expect(selfRow()?.canonical_name).toBe("Maya");
  });

  test("does not clobber a real headline when enriching", () => {
    reconcileSelfIdentity(db, { name: "Maya", emails: ["me@example.com"], phones: [] }, "config");
    reconcileSelfIdentity(db, { name: "Other", emails: [], phones: [] }, "config");
    // "Maya" is not a placeholder, so the headline stays; the new name is added as an alias.
    expect(selfRow()?.canonical_name).toBe("Maya");
  });
});

describe("reconcileSelfFromConfig", () => {
  test("normalizes emails/phones and drops invalid entries", () => {
    const id = reconcileSelfFromConfig(db, {
      name: "Maya",
      emails: ["Me@Example.com", "not-an-email"],
      phones: ["+1 202 555 0123", "garbage"],
    });
    expect(id).toBeTruthy();
    const aliases = aliasesOf(id as string);
    expect(aliases).toContainEqual({ alias: "me@example.com", alias_type: "email" }); // lowercased
    expect(aliases.find((a) => a.alias === "not-an-email")).toBeUndefined(); // malformed dropped
    const phones = aliases.filter((a) => a.alias_type === "phone");
    expect(phones).toEqual([{ alias: "+12025550123", alias_type: "phone" }]); // E.164, garbage dropped
  });

  test("no-op on undefined / empty config", () => {
    expect(reconcileSelfFromConfig(db, undefined)).toBeNull();
    expect(reconcileSelfFromConfig(db, { emails: [], phones: [] })).toBeNull();
    expect(selfRow()).toBeUndefined();
  });

  test("name-only config enriches an existing self but never creates one", () => {
    expect(reconcileSelfFromConfig(db, { name: "Maya" })).toBeNull(); // no self, no identifier
    reconcileSelfFromConfig(db, { emails: ["me@example.com"] }); // create via email
    const id = reconcileSelfFromConfig(db, { name: "Maya" }); // now enriches the placeholder headline
    expect(id).toBeTruthy();
    expect(selfRow()?.canonical_name).toBe("Maya");
  });
});

describe("bootstrapSelfFromConfig via the write gate (boot wiring)", () => {
  test("the gate funnels config.self through to a materialized self person", async () => {
    const gate = directWriteGate(db);
    const id = await gate.bootstrapSelfFromConfig({
      name: "Maya",
      emails: ["me@example.com"],
      phones: ["+12025550123"],
    });
    expect(id).toBeTruthy();
    expect(selfRow()?.canonical_name).toBe("Maya");
    expect(aliasesOf(id as string)).toEqual(
      expect.arrayContaining([
        { alias: "me@example.com", alias_type: "email" },
        { alias: "+12025550123", alias_type: "phone" },
      ]),
    );
  });

  test("the gate no-ops on absent config.self", async () => {
    const gate = directWriteGate(db);
    expect(await gate.bootstrapSelfFromConfig(undefined)).toBeNull();
    expect(selfRow()).toBeUndefined();
  });
});

describe("computeSelfCandidate", () => {
  test("proposes the account when exactly one email-shaped source exists", () => {
    insertDoc(db, "d1", "gmail:me@example.com");
    insertDoc(db, "d2", "google-calendar:me@example.com"); // same account, still one
    insertDoc(db, "d3", "whatsapp-messages:447700900123"); // not email-shaped, ignored
    expect(computeSelfCandidate(db)).toEqual({
      email: "me@example.com",
      sourceId: "gmail:me@example.com",
    });
  });

  test("proposes nothing when multiple distinct email accounts exist (ambiguous)", () => {
    insertDoc(db, "d1", "gmail:me@example.com");
    insertDoc(db, "d2", "outlook:me@example.org");
    expect(computeSelfCandidate(db)).toBeNull();
  });

  test("proposes nothing when no email-shaped source exists", () => {
    insertDoc(db, "d1", "whatsapp-messages:447700900123");
    insertDoc(db, "d2", "notion-pages:workspace");
    expect(computeSelfCandidate(db)).toBeNull();
  });

  test("proposes nothing once a canonical self already exists", () => {
    insertDoc(db, "d1", "gmail:me@example.com");
    reconcileSelfIdentity(db, { emails: ["me@example.com"], phones: [] }, "config");
    expect(computeSelfCandidate(db)).toBeNull();
  });

  test("proposes nothing when config.self already carries identity (self not yet materialized)", () => {
    insertDoc(db, "d1", "gmail:me@example.com"); // a candidate would otherwise exist
    // No self person yet, but config.self is set — the nudge must not re-ask.
    expect(computeSelfCandidate(db, { emails: ["me@example.com"] })).toBeNull();
    expect(computeSelfCandidate(db, { phones: ["+12025550123"] })).toBeNull();
    // Empty config.self does not suppress the proposal.
    expect(computeSelfCandidate(db, { emails: [], phones: [] })).not.toBeNull();
  });
});

describe("a source that says who its account is", () => {
  /** A source row carrying whatever the source declared about its account. */
  function insertSource(sourceId: string, account: Record<string, unknown> | null): void {
    db.prepare(
      `INSERT OR IGNORE INTO devices (id, name, kind, paired_at)
       VALUES ('device-1', 'collector', 'collector', 0)`,
    ).run();
    const colon = sourceId.indexOf(":");
    db.prepare(
      `INSERT INTO sources (id, type, account_id, account, device_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'device-1', 0, 0)`,
    ).run(
      sourceId,
      sourceId.slice(0, colon),
      sourceId.slice(colon + 1),
      account ? JSON.stringify(account) : null,
    );
  }

  test("a declared address is read, not recognised", () => {
    // The account id here is opaque; nothing about its shape says whose it is.
    // Under the old rule this source contributed no candidate at all.
    insertSource("notion:ws_8f2a1c", {
      id: "ws_8f2a1c",
      subject: { kind: "email", value: "maya@example.com" },
    });
    insertDoc(db, "d1", "notion:ws_8f2a1c");

    expect(computeSelfCandidate(db)).toEqual({
      email: "maya@example.com",
      sourceId: "notion:ws_8f2a1c",
    });
  });

  test("a declared handle is not treated as an address, however it is spelled", () => {
    // The near miss the shape test has today: a connection named after the
    // organization it is scoped to contains an `@` and is not an address.
    // Saying what the value is removes the question instead of answering it.
    insertSource("github:octocat@acme-org", {
      id: "octocat@acme-org",
      subject: { kind: "handle", value: "octocat" },
      tenant: { id: "acme-org" },
    });
    insertDoc(db, "d1", "github:octocat@acme-org");

    expect(computeSelfCandidate(db)).toBeNull();
  });

  test("a source that declares nothing keeps the behaviour it has", () => {
    // Most sources declare nothing, and none of them may change.
    insertSource("gmail:maya@example.com", null);
    insertDoc(db, "d1", "gmail:maya@example.com");

    expect(computeSelfCandidate(db)).toEqual({
      email: "maya@example.com",
      sourceId: "gmail:maya@example.com",
    });
  });

  test("a document whose source row is gone still falls back to the id", () => {
    // Documents outlive a removed source, and the join is a left join for
    // exactly that reason.
    insertDoc(db, "d1", "gmail:maya@example.com");

    expect(computeSelfCandidate(db)?.email).toBe("maya@example.com");
  });

  test("a declared address and a shaped one for the same person count once", () => {
    insertSource("gmail:maya@example.com", null);
    insertSource("notion:ws_8f2a1c", {
      id: "ws_8f2a1c",
      subject: { kind: "email", value: "maya@example.com" },
    });
    insertDoc(db, "d1", "gmail:maya@example.com");
    insertDoc(db, "d2", "notion:ws_8f2a1c");

    // Two sources, one operator. Ambiguity is what makes this return null, and
    // the same address twice is not ambiguity.
    expect(computeSelfCandidate(db)?.email).toBe("maya@example.com");
  });

  test("an unreadable descriptor falls back rather than failing", () => {
    db.prepare(
      `INSERT OR IGNORE INTO devices (id, name, kind, paired_at)
       VALUES ('device-1', 'collector', 'collector', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sources (id, type, account_id, account, device_id, created_at, updated_at)
       VALUES ('gmail:maya@example.com', 'gmail', 'maya@example.com', '{not json', 'device-1', 0, 0)`,
    ).run();
    insertDoc(db, "d1", "gmail:maya@example.com");

    expect(computeSelfCandidate(db)?.email).toBe("maya@example.com");
  });
});
