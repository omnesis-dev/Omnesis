// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { defineProvider, defineSource } from "@omnesis/source-sdk";
import { AccountId, SourceType, ProviderType } from "@omnesis/types";
import {
  setupSources,
  warnAboutUnreachableConfiguredSources,
  resetOrphanWarningsForTesting,
  type SourceInstantiatorContext,
} from "./source-instantiator.js";
import { buildSourceToProviderMap } from "./source-config-reconciler.js";
import type { SourceConfig } from "@omnesis/core";
import type {
  SourceDescriptor,
  SourceOrProviderDefinition,
  GatewayClient,
} from "@omnesis/source-sdk";
import type { RegisteredProvider } from "./sync-engine-types.js";

let isolatedConfigDir: string;
beforeEach(() => {
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "omnesis-instantiator-"));
  vi.stubEnv("OMNESIS_CONFIG_DIR", isolatedConfigDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(isolatedConfigDir, { recursive: true, force: true });
});

describe("warnAboutUnreachableConfiguredSources", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetOrphanWarningsForTesting();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  function makeCtx(
    definitions: SourceOrProviderDefinition[],
    descriptorsToAdvertise: SourceDescriptor[],
  ): SourceInstantiatorContext {
    return {
      configDir: isolatedConfigDir,
      definitions,
      descriptors: descriptorsToAdvertise,
      sourceToProvider: buildSourceToProviderMap(descriptorsToAdvertise),
      config: { sources: {} },
      gateway: {} as GatewayClient,

      engine: {} as any,
    };
  }

  function makeDescriptor(id: string, providerId: string): SourceDescriptor {
    return {
      id: SourceType(id),
      name: id,
      description: id,
      provider: { id: ProviderType(providerId), name: providerId },
      authType: "local",
    };
  }

  it("warns when a configured source has no descriptor and is platform-gated", () => {
    // Simulate Linux host with the Apple provider definition loaded but
    // its descriptors filtered out (the production behavior introduced by
    // `supportedPlatforms`). A user copied `apple-notes:foo@icloud.com`
    // over from a Mac config.
    const appleDef = defineProvider({
      provider: { id: "apple", name: "Apple" },
      authType: "local",
      supportedPlatforms: ["darwin"],
      sources: [
        {
          id: "apple-notes",
          name: "Apple Notes",
          description: "notes",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const ctx = makeCtx([appleDef], []);
    const enabled: Record<string, SourceConfig> = {
      "apple-notes:foo@icloud.com": { enabled: true },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);

    const calls = consoleWarnSpy.mock.calls.map((c) => String(c[0]));
    const warning = calls.find((m) => m.includes("apple-notes:foo@icloud.com"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/supportedPlatforms=\[darwin\]/);
    expect(warning).toMatch(/copied from another OS/);
  });

  it("warns with a generic message when the source ID is unknown", () => {
    const ctx = makeCtx([], []);
    const enabled: Record<string, SourceConfig> = {
      "ghost-source:account": { enabled: true },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);

    const calls = consoleWarnSpy.mock.calls.map((c) => String(c[0]));
    const warning = calls.find((m) => m.includes("ghost-source:account"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/no descriptor in the registry/);
    expect(warning).toMatch(/provider package was removed/);
  });

  it("warns with an OMNESIS_EXPERIMENTAL hint for a configured but gated experimental source", () => {
    // The definition stays loaded (experimental gating only removes the
    // descriptor), so the source resolves as experimental rather than as a
    // removed package — the warning must point at the flag, not at deletion.
    const def = defineProvider({
      provider: { id: "labs", name: "Labs" },
      authType: "local",
      experimental: true,
      sources: [
        {
          id: "labs-source",
          name: "Labs Source",
          description: "not yet battle-tested",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const ctx = makeCtx([def], []); // definition loaded, descriptor gated out
    const enabled: Record<string, SourceConfig> = {
      "labs-source:account": { enabled: true },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);

    const calls = consoleWarnSpy.mock.calls.map((c) => String(c[0]));
    const warning = calls.find((m) => m.includes("labs-source:account"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/experimental and currently hidden/);
    expect(warning).toMatch(/OMNESIS_EXPERIMENTAL=1/);
    expect(warning).not.toMatch(/provider package was removed/);
  });

  it("stays silent for configured sources that DO have a descriptor", () => {
    const def = defineSource({
      id: "obsidian-notes",
      name: "Obsidian",
      description: "x",
      authType: "local",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const descriptors: SourceDescriptor[] = [makeDescriptor("obsidian-notes", "obsidian-notes")];
    const ctx = makeCtx([def], descriptors);
    const enabled: Record<string, SourceConfig> = {
      "obsidian-notes:vault-a": { enabled: true },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("does not double-warn on a second invocation with the same key", () => {
    const def = defineSource({
      id: "macos-source",
      name: "macOS Source",
      description: "x",
      authType: "local",
      supportedPlatforms: ["darwin"],
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const ctx = makeCtx([def], []);
    const enabled: Record<string, SourceConfig> = {
      "macos-source:acct": { enabled: true },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);
    const firstCount = consoleWarnSpy.mock.calls.length;
    warnAboutUnreachableConfiguredSources(ctx, enabled);
    expect(consoleWarnSpy.mock.calls.length).toBe(firstCount);
  });

  it("ignores disabled config entries", () => {
    const def = defineSource({
      id: "macos-source",
      name: "macOS Source",
      description: "x",
      authType: "local",
      supportedPlatforms: ["darwin"],
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const ctx = makeCtx([def], []);
    const enabled: Record<string, SourceConfig> = {
      "macos-source:acct": { enabled: false },
    };

    warnAboutUnreachableConfiguredSources(ctx, enabled);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});

describe("setupSources — per-instance label override", () => {
  function makeDescriptor(id: string, providerId: string): SourceDescriptor {
    return {
      id: SourceType(id),
      name: id,
      description: id,
      provider: { id: ProviderType(providerId), name: providerId },
      authType: "local",
    };
  }

  function makeCtx(
    definitions: SourceOrProviderDefinition[],
    descriptors: SourceDescriptor[],
    registered: RegisteredProvider[],
  ): SourceInstantiatorContext {
    return {
      configDir: isolatedConfigDir,
      definitions,
      descriptors,
      sourceToProvider: buildSourceToProviderMap(descriptors),
      config: { sources: {} },
      gateway: {} as GatewayClient,
      engine: {
        registerProvider: (p: RegisteredProvider) => registered.push(p),
      } as never,
    };
  }

  const noopSync = async () => ({ documents: [], cursor: {}, hasMore: false });

  it("a standalone authenticated source owns its typed connection state", async () => {
    const definition = defineSource({
      id: "fixture-linked",
      name: "Fixture",
      description: "Fixture",
      authType: "oauth",
      discover: async () => [AccountId("local")],
      create: async () => ({
        sync: noopSync,
        credentialState: async () => ({ status: "unlinked" as const }),
      }),
    });
    const registered: RegisteredProvider[] = [];
    await setupSources(
      makeCtx([definition], [makeDescriptor("fixture-linked", "fixture-linked")], registered),
      { "fixture-linked": { enabled: true } },
    );
    expect(registered[0].renewableCredential).toBe(true);
    await expect(registered[0].credentialState()).resolves.toEqual({ status: "unlinked" });
  });

  it("only lends scoped hosts to source factories and never constructs external entries", async () => {
    const received: unknown[] = [];
    const externalCreate = vi.fn(async () => ({ sync: noopSync }));
    const single = defineSource({
      id: "fixture-single",
      name: "Fixture",
      description: "Fixture",
      authType: "local",
      discover: async () => [AccountId("local")],
      create: async (options) => {
        received.push(options);
        return { sync: noopSync };
      },
    });
    const provider = defineProvider({
      provider: { id: "fixture-provider", name: "Fixture" },
      authType: "local",
      discover: async () => [AccountId("local")],
      createContext: async (options) => {
        received.push(options);
        return {};
      },
      sources: [
        {
          id: "fixture-child",
          name: "Child",
          description: "Fixture",
          create: async (options) => {
            received.push(options);
            return { sync: noopSync };
          },
        },
        {
          id: "fixture-external",
          name: "Push",
          description: "Fixture",
          execution: "external",
          create: externalCreate,
        },
        { id: "fixture-no-factory", name: "Push", description: "Fixture", execution: "external" },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [single, provider],
      [
        makeDescriptor("fixture-single", "fixture-single"),
        makeDescriptor("fixture-child", "fixture-provider"),
        makeDescriptor("fixture-external", "fixture-provider"),
        makeDescriptor("fixture-no-factory", "fixture-provider"),
      ],
      registered,
    );
    await setupSources(ctx, {
      "fixture-single": { enabled: true },
      "fixture-child": { enabled: true },
      "fixture-external": { enabled: true },
      "fixture-no-factory": { enabled: true },
    });
    expect(received).toHaveLength(3);
    for (const options of received) {
      expect(options).not.toHaveProperty("gateway");
      expect(options).toHaveProperty("host");
    }
    expect(externalCreate).not.toHaveBeenCalled();
    expect(
      registered.flatMap((entry) => entry.sources.map((source) => String(source.id))).sort(),
    ).toEqual(["fixture-child:local", "fixture-single:local"]);
  });

  it("source definition: instance.label wins over def.name; absent label falls back", async () => {
    const def = defineSource({
      id: "test-label-source",
      name: "Generic Name",
      description: "x",
      authType: "local",
      discover: async () => [AccountId("with-label"), AccountId("without-label")],
      create: async (options) => ({
        sync: noopSync,
        label: options.accountId === "with-label" ? "Custom Label" : undefined,
      }),
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("test-label-source", "test-label-source")],
      registered,
    );

    await setupSources(ctx, { "test-label-source": { enabled: true } });

    const names = new Map(
      registered.flatMap((p) => p.sources.map((s) => [String(s.id), s.name] as const)),
    );
    expect(names.get("test-label-source:with-label")).toBe("Custom Label");
    expect(names.get("test-label-source:without-label")).toBe("Generic Name");
  });

  it("the account's declared label sits between the instance's and the family's", async () => {
    // Three answers to one question, and a stated order. Without the middle
    // rung the descriptor's `label` had no producer and no reader — a field
    // an author could set and never see used.
    const def = defineSource({
      id: "test-declared-label",
      name: "Generic Name",
      description: "x",
      authType: "local",
      discover: async () => [
        { id: "opaque-1", label: "declared" },
        { id: "opaque-2", label: "also-declared" },
        { id: "opaque-3", label: undefined },
      ],
      create: async (options) => ({
        sync: noopSync,
        label: options.accountId === "opaque-1" ? "live" : undefined,
      }),
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("test-declared-label", "test-declared-label")],
      registered,
    );

    await setupSources(ctx, { "test-declared-label": { enabled: true } });

    const names = new Map(
      registered.flatMap((p) => p.sources.map((s) => [String(s.id), s.name] as const)),
    );
    // A live label resolved while the source runs wins: it can change, and the
    // declaration cannot.
    expect(names.get("test-declared-label:opaque-1")).toBe("live");
    // No live label, so what the source knew at discovery.
    expect(names.get("test-declared-label:opaque-2")).toBe("also-declared");
    // Neither, so the family's name — which is what every account showed
    // before, including the ones whose id is unreadable.
    expect(names.get("test-declared-label:opaque-3")).toBe("Generic Name");
    const accounts = registered.flatMap((provider) =>
      provider.sources.map((source) => source.account),
    );
    expect(accounts).toEqual([
      { id: "opaque-1", label: "declared" },
      { id: "opaque-2", label: "also-declared" },
      undefined,
    ]);
  });

  it("provider definition: the declared label sits between them there too", async () => {
    // The same three rungs on the other instantiation branch. Removing a
    // fallback needs every construction site checked, not the one that has a
    // test.
    const def = defineProvider({
      provider: { id: "test-declared-provider", name: "declared-provider" },
      authType: "local",
      discover: async () => [{ id: "opaque-1", label: "declared" }, { id: "opaque-2" }],
      sources: [
        {
          id: "test-declared-entry",
          name: "Entry Name",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("test-declared-entry", "test-declared-provider")],
      registered,
    );

    await setupSources(ctx, { "test-declared-entry": { enabled: true } });

    const names = new Map(
      registered.flatMap((p) => p.sources.map((s) => [String(s.id), s.name] as const)),
    );
    expect(names.get("test-declared-entry:opaque-1")).toBe("declared");
    expect(names.get("test-declared-entry:opaque-2")).toBe("Entry Name");
  });

  it("a registered source carries the family its definition declares", async () => {
    // The family is what a client shows when it groups by type. Nothing
    // asserted that the collector actually supplies one — the tests that read
    // it build their own.
    const def = defineSource({
      id: "test-family-source",
      name: "the-family",
      description: "x",
      authType: "local",
      discover: async () => [{ id: "acct-1", label: "declared" }],
      create: async () => ({ sync: noopSync, label: "instance" }),
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("test-family-source", "test-family-source")],
      registered,
    );

    await setupSources(ctx, { "test-family-source": { enabled: true } });

    const source = registered.flatMap((p) => p.sources)[0];
    // Its own name is the account's; the family's is the definition's, and
    // never an account override — that is the whole distinction.
    expect(source.name).toBe("instance");
    expect(source.family.name).toBe("the-family");
  });

  it("provider definition: instance.label wins over the source entry name", async () => {
    const def = defineProvider({
      provider: { id: "test-label-provider", name: "Test Label Provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      sources: [
        {
          id: "test-labelled",
          name: "Entry Name",
          description: "x",
          create: async () => ({ sync: noopSync, label: "Instance Label" }),
        },
        {
          id: "test-unlabelled",
          name: "Plain Entry",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("test-labelled", "test-label-provider"),
        makeDescriptor("test-unlabelled", "test-label-provider"),
      ],
      registered,
    );

    await setupSources(ctx, {
      "test-labelled": { enabled: true },
      "test-unlabelled": { enabled: true },
    });

    const names = new Map(
      registered.flatMap((p) => p.sources.map((s) => [String(s.id), s.name] as const)),
    );
    expect(names.get("test-labelled:acct-1")).toBe("Instance Label");
    expect(names.get("test-unlabelled:acct-1")).toBe("Plain Entry");
  });
});

describe("setupSources — audio routing by the conversational flag", () => {
  function makeDescriptor(id: string, providerId: string): SourceDescriptor {
    return {
      id: SourceType(id),
      name: id,
      description: id,
      provider: { id: ProviderType(providerId), name: providerId },
      authType: "local",
    };
  }

  const noopSync = async () => ({ documents: [], cursor: {}, hasMore: false });

  /**
   * Run setupSources for a provider with one conversational + one document
   * source and capture the `CreateOptions` each one's factory received. Audio
   * routing is driven purely by whether the instantiator context carries a
   * `transcribeAudio` fn — when `sttOn` is true one is wired, otherwise the
   * context has none.
   */
  async function captureCreateOptions(sttOn: boolean) {
    const seen = new Map<string, { transcribeAudio: unknown; includeAudioTypes: unknown }>();
    const def = defineProvider({
      provider: { id: "audio-provider", name: "Audio Provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      sources: [
        {
          id: "conv-src",
          name: "Conversation",
          description: "x",
          conversational: true,
          create: async (options) => {
            seen.set("conv-src", {
              transcribeAudio: options.transcribeAudio,
              includeAudioTypes: options.includeAudioTypes,
            });
            return { sync: noopSync };
          },
        },
        {
          id: "doc-src",
          name: "Document",
          description: "x",
          create: async (options) => {
            seen.set("doc-src", {
              transcribeAudio: options.transcribeAudio,
              includeAudioTypes: options.includeAudioTypes,
            });
            return { sync: noopSync };
          },
        },
      ],
    });

    const descriptors = [
      makeDescriptor("conv-src", "audio-provider"),
      makeDescriptor("doc-src", "audio-provider"),
    ];
    const transcribeAudio = vi.fn();
    const ctx: SourceInstantiatorContext = {
      definitions: [def],
      descriptors,
      sourceToProvider: buildSourceToProviderMap(descriptors),
      config: { sources: {} },
      gateway: {} as GatewayClient,
      engine: { registerProvider: () => {} } as never,
      ...(sttOn ? { transcribeAudio } : {}),
    };

    await setupSources(ctx, { "conv-src": { enabled: true }, "doc-src": { enabled: true } });
    return { seen, transcribeAudio };
  }

  it("with a transcribeAudio fn wired: conversation source gets transcribeAudio, document source gets includeAudioTypes", async () => {
    const { seen, transcribeAudio } = await captureCreateOptions(true);

    expect(seen.get("conv-src")!.transcribeAudio).toBe(transcribeAudio);
    expect(seen.get("conv-src")!.includeAudioTypes).toBe(false);

    expect(seen.get("doc-src")!.transcribeAudio).toBeUndefined();
    expect(seen.get("doc-src")!.includeAudioTypes).toBe(true);
  });

  it("with no transcribeAudio fn wired: neither source gets transcribeAudio nor includeAudioTypes", async () => {
    const { seen } = await captureCreateOptions(false);

    expect(seen.get("conv-src")!.transcribeAudio).toBeUndefined();
    expect(seen.get("conv-src")!.includeAudioTypes).toBe(false);

    expect(seen.get("doc-src")!.transcribeAudio).toBeUndefined();
    expect(seen.get("doc-src")!.includeAudioTypes).toBe(false);
  });
});

describe("setupSources — per-source settings by config key specificity", () => {
  function makeDescriptor(id: string, providerId: string): SourceDescriptor {
    return {
      id: SourceType(id),
      name: id,
      description: id,
      provider: { id: ProviderType(providerId), name: providerId },
      authType: "local",
    };
  }

  const noopSync = async () => ({ documents: [], cursor: {}, hasMore: false });

  /**
   * Two accounts of one source type, a descriptor-keyed settings block and an
   * instance-keyed one. Captures what each account's factory was handed.
   */
  async function captureCreateOptions() {
    const seen = new Map<string, { sourceConfig?: SourceConfig; dataCutoff?: string }>();
    const def = defineProvider({
      provider: { id: "settings-provider", name: "settings-provider" },
      authType: "local",
      discover: async () => [AccountId("maya@example.com"), AccountId("jamie@example.org")],
      sources: [
        {
          id: "settings-src",
          name: "settings-src",
          description: "x",
          create: async (options) => {
            seen.set(String(options.sourceId), {
              sourceConfig: options.sourceConfig,
              dataCutoff: options.dataCutoff,
            });
            return { sync: noopSync };
          },
        },
      ],
    });

    const descriptors = [makeDescriptor("settings-src", "settings-provider")];
    const ctx: SourceInstantiatorContext = {
      definitions: [def],
      descriptors,
      sourceToProvider: buildSourceToProviderMap(descriptors),
      config: {
        dataRetention: { maxAge: "1y" },
        sources: {
          "settings-src": { enabled: true, syncInterval: "30m", maxAge: "7d" },
          "settings-src:maya@example.com": { enabled: true, syncInterval: "2m" },
        },
      },
      gateway: {} as GatewayClient,
      engine: { registerProvider: () => {} } as never,
    };

    await setupSources(ctx, { "settings-src": { enabled: true } });
    return seen;
  }

  it("a descriptor-keyed block reaches every account; the instance key wins per field", async () => {
    const seen = await captureCreateOptions();

    expect(seen.get("settings-src:maya@example.com")!.sourceConfig?.syncInterval).toBe("2m");
    expect(seen.get("settings-src:jamie@example.org")!.sourceConfig?.syncInterval).toBe("30m");
    // Not restated on the instance block, so it comes from the descriptor one.
    expect(seen.get("settings-src:maya@example.com")!.sourceConfig?.maxAge).toBe("7d");
  });

  it("a descriptor-keyed maxAge bounds the data cutoff of every account", async () => {
    const seen = await captureCreateOptions();
    const dayMs = 24 * 3_600_000;

    for (const id of ["settings-src:maya@example.com", "settings-src:jamie@example.org"]) {
      const cutoff = seen.get(id)!.dataCutoff;
      expect(cutoff).toBeDefined();
      expect(Math.abs(new Date(cutoff!).getTime() - (Date.now() - 7 * dayMs))).toBeLessThan(60_000);
    }
  });
});

describe("setupSources — an instantiation failure is reported, not swallowed", () => {
  function makeDescriptor(id: string, providerId: string): SourceDescriptor {
    return {
      id: SourceType(id),
      name: id,
      description: id,
      provider: { id: ProviderType(providerId), name: providerId },
      authType: "local",
    };
  }

  function makeCtx(
    definitions: SourceOrProviderDefinition[],
    descriptors: SourceDescriptor[],
    registered: RegisteredProvider[],
  ): SourceInstantiatorContext {
    return {
      configDir: isolatedConfigDir,
      definitions,
      descriptors,
      sourceToProvider: buildSourceToProviderMap(descriptors),
      config: { sources: {} },
      gateway: {} as GatewayClient,
      engine: {
        registerProvider: (p: RegisteredProvider) => registered.push(p),
      } as unknown as SourceInstantiatorContext["engine"],
    };
  }

  const noopSync = async () => ({ documents: [], cursor: {}, hasMore: false });

  it("refuses a missing capability before create and still registers a provider's supported sibling", async () => {
    const refusedCreate = vi.fn(async () => ({ sync: noopSync }));
    const supportedCreate = vi.fn(async () => ({ sync: noopSync }));
    const def = defineProvider({
      provider: { id: "contract-suite", name: "Contract suite" },
      authType: "local",
      discover: async () => [AccountId("local")],
      sources: [
        {
          id: "future-records",
          name: "Future",
          description: "Fixture",
          contract: { requires: ["connection-identity"] },
          create: refusedCreate,
        },
        {
          id: "supported-records",
          name: "Supported",
          description: "Fixture",
          contract: {
            apiVersion: 2,
            requires: [
              "snapshot-sessions",
              "scoped-host",
              "typed-config",
              "tuple-deletes",
              "multi-table-batch",
            ],
          },
          create: supportedCreate,
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("future-records", "contract-suite"),
        makeDescriptor("supported-records", "contract-suite"),
      ],
      registered,
    );
    const failures = await setupSources(ctx, {
      "future-records:local": { enabled: true },
      "supported-records:local": { enabled: true },
    });
    expect(refusedCreate).not.toHaveBeenCalled();
    expect(supportedCreate).toHaveBeenCalledOnce();
    expect(failures).toEqual([
      { key: "future-records:local", error: expect.stringContaining("connection-identity") },
    ]);
    expect(registered.flatMap((provider) => provider.sources.map((source) => source.id))).toEqual([
      "supported-records:local",
    ]);
  });

  it("reports a single-source capability refusal instead of creating an unsafe instance", async () => {
    const create = vi.fn(async () => ({ sync: noopSync }));
    const def = defineSource({
      id: "future-local",
      name: "Future local",
      description: "Fixture",
      authType: "local",
      discover: async () => [AccountId("local")],
      contract: { requires: ["connection-identity"] },
      create,
    });
    const registered: RegisteredProvider[] = [];
    const failures = await setupSources(
      makeCtx([def], [makeDescriptor("future-local", "future-local")], registered),
      { "future-local:local": { enabled: true } },
    );
    expect(create).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
    expect(failures).toEqual([
      { key: "future-local:local", error: expect.stringContaining("connection-identity") },
    ]);
  });

  it("does not bind a discovered single-source provider to an absent configured account", async () => {
    const create = vi.fn(async () => ({ sync: noopSync }));
    const def = defineSource({
      id: "desktop-notes",
      name: "fixture records",
      description: "x",
      provider: { id: "desktop-suite", name: "fixture adapter" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      create,
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("desktop-notes", "desktop-suite")], registered);

    const failures = await setupSources(ctx, {
      "desktop-notes:missing@example.com": { enabled: true },
    });

    expect(create).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
    expect(failures).toEqual([
      {
        key: "desktop-notes:missing@example.com",
        error:
          "fixture adapter did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("uses a validated member-local path when the source is outside automatic discovery", async () => {
    const create = vi.fn(async () => ({ sync: noopSync }));
    const def = defineSource({
      id: "desktop-notes",
      name: "fixture records",
      description: "x",
      provider: { id: "desktop-suite", name: "fixture adapter" },
      authType: "local",
      params: [
        {
          name: "databasePath",
          label: "Database path",
          type: "path",
          scope: "member",
          provesLocalAvailabilityForAccount: "local",
          validate: (value) => (value === "/srv/fixture/notes.db" ? null : "not found"),
        },
      ],
      discover: async () => [],
      create,
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("desktop-notes", "desktop-suite")], registered);
    ctx.config.sources = {
      "desktop-notes:local": {
        enabled: true,
        params: { databasePath: "/srv/fixture/notes.db" },
      },
    };

    const failures = await setupSources(ctx, ctx.config.sources);

    expect(failures).toEqual([]);
    expect(create).toHaveBeenCalledOnce();
    expect(registered[0]?.sources[0]?.id).toBe("desktop-notes:local");
  });

  it("does not let an invalid member-local path bypass account discovery", async () => {
    const create = vi.fn(async () => ({ sync: noopSync }));
    const def = defineSource({
      id: "desktop-notes",
      name: "fixture records",
      description: "x",
      provider: { id: "desktop-suite", name: "fixture adapter" },
      authType: "local",
      params: [
        {
          name: "databasePath",
          label: "Database path",
          type: "path",
          scope: "member",
          provesLocalAvailabilityForAccount: "local",
          validate: () => "not found",
        },
      ],
      discover: async () => [],
      create,
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("desktop-notes", "desktop-suite")], registered);
    ctx.config.sources = {
      "desktop-notes:local": {
        enabled: true,
        params: { databasePath: "/srv/fixture/missing.db" },
      },
    };

    const failures = await setupSources(ctx, ctx.config.sources);

    expect(create).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
    expect(failures).toEqual([
      {
        key: "desktop-notes:local",
        error:
          "fixture adapter did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("fails closed when an availability proof is malformed or names another account", async () => {
    for (const scenario of ["primitive", "throwing-validator", "wrong-account"] as const) {
      const create = vi.fn(async () => ({ sync: noopSync }));
      const def = defineSource({
        id: "desktop-notes",
        name: "fixture records",
        description: "x",
        provider: { id: "desktop-suite", name: "fixture adapter" },
        authType: "local",
        params: [
          {
            name: "databasePath",
            label: "Database path",
            type: "path",
            scope: "member",
            provesLocalAvailabilityForAccount: "local",
            validate: () => {
              if (scenario === "throwing-validator") throw new Error("unreadable path");
              return null;
            },
          },
        ],
        discover: async () => [],
        create,
      });
      const registered: RegisteredProvider[] = [];
      const ctx = makeCtx([def], [makeDescriptor("desktop-notes", "desktop-suite")], registered);
      const sourceKey = `desktop-notes:${scenario === "wrong-account" ? "other-account" : "local"}`;
      ctx.config.sources = {
        [sourceKey]: {
          enabled: true,
          params: {
            databasePath: (scenario === "primitive" ? 42 : "/srv/fixture/notes.db") as never,
          },
        },
      };

      const failures = await setupSources(ctx, ctx.config.sources);

      expect(create).not.toHaveBeenCalled();
      expect(registered).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.key).toBe(sourceKey);
    }
  });

  it("keeps fresh interactive single-source adds compatible with post-auth discovery", async () => {
    const def = defineSource({
      id: "desktop-notes",
      name: "fixture records",
      description: "x",
      provider: { id: "desktop-suite", name: "fixture adapter" },
      authType: "oauth",
      discover: async () => [AccountId("stored@example.com")],
      create: async () => ({ sync: noopSync }),
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("desktop-notes", "desktop-suite")], registered);
    ctx.configDerivedAccountKeys = new Set(["desktop-notes:new@example.com"]);

    const failures = await setupSources(ctx, {
      "desktop-notes:new@example.com": { enabled: true },
    });

    expect(failures).toEqual([]);
    expect(registered[0]?.sources[0]?.id).toBe("desktop-notes:new@example.com");
  });

  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  const warnings = () => consoleWarnSpy.mock.calls.map((c) => String(c[0])).join("\n");

  // A source that cannot be built — its local database is unreadable, its
  // account lacks a scope — is one source's problem. Dropping its siblings
  // with it turns a partial outage into a total one; reporting none of it at
  // all leaves the operator a source that is configured and does nothing.
  it("one source's factory failing leaves its siblings registered, and names it", async () => {
    const def = defineProvider({
      provider: { id: "mixed-provider", name: "mixed provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      sources: [
        {
          id: "mixed-ok",
          name: "Ok",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
        {
          id: "mixed-broken",
          name: "Broken",
          description: "x",
          create: async () => {
            throw new Error("cannot open the local database — the grant is missing");
          },
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("mixed-ok", "mixed-provider"),
        makeDescriptor("mixed-broken", "mixed-provider"),
      ],
      registered,
    );

    const failures = await setupSources(ctx, {
      "mixed-ok:acct-1": { enabled: true },
      "mixed-broken:acct-1": { enabled: true },
    });

    expect(registered.flatMap((p) => p.sources.map((s) => String(s.id)))).toEqual([
      "mixed-ok:acct-1",
    ]);
    expect(failures).toEqual([
      {
        key: "mixed-broken:acct-1",
        error: "cannot open the local database — the grant is missing",
      },
    ]);
    // The same reason is in the collector log, which is where an operator
    // reading service output rather than a status pill will meet it.
    expect(warnings()).toContain("mixed-broken:acct-1");
    expect(warnings()).toContain("cannot open the local database");
  });

  it("a local provider says what it found, and is never stopped by its own answer", async () => {
    const def = defineProvider({
      provider: { id: "desktop-store", name: "desktop store" },
      authType: "local",
      discover: async () => [AccountId("local")],
      createContext: async () => ({}),
      // Model a local database helper whose file is temporarily unreadable.
      // There is no credential the operator can renew.
      credentialState: () =>
        Promise.resolve({ status: "unknown" as const, because: "database is not readable" }),
      sources: [
        {
          id: "desktop-records",
          name: "desktop records",
          description: "Records in a local desktop database",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("desktop-records", "desktop-store")], registered);

    expect(await setupSources(ctx, { "desktop-records:local": { enabled: true } })).toEqual([]);
    expect(registered).toHaveLength(1);

    // The answer is its own, and worth having: "unreadable right now" is not
    // the same claim as "absent".
    await expect(registered[0]!.credentialState()).resolves.toEqual({
      status: "unknown",
      because: "database is not readable",
    });
    // What it does not get is to be stopped by that answer. There is no
    // credential to renew, so parking it as needs-auth would offer a remedy
    // that does not exist; the concrete local problem reaches the operator
    // from the sync path instead.
    expect(registered[0]!.renewableCredential).toBe(false);
  });

  it("a local provider that claims a blocking state is still not parked by it", async () => {
    // The guard is on the consequence, not on the claim. A local source that
    // reported itself revoked — nothing does, but the type permits it — would
    // otherwise prompt an operator to re-authorize a folder.
    const def = defineProvider({
      provider: { id: "desktop-store-2", name: "desktop store" },
      authType: "local",
      discover: async () => [AccountId("local")],
      createContext: async () => ({}),
      credentialState: () => Promise.resolve({ status: "revoked" as const }),
      sources: [
        {
          id: "desktop-records-2",
          name: "desktop records",
          description: "Records in a local desktop database",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("desktop-records-2", "desktop-store-2")],
      registered,
    );

    await setupSources(ctx, { "desktop-records-2:local": { enabled: true } });

    expect(registered[0]!.renewableCredential).toBe(false);
  });

  it("a credential-backed provider keeps its re-authentication gate", async () => {
    const def = defineProvider({
      provider: { id: "cloud-store", name: "cloud store" },
      authType: "oauth",
      discover: async () => [AccountId("maya@example.com")],
      createContext: async () => ({}),
      credentialState: () => Promise.resolve({ status: "revoked" as const }),
      sources: [
        {
          id: "cloud-records",
          name: "cloud records",
          description: "Records in a cloud account",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("cloud-records", "cloud-store")], registered);

    expect(
      await setupSources(ctx, { "cloud-records:maya@example.com": { enabled: true } }),
    ).toEqual([]);
    expect(registered).toHaveLength(1);
    await expect(registered[0]!.credentialState()).resolves.toEqual({ status: "revoked" });
  });

  // The provider-wide catch still exists for a context that cannot be built at
  // all; nothing under it registers, and every source on the account pays.
  it("a provider whose shared context throws costs every source on the account", async () => {
    const def = defineProvider({
      provider: { id: "ctx-provider", name: "ctx provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      createContext: async () => {
        throw new Error("no local database could be read");
      },
      sources: [
        { id: "ctx-one", name: "One", description: "x", create: async () => ({ sync: noopSync }) },
        { id: "ctx-two", name: "Two", description: "x", create: async () => ({ sync: noopSync }) },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("ctx-one", "ctx-provider"), makeDescriptor("ctx-two", "ctx-provider")],
      registered,
    );

    const failures = await setupSources(ctx, {
      "ctx-one:acct-1": { enabled: true },
      "ctx-two:acct-1": { enabled: true },
    });

    expect(registered).toEqual([]);
    expect(failures).toEqual([
      { key: "ctx-one:acct-1", error: "no local database could be read" },
      { key: "ctx-two:acct-1", error: "no local database could be read" },
    ]);
    expect(warnings()).toContain("ctx-provider:acct-1");
    expect(warnings()).toContain("no local database could be read");
  });

  it("a discovery pass that finds no account reports the keys it was asked for", async () => {
    const def = defineProvider({
      provider: { id: "empty-provider", name: "empty provider" },
      authType: "local",
      discover: async () => [],
      sources: [
        {
          id: "empty-one",
          name: "One",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("empty-one", "empty-provider")], registered);

    const failures = await setupSources(ctx, { "empty-one:acct-1": { enabled: true } });

    expect(registered).toEqual([]);
    expect(failures).toEqual([
      {
        key: "empty-one:acct-1",
        error:
          "empty provider did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("keeps fresh interactive provider adds compatible with post-auth discovery", async () => {
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "oauth",
      discover: async () => [],
      createContext: async () => ({}),
      sources: [
        {
          id: "local-notes",
          name: "fixture records",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("local-notes", "fixture-suite")], registered);
    ctx.configDerivedAccountKeys = new Set(["local-notes:new@example.com"]);

    const failures = await setupSources(ctx, {
      "local-notes:new@example.com": { enabled: true },
    });

    expect(failures).toEqual([]);
    expect(registered[0]?.sources[0]?.id).toBe("local-notes:new@example.com");
  });

  it("does not let one provider child's local path authorize a sibling source", async () => {
    const localCreate = vi.fn(async () => ({ sync: noopSync }));
    const siblingCreate = vi.fn(async () => ({ sync: noopSync }));
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [],
      sources: [
        {
          id: "local-notes",
          name: "local notes",
          description: "x",
          params: [
            {
              name: "databasePath",
              label: "Database path",
              type: "path",
              scope: "member",
              provesLocalAvailabilityForAccount: "local",
              validate: (value) => (value === "/srv/fixture/notes.db" ? null : "not found"),
            },
          ],
          create: localCreate,
        },
        {
          id: "local-calendar",
          name: "local calendar",
          description: "x",
          create: siblingCreate,
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("local-notes", "fixture-suite"),
        makeDescriptor("local-calendar", "fixture-suite"),
      ],
      registered,
    );
    ctx.config.sources = {
      "local-notes:local": {
        enabled: true,
        params: { databasePath: "/srv/fixture/notes.db" },
      },
      "local-calendar:local": { enabled: true },
    };

    const failures = await setupSources(ctx, ctx.config.sources);

    expect(localCreate).toHaveBeenCalledOnce();
    expect(siblingCreate).not.toHaveBeenCalled();
    expect(registered[0]?.sources.map((source) => source.id)).toEqual(["local-notes:local"]);
    expect(failures).toEqual([
      {
        key: "local-calendar:local",
        error:
          "fixture provider did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("reports a configured account that provider discovery does not find", async () => {
    const createContext = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({ sync: noopSync }));
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      createContext,
      sources: [
        {
          id: "local-notes",
          name: "fixture records",
          description: "x",
          create,
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("local-notes", "fixture-suite")], registered);

    const failures = await setupSources(ctx, {
      "local-notes:missing@example.com": { enabled: true },
    });

    expect(registered).toEqual([]);
    expect(createContext).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(failures).toEqual([
      {
        key: "local-notes:missing@example.com",
        error:
          "fixture provider did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("registers discovered accounts while reporting only configured accounts absent here", async () => {
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      createContext: async () => ({}),
      sources: [
        {
          id: "local-notes",
          name: "fixture records",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("local-notes", "fixture-suite")], registered);

    const failures = await setupSources(ctx, {
      "local-notes:available@example.com": { enabled: true },
      "local-notes:missing@example.com": { enabled: true },
    });

    expect(
      registered.flatMap((provider) => provider.sources.map((source) => source.id)),
    ).toHaveLength(1);
    expect(registered[0]?.sources[0]?.id).toBe("local-notes:available@example.com");
    expect(failures).toEqual([
      {
        key: "local-notes:missing@example.com",
        error:
          "fixture provider did not discover the configured account on this host; choose a device where that account is available",
      },
    ]);
  });

  it("does not instantiate a provider child its own discovery marks unavailable", async () => {
    const create = vi.fn(async () => ({ sync: noopSync }));
    const createContext = vi.fn(async () => ({}));
    const disposeContext = vi.fn(async () => {});
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      createContext,
      disposeContext,
      sources: [
        {
          id: "fixture-notes",
          name: "fixture notes",
          description: "x",
          discover: async () => [],
          create,
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("fixture-notes", "fixture-suite")], registered);

    const failures = await setupSources(ctx, {
      "fixture-notes:available@example.com": { enabled: true },
    });

    expect(create).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(disposeContext).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
    expect(failures).toEqual([
      {
        key: "fixture-notes:available@example.com",
        error:
          "fixture notes is not available for the configured account on this host; choose a device where that source is available",
      },
    ]);
  });

  it("isolates a child discovery failure while registering an available sibling", async () => {
    const failingCreate = vi.fn(async () => ({ sync: noopSync }));
    const siblingCreate = vi.fn(async () => ({ sync: noopSync }));
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      createContext: async () => ({}),
      sources: [
        {
          id: "fixture-notes",
          name: "fixture notes",
          description: "x",
          discover: async () => {
            throw new Error("notes database is unreadable");
          },
          create: failingCreate,
        },
        {
          id: "fixture-calendar",
          name: "fixture calendar",
          description: "x",
          create: siblingCreate,
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("fixture-notes", "fixture-suite"),
        makeDescriptor("fixture-calendar", "fixture-suite"),
      ],
      registered,
    );

    const failures = await setupSources(ctx, {
      "fixture-notes:available@example.com": { enabled: true },
      "fixture-calendar:available@example.com": { enabled: true },
    });

    expect(failingCreate).not.toHaveBeenCalled();
    expect(siblingCreate).toHaveBeenCalledOnce();
    expect(registered[0]?.sources.map((source) => source.id)).toEqual([
      "fixture-calendar:available@example.com",
    ]);
    expect(failures).toEqual([
      {
        key: "fixture-notes:available@example.com",
        error: "notes database is unreadable",
      },
    ]);
  });

  it("disposes an unused provider context without masking source factory failures", async () => {
    const context = { handle: "fixture-handle" };
    const disposeContext = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const def = defineProvider({
      provider: { id: "fixture-suite", name: "fixture provider" },
      authType: "local",
      discover: async () => [AccountId("available@example.com")],
      createContext: async () => context,
      disposeContext,
      sources: [
        {
          id: "fixture-notes",
          name: "fixture notes",
          description: "x",
          discover: async () => [AccountId("available@example.com")],
          create: async () => {
            throw new Error("source factory failed");
          },
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("fixture-notes", "fixture-suite")], registered);

    const failures = await setupSources(ctx, {
      "fixture-notes:available@example.com": { enabled: true },
    });

    expect(disposeContext).toHaveBeenCalledOnce();
    expect(disposeContext).toHaveBeenCalledWith(context);
    expect(registered).toEqual([]);
    expect(failures).toEqual([
      {
        key: "fixture-notes:available@example.com",
        error: "source factory failed",
      },
    ]);
    expect(warnings()).toContain("cleanup failed");
  });

  it("a discovery pass that throws costs every key the definition owns", async () => {
    const def = defineProvider({
      provider: { id: "throwing-provider", name: "throwing provider" },
      authType: "local",
      discover: async () => {
        throw new Error("permission denied");
      },
      sources: [
        {
          id: "throw-one",
          name: "One",
          description: "x",
          create: async () => ({ sync: noopSync }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("throw-one", "throwing-provider")], registered);

    const failures = await setupSources(ctx, { "throw-one:acct-1": { enabled: true } });

    expect(failures).toEqual([{ key: "throw-one:acct-1", error: "permission denied" }]);
  });

  it("a single-source package whose factory throws reports its own key", async () => {
    const def = defineSource({
      id: "solo-source",
      name: "Solo",
      description: "x",
      provider: { id: "solo-provider", name: "solo provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      create: async () => {
        throw new Error("vault path does not exist");
      },
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("solo-source", "solo-provider")], registered);

    const failures = await setupSources(ctx, { "solo-source:acct-1": { enabled: true } });

    expect(registered).toEqual([]);
    expect(failures).toEqual([{ key: "solo-source:acct-1", error: "vault path does not exist" }]);
  });

  it("a healthy setup reports nothing", async () => {
    const def = defineProvider({
      provider: { id: "healthy-provider", name: "healthy provider" },
      authType: "local",
      discover: async () => [AccountId("acct-1")],
      sources: [
        { id: "fine-one", name: "One", description: "x", create: async () => ({ sync: noopSync }) },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("fine-one", "healthy-provider")], registered);

    expect(await setupSources(ctx, { "fine-one:acct-1": { enabled: true } })).toEqual([]);
    expect(registered).toHaveLength(1);
  });
});
