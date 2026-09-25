// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { defineSource, defineProvider } from "../define-source.js";
import { emptySync } from "../source.js";
import {
  formatConformanceReport,
  runProviderConformance,
  runSourceConformance,
} from "./conformance.js";
import type { AnalyticsTableSchema } from "../structured-source.js";

interface Notes extends Record<string, unknown> {
  after: string;
}
const isNotes = (v: unknown): v is Notes =>
  typeof v === "object" && v !== null && typeof (v as Notes).after === "string";

/** A well-formed source: two state versions, a complete migration. */
const wellFormed = defineSource<never, Notes>({
  id: "fieldnotes",
  name: "Fieldnotes",
  description: "Plain-text notes from a folder",
  authType: "local",
  unitName: "notes",
  contract: {
    apiVersion: 2,
    outputRevision: 1,
    requires: ["state-envelope"],
    state: {
      version: 2,
      decode: (v) => (isNotes(v) ? v : null),
      migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
    },
  },
  create: async () => ({ sync: async () => emptySync() }),
});

const errorsOf = (r: { findings: { severity: string; check: string }[] }) =>
  r.findings.filter((f) => f.severity === "error").map((f) => f.check);
const warningsOf = (r: { findings: { severity: string; check: string }[] }) =>
  r.findings.filter((f) => f.severity === "warning").map((f) => f.check);

describe("a well-formed source", () => {
  test("passes with fixtures for every version", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "abc" }, 2: { after: "abc" } },
      expectMigrated: {
        1: (s) => {
          if (s.after !== "abc") throw new Error("the v1 cursor value was not carried across");
        },
      },
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks).toBeGreaterThan(5);
    expect(formatConformanceReport(report)).toContain("conformance checks passed");
  });

  test("counts only the checks its declarations earn", async () => {
    // A source declaring no state runs strictly fewer checks than one that does.
    const bare = defineSource({
      id: "bookmarks",
      name: "Bookmarks",
      description: "Saved links",
      authType: "local",
      create: async () => ({ sync: async () => emptySync() }),
    });
    const bareReport = await runSourceConformance(bare);
    const richReport = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
    });
    expect(bareReport.checks).toBeLessThan(richReport.checks);
    expect(bareReport.findings).toEqual([]);
  });
});

describe("state checks", () => {
  test("a missing fixture for an old version is a warning, not a pass", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 2: { after: "abc" } },
    });
    expect(warningsOf(report)).toContain("state.migration-from-1");
    expect(report.ok).toBe(true);
  });

  test("a migration that produces an undecodable shape fails, naming the version", async () => {
    const broken = defineSource<never, Notes>({
      ...wellFormed,
      id: "broken-migration",
      contract: {
        ...wellFormed.contract,
        state: {
          version: 2,
          decode: (v) => (isNotes(v) ? v : null),
          migrate: { 1: () => ({ wrongField: true }) },
        },
      },
    });
    const report = await runSourceConformance(broken, {
      stateFixtures: { 1: { cursor: "abc" }, 2: { after: "abc" } },
    });
    expect(errorsOf(report)).toContain("state.migration-from-1");
    expect(report.ok).toBe(false);
  });

  test("expectMigrated failures are reported as findings, not thrown", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "abc" }, 2: { after: "abc" } },
      expectMigrated: {
        1: () => {
          throw new Error("the note count was dropped");
        },
      },
    });
    expect(errorsOf(report)).toContain("state.migration-from-1.expectations");
    expect(report.findings.map((f) => f.message)).toContain("the note count was dropped");
  });

  test("a decoder that rejects its own version's fixture fails", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { notTheRightShape: true } },
    });
    expect(errorsOf(report)).toContain("state.current-fixture");
  });

  test("a legacy stored value the source cannot classify fails", async () => {
    // A source that recognises its own historical shapes rejects anything
    // else. Without a legacyVersion discriminator every legacy value is
    // version 1 by definition, so a permissive v1 migration would accept
    // junk — which is exactly why declaring one is worth doing.
    const strict = defineSource<never, Notes>({
      ...wellFormed,
      id: "strict-legacy",
      contract: {
        ...wellFormed.contract,
        state: {
          version: 2,
          decode: (v) => (isNotes(v) ? v : null),
          legacyVersion: (v) => (typeof (v as { cursor?: unknown }).cursor === "string" ? 1 : null),
          migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
        },
      },
    });
    const report = await runSourceConformance(strict, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      legacyStateFixtures: [{ cursor: "a" }, { somethingElse: 1 }],
    });
    expect(errorsOf(report)).toContain("state.legacy-fixture-1");
    expect(errorsOf(report)).not.toContain("state.legacy-fixture-0");
  });

  test("a decoder that never settles is caught by the round trip, because the drift compounds silently", async () => {
    const drifting = defineSource<never, Notes>({
      ...wellFormed,
      id: "drifting-decoder",
      contract: {
        ...wellFormed.contract,
        state: {
          version: 2,
          // Appends on every pass, so each cycle writes a state that differs
          // from the last even when nothing upstream changed.
          decode: (v) => (isNotes(v) ? { ...v, after: `${v.after}!` } : null),
          migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
        },
      },
    });
    const report = await runSourceConformance(drifting, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
    });
    expect(errorsOf(report)).toContain("state.round-trip");
  });

  test("a decoder that emits a shape it would not accept is caught", async () => {
    const oneWay = defineSource<never, Notes>({
      ...wellFormed,
      id: "one-way-decoder",
      contract: {
        ...wellFormed.contract,
        state: {
          version: 2,
          // Accepts the stored shape but emits one it would not accept again.
          decode: (v) => (isNotes(v) ? ({ renamed: v.after } as unknown as Notes) : null),
          migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
        },
      },
    });
    const report = await runSourceConformance(oneWay, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
    });
    expect(errorsOf(report)).toContain("state.round-trip");
  });

  test("normalising in decode is fine, as long as it settles", async () => {
    const normalising = defineSource<never, Notes>({
      ...wellFormed,
      id: "normalising-decoder",
      contract: {
        ...wellFormed.contract,
        state: {
          version: 2,
          decode: (v) => (isNotes(v) ? { after: v.after.trim() } : null),
          migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
        },
      },
    });
    const report = await runSourceConformance(normalising, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "  a  " } },
    });
    expect(errorsOf(report)).toEqual([]);
  });
});

