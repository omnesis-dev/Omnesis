// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whatever is read from the filter rows equals what the check reads from the
 * records themselves.
 *
 * Each seed generates two invented accounts whose records cover what a
 * filter treats differently: unreadable metadata, attachments of present,
 * missing and nested records, fields absent, empty, malformed or naming ids
 * the account's list does not hold, records without a device, people who
 * cannot be read or are too many, and chats whose members are not all known.
 * Then, for generated filters and for every field the editor counts, the
 * counts, the verdict totals and the readable set read from the rows must
 * equal the ones the record-by-record check gives.
 */

import { describe, expect, it } from "vitest";
import { storedSpellings } from "@omnesis/core";
import { sourceTypeOf, type FilterRef, type SourceFilter } from "@omnesis/types";
import { documentAccessInclusionSql } from "./filter-decision.js";
import { filterFieldsFor } from "./filter-fields.js";
import {
  FILTER_PEOPLE_FIELD,
  compileFieldProbe,
  compileSourceFilter,
  filterAllowSql,
  filterDeviceCountsSql,
  filterItemCountsSql,
  filterPersonCountsSql,
  filterVerdictSql,
  type CompiledFilter,
  type FilterSql,
} from "./filter-sql.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  chat,
  directory,
  folder,
  hide,
  insertDocument,
  label,
  openFilterFixture,
  person,
  publishList,
  publishProfile,
  shareOnly,
  tag,
  type FilterFixture,
} from "./filter-test-utils.js";
import {
  filterValueDeviceCountsSql,
  filterValueItemCountsSql,
  filterValuePersonCountsSql,
  filterValueVerdicts,
  filterValueVerdictsSql,
} from "./filter-value-sql.js";
import {
  filterValueDeclaration,
  filterValuesReady,
  mergeFilterPostings,
  settleFilterValues,
} from "./filter-values.js";
import { filterPersonKey } from "./filter-people.js";
import type { Db } from "../data/types.js";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const MAYA = "+15550100123";
const JAMIE = "+15550100456";

function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)]!;
}

function some<T>(next: () => number, list: readonly T[], most: number): T[] {
  const out: T[] = [];
  for (let n = 1 + Math.floor(next() * most); n > 0; n--) out.push(pick(next, list));
  return out;
}

const LABELS = ["l-1", "l-2", "l-3", "l-4", "l-5"];
const FOLDERS = ["f-root", "f-a", "f-b", "f-a1", "f-a2", "f-b1", "f-ghost"];
const DIRECTORIES = ["d-root", "d-1", "d-2", "d-3", "d-ghost"];
const TAGS = ["t-1", "t-2", "t-3"];
const CHATS = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-ghost"];
const EMAILS = [
  "maya@example.org",
  "jamie@example.com",
  "Sarah.Mendez@Example.com",
  "not an address",
];
const PHONES = [MAYA, JAMIE, "+1 (555) 010-0789", "call me"];

function mention(next: () => number, roles: readonly string[], kinds: "mail" | "phone"): unknown {
  const role = pick(next, roles);
  const roll = next();
  if (roll < 0.05) return { role, name: "Self", isSelf: true };
  if (roll < 0.08) return { role, name: "Nobody" };
  if (roll < 0.1) return "not a mention";
  if (kinds === "phone")
    return { role, name: "P", identifiers: [{ kind: "phone", value: pick(next, PHONES) }] };
  if (next() < 0.5) return { role, name: "E", emails: some(next, EMAILS, 2) };
  return {
    role,
    name: "I",
    identifiers: [
      { kind: "email", value: pick(next, EMAILS) },
      ...(next() < 0.3 ? [{ kind: "phone", value: pick(next, PHONES) }] : []),
    ],
  };
}

function people(next: () => number, roles: readonly string[], kinds: "mail" | "phone"): unknown {
  const roll = next();
  if (roll < 0.08) return undefined;
  if (roll < 0.11) return "not a list";
  // The ledger caps people at five: a list that long may have been cut.
  const count = roll < 0.14 ? 5 : 1 + Math.floor(next() * 3);
  return Array.from({ length: count }, () => mention(next, roles, kinds));
}

