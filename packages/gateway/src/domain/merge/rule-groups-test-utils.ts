// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invented merge-rule fixtures for the People → Rules page
 * (`GET /people/merge-rule-groups`), with fixed ids and timestamps so what the
 * page returns can be compared byte for byte, and helpers that load every page
 * of every filter the page offers.
 */

import type Database from "better-sqlite3";
import type { MergeRuleKind } from "./types.js";

type Db = Database.Database;

/** The page's options, as `GET /people/merge-rule-groups` passes them. */
export interface MergeRuleGroupsQuery {
  limit: number;
  q?: string;
  kind?: MergeRuleKind;
  before?: { latest: string; key: string };
}

/** A page as the route receives it. */
export interface MergeRuleGroupsPage {
  items: Array<{ key: string; latest: string }>;
  hasMore: boolean;
  last?: { latest: string; key: string };
}

export type LoadMergeRuleGroups = (
  query: MergeRuleGroupsQuery,
) => MergeRuleGroupsPage | Promise<MergeRuleGroupsPage>;

function at(day: number, second = 0): string {
  return new Date(Date.UTC(2026, 0, 1) + day * 86_400_000 + second * 1000).toISOString();
}

interface Seeder {
  person(
    id: string,
    name: string,
    aliases: Array<[type: string, alias: string]>,
    opts?: { mergedInto?: string },
  ): void;
  rule(
    id: string,
    kind: MergeRuleKind,
    a: [type: string, alias: string],
    b: [type: string, alias: string],
    winner: "a" | "b",
    createdAt: string,
    opts?: { groupId?: string; active?: boolean; reason?: string },
  ): void;
  mention(documentId: string, personId: string, sourceId: string, createdAt: string): void;
}

