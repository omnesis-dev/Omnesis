// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPERIMENTAL_ENV_VAR } from "@omnesis/core";
import {
  config as configSchema,
  defineProvider,
  defineSource,
  serializeDescriptor,
} from "@omnesis/source-sdk";
import webDefinition from "@omnesis/provider-web";
import { AccountId, SourceType, ProviderType } from "@omnesis/types";
import {
  descriptorExperimentalEnabled,
  experimentalDescriptorHidden,
  descriptorSupportsPlatform,
  extractDescriptors,
  providerPackageNames,
} from "./source-descriptors.js";
import type { SourceDescriptor } from "@omnesis/source-sdk";

describe("providerPackageNames", () => {
  const manifest = {
    dependencies: {
      "@omnesis/core": "*",
      "@omnesis/provider-google": "*",
      "@omnesis/provider-shadow-synth": "*",
    },
    devDependencies: {
      "@omnesis/provider-google-synth": "*",
      "@omnesis/providers-synth-common": "*",
    },
  };

  it("loads only real runtime providers in production", () => {
    expect(providerPackageNames(manifest, false)).toEqual(["@omnesis/provider-google"]);
  });

  it("loads private synthetic providers from development dependencies in synthetic mode", () => {
    expect(providerPackageNames(manifest, true)).toEqual([
      "@omnesis/provider-shadow-synth",
      "@omnesis/provider-google-synth",
    ]);
  });
});

describe("descriptorSupportsPlatform", () => {
  it("returns true when supportedPlatforms is undefined (cross-platform default)", () => {
    expect(descriptorSupportsPlatform({}, "linux")).toBe(true);
    expect(descriptorSupportsPlatform({}, "darwin")).toBe(true);
    expect(descriptorSupportsPlatform({}, "win32")).toBe(true);
  });

  it("returns true on a listed platform", () => {
    expect(descriptorSupportsPlatform({ supportedPlatforms: ["darwin"] }, "darwin")).toBe(true);
    expect(descriptorSupportsPlatform({ supportedPlatforms: ["darwin", "linux"] }, "linux")).toBe(
      true,
    );
  });

  it("returns false on an unlisted platform", () => {
    expect(descriptorSupportsPlatform({ supportedPlatforms: ["darwin"] }, "linux")).toBe(false);
    expect(descriptorSupportsPlatform({ supportedPlatforms: ["darwin"] }, "win32")).toBe(false);
    expect(descriptorSupportsPlatform({ supportedPlatforms: ["linux"] }, "darwin")).toBe(false);
  });

  it("treats an empty supportedPlatforms array as 'nothing matches'", () => {
    // `defineSource` rejects empty arrays at the SDK boundary; the
    // helper still handles this case defensively so that a definition
    // smuggled in through a different path (mocks, e2e fixtures) can't
    // accidentally surface a globally-unreachable source.
    expect(descriptorSupportsPlatform({ supportedPlatforms: [] }, "darwin")).toBe(false);
    expect(descriptorSupportsPlatform({ supportedPlatforms: [] }, "linux")).toBe(false);
  });
});

