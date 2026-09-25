// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_TEMPORAL_KINDS,
  RETIRED_TEMPORAL_KINDS,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_ORIGINS,
  TEMPORAL_PRECISIONS,
  TEMPORAL_STATUSES,
  canonicalTemporalKind,
  isTemporalKind,
  temporalVocabularyCheck,
} from "./temporal-vocabulary.js";

describe("temporal vocabulary", () => {
  it("declares each value once", () => {
    for (const list of [
      TEMPORAL_ORIGINS,
      TEMPORAL_KINDS,
      TEMPORAL_MODALITIES,
      TEMPORAL_STATUSES,
      TEMPORAL_PRECISIONS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("keeps kinds free of any value that names an origin", () => {
    // A kind describes what a fact is. The moment one describes where it came
    // from, filtering by kind silently also filters by producer.
    for (const kind of TEMPORAL_KINDS) {
      expect(kind).not.toMatch(/calendar|source|document|annotation|projection|analytics|row/);
    }
  });

  it("resolves every retired spelling onto a canonical kind", () => {
    for (const [retired, canonical] of Object.entries(RETIRED_TEMPORAL_KINDS)) {
      expect(isTemporalKind(retired)).toBe(false);
      expect(isTemporalKind(canonical)).toBe(true);
      expect(canonicalTemporalKind(retired)).toBe(canonical);
    }
    expect(canonicalTemporalKind("not-a-kind")).toBeNull();
    expect(canonicalTemporalKind(undefined)).toBeNull();
    for (const kind of TEMPORAL_KINDS) expect(canonicalTemporalKind(kind)).toBe(kind);
  });

  it("never resolves a prototype-chain property name to a kind", () => {
    // The retired-alias table is indexed by strings off the wire and out of
    // storage. Anything answered by `Object.prototype` rather than by the
    // table's own keys must be outside the vocabulary.
    const inherited = [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    for (const name of inherited) {
      expect(isTemporalKind(name), name).toBe(false);
      expect(canonicalTemporalKind(name), name).toBeNull();
      expect(ACCEPTED_TEMPORAL_KINDS, name).not.toContain(name);
    }
  });

  it("declares the retired-alias table with a null prototype and freezes it", () => {
    // Structural guarantee behind the test above: with no prototype there is no
    // inherited name for a lookup to find, whatever the lookup is written with.
    expect(Object.getPrototypeOf(RETIRED_TEMPORAL_KINDS)).toBeNull();
    expect(Object.isFrozen(RETIRED_TEMPORAL_KINDS)).toBe(true);
  });

  it("accepts canonical and retired spellings on the wire", () => {
    expect([...ACCEPTED_TEMPORAL_KINDS].sort()).toEqual(
      [...TEMPORAL_KINDS, ...Object.keys(RETIRED_TEMPORAL_KINDS)].sort(),
    );
  });

  it("renders a SQL membership clause that quotes safely", () => {
    expect(temporalVocabularyCheck("status", TEMPORAL_STATUSES)).toBe(
      "status IN ('active', 'completed', 'cancelled')",
    );
    expect(temporalVocabularyCheck("k", ["it's"])).toBe("k IN ('it''s')");
  });
});

/**
 * The ratchet.
 *
 * A hand-written copy of the vocabulary is cheap to add and expensive to find:
 * it drifts silently, and a caller filtering on one copy quietly disagrees with
 * a caller filtering on another. The scan below fails if any file outside this
 * module spells out a list of temporal kinds, rather than deriving one from the
 * arrays above.
 *
 * `ALLOWED_LITERAL_LISTS` is the list of files that may legitimately spell the
 * vocabulary out. An addition to it should be argued for, not assumed.
 */
const ALLOWED_LITERAL_LISTS: readonly string[] = [
  // Migrations are append-only historical records. Migration 73 rewrites the
  // spellings retired at the time it was written, and must keep doing exactly
  // that even if the vocabulary moves on again — so it states its mapping
  // literally rather than reading whatever `RETIRED_TEMPORAL_KINDS` says today.
  "packages/gateway/src/data/migrations.ts",
];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".ts") || entry.endsWith(".js")) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Repo root, from this file at `packages/types/src/`. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("temporal vocabulary has exactly one declaration", () => {
  it("no production file outside the vocabulary module enumerates three or more kinds", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(REPO_ROOT, "packages"))) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      if (rel.includes("temporal-vocabulary")) continue;
      if (ALLOWED_LITERAL_LISTS.includes(rel)) continue;
      // Tests name kinds as fixture data, which is not a second declaration —
      // what must not recur is production code constraining the vocabulary.
      if (/\.(test|spec)\.[cm]?[jt]s$/.test(rel) || rel.includes("/__fixtures__/")) continue;

      const text = readFileSync(file, "utf8");
      const quoted = new Set<string>();
      for (const kind of [...TEMPORAL_KINDS, ...Object.keys(RETIRED_TEMPORAL_KINDS)]) {
        if (text.includes(`"${kind}"`) || text.includes(`'${kind}'`)) quoted.add(kind);
      }
      if (quoted.size >= 3) offenders.push(`${rel} (${[...quoted].sort().join(", ")})`);
    }

    expect(offenders, `derive these from TEMPORAL_KINDS instead:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("no stale allowlist entries", () => {
    for (const entry of ALLOWED_LITERAL_LISTS) {
      expect(sourceFiles(join(REPO_ROOT, "packages")).map((f) => relative(REPO_ROOT, f))).toContain(
        entry,
      );
    }
  });
});
