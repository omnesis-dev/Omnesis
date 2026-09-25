// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SourceType, ProviderType } from "@omnesis/types";
import {
  defineSource,
  defineProvider,
  defineStructuredSource,
  memberScopedParamNames,
} from "./define-source.js";
import * as config from "./config-schema.js";
import { serializeDescriptor, type SourceDescriptor } from "./source-descriptor.js";

describe("supportedPlatforms — defineSource", () => {
  it("round-trips through defineSource (single platform)", () => {
    const def = defineSource({
      id: "macos-only",
      name: "macOS Only",
      description: "Test source",
      authType: "local",
      supportedPlatforms: ["darwin"],
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    expect(def.supportedPlatforms).toEqual(["darwin"]);
  });

  it("is undefined when not declared (cross-platform default)", () => {
    const def = defineSource({
      id: "cross-platform",
      name: "Cross Platform",
      description: "Test source",
      authType: "local",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    expect(def.supportedPlatforms).toBeUndefined();
  });

  it("rejects an empty supportedPlatforms array", () => {
    // `[]` would mean the source is unreachable on every host. Catching
    // it at the SDK boundary surfaces the mistake at provider build
    // time rather than as a silent disappearance from the picker.
    expect(() =>
      defineSource({
        id: "broken",
        name: "Broken",
        description: "Test source",
        authType: "local",
        supportedPlatforms: [],
        create: async () => ({
          sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
        }),
      }),
    ).toThrow(/globally unreachable/);
  });
});

describe("supportedPlatforms — defineProvider", () => {
  it("round-trips at provider level", () => {
    const def = defineProvider({
      provider: { id: "test", name: "Test" },
      authType: "local",
      supportedPlatforms: ["darwin"],
      sources: [
        {
          id: "test-source",
          name: "Test Source",
          description: "Test",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    expect(def.supportedPlatforms).toEqual(["darwin"]);
  });

  it("supports per-source override within a provider", () => {
    const def = defineProvider({
      provider: { id: "mixed", name: "Mixed" },
      authType: "local",
      supportedPlatforms: ["darwin", "linux"],
      sources: [
        {
          id: "darwin-only-child",
          name: "Darwin Only Child",
          description: "narrower than parent",
          supportedPlatforms: ["darwin"],
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "inheriting-child",
          name: "Inheriting Child",
          description: "inherits parent",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    expect(def.sources[0].supportedPlatforms).toEqual(["darwin"]);
    expect(def.sources[1].supportedPlatforms).toBeUndefined();
  });

  it("rejects an empty supportedPlatforms array at the provider level", () => {
    expect(() =>
      defineProvider({
        provider: { id: "broken", name: "Broken" },
        authType: "local",
        supportedPlatforms: [],
        sources: [
          {
            id: "broken-child",
            name: "Broken Child",
            description: "any",
            create: async () => ({
              sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
            }),
          },
        ],
      }),
    ).toThrow(/globally unreachable/);
  });

  it("rejects an empty supportedPlatforms array on a child source", () => {
    expect(() =>
      defineProvider({
        provider: { id: "ok-parent", name: "OK Parent" },
        authType: "local",
        sources: [
          {
            id: "broken-child",
            name: "Broken Child",
            description: "any",
            supportedPlatforms: [],
            create: async () => ({
              sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
            }),
          },
        ],
      }),
    ).toThrow(/use undefined to inherit/);
  });
});

describe("discovery — defineProvider", () => {
  it("allows factory-free external entries but requires factories for pulled entries", () => {
    const source = { id: "fixture-push", name: "Fixture push", description: "External fixture" };
    const provider = { provider: { id: "fixture", name: "Fixture" }, authType: "local" as const };
    const result = defineProvider({ ...provider, sources: [{ ...source, execution: "external" }] });
    expect(result.sources[0].create).toBeUndefined();
    expect(() => defineProvider({ ...provider, sources: [source] })).toThrow("missing 'create'");
  });
  it("requires provider discovery when a child narrows account availability", () => {
    expect(() =>
      defineProvider({
        provider: { id: "local-suite", name: "local suite" },
        authType: "local",
        sources: [
          {
            id: "local-records",
            name: "local records",
            description: "Test source",
            discover: async () => [],
            create: async () => ({
              sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
            }),
          },
        ],
      }),
    ).toThrow(/requires provider-level 'discover'/);
  });
});

describe("member-local availability proof", () => {
  it("accepts a validated member path on a discoverable source", () => {
    const def = defineSource({
      id: "local-records",
      name: "Local records",
      description: "Test source",
      authType: "local",
      discover: async () => [],
      params: [
        {
          name: "databasePath",
          label: "Database path",
          type: "path",
          scope: "member",
          provesLocalAvailabilityForAccount: "local",
          validate: () => null,
        },
      ],
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });

    expect(def.params?.[0]?.provesLocalAvailabilityForAccount).toBe("local");
  });

  it("rejects every incomplete availability-proof contract", () => {
    const validParam = {
      name: "databasePath",
      label: "Database path",
      type: "path" as const,
      scope: "member" as const,
      provesLocalAvailabilityForAccount: "local",
      validate: () => null,
    };
    const invalidParams = [
      { ...validParam, scope: "source" as const },
      { ...validParam, type: "string" as const },
      { ...validParam, validate: undefined },
      { ...validParam, provesLocalAvailabilityForAccount: "../local" },
    ];
    for (const param of invalidParams) {
      expect(() =>
        defineSource({
          id: "local-records",
          name: "Local records",
          description: "Test source",
          authType: "local",
          discover: async () => [],
          params: [param],
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        }),
      ).toThrow(/member-scoped path with validation/);
    }

    expect(() =>
      defineSource({
        id: "local-records",
        name: "Local records",
        description: "Test source",
        authType: "local",
        params: [validParam],
        create: async () => ({
          sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
        }),
      }),
    ).toThrow(/source that supports discovery/);
  });
});

describe("supportedPlatforms — defineStructuredSource", () => {
  it("round-trips through defineStructuredSource", () => {
    const def = defineStructuredSource({
      id: "structured-mac",
      name: "Structured Mac",
      description: "Test",
      authType: "local",
      supportedPlatforms: ["darwin"],
      analyticsSchemas: [
        {
          tableName: "test_table",
          columns: [{ name: "id", type: "TEXT" }],
          primaryKey: ["id"],
          semanticTimeColumn: null,
          record: { titleColumns: ["id"], keyColumns: ["id"] },
        },
      ],
      create: async () => ({
        analyticsSchemas: [
          {
            tableName: "test_table",
            columns: [{ name: "id", type: "TEXT" }],
            primaryKey: ["id"],
            semanticTimeColumn: null,
            record: { titleColumns: ["id"], keyColumns: ["id"] },
          },
        ],
        syncStructured: async () => ({
          records: [],
          tableName: "test_table",
          cursor: {},
          hasMore: false,
        }),
      }),
    });
    expect(def.supportedPlatforms).toEqual(["darwin"]);
  });
});

describe("reserved analytics columns", () => {
  const schema = {
    tableName: "test_table",
    columns: [
      { name: "id", type: "TEXT" },
      { name: "_stream_id", type: "TEXT" },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["id"], keyColumns: ["id"] },
  } as const;

  it("defineSource refuses a schema that declares the gateway's stream column", () => {
    expect(() =>
      defineSource({
        id: "reserved-source",
        name: "reserved source",
        description: "Test source",
        authType: "local",
        analyticsSchemas: [schema],
        create: async () => ({
          sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
        }),
      }),
    ).toThrow(/'_stream_id', which is reserved/);
  });

  it("defineProvider refuses a source schema that declares the gateway's stream column", () => {
    expect(() =>
      defineProvider({
        provider: { id: "reserved", name: "reserved" },
        authType: "local",
        sources: [
          {
            id: "reserved-child",
            name: "reserved child",
            description: "Test",
            analyticsSchemas: [schema],
            create: async () => ({
              sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
            }),
          },
        ],
      }),
    ).toThrow(/'_stream_id', which is reserved/);
  });

  it("defineStructuredSource refuses a schema that declares the gateway's stream column", () => {
    expect(() =>
      defineStructuredSource({
        id: "structured-reserved",
        name: "structured reserved",
        description: "Test",
        authType: "local",
        analyticsSchemas: [schema],
        create: async () => ({
          analyticsSchemas: [schema],
          syncStructured: async () => ({
            records: [],
            tableName: "test_table",
            cursor: {},
            hasMore: false,
          }),
        }),
      }),
    ).toThrow(/'_stream_id', which is reserved/);
  });
});

describe("supportedPlatforms — serializeDescriptor", () => {
  function fakeDescriptor(supportedPlatforms?: SourceDescriptor["supportedPlatforms"]) {
    return {
      id: SourceType("x"),
      name: "X",
      description: "x",
      provider: { id: ProviderType("p"), name: "P" },
      authType: "local" as const,
      supportedPlatforms,
    };
  }

  it("forwards declared platforms to the wire shape", () => {
    const serialized = serializeDescriptor(fakeDescriptor(["darwin"]));
    expect(serialized.supportedPlatforms).toEqual(["darwin"]);
  });

  it("omits the field on the wire when undefined", () => {
    const serialized = serializeDescriptor(fakeDescriptor(undefined));
    // `undefined` properties survive object-literal access but `JSON.stringify`
    // drops them — confirm the key is absent after a wire round-trip rather
    // than just spot-checking the JS getter.
    const wire = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
    expect("supportedPlatforms" in wire).toBe(false);
  });
});

describe("historyImport — serializeDescriptor (#588)", () => {
  const base = {
    id: SourceType("x"),
    name: "X",
    description: "x",
    provider: { id: ProviderType("p"), name: "P" },
    authType: "local" as const,
  };

  it("forwards the historyImport spec to the wire shape", () => {
    const serialized = serializeDescriptor({
      ...base,
      historyImport: {
        label: "Import full history",
        description: "from a backup",
        fields: [{ key: "backupPath", label: "Backup folder", type: "directory", required: true }],
      },
    });
    expect(serialized.historyImport?.label).toBe("Import full history");
    expect(serialized.historyImport?.fields[0].key).toBe("backupPath");
  });

  it("omits historyImport when the source doesn't support importing", () => {
    const wire = JSON.parse(JSON.stringify(serializeDescriptor(base))) as Record<string, unknown>;
    expect("historyImport" in wire).toBe(false);
  });
});

describe("the per-machine contract a source declares", () => {
  /** A source whose per-machine settings are split across the form and an escape hatch. */
  const withAdvancedMemberSetting = {
    id: "fixture-local",
    name: "fixture with a local store",
    description: "x",
    provider: { id: "fixture", name: "Fixture" },
    authType: "local" as const,
    config: config.object({
      dbPath: config.path({ label: "Database", scope: "member" as const, required: true }),
      overrideDir: config.path({ label: "Override", scope: "member" as const, advanced: true }),
      label: config.string({ label: "Label" }),
    }),
    create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
  };

  // Both halves, deliberately: either assertion alone still passes while the
  // helper reads the compiled form list, which is the shape that leaves an
  // advanced host-local setting out of the contract.
  it("leaves an advanced setting off the form but keeps it in the contract", () => {
    const def = defineSource(withAdvancedMemberSetting);

    expect(def.params?.map((p) => p.name)).not.toContain("overrideDir");
    expect(memberScopedParamNames(def)).toEqual(["dbPath", "overrideDir"]);
  });

  it("names only the settings that belong to a machine", () => {
    const def = defineSource(withAdvancedMemberSetting);
    expect(memberScopedParamNames(def)).not.toContain("label");
  });

  it("answers with a list when a source declares none, rather than staying silent", () => {
    // "declares none" and "did not say" are different facts and every consumer
    // reads a missing value as the second.
    const def = defineSource({
      id: "fixture-bare",
      name: "fixture declaring no config",
      description: "x",
      authType: "local" as const,
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    expect(memberScopedParamNames(def)).toEqual([]);
  });

  it("travels to clients, which route a value by it rather than by the form", () => {
    const def = defineSource(withAdvancedMemberSetting);
    const serialized = serializeDescriptor({
      ...(def as unknown as SourceDescriptor),
      memberScopedParamNames: memberScopedParamNames(def),
    });
    expect(serialized.memberScopedParamNames).toEqual(["dbPath", "overrideDir"]);
  });
});