describe("declaration versus implementation", () => {
  const schema = [
    {
      tableName: "notes_daily",
      displayName: "Notes",
      description: "Daily note counts",
      columns: [{ name: "day", type: "DATE" }],
      primaryKey: ["day"],
      semanticTimeColumn: "day",
      record: { titleColumns: ["day"], keyColumns: ["day"] },
    },
  ] as unknown as AnalyticsTableSchema[];

  test("declaring analytics tables without implementing syncStructured fails", async () => {
    const def = defineSource({
      id: "claims-analytics",
      name: "Claims analytics",
      description: "Declares tables it never writes",
      authType: "local",
      analyticsSchemas: schema,
      create: async () => ({ sync: async () => emptySync() }),
    });
    const report = await runSourceConformance(def, {
      instantiate: () => ({ sync: async () => emptySync() }),
    });
    expect(errorsOf(report)).toContain("capability.analytics");
    expect(report.findings[0]?.message).toContain("never written");
  });

  test("implementing syncStructured without declaring schemas fails", async () => {
    const def = defineSource({
      id: "hidden-analytics",
      name: "Hidden analytics",
      description: "Writes tables it never declares",
      authType: "local",
      create: async () => ({ sync: async () => emptySync() }),
    });
    const report = await runSourceConformance(def, {
      instantiate: () => ({
        sync: async () => emptySync(),
        syncStructured: async () => ({
          records: [],
          tableName: "notes_daily",
          cursor: {},
          hasMore: false,
        }),
      }),
    });
    expect(errorsOf(report)).toContain("capability.analytics");
  });

  test("an empty schema array is a legitimate declaration for a dynamic source", async () => {
    // Notion-style: the tables exist but their columns are discovered at
    // runtime. The capability is still declared, so the check passes.
    const def = defineSource({
      id: "dynamic-analytics",
      name: "Dynamic analytics",
      description: "Schemas discovered at runtime",
      authType: "local",
      analyticsSchemas: [],
      create: async () => ({ sync: async () => emptySync() }),
    });
    const report = await runSourceConformance(def, {
      instantiate: () => ({
        sync: async () => emptySync(),
        syncStructured: async () => ({
          records: [],
          tableName: "discovered",
          cursor: {},
          hasMore: false,
        }),
      }),
    });
    expect(errorsOf(report)).toEqual([]);
  });

  test("suspend without resume fails, because disabling would be irreversible", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      instantiate: () => ({ sync: async () => emptySync(), suspend: async () => {} }),
    });
    expect(errorsOf(report)).toContain("lifecycle.suspend-resume");
    expect(report.findings.map((f) => f.message).join()).toContain("cannot be undone");
  });

  test("resume without suspend fails too", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      instantiate: () => ({ sync: async () => emptySync(), resume: async () => {} }),
    });
    expect(errorsOf(report)).toContain("lifecycle.suspend-resume");
  });

  test("both together pass", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      instantiate: () => ({
        sync: async () => emptySync(),
        suspend: async () => {},
        resume: async () => {},
      }),
    });
    expect(errorsOf(report)).toEqual([]);
  });

  test("declaring a history import without implementing it fails", async () => {
    const def = defineSource({
      id: "claims-import",
      name: "Claims import",
      description: "Offers a form that cannot run",
      authType: "local",
      historyImport: { label: "Import", description: "Import a backup", fields: [] },
      create: async () => ({ sync: async () => emptySync() }),
    });
    const report = await runSourceConformance(def, {
      instantiate: () => ({ sync: async () => emptySync() }),
    });
    expect(errorsOf(report)).toContain("capability.history-import");
  });

  test("a create() that throws is a finding, not an exception", async () => {
    const report = await runSourceConformance(wellFormed, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      instantiate: () => {
        throw new Error("vault path missing");
      },
    });
    expect(errorsOf(report)).toContain("instance.creates");
    expect(report.findings.map((f) => f.message).join()).toContain("vault path missing");
  });
});