function parentField(next: () => number, externals: readonly string[]): Record<string, unknown> {
  const roll = next();
  if (roll < 0.6 && externals.length > 0) return { parentExternalId: pick(next, externals) };
  if (roll < 0.75) return { parentExternalId: "gone-parent" };
  if (roll < 0.85) return { parentExternalId: null };
  if (roll < 0.92) return { parentExternalId: 42 };
  return {};
}

function arrayField(next: () => number, ids: readonly string[]): unknown {
  const roll = next();
  if (roll < 0.15) return undefined;
  if (roll < 0.2) return [];
  if (roll < 0.23) return [ids[0], ""];
  if (roll < 0.26) return [ids[0], 7];
  if (roll < 0.28) return ids[0];
  return [...new Set(some(next, ids, 2))];
}

function ledgerMetadata(next: () => number, externals: readonly string[]): unknown {
  const roll = next();
  if (roll < 0.04) return "not json";
  if (roll < 0.06) return "[1, 2]";
  const extra: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = { documentType: "entry", extra };
  if (next() < 0.2) {
    if (next() < 0.6) metadata.documentType = "attachment";
    Object.assign(extra, parentField(next, externals));
  }
  const labels = arrayField(next, LABELS);
  if (labels !== undefined) extra.labelIds = labels;
  const folders = arrayField(next, FOLDERS);
  if (folders !== undefined) extra.folderIds = folders;
  const dir = next();
  if (dir < 0.7) extra.directory = pick(next, DIRECTORIES);
  else if (dir < 0.75) extra.directory = "";
  const tags = arrayField(next, TAGS);
  if (tags !== undefined) extra.tagIds = tags;
  const found = people(next, ["sender", "recipient", "mentioned", "cc"], "mail");
  if (found !== undefined) metadata.people = found;
  return metadata;
}

function parleyMetadata(next: () => number, externals: readonly string[]): unknown {
  if (next() < 0.03) return "{broken";
  const extra: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = { documentType: "day", extra };
  if (next() < 0.1) {
    metadata.documentType = "attachment";
    Object.assign(extra, parentField(next, externals));
  }
  const roll = next();
  if (roll < 0.85) extra.chatId = pick(next, CHATS);
  else if (roll < 0.9) extra.chatId = "";
  else if (roll < 0.93) extra.chatId = 5;
  const found = people(next, ["participant", "mentioned"], "phone");
  if (found !== undefined) metadata.people = found;
  return metadata;
}

function seed(fixture: FilterFixture, n: number, records: number): void {
  const { db } = fixture;
  publishProfile(db, "ledger", 3, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "f-root", label: "Root" },
    { id: "f-a", parentId: "f-root", label: "A" },
    { id: "f-b", parentId: "f-root", label: "B" },
    { id: "f-a1", parentId: "f-a", label: "A1" },
    { id: "f-a2", parentId: "f-a", label: "A2" },
    { id: "f-b1", parentId: "f-b", label: "B1" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: "dev-a" }, [
    { id: "d-root", label: "~" },
    { id: "d-1", parentId: "d-root", label: "~/one" },
    { id: "d-2", parentId: "d-1", label: "~/one/two" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: "dev-b" }, [
    { id: "d-root", label: "~" },
    { id: "d-3", parentId: "d-root", label: "~/three" },
  ]);
  publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [
    { id: "c-1", label: "One", members: [{ type: "phone", value: MAYA }] },
    {
      id: "c-2",
      label: "Two",
      members: [
        { type: "phone", value: JAMIE },
        { type: "phone", value: "+15550100789" },
      ],
    },
    {
      id: "c-3",
      label: "Three",
      membersIncomplete: true,
      members: [{ type: "phone", value: MAYA }],
    },
    { id: "c-4", label: "Four", members: [{ type: "phone", value: "call me" }] },
    { id: "c-5", label: "Five", members: [{ type: "email", value: "maya@example.org" }] },
  ]);
  const next = random(n);
  for (const [sourceId, metadataOf] of [
    [LEDGER, ledgerMetadata],
    [PARLEY, parleyMetadata],
  ] as const) {
    const externals: string[] = [];
    for (let index = 0; index < records; index++) {
      const externalId = `${sourceId}-e${index}`;
      // A record can name one written after it: half of what a record may
      // be attached to is drawn from ids still to come.
      const candidates = [...externals, ...(next() < 0.5 ? [`${sourceId}-e${index + 3}`] : [])];
      insertDocument(db, {
        id: `${sourceId}-d${index}`,
        sourceId,
        externalId,
        streamId: sourceId === LEDGER ? pick(next, ["", "dev-a", "dev-b"]) : "",
        version: pick(next, [0, 1, 2, 3, 3]),
        metadata: metadataOf(next, candidates),
      });
      externals.push(externalId);
    }
  }
}

