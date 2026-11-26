// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { sourcePermissionScopeDigest } from "@omnesis/core";
import { expect, test, vi } from "vitest";
import { SourceType, ProviderType, SourceId, ProviderId } from "@omnesis/types";
import { CollectorSourcePermissions } from "./source-permissions.js";
import type { SourceDescriptor, SourceReadAccessResult } from "@omnesis/source-sdk";
import type { RegisteredSource } from "./sync-engine-types.js";

const requirements = [
  {
    id: "local-store",
    kind: "protected-files" as const,
    summary: "Allow selected store access",
    scope: "Selected local store",
    blocking: true,
    actions: [{ kind: "retry-access" as const }],
  },
];
function descriptor(): SourceDescriptor {
  return {
    id: SourceType("fixture"),
    name: "Fixture",
    description: "Invented source",
    provider: { id: ProviderType("fixture"), name: "Fixture" },
    authType: "local",
    permissionRequirements: requirements,
  };
}

test("candidate probing uses fresh provider metadata without creating a source or saving credentials", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  let status: SourceReadAccessResult["status"] = "denied";
  const probe = vi.fn(async ({ params }: { params: Record<string, string> }) => {
    expect(params).toEqual({ folder: "/example/selected" });
    return { status };
  });
  const d = { ...descriptor(), probePermissionAccess: probe };
  try {
    const first = await service.check(
      { descriptorId: "fixture", params: { folder: "/example/selected" } },
      d,
    );
    expect(first.status).toBe("denied");
    expect(first.target).toBe("unverified");
    status = "readable";
    expect(
      (await service.check({ descriptorId: "fixture", params: { folder: "/example/selected" } }, d))
        .status,
    ).toBe("readable");
    expect(probe).toHaveBeenCalledTimes(2);
  } finally {
    await service.close();
  }
});
test("configured checks use the registered instance and never fall back to a candidate or different account", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  const candidate = vi.fn(async () => ({ status: "readable" as const }));
  const registered = vi.fn(async () => ({ status: "denied" as const }));
  const source: RegisteredSource = {
    id: SourceId("fixture:local"),
    permissionScopeDigest: sourcePermissionScopeDigest("fixture", "local", {}),
    name: "Fixture",
    providerId: ProviderId("fixture:local"),
    family: { name: "Fixture" },
    instance: {
      sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
      probeReadAccess: registered,
    },
  };
  try {
    expect(
      (
        await service.check(
          { descriptorId: "fixture", sourceId: "fixture:local" },
          { ...descriptor(), probePermissionAccess: candidate },
          source,
        )
      ).status,
    ).toBe("denied");
    expect(
      (
        await service.check(
          { descriptorId: "fixture", sourceId: "fixture:missing" },
          { ...descriptor(), probePermissionAccess: candidate },
        )
      ).status,
    ).toBe("unavailable");
    expect(candidate).not.toHaveBeenCalled();
    expect(registered).toHaveBeenCalledTimes(1);
    await expect(
      service.check({ descriptorId: "fixture", sourceId: "other:local" }, descriptor(), source),
    ).rejects.toThrow("does not match");
  } finally {
    await service.close();
  }
});
test("explicit no-permission declaration does not turn legacy or unsupported probes into a grant", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  try {
    expect(
      (
        await service.check(
          { descriptorId: "fixture" },
          { ...descriptor(), permissionRequirements: [] },
        )
      ).status,
    ).toBe("not-required");
    const legacy = await service.check(
      { descriptorId: "fixture" },
      { ...descriptor(), permissionRequirements: undefined },
    );
    expect(legacy.status).toBe("unsupported");
    expect(legacy.requirements).toBeUndefined();
    expect((await service.check({ descriptorId: "fixture" }, descriptor())).status).toBe(
      "unsupported",
    );
  } finally {
    await service.close();
  }
});

test("more than64 completed candidate scopes are reusable without collector restart", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  const probe = vi.fn(async () => ({ status: "readable" as const }));
  try {
    for (let index = 0; index < 80; index++)
      expect(
        (
          await service.check(
            { descriptorId: "fixture", params: { folder: `/example/${index}` } },
            { ...descriptor(), probePermissionAccess: probe },
          )
        ).status,
      ).toBe("readable");
    expect(probe).toHaveBeenCalledTimes(80);
  } finally {
    await service.close();
  }
});