describe("static declaration sanity", () => {
  test("an invalid self-identity pattern fails", async () => {
    const def = defineSource({
      id: "bad-pattern",
      name: "Bad pattern",
      description: "Unparseable identity regex",
      authType: "local",
      selfIdentity: { aliasPrefix: "acme", accountPattern: "^([0-9" },
      create: async () => ({ sync: async () => emptySync() }),
    });
    const report = await runSourceConformance(def);
    expect(errorsOf(report)).toContain("self-identity.pattern");
  });
});

describe("provider packages", () => {
  test("every source entry gets its own report", async () => {
    const provider = defineProvider({
      provider: { id: "acme", name: "Acme" },
      authType: "oauth",
      contract: { apiVersion: 2 },
      sources: [
        {
          id: "acme-mail",
          name: "Acme mail",
          description: "Mail",
          create: async () => ({ sync: async () => emptySync() }),
        },
        {
          id: "acme-files",
          name: "Acme files",
          description: "Files",
          create: async () => ({ sync: async () => emptySync() }),
        },
      ],
    });
    const reports = await runProviderConformance(provider);
    expect(reports.map((r) => r.source)).toEqual(["acme-mail", "acme-files"]);
    // Both inherit the provider's api version 2 with no state spec, which is
    // the warning that exists to stop a package claiming the new generation
    // while keeping the old indistinguishable-first-run behaviour.
    expect(reports.every((r) => warningsOf(r).includes("state.declared"))).toBe(true);
    expect(reports.every((r) => r.ok)).toBe(true);
  });
});

describe("shapes a source must refuse", () => {
  /** A source whose older cursors carry watermarks no transform can repair. */
  const strict = defineSource<never, Notes>({
    ...wellFormed,
    id: "strict-refuser",
    contract: {
      ...wellFormed.contract,
      state: {
        version: 2,
        decode: (v) => (isNotes(v) ? v : null),
        legacyVersion: (v) => ((v as { renderVersion?: number }).renderVersion === 3 ? null : 1),
        migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
      },
    },
  });

  test("a declared refusal that is honoured passes", async () => {
    const report = await runSourceConformance(strict, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      refusedStateFixtures: [{ renderVersion: 3, cursor: "stale" }],
    });
    expect(errorsOf(report)).toEqual([]);
  });

  test("a declared refusal the source actually resumes from fails", async () => {
    const lax = defineSource<never, Notes>({
      ...strict,
      id: "lax-refuser",
      contract: {
        ...strict.contract,
        state: { ...strict.contract!.state!, legacyVersion: () => 1 },
      },
    });
    const report = await runSourceConformance(lax, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
      refusedStateFixtures: [{ renderVersion: 3, cursor: "stale" }],
    });
    expect(errorsOf(report)).toContain("state.refused-fixture-0");
  });
});

describe("a state ceiling", () => {
  const bounded = defineSource<never, Notes>({
    ...wellFormed,
    id: "bounded-state",
    contract: {
      ...wellFormed.contract,
      state: {
        version: 2,
        maxBytes: 120,
        decode: (v) => (isNotes(v) ? v : null),
        migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
      },
    },
  });

  test("state within the ceiling round-trips normally", async () => {
    const report = await runSourceConformance(bounded, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "a" } },
    });
    expect(errorsOf(report)).toEqual([]);
  });

  test("state over the ceiling fails the round trip rather than being written", async () => {
    const report = await runSourceConformance(bounded, {
      stateFixtures: { 1: { cursor: "a" }, 2: { after: "x".repeat(400) } },
    });
    // Surfaced through the round-trip check: encoding is where the ceiling is
    // enforced, because the envelope is what actually reaches storage.
    expect(report.ok).toBe(false);
  });
});