const LEDGER_REFS: FilterRef[] = [
  ...LABELS.map(label),
  label("l-none"),
  ...FOLDERS.map(folder),
  directory("dev-a", "d-root"),
  directory("dev-a", "d-1"),
  directory("dev-b", "d-3"),
  directory("dev-b", "d-ghost"),
  { capability: "tree", field: "extra.directory", id: "", device: "dev-a" },
  tag("dev-a", "t-1"),
  tag("dev-b", "t-2"),
  { capability: "membership", field: "extra.tagIds", id: "", device: "dev-b" },
  person("Maya", ["email", "maya@example.org"]),
  person("Example", ["domain", "example.com"]),
  person("Phone", ["phone", MAYA]),
];
const PARLEY_REFS: FilterRef[] = [
  ...CHATS.map(chat),
  person("Maya", ["phone", MAYA]),
  person("Jamie", ["phone", JAMIE]),
];

function filters(
  n: number,
  sourceId: string,
  refs: readonly FilterRef[],
  count: number,
): SourceFilter[] {
  const next = random(n * 31 + sourceId.length);
  return Array.from({ length: count }, (_unused, index) => {
    const match = index === 0 ? [] : some(next, refs, 3);
    return next() < 0.5 ? shareOnly(sourceId, match) : hide(sourceId, match);
  });
}

function postingsAt(db: Db, level: number): number {
  return db
    .prepare<[number], { n: number }>(
      "SELECT count(*) AS n FROM document_filter_postings WHERE level = ?",
    )
    .get(level)!.n;
}

function rows<T>(db: Db, sql: FilterSql, ...extra: unknown[]): T[] {
  return db.prepare<unknown[], T>(sql.sql).all(...sql.params, ...extra);
}

function recordVerdicts(db: Db, compiled: CompiledFilter): Record<string, number> {
  const verdict = filterVerdictSql(compiled, { row: "d" });
  const counts: Record<string, number> = { total: 0, R: 0, H: 0, N: 0, O: 0, U: 0 };
  for (const row of rows<{ verdict: string; n: number }>(
    db,
    {
      sql: `SELECT verdict, count(*) AS n FROM (SELECT (${verdict.sql}) AS verdict FROM documents d WHERE d.source_id = ?) GROUP BY verdict`,
      params: verdict.params,
    },
    compiled.sourceId,
  )) {
    counts[row.verdict] = row.n;
    counts.total! += row.n;
  }
  return counts;
}

function valueVerdicts(db: Db, compiled: CompiledFilter, sourceId: string): Record<string, number> {
  const declaration = filterValueDeclaration(filterFieldsFor(db, sourceTypeOf(sourceId)));
  const sql = filterValueVerdictsSql(compiled, declaration)!;
  const [row] = rows<Parameters<typeof filterValueVerdicts>[1]>(db, sql);
  for (const [part, n] of Object.entries(row!)) if (n > 0) exercised.add(part);
  const verdicts = filterValueVerdicts(compiled, row!);
  for (const verdict of ["R", "H", "N", "O", "U"] as const) {
    if (verdicts[verdict] > 0) exercised.add(verdict);
  }
  return { ...verdicts };
}