test("eviction never overlaps a timed-out candidate's physically pending probe", async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  let pendingCalls = 0;
  const d = {
    ...descriptor(),
    probePermissionAccess: async ({ params }: { params: Record<string, string> }) => {
      if (params.folder === "pending") {
        pendingCalls++;
        await deferred;
      }
      return { status: "readable" as const };
    },
  };
  try {
    const first = service.check({ descriptorId: "fixture", params: { folder: "pending" } }, d);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await first).status).toBe("unavailable");
    for (let index = 0; index < 80; index++)
      expect(
        (
          await service.check(
            { descriptorId: "fixture", params: { folder: `complete-${index}` } },
            d,
          )
        ).status,
      ).toBe("readable");
    expect(
      (await service.check({ descriptorId: "fixture", params: { folder: "pending" } }, d)).status,
    ).toBe("unavailable");
    expect(pendingCalls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (await service.check({ descriptorId: "fixture", params: { folder: "pending" } }, d)).status,
    ).toBe("readable");
    expect(pendingCalls).toBe(2);
  } finally {
    release();
    await service.close();
    vi.useRealTimers();
  }
});

test("an actual large selected vault has scoped root capability without inventing exhaustive coverage", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: definition } = await import("@omnesis/provider-obsidian");
  const root = await mkdtemp(join(tmpdir(), "omnesis-root-access-"));
  const service = new CollectorSourcePermissions(root);
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => writeFile(join(root, `${i}.md`), "Invented fixture")),
    );
    const instance = await definition.create!({
      accountId: "local",
      sourceId: SourceId("obsidian-notes:local"),
      providerId: ProviderId("obsidian:local"),
      config: { vaultPath: root, exclude: [] },
    });
    const { extractDescriptors } = await import("./source-descriptors.js");
    const descriptor = extractDescriptors(definition)[0];
    expect(
      (
        await service.check(
          { descriptorId: descriptor.id, params: { vaultPath: root } },
          descriptor,
        )
      ).status,
    ).toBe("readable");
    const digest = sourcePermissionScopeDigest(descriptor.id, "local", { vaultPath: root });
    const source: RegisteredSource = {
      id: SourceId("obsidian-notes:local"),
      name: "Fixture",
      providerId: ProviderId("obsidian:local"),
      family: { name: "Fixture" },
      permissionRequirements: definition.permissionRequirements,
      permissionScopeDigest: digest,
      instance,
    };
    const configured = await service.check(
      {
        descriptorId: descriptor.id,
        sourceId: source.id,
        accountId: "local",
        expectedScopeDigest: digest,
      },
      descriptor,
      source,
    );
    expect(configured).toMatchObject({
      status: "readable",
      scopeDigest: digest,
      target: "unverified",
    });
    expect(configured.requirements?.[0]?.scope).toBe("Selected notes source root");
    expect((await instance.probeReadAccess!({ signal: new AbortController().signal })).status).toBe(
      "unavailable",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("probe replies distinguish guarded collection from ordinary or legacy collection", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  try {
    const ordinary = await service.check({ descriptorId: "fixture" }, descriptor());
    expect(ordinary.status).toBe("unsupported");
    expect(ordinary.publicationGuard).toBeUndefined();
    const guarded = await service.check(
      { descriptorId: "fixture" },
      descriptor(),
      undefined,
      "managed-v1",
    );
    expect(guarded.status).toBe("unsupported");
    expect(guarded.publicationGuard).toBe("managed-v1");
    expect(guarded.target).toBe("unverified");
  } finally {
    await service.close();
  }
});

test("engine protection is advertised only for declarations the selected runner actually enforces", async () => {
  const service = new CollectorSourcePermissions("/tmp/fixture-config");
  const declarations = [
    undefined,
    [],
    requirements.map((requirement) => ({ ...requirement, blocking: false })),
  ];
  const source: RegisteredSource = {
    id: SourceId("fixture:local"),
    name: "Fixture",
    providerId: ProviderId("fixture:local"),
    family: { name: "Fixture" },
    permissionScopeDigest: sourcePermissionScopeDigest("fixture", "local", {}),
    instance: {
      sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    },
  };
  try {
    for (const permissionRequirements of declarations) {
      const candidate = await service.check(
        { descriptorId: "fixture" },
        { ...descriptor(), permissionRequirements },
        undefined,
        "managed-v1",
      );
      expect(candidate.publicationGuard).toBeUndefined();
      const configured = await service.check(
        { descriptorId: "fixture", sourceId: source.id },
        descriptor(),
        { ...source, permissionRequirements },
        "managed-v1",
      );
      expect(configured.publicationGuard).toBeUndefined();
    }
    const missing = await service.check(
      { descriptorId: "fixture", sourceId: "fixture:missing" },
      descriptor(),
      undefined,
      "managed-v1",
    );
    expect(missing.publicationGuard).toBeUndefined();
    const guarded = await service.check(
      { descriptorId: "fixture", sourceId: source.id },
      descriptor(),
      { ...source, permissionRequirements: requirements },
      "managed-v1",
    );
    expect(guarded.publicationGuard).toBe("managed-v1");
  } finally {
    await service.close();
  }
});