function seeder(db: Db): Seeder {
  const insertPerson = db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  );
  const insertAlias = db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, 'fixture-source', '2026-01-01')`,
  );
  const insertRule = db.prepare(
    `INSERT INTO merge_rules
       (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
        winner_side, reason, created_at, created_by, active, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insertDocument = db.prepare(
    `INSERT OR IGNORE INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                                      source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'fixture', ?, ?, 'Example', 'Quarterly budget review notes', ?, ?, ?, ?, ?)`,
  );
  const insertMention = db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, 'sender', ?)`,
  );
  return {
    person(id, name, aliases, opts = {}) {
      insertPerson.run(id, name, opts.mergedInto ?? null);
      for (const [index, [type, alias]] of aliases.entries())
        insertAlias.run(`${id}-alias-${index}`, id, alias, type);
    },
    rule(id, kind, a, b, winner, createdAt, opts = {}) {
      insertRule.run(
        id,
        kind,
        a[0],
        a[1],
        b[0],
        b[1],
        winner,
        opts.reason ?? null,
        createdAt,
        opts.active === false ? 0 : 1,
        opts.groupId ?? null,
      );
    },
    mention(documentId, personId, sourceId, createdAt) {
      insertDocument.run(
        documentId,
        sourceId,
        documentId,
        `hash-${documentId}`,
        createdAt,
        createdAt,
        createdAt,
        createdAt,
      );
      insertMention.run(documentId, personId, sourceId);
    },
  };
}

/** Two people, three rules: a cluster merge and a single one. */
export function seedSmallRuleGroups(db: Db): void {
  const s = seeder(db);
  s.person("p-maya", "Maya reeves", [
    ["email", "maya@example.com"],
    ["name", "Maya reeves"],
  ]);
  s.person("p-maya-work", "M. Reeves", [["email", "m.reeves@northstar.example"]], {
    mergedInto: "p-maya",
  });
  s.person("p-maya-phone", "Maya", [["phone", "+15550100101"]], { mergedInto: "p-maya" });
  s.person("p-david", "David lin", [["email", "david@example.com"]]);
  s.person("p-david-alt", "D. Lin", [["email", "d.lin@northstar.example"]], {
    mergedInto: "p-david",
  });
  s.rule(
    "r-maya-work",
    "user",
    ["email", "m.reeves@northstar.example"],
    ["email", "maya@example.com"],
    "b",
    at(10),
    { groupId: "g-maya", reason: "Same person" },
  );
  s.rule(
    "r-maya-phone",
    "user",
    ["email", "maya@example.com"],
    ["phone", "+15550100101"],
    "a",
    at(10),
    { groupId: "g-maya", reason: "Same person" },
  );
  s.rule(
    "r-david",
    "system",
    ["email", "d.lin@northstar.example"],
    ["email", "david@example.com"],
    "b",
    at(5),
  );
  s.mention("doc-1", "p-maya", "gmail-fixture", at(1));
  s.mention("doc-2", "p-maya-work", "slack-fixture", at(2));
  s.mention("doc-3", "p-david", "gmail-fixture", at(3));
}

/**
 * Every shape the grouping has to get right: a winner nobody carries, a name
 * winner matched case-insensitively, a name two people share, a winner that is
 * itself merged, a lid and a phone winner, user and system rules on one
 * identity, inactive rules, groups tied on their latest rule, and names and
 * aliases with LIKE's special characters.
 */
export function seedEdgeRuleGroups(db: Db): void {
  const s = seeder(db);
  s.person("p-sarah", "Sarah mendez", [
    ["name", "Sarah mendez"],
    ["email", "sarah@example.org"],
  ]);
  s.person("p-sarah-2", "Sarah mendez", [["name", "SARAH MENDEZ"]]);
  s.person("p-sarah-old", "S. Mendez", [["email", "s.mendez@example.org"]], {
    mergedInto: "p-sarah",
  });
  s.person("p-jamie", "Jamie lopez", [["email", "jamie@example.com"]], { mergedInto: "p-root" });
  s.person("p-root", "Jamie R. Lopez", [["email", "jamie.root@example.com"]]);
  s.person("p-jamie-lid", "Jamie (chat)", [["lid", "lid-0001"]], { mergedInto: "p-root" });
  s.person("p-percent", "100% Studio_Northstar", [["email", "studio@example.io"]]);
  s.person("p-percent-alt", "Studio", [["email", "studio_alt@example.io"]], {
    mergedInto: "p-percent",
  });
  s.person("p-back", "Back\\Slash", [["phone", "+15550100199"]]);
  s.person("p-back-alt", "Back", [["email", "back@example.com"]], { mergedInto: "p-back" });
  s.person("p-tie-a", "Tie alpha", [["email", "tie.a@example.com"]]);
  s.person("p-tie-b", "Tie beta", [["email", "tie.b@example.com"]]);
  s.person("p-loser", "Loser", [["email", "loser@example.com"]]);

  // A name winner: lowercased in the rule, mixed case on two people.
  s.rule(
    "r-name",
    "user",
    ["email", "s.mendez@example.org"],
    ["name", "sarah mendez"],
    "b",
    at(20),
  );
  // A winner nobody carries: grouped by its alias.
  s.rule(
    "r-orphan",
    "system",
    ["email", "ghost@example.com"],
    ["email", "nobody@example.com"],
    "a",
    at(19),
  );
  s.rule(
    "r-orphan-2",
    "user",
    ["email", "ghost@example.com"],
    ["phone", "+15550100150"],
    "a",
    at(18, 5),
  );
  // A winner that is itself merged: grouped under its root.
  s.rule(
    "r-merged-winner",
    "user",
    ["email", "jamie@example.com"],
    ["lid", "lid-0001"],
    "a",
    at(18),
  );
  s.rule(
    "r-root",
    "system",
    ["email", "jamie.root@example.com"],
    ["email", "jamie@example.com"],
    "a",
    at(17),
  );
  // A lid winner.
  s.rule("r-lid", "system", ["email", "loser@example.com"], ["lid", "lid-0001"], "b", at(16));
  // LIKE's special characters in a name and an alias.
  s.rule(
    "r-percent",
    "user",
    ["email", "studio@example.io"],
    ["email", "studio_alt@example.io"],
    "a",
    at(15),
  );
  s.rule("r-back", "user", ["email", "back@example.com"], ["phone", "+15550100199"], "b", at(14));
  // Two identities whose latest rules tie.
  s.rule(
    "r-tie-a",
    "user",
    ["email", "tie.a@example.com"],
    ["email", "x.a@example.com"],
    "a",
    at(12),
  );
  s.rule(
    "r-tie-b",
    "user",
    ["email", "tie.b@example.com"],
    ["email", "x.b@example.com"],
    "a",
    at(12),
  );
  // Inactive rules are not on the page.
  s.rule(
    "r-inactive",
    "user",
    ["email", "tie.a@example.com"],
    ["email", "y.a@example.com"],
    "a",
    at(30),
    {
      active: false,
    },
  );
  s.rule(
    "r-inactive-only",
    "user",
    ["email", "z@example.com"],
    ["email", "w@example.com"],
    "a",
    at(31),
    {
      active: false,
    },
  );
  s.mention("doc-e1", "p-sarah", "gmail-fixture", at(1));
  s.mention("doc-e2", "p-sarah-2", "notes-fixture", at(2));
  s.mention("doc-e3", "p-root", "chat-fixture", at(3));
}

const FIRST = ["Maya", "Jamie", "David", "Sarah", "Noah", "Lena", "Omar", "Priya"];
const LAST = ["Reeves", "Lopez", "Lin", "Mendez", "Okafor", "Brandt", "Haddad", "Sato"];

/**
 * Many identities across pages: winners named by email, phone and name, user
 * and system rules, cluster merges sharing a timestamp, and enough repeated
 * timestamps that page boundaries fall inside ties.
 */
export function seedLargeRuleGroups(db: Db, identities = 90): void {
  const s = seeder(db);
  let rule = 0;
  for (let i = 0; i < identities; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
    const root = `p-${i}`;
    const name = `${first} ${last.toLowerCase()} ${i}`;
    const email = `${first}.${last}.${i}@example.com`.toLowerCase();
    const phone = `+1555010${String(i).padStart(4, "0")}`;
    s.person(root, name, [
      ["name", name],
      ["email", email],
      ["phone", phone],
    ]);
    const winner: [string, string] =
      i % 5 === 0
        ? ["name", name.toLowerCase()]
        : i % 7 === 0
          ? ["phone", phone]
          : ["email", email];
    const losers = 1 + (i % 3);
    for (let l = 0; l < losers; l++) {
      const loserId = `${root}-loser-${l}`;
      const loserAlias: [string, string] = [
        "email",
        `${first}.${l}.${i}@northstar.example`.toLowerCase(),
      ];
      s.person(loserId, `${first} ${l}`, [loserAlias], { mergedInto: root });
      const winnerFirst =
        `${winner[0]}\u0000${winner[1]}` < `${loserAlias[0]}\u0000${loserAlias[1]}`;
      s.rule(
        `r-${String(rule++).padStart(4, "0")}`,
        i % 4 === 0 ? "system" : "user",
        winnerFirst ? winner : loserAlias,
        winnerFirst ? loserAlias : winner,
        winnerFirst ? "a" : "b",
        // Every third identity shares its day with the next: ties across groups.
        at(Math.floor(i / 3), l),
        losers > 1 ? { groupId: `g-${i}` } : {},
      );
      s.mention(`doc-${i}-${l}`, l === 0 ? root : loserId, `source-${(i + l) % 4}`, at(i % 40));
    }
  }
}

/** Every page of one filter, following the cursor until the last page. */
export async function loadAllPages(
  load: LoadMergeRuleGroups,
  query: Omit<MergeRuleGroupsQuery, "before">,
): Promise<MergeRuleGroupsPage[]> {
  const pages: MergeRuleGroupsPage[] = [];
  let before: MergeRuleGroupsQuery["before"];
  for (;;) {
    const page = await load({ ...query, ...(before ? { before } : {}) });
    pages.push(page);
    if (!page.hasMore || !page.last) return pages;
    before = page.last;
    if (pages.length > 500) throw new Error("the cursor never reached the last page");
  }
}

/** The filters the page offers: each kind, and searches that hit names, aliases and LIKE's specials. */
export const RULE_GROUP_FILTERS: Array<Omit<MergeRuleGroupsQuery, "limit" | "before">> = [
  {},
  { kind: "user" },
  { kind: "system" },
  { q: "reeves" },
  { q: "NORTHSTAR" },
  { q: "mendez", kind: "user" },
  { q: "jamie r." },
  { q: "%" },
  { q: "_alt" },
  { q: "\\" },
  { q: "ghost" },
  { q: "no such identity" },
];