/** What the generated accounts made the counts go through, so a test cannot pass by covering nothing. */
const exercised = new Set<string>();

function sorted(list: Array<{ idx?: number; device?: string; n: number }>): string[] {
  return list
    .filter((row) => row.n > 0)
    .map((row) => JSON.stringify([row.idx ?? row.device, row.n]))
    .sort();
}

function personEntries(refs: readonly FilterRef[]): Array<[number, string]> {
  const entries: Array<[number, string]> = [];
  refs.forEach((ref, index) => {
    if (ref.capability !== "person") return;
    for (const identifier of ref.identifiers) {
      for (const spelling of storedSpellings(identifier)) {
        entries.push([index, filterPersonKey(identifier.type, spelling)]);
      }
    }
  });
  return entries;
}

function readableIds(
  db: Db,
  sourceId: string,
  filter: SourceFilter,
  target: "row" | "id",
): string[] {
  const grant = { capabilityGranted: true, permittedSourceIds: null, filters: [filter] };
  const inclusion =
    target === "row"
      ? documentAccessInclusionSql(db, grant, "x.id", "x.source_id", { row: "x" })
      : documentAccessInclusionSql(db, grant, "x.id", "x.source_id");
  return db
    .prepare<unknown[], { id: string }>(
      `SELECT x.id FROM documents x WHERE x.source_id = ? AND ${inclusion.sql} ORDER BY x.id`,
    )
    .all(sourceId, ...inclusion.params)
    .map((row) => row.id);
}

function checkedIds(db: Db, sourceId: string, filter: SourceFilter): string[] {
  const allow = filterAllowSql(
    compileSourceFilter(filter, filterFieldsFor(db, sourceTypeOf(sourceId))),
    { row: "x" },
  );
  return db
    .prepare<unknown[], { id: string }>(
      `SELECT x.id FROM documents x WHERE x.source_id = ? AND ${allow.sql} ORDER BY x.id`,
    )
    .all(sourceId, ...allow.params)
    .map((row) => row.id);
}

describe("the filter rows answer what the records answer", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`agrees on generated accounts (seed ${n})`, () => {
      const fixture = openFilterFixture({ unreadableMetadata: true });
      try {
        const { db } = fixture;
        seed(fixture, n, 160);
        settleFilterValues(db);
        // Odd seeds read postings spread over three levels.
        if (n % 2 === 1) {
          const third = Math.floor(postingsAt(db, 0) / 3);
          mergeFilterPostings(db, 0, () => true, 2 * third);
          mergeFilterPostings(db, 1, () => true, third);
          expect([0, 1, 2].map((level) => postingsAt(db, level) > 0)).toEqual([true, true, true]);
        }
        for (const [sourceId, refs] of [
          [LEDGER, LEDGER_REFS],
          [PARLEY, PARLEY_REFS],
        ] as const) {
          const fields = filterFieldsFor(db, sourceTypeOf(sourceId));
          const declaration = filterValueDeclaration(fields);
          expect(filterValuesReady(db, sourceId, declaration)).toBe(true);

          for (const filter of filters(n, sourceId, refs, 25)) {
            const compiled = compileSourceFilter(filter, fields);
            expect(compiled.unusable).toBeNull();
            const context = JSON.stringify(filter.rules[0]);
            expect(valueVerdicts(db, compiled, sourceId), context).toEqual(
              recordVerdicts(db, compiled),
            );
            const expected = checkedIds(db, sourceId, filter);
            expect(readableIds(db, sourceId, filter, "row"), context).toEqual(expected);
            expect(readableIds(db, sourceId, filter, "id"), context).toEqual(expected);
          }

          const probed = new Set(
            refs.map((ref) => (ref.capability === "person" ? FILTER_PEOPLE_FIELD : ref.field)),
          );
          for (const field of probed) {
            const probe = compileFieldProbe(sourceId, fields, field);
            expect(probe.unusable).toBeNull();
            expect(valueVerdicts(db, probe, sourceId), field).toEqual(recordVerdicts(db, probe));
            if (field === FILTER_PEOPLE_FIELD) {
              const entries = personEntries(refs);
              expect(
                sorted(rows(db, filterValuePersonCountsSql(probe, declaration, entries)!)),
              ).toEqual(sorted(rows(db, filterPersonCountsSql(probe, entries))));
              continue;
            }
            const entries: Array<[number, string, string]> = [];
            refs.forEach((ref, index) => {
              if (ref.capability === "person" || ref.field !== field || ref.id === "") return;
              entries.push([index, ref.device ?? "", ref.id]);
            });
            expect(
              sorted(rows(db, filterValueItemCountsSql(probe, declaration, entries)!)),
              field,
            ).toEqual(sorted(rows(db, filterItemCountsSql(probe, entries))));
            if (
              refs.some((ref) => ref.capability !== "person" && ref.field === field && ref.device)
            ) {
              expect(
                sorted(rows(db, filterValueDeviceCountsSql(probe, declaration)!)),
                field,
              ).toEqual(sorted(rows(db, filterDeviceCountsSql(probe))));
            }
          }
        }
      } finally {
        fixture.close();
      }
    });
  }

  it("covered every condition", () => {
    expect([...exercised].sort()).toEqual(
      [
        "H",
        "N",
        "O",
        "R",
        "U",
        "current",
        "known",
        "matched",
        "roster",
        "total",
        "tooOld",
        "undecided",
        "unlisted",
      ].sort(),
    );
  });
});