describe("extractDescriptors — supportedPlatforms inheritance", () => {
  it("child sources inherit supportedPlatforms from the provider", () => {
    const def = defineProvider({
      provider: { id: "macos-provider", name: "macOS Provider" },
      authType: "local",
      supportedPlatforms: ["darwin"],
      sources: [
        {
          id: "child-a",
          name: "Child A",
          description: "Inherits parent",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "child-b",
          name: "Child B",
          description: "Inherits parent too",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0].supportedPlatforms).toEqual(["darwin"]);
    expect(descriptors[1].supportedPlatforms).toEqual(["darwin"]);
  });

  it("per-source supportedPlatforms overrides the provider default", () => {
    const def = defineProvider({
      provider: { id: "mixed-provider", name: "Mixed" },
      authType: "local",
      supportedPlatforms: ["darwin", "linux"],
      sources: [
        {
          id: "narrow-child",
          name: "Narrow Child",
          description: "darwin only",
          supportedPlatforms: ["darwin"],
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "inheriting-child",
          name: "Inheriting Child",
          description: "darwin + linux",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.find((d) => String(d.id) === "narrow-child")?.supportedPlatforms).toEqual([
      "darwin",
    ]);
    expect(
      descriptors.find((d) => String(d.id) === "inheriting-child")?.supportedPlatforms,
    ).toEqual(["darwin", "linux"]);
  });

  it("a single-source defineSource carries its supportedPlatforms through", () => {
    const def = defineSource({
      id: "single",
      name: "Single",
      description: "single source package",
      authType: "local",
      supportedPlatforms: ["win32"],
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.supportedPlatforms).toEqual(["win32"]);
  });

  it("a cross-platform source has undefined supportedPlatforms after extraction", () => {
    const def = defineSource({
      id: "anywhere",
      name: "Anywhere",
      description: "cross-platform",
      authType: "local",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.supportedPlatforms).toBeUndefined();
  });
});

describe("extractDescriptors — provider source discovery", () => {
  it("lets a provider source narrow inherited account discovery", async () => {
    const def = defineProvider({
      provider: { id: "fixture-provider", name: "fixture provider" },
      authType: "local",
      discover: async () => ["provider-account"],
      sources: [
        {
          id: "fixture-records",
          name: "fixture records",
          description: "x",
          discover: async () => ["source-account"],
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });

    const [descriptor] = extractDescriptors(def);
    await expect(descriptor?.discover?.()).resolves.toEqual([{ id: AccountId("source-account") }]);
  });
});

describe("extractDescriptors — singleInstance inheritance", () => {
  // Before this was wired, `singleInstance` existed only on standalone
  // SourceDefinitions, so every source under a multi-source provider
  // serialized as multi-instance no matter what it declared. Clients then
  // offered "add another account" for sources that admit exactly one — the
  // Apple sources being the visible case.
  it("child sources inherit singleInstance from the provider", () => {
    const def = defineProvider({
      provider: { id: "local-provider", name: "local-provider" },
      authType: "local",
      singleInstance: true,
      sources: [
        {
          id: "local-a",
          name: "Local A",
          description: "One instance",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "local-b",
          name: "Local B",
          description: "One instance too",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.map((d) => d.singleInstance)).toEqual([true, true]);
  });

  it("a per-source singleInstance overrides the provider default", () => {
    const def = defineProvider({
      provider: { id: "mixed-instance-provider", name: "Mixed" },
      authType: "oauth",
      sources: [
        {
          id: "one-only",
          name: "one-only",
          description: "single",
          singleInstance: true,
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "many-ok",
          name: "Many OK",
          description: "multi",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.find((d) => String(d.id) === "one-only")?.singleInstance).toBe(true);
    expect(descriptors.find((d) => String(d.id) === "many-ok")?.singleInstance).toBeUndefined();
  });

  it("defaults to undefined (multi-account) when nobody declares it", () => {
    const def = defineProvider({
      provider: { id: "plain-provider", name: "Plain" },
      authType: "oauth",
      sources: [
        {
          id: "plain-source",
          name: "plain-source",
          description: "multi",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    expect(extractDescriptors(def)[0].singleInstance).toBeUndefined();
  });
});

describe("extractDescriptors — gatewayHosted flag", () => {
  it("a defineSource gatewayHosted flag travels to the descriptor and serializes", () => {
    const def = defineSource({
      id: "gateway-hosted-source",
      name: "Gateway-hosted test source",
      description: "hosted by the gateway, not synced by a collector",
      authType: "local",
      gatewayHosted: true,
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.gatewayHosted).toBe(true);
    expect(serializeDescriptor(descriptor).gatewayHosted).toBe(true);
  });

  it("sources without the flag leave gatewayHosted undefined", () => {
    const def = defineSource({
      id: "collector-source",
      name: "Collector-synced test source",
      description: "synced by a collector",
      authType: "local",
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(serializeDescriptor(descriptor).gatewayHosted).toBeUndefined();
  });
});

describe("extractDescriptors — URL graph roles", () => {
  it("a source carries independent traversal and target roles through serialization", () => {
    const def = defineSource({
      id: "url-role-source",
      name: "url role fixture",
      description: "invented source used to verify URL graph roles",
      authType: "local",
      urlHub: true,
      urlTargetRole: "reference",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });

    const serialized = serializeDescriptor(extractDescriptors(def)[0]);
    expect(serialized.urlHub).toBe(true);
    expect(serialized.urlTargetRole).toBe("reference");
  });

  it("a provider source entry carries its URL target role", () => {
    const def = defineProvider({
      provider: { id: "url-role-provider", name: "fixture provider" },
      authType: "local",
      sources: [
        {
          id: "fallback-entry",
          name: "fallback fixture",
          description: "invented fallback representation source",
          urlTargetRole: "fallback",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });

    expect(serializeDescriptor(extractDescriptors(def)[0]).urlTargetRole).toBe("fallback");
  });
});

describe("extractDescriptors — primaryCount headline plane", () => {
  it("a defineSource primaryCount flag travels to the descriptor and serializes", () => {
    const def = defineSource({
      id: "doc-primary-source",
      name: "Doc Primary Source",
      description: "documents are the headline count, not its analytics rows",
      authType: "local",
      primaryCount: "documents",
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.primaryCount).toBe("documents");
    expect(serializeDescriptor(descriptor).primaryCount).toBe("documents");
  });

  it("a provider source-entry primaryCount flag travels to that source's descriptor", () => {
    const def = defineProvider({
      provider: { id: "mixed-provider", name: "Mixed Provider" },
      authType: "local",
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "analytics-primary",
          name: "Analytics Primary",
          description: "child",
          primaryCount: "analytics",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const [descriptor] = extractDescriptors(def);
    expect(serializeDescriptor(descriptor).primaryCount).toBe("analytics");
  });

  it("sources without the flag leave primaryCount undefined (heuristic decides)", () => {
    const def = defineSource({
      id: "heuristic-source",
      name: "Heuristic Source",
      description: "no declared headline plane",
      authType: "local",
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(serializeDescriptor(descriptor).primaryCount).toBeUndefined();
  });
});

describe("extractDescriptors — acceptsAuthCode capability", () => {
  it("a defineSource acceptsAuthCode flag travels to the descriptor and serializes to true", () => {
    const def = defineSource({
      id: "code-channel-source",
      name: "Code Channel Source",
      description: "consumes externally delivered auth codes",
      authType: "oauth",
      acceptsAuthCode: true,
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.acceptsAuthCode).toBe(true);
    expect(serializeDescriptor(descriptor).acceptsAuthCode).toBe(true);
  });

  it("a provider-level acceptsAuthCode flag is mirrored onto every child source", () => {
    const def = defineProvider({
      provider: { id: "code-channel-provider", name: "Code Channel Provider" },
      authType: "oauth",
      acceptsAuthCode: true,
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "child-x",
          name: "Child X",
          description: "child",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "child-y",
          name: "Child Y",
          description: "child",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.map((d) => d.acceptsAuthCode)).toEqual([true, true]);
  });

  it("sources without the flag serialize acceptsAuthCode=false (localhost-listener default)", () => {
    const def = defineSource({
      id: "listener-source",
      name: "Listener Source",
      description: "runs its own localhost callback listener",
      authType: "oauth",
      authFlow: async () => "acct-1",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.acceptsAuthCode).toBeUndefined();
    expect(serializeDescriptor(descriptor).acceptsAuthCode).toBe(false);
  });
});

describe("extractDescriptors — lifecycle context forwarding", () => {
  it("forwards context into single-source discover, authFlow, and cleanupCredentials", async () => {
    const seen: string[] = [];
    const def = defineSource({
      id: "ctx-source",
      name: "ctx-source",
      description: "tests lifecycle context",
      authType: "local",
      discover: async (ctx) => {
        seen.push(`discover:${ctx?.configDir}`);
        return ["acct-1"];
      },
      authFlow: async (_params, _callbacks, ctx) => {
        seen.push(`auth:${ctx?.configDir}`);
        return "acct-1";
      },
      cleanupCredentials: async (accountId, ctx) => {
        seen.push(`cleanup:${accountId}:${ctx?.configDir}`);
      },
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });

    const [descriptor] = extractDescriptors(def);
    await descriptor.discover?.({ configDir: "/tmp/ctx-source" });
    await descriptor.authFlow?.({}, undefined, { configDir: "/tmp/ctx-source" });
    await descriptor.cleanupCredentials?.(AccountId("acct-1"), { configDir: "/tmp/ctx-source" });

    expect(seen).toEqual([
      "discover:/tmp/ctx-source",
      "auth:/tmp/ctx-source",
      "cleanup:acct-1:/tmp/ctx-source",
    ]);
  });

  it("forwards context into provider-level discover, authFlow, and cleanupCredentials", async () => {
    const seen: string[] = [];
    const def = defineProvider({
      provider: { id: "ctx-provider", name: "ctx-provider" },
      authType: "local",
      discover: async (ctx) => {
        seen.push(`discover:${ctx?.configDir}`);
        return ["acct-1"];
      },
      authFlow: async (_params, _callbacks, ctx) => {
        seen.push(`auth:${ctx?.configDir}`);
        return "acct-1";
      },
      cleanupCredentials: async (accountId, ctx) => {
        seen.push(`cleanup:${accountId}:${ctx?.configDir}`);
      },
      sources: [
        {
          id: "ctx-child",
          name: "ctx-child",
          description: "tests provider lifecycle context",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });

    const [descriptor] = extractDescriptors(def);
    await descriptor.discover?.({ configDir: "/tmp/ctx-provider" });
    await descriptor.authFlow?.({}, undefined, { configDir: "/tmp/ctx-provider" });
    await descriptor.cleanupCredentials?.(AccountId("acct-1"), {
      configDir: "/tmp/ctx-provider",
    });

    expect(seen).toEqual([
      "discover:/tmp/ctx-provider",
      "auth:/tmp/ctx-provider",
      "cleanup:acct-1:/tmp/ctx-provider",
    ]);
  });
});

describe("descriptorExperimentalEnabled", () => {
  const original = process.env[EXPERIMENTAL_ENV_VAR];

  beforeEach(() => {
    delete process.env[EXPERIMENTAL_ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_ENV_VAR];
    else process.env[EXPERIMENTAL_ENV_VAR] = original;
  });

  // Minimal stand-in for the shape descriptorExperimentalEnabled reads.
  function fakeDescriptor(
    providerId: string,
    descriptorId: string,
    experimental?: boolean,
  ): Pick<SourceDescriptor, "experimental" | "id" | "provider"> {
    return {
      experimental,
      id: SourceType(descriptorId),
      provider: { id: ProviderType(providerId), name: providerId },
    };
  }

  it("a non-experimental descriptor is always enabled regardless of the env var", () => {
    const d = fakeDescriptor("acme", "acme-source");
    expect(descriptorExperimentalEnabled(d)).toBe(true);
    process.env[EXPERIMENTAL_ENV_VAR] = "1";
    expect(descriptorExperimentalEnabled(d)).toBe(true);
    process.env[EXPERIMENTAL_ENV_VAR] = "something-else";
    expect(descriptorExperimentalEnabled(d)).toBe(true);
  });

  it("an experimental descriptor is disabled when the env var is unset", () => {
    expect(descriptorExperimentalEnabled(fakeDescriptor("acme", "acme-source", true))).toBe(false);
  });

  it("an experimental descriptor is enabled when experimental mode is on", () => {
    for (const v of ["1", "true", "on", "all"]) {
      process.env[EXPERIMENTAL_ENV_VAR] = v;
      expect(descriptorExperimentalEnabled(fakeDescriptor("acme", "acme-source", true)), v).toBe(
        true,
      );
    }
  });

  it("an experimental descriptor stays disabled for any non-on value (no per-feature names)", () => {
    for (const v of ["acme", "acme-source", "other-source", "0", "off"]) {
      process.env[EXPERIMENTAL_ENV_VAR] = v;
      expect(descriptorExperimentalEnabled(fakeDescriptor("acme", "acme-source", true)), v).toBe(
        false,
      );
    }
  });
});

describe("experimentalDescriptorHidden", () => {
  const original = process.env[EXPERIMENTAL_ENV_VAR];
  beforeEach(() => {
    delete process.env[EXPERIMENTAL_ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_ENV_VAR];
    else process.env[EXPERIMENTAL_ENV_VAR] = original;
  });

  function fakeDescriptor(
    providerId: string,
    descriptorId: string,
    experimental?: boolean,
  ): Pick<SourceDescriptor, "experimental" | "id" | "provider"> {
    return {
      experimental,
      id: SourceType(descriptorId),
      provider: { id: ProviderType(providerId), name: providerId },
    };
  }

  it("never hides a non-experimental descriptor", () => {
    const d = fakeDescriptor("acme", "acme-source");
    expect(experimentalDescriptorHidden(d, false)).toBe(false);
    expect(experimentalDescriptorHidden(d, true)).toBe(false);
  });

  it("hides an experimental descriptor when the flag is off and not in synth mode", () => {
    expect(experimentalDescriptorHidden(fakeDescriptor("acme", "acme-source", true), false)).toBe(
      true,
    );
  });

  it("synthetic mode exposes experimental descriptors unconditionally", () => {
    expect(experimentalDescriptorHidden(fakeDescriptor("acme", "acme-source", true), true)).toBe(
      false,
    );
  });

  it("does not hide an experimental descriptor when experimental mode is on", () => {
    process.env[EXPERIMENTAL_ENV_VAR] = "1";
    expect(experimentalDescriptorHidden(fakeDescriptor("acme", "acme-source", true), false)).toBe(
      false,
    );
  });
});

describe("extractDescriptors — experimental flag", () => {
  it("serializeDescriptor projects experimental=true for an experimental descriptor", () => {
    const def = defineSource({
      id: "beta-source",
      name: "Beta Source",
      description: "not yet battle-tested",
      authType: "local",
      experimental: true,
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.experimental).toBe(true);
    expect(serializeDescriptor(descriptor).experimental).toBe(true);
  });

  it("serializeDescriptor defaults experimental=false when the field is absent", () => {
    const def = defineSource({
      id: "stable-source",
      name: "Stable Source",
      description: "shipped and trusted",
      authType: "local",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.experimental).toBeFalsy();
    expect(serializeDescriptor(descriptor).experimental).toBe(false);
  });

  it("a provider-level experimental flag cascades onto every child source", () => {
    const def = defineProvider({
      provider: { id: "beta-provider", name: "Beta Provider" },
      authType: "oauth",
      experimental: true,
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "beta-child-a",
          name: "Beta Child A",
          description: "child",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "beta-child-b",
          name: "Beta Child B",
          description: "child",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.map((d) => d.experimental)).toEqual([true, true]);
    expect(descriptors.map((d) => serializeDescriptor(d).experimental)).toEqual([true, true]);
  });

  it("a non-experimental provider yields falsy experimental on its sources", () => {
    const def = defineProvider({
      provider: { id: "stable-provider", name: "Stable Provider" },
      authType: "oauth",
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "stable-child",
          name: "Stable Child",
          description: "child",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.experimental).toBeUndefined();
    expect(serializeDescriptor(descriptor).experimental).toBe(false);
  });

  it("a per-source experimental flag marks one source without hiding its siblings", () => {
    const def = defineProvider({
      provider: { id: "mixed-provider", name: "Mixed Provider" },
      authType: "oauth",
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "shipped-source",
          name: "Shipped Source",
          description: "battle-tested",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "experimental-source",
          name: "Experimental Source",
          description: "not yet battle-tested",
          experimental: true,
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    const byId = Object.fromEntries(descriptors.map((d) => [d.id, d]));
    expect(byId["shipped-source"].experimental).toBeFalsy();
    expect(byId["experimental-source"].experimental).toBe(true);
  });

  it("a per-source experimental=false overrides a provider-level experimental default", () => {
    const def = defineProvider({
      provider: { id: "beta-provider", name: "Beta Provider" },
      authType: "oauth",
      experimental: true,
      authFlow: async () => "acct-1",
      sources: [
        {
          id: "opted-out",
          name: "Opted Out",
          description: "promoted to stable ahead of its siblings",
          experimental: false,
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.experimental).toBe(false);
  });

  // The discovery loop (discoverProviders) gates an experimental descriptor on
  // `synthMode || descriptorExperimentalEnabled(descriptor)`. That top-level
  // helper runs at module load and reads collector/package.json, so it isn't
  // re-exercised here; descriptorExperimentalEnabled above is the pure decision
  // the loop delegates to, and it is covered directly.
});

describe("discovered registry — experimental visibility", () => {
  const original = process.env[EXPERIMENTAL_ENV_VAR];
  beforeEach(() => {
    delete process.env[EXPERIMENTAL_ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_ENV_VAR];
    else process.env[EXPERIMENTAL_ENV_VAR] = original;
  });

  async function registryDescriptors(providerId: string): Promise<SourceDescriptor[]> {
    const { allDefinitions } = await import("./source-descriptors.js");
    const descriptors = allDefinitions
      .flatMap((def) => extractDescriptors(def))
      .filter((d) => d.provider.id === providerId);
    expect(descriptors.length, `${providerId} is not in the registry`).toBeGreaterThan(0);
    return descriptors;
  }

  it.each(["openclaw", "hermes"])(
    "the %s agent transcripts are generally available without experimental mode",
    async (providerId) => {
      for (const descriptor of await registryDescriptors(providerId)) {
        expect(descriptor.experimental).toBeFalsy();
        expect(experimentalDescriptorHidden(descriptor, false)).toBe(false);
      }
    },
  );

  it("an experimental provider such as Plaid stays hidden without experimental mode", async () => {
    for (const descriptor of await registryDescriptors("plaid")) {
      expect(descriptor.experimental).toBe(true);
      expect(experimentalDescriptorHidden(descriptor, false)).toBe(true);
    }
  });
});

describe("discovered registry — web push-based source", () => {
  it("the unified web source is discovered and registered", async () => {
    const { findDescriptor } = await import("./source-descriptors.js");
    const web = findDescriptor("web");
    expect(web).toBeDefined();
    expect(web!.name).toBe("Web Pages");
    expect(web!.provider.id).toBe("web");
  });

  it("web is push-based, not experimental, and carries the 'web pages' unit noun", async () => {
    const { findDescriptor } = await import("./source-descriptors.js");
    const web = findDescriptor("web")!;
    expect(web.pushBased).toBe(true);
    expect(web.experimental).toBeFalsy();
    expect(web.unitName).toBe("web pages");
  });

  it("web declares the page_visits analytics schema with semanticTimeColumn=visited_at", async () => {
    const { findDescriptor } = await import("./source-descriptors.js");
    const web = findDescriptor("web")!;
    const pageVisits = web.analyticsSchemas?.find((s) => s.tableName === "page_visits");
    expect(pageVisits).toBeDefined();
    expect(pageVisits!.semanticTimeColumn).toBe("visited_at");
  });

  it("web renders generically with an icon colour", async () => {
    const { findDescriptor } = await import("./source-descriptors.js");
    const web = findDescriptor("web")!;
    expect(web.icon?.color).toBeDefined();
  });
});

describe("extractDescriptors — conversational flag round-trip", () => {
  it("a defineSource conversational flag travels to the descriptor and serializes to true", () => {
    const def = defineSource({
      id: "chatter",
      name: "Chatter",
      description: "a conversation source",
      authType: "local",
      conversational: true,
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.conversational).toBe(true);
    expect(serializeDescriptor(descriptor).conversational).toBe(true);
  });

  it("serializeDescriptor defaults conversational=false when the field is absent", () => {
    const def = defineSource({
      id: "docs-source",
      name: "Docs Source",
      description: "a document source",
      authType: "local",
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor.conversational).toBeUndefined();
    expect(serializeDescriptor(descriptor).conversational).toBe(false);
  });

  it("conversational is per-source within a provider (one source on, siblings off)", () => {
    const def = defineProvider({
      provider: { id: "mixed-conv-provider", name: "Mixed Conv" },
      authType: "local",
      sources: [
        {
          id: "conv-child",
          name: "Conv Child",
          description: "a conversation stream",
          conversational: true,
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
        {
          id: "doc-child",
          name: "Doc Child",
          description: "not a conversation",
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        },
      ],
    });
    const descriptors = extractDescriptors(def);
    expect(descriptors.find((d) => String(d.id) === "conv-child")?.conversational).toBe(true);
    expect(descriptors.find((d) => String(d.id) === "doc-child")?.conversational).toBeUndefined();
    expect(descriptors.map((d) => serializeDescriptor(d).conversational)).toEqual([true, false]);
  });
});

describe("Web Pages source registers + renders generically", () => {
  it("extracts a single `web` descriptor that serializes to a JSON-safe shape", () => {
    // The exact path the gateway uses to ship a descriptor to clients:
    // extractDescriptors(definition) → serializeDescriptor(descriptor). Proves
    // the `web` source is reachable through the generic registry accessor every
    // catalog surface (portal / iOS / Android / CLI) reads from — no per-source
    // branching anywhere downstream.
    const descriptors = extractDescriptors(webDefinition);
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0]!;
    expect(String(descriptor.id)).toBe("web");
    expect(descriptor.name).toBe("Web Pages");
    expect(descriptor.unitName).toBe("web pages");

    const serialized = serializeDescriptor(descriptor);
    expect(serialized.id).toBe("web");
    expect(serialized.name).toBe("Web Pages");
    expect(serialized.unitName).toBe("web pages");
    expect(serialized.pushBased).toBe(true);
    expect(serialized.experimental).toBe(false);
    expect(serialized.icon?.color).toBe("#0EA5E9");
    expect(serialized.analyticsSchemas?.map((s) => s.tableName)).toContain("page_visits");
    // Functions are stripped — the wire shape round-trips through JSON.
    expect(() => JSON.parse(JSON.stringify(serialized))).not.toThrow();
  });
});

describe("extractDescriptors — what a typed flow may return as an account id", () => {
  function sourceReturning(accountId: string) {
    return defineSource({
      id: "typed-auth-source",
      name: "typed-auth-source",
      description: "tests the branding seam on the typed entry point",
      authType: "local",
      authenticate: async () => ({ accounts: [{ accountId, state: { status: "connected" } }] }),
      create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
    });
  }

  it("passes a well-formed id through unchanged", async () => {
    const [descriptor] = extractDescriptors(sourceReturning("maya@example.org"));
    const result = await descriptor.authenticate!({} as never);
    expect(result.accounts[0]?.accountId).toBe("maya@example.org");
    expect(result.accounts[0]?.state).toEqual({ status: "connected" });
  });

  it("refuses one that would climb out of the directory it is about to name", async () => {
    // Both providers that need this derive the id from a third party — an
    // exchange response, an institution's own name — so the id is upstream
    // data, and it becomes a path segment under the config directory. The
    // older entry point has been constrained here since it shipped; leaving
    // the newer one unconstrained would make adopting the contract the thing
    // that removed the check.
    for (const hostile of ["../../etc", "a/b", ""]) {
      const [descriptor] = extractDescriptors(sourceReturning(hostile));
      await expect(descriptor.authenticate!({} as never)).rejects.toThrow();
    }
  });
});

describe("extractDescriptors — the per-machine contract a device advertises", () => {
  /**
   * The field the collector sends is what every client routes host-local
   * settings by. A descriptor built without it reads as "did not say", and
   * each client then falls back to the form's parameter list — which leaves
   * advanced settings out, so a value for one is routed into the shared
   * config the gateway refuses to store.
   */
  const withAdvancedMemberSetting = {
    id: "fixture-local-store",
    name: "fixture with a local store",
    description: "x",
    authType: "local" as const,
    config: configSchema.object({
      dbPath: configSchema.path({ label: "Database", scope: "member" as const, required: true }),
      overrideDir: configSchema.path({
        label: "Override",
        scope: "member" as const,
        advanced: true,
      }),
      label: configSchema.string({ label: "Label" }),
    }),
    create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
  };

  it("carries the whole contract, not the subset the form renders", () => {
    const [descriptor] = extractDescriptors(defineSource(withAdvancedMemberSetting));
    expect(descriptor?.params?.map((p) => p.name)).not.toContain("overrideDir");
    expect(descriptor?.memberScopedParamNames).toEqual(["dbPath", "overrideDir"]);
    expect(serializeDescriptor(descriptor!).memberScopedParamNames).toEqual([
      "dbPath",
      "overrideDir",
    ]);
  });

  it("a source under a provider advertises its own contract too", () => {
    const def = defineProvider({
      provider: { id: "fixture-provider", name: "fixture provider" },
      authType: "local",
      sources: [withAdvancedMemberSetting],
    });
    const [descriptor] = extractDescriptors(def);
    expect(descriptor?.memberScopedParamNames).toEqual(["dbPath", "overrideDir"]);
  });

  it("a source with nothing host-local says so, rather than staying silent", () => {
    const [descriptor] = extractDescriptors(
      defineSource({
        id: "fixture-no-local-store",
        name: "fixture declaring no config",
        description: "x",
        authType: "local",
        create: async () => ({ sync: async () => ({ documents: [], cursor: {}, hasMore: false }) }),
      }),
    );
    expect(descriptor?.memberScopedParamNames).toEqual([]);
  });
});
