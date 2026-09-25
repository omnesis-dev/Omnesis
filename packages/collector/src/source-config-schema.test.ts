// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The declared configuration schema, driven through the real instantiator.
 *
 * The unit tests in `@omnesis/source-sdk` prove the parsing. These prove that
 * the collector actually parses a source's stored settings against its own
 * schema, hands the typed result to the factory, and refuses to start a source
 * whose settings do not satisfy it.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config as c, defineSource } from "@omnesis/source-sdk";
import { AccountId, ProviderType, SourceType } from "@omnesis/types";
import { setupSources, type SourceInstantiatorContext } from "./source-instantiator.js";
import { buildSourceToProviderMap } from "./source-config-reconciler.js";
import type {
  GatewayClient,
  SourceDescriptor,
  SourceOrProviderDefinition,
} from "@omnesis/source-sdk";
import type { RegisteredProvider } from "./sync-engine-types.js";

let isolatedConfigDir: string;
let fallbackConfigDir: string;
beforeEach(() => {
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "omnesis-config-schema-"));
  fallbackConfigDir = mkdtempSync(join(tmpdir(), "omnesis-config-fallback-"));
  vi.stubEnv("OMNESIS_CONFIG_DIR", fallbackConfigDir);
});
afterEach(() => {
  try {
    // Explicit fixture ownership must win over the process-wide fallback.
    expect(readdirSync(fallbackConfigDir)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(isolatedConfigDir, { recursive: true, force: true });
    rmSync(fallbackConfigDir, { recursive: true, force: true });
  }
});

function makeCtx(
  definitions: SourceOrProviderDefinition[],
  descriptors: SourceDescriptor[],
  registered: RegisteredProvider[],
  sources: Record<string, unknown> = {},
): SourceInstantiatorContext {
  return {
    configDir: isolatedConfigDir,
    definitions,
    descriptors,
    sourceToProvider: buildSourceToProviderMap(descriptors),
    // Settings are resolved from the collector's own config, not from the
    // enabled-keys argument, which only says which sources are on.
    config: { sources } as never,
    gateway: {} as GatewayClient,
    engine: { registerProvider: (p: RegisteredProvider) => registered.push(p) } as never,
  };
}

const descriptor = (id: string): SourceDescriptor => ({
  id: SourceType(id),
  name: id,
  description: id,
  provider: { id: ProviderType(id), name: id },
  authType: "local",
});

/** A vault source, shaped like the real one whose second setting no form could produce. */
function vaultSource(seen: { config?: unknown; sourceConfig?: unknown }) {
  return defineSource({
    id: "synth-vault",
    name: "Synth vault",
    description: "Notes from a folder",
    authType: "local",
    config: c.object({
      vaultPath: c.path({ label: "Vault path", required: true, scope: "member" }),
      exclude: c.list(c.string({ label: "Pattern" }), { label: "Exclude", default: [] }),
      maxDepth: c.number({ label: "Max depth", min: 1, max: 20, integer: true, default: 5 }),
    }),
    discover: async () => [AccountId("local")],
    create: async (options) => {
      seen.config = options.config;
      seen.sourceConfig = options.sourceConfig;
      return {
        sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
      };
    },
  });
}

describe("a source that declares its configuration", () => {
  it("receives it parsed and typed, with defaults applied", async () => {
    const seen: { config?: unknown } = {};
    const registered: RegisteredProvider[] = [];
    const settings = {
      // Every stored setting is a string: the configuration file types params
      // as text, and so does every form that posts one. A test that supplied a
      // real array would be proving a path production never takes.
      "synth-vault": { enabled: true, params: { vaultPath: "/notes", exclude: "archive/**" } },
    };
    const ctx = makeCtx([vaultSource(seen)], [descriptor("synth-vault")], registered, settings);

    await setupSources(ctx, settings);

    expect(seen.config).toEqual({
      vaultPath: "/notes",
      exclude: ["archive/**"],
      // Supplied by the declaration, not by the operator.
      maxDepth: 5,
    });
    expect(registered.length).toBe(1);
    expect(readdirSync(join(isolatedConfigDir, "synth-vault"))).toEqual(["local"]);
  });

  it("does not start when a required setting is missing, and says which", async () => {
    const seen: { config?: unknown } = {};
    const registered: RegisteredProvider[] = [];
    const settings = { "synth-vault": { enabled: true, params: { exclude: "" } } };
    const ctx = makeCtx([vaultSource(seen)], [descriptor("synth-vault")], registered, settings);

    const failures = await setupSources(ctx, settings);

    // A source that starts and then throws on its third page looks broken; one
    // that never starts and names the field looks like what it is.
    expect(seen.config).toBeUndefined();
    expect(registered.length).toBe(0);
    expect(failures[0]?.error).toContain("Vault path is required");
  });

  it("does not start when a setting is out of range", async () => {
    const registered: RegisteredProvider[] = [];
    const settings = {
      "synth-vault": { enabled: true, params: { vaultPath: "/notes", maxDepth: "99" } },
    };
    const ctx = makeCtx([vaultSource({})], [descriptor("synth-vault")], registered, settings);

    const failures = await setupSources(ctx, settings);

    expect(failures[0]?.error).toMatch(/Max depth must be at most 20/);
    expect(registered.length).toBe(0);
  });

  it("still receives the raw settings, so nothing that read them stops working", async () => {
    const seen: { sourceConfig?: unknown } = {};
    const registered: RegisteredProvider[] = [];
    const settings = { "synth-vault": { enabled: true, params: { vaultPath: "/notes" } } };
    const ctx = makeCtx([vaultSource(seen)], [descriptor("synth-vault")], registered, settings);

    await setupSources(ctx, settings);

    expect(seen.sourceConfig).toMatchObject({ params: { vaultPath: "/notes" } });
  });

  it("derives the form clients render, so the declaration is stated once", async () => {
    const def = vaultSource({});
    expect(def.params?.map((p) => [p.name, p.type, p.scope])).toEqual([
      ["vaultPath", "path", "member"],
      // The list field a client cannot render natively is still visible.
      ["exclude", "string", undefined],
      ["maxDepth", "string", undefined],
    ]);
  });
});

describe("a source that declares no configuration", () => {
  it("is untouched: no parsed config, no new failure mode", async () => {
    const seen: { config?: unknown; sourceConfig?: unknown } = {};
    const def = defineSource({
      id: "synth-plain",
      name: "Synth plain",
      description: "No settings",
      authType: "local",
      discover: async () => [AccountId("local")],
      create: async (options) => {
        seen.config = options.config;
        seen.sourceConfig = options.sourceConfig;
        return {
          sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
        };
      },
    });
    const registered: RegisteredProvider[] = [];
    const settings = { "synth-plain": { enabled: true, params: { anything: "1" } } };
    const ctx = makeCtx([def], [descriptor("synth-plain")], registered, settings);

    await setupSources(ctx, settings);

    expect(seen.config).toBeUndefined();
    expect(seen.sourceConfig).toMatchObject({ params: { anything: "1" } });
    expect(registered.length).toBe(1);
  });
});

describe("declaring both a schema and a hand-written form", () => {
  it("is refused at package load, because nothing would keep the two in step", () => {
    expect(() =>
      defineSource({
        id: "synth-both",
        name: "Both",
        description: "Two statements of one fact",
        authType: "local",
        config: c.object({ a: c.string({ label: "A" }) }),
        params: [{ name: "a", label: "A", type: "string" }],
        create: async () => ({
          sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
        }),
      }),
    ).toThrow(/declares both 'config' and 'params'/);
  });

  it("is allowed when the form is the one the schema produced", () => {
    // A definition carries both its schema and the form derived from it, and a
    // synthetic double is built by spreading a real definition into a second
    // `defineSource`. The second one is handed a `params` it never wrote, so a
    // rule against stating a fact twice would fire on a source that stated it
    // once.
    const base = defineSource({
      id: "synth-vault-real",
      name: "Vault",
      description: "A vault",
      authType: "local",
      config: c.object({ a: c.string({ label: "A" }) }),
      create: async () => ({
        sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
      }),
    });
    expect(base.params?.map((p) => p.name)).toEqual(["a"]);

    const { type: _type, ...rest } = base;
    const double = defineSource({ ...rest, id: "synth-vault-double" });
    expect(double.params?.map((p) => p.name)).toEqual(["a"]);
  });

  it("is still refused when the spread form was edited", () => {
    // The moment an author touches the derived array it stops being derived,
    // and the two statements can disagree again.
    const base = defineSource({
      id: "synth-vault-edited",
      name: "Vault",
      description: "A vault",
      authType: "local",
      config: c.object({ a: c.string({ label: "A" }) }),
      create: async () => ({
        sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
      }),
    });
    const { type: _type, ...rest } = base;
    expect(() =>
      defineSource({ ...rest, id: "synth-vault-edited-2", params: [...(base.params ?? [])] }),
    ).toThrow(/declares both 'config' and 'params'/);
  });
});