describe("a count over a tree", () => {
  /**
   * A tree entry's count is read one of three ways: the sum of its ids'
   * counts when no record holds two of them, that sum less the repeats when
   * few records hold several ids, or the distinct records of the ids' rows
   * when many do. Each account below makes one of them the cheaper.
   */
  function folderCounts(
    holding: (index: number) => string[],
    records: number,
    asked: readonly string[] = ["f-root", "f-a", "f-b", "f-a1", "f-gone"],
  ): void {
    const fixture = openFilterFixture();
    try {
      const { db } = fixture;
      publishProfile(db, "ledger", 3, LEDGER_PROFILE);
      publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
        { id: "f-root", label: "Root" },
        { id: "f-a", parentId: "f-root", label: "A" },
        { id: "f-b", parentId: "f-root", label: "B" },
        { id: "f-a1", parentId: "f-a", label: "A1" },
      ]);
      for (let index = 0; index < records; index++) {
        insertDocument(db, {
          id: `d-${index}`,
          sourceId: LEDGER,
          version: 3,
          metadata: { documentType: "entry", extra: { folderIds: holding(index) } },
        });
      }
      settleFilterValues(db);
      const fields = filterFieldsFor(db, "ledger");
      const probe = compileFieldProbe(LEDGER, fields, "extra.folderIds");
      const entries = asked.map((id, index): [number, string, string] => [index, "", id]);
      expect(
        sorted(rows(db, filterValueItemCountsSql(probe, filterValueDeclaration(fields), entries)!)),
      ).toEqual(sorted(rows(db, filterItemCountsSql(probe, entries))));
    } finally {
      fixture.close();
    }
  }

  it("agrees when no record holds two ids", () => {
    folderCounts((index) => [["f-root", "f-a", "f-b", "f-a1"][index % 4]!], 40);
  });

  it("agrees when a few records hold several ids", () => {
    folderCounts(
      (index) => (index === 0 ? ["f-a", "f-a1", "f-b"] : [["f-a", "f-b"][index % 2]!]),
      40,
    );
  });

  it("agrees when most records hold several ids", () => {
    // Thirty-six records hold several ids; the entries asked about hold four.
    folderCounts((index) => (index % 10 === 0 ? ["f-b", "f-gone"] : ["f-a", "f-a1"]), 40, [
      "f-b",
      "f-gone",
    ]);
  });
});
