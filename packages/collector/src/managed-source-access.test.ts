// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { probeTreeReadAccess, type SourceDescriptor } from "@omnesis/source-sdk";
import { ProviderId, ProviderType, SourceId, SourceType } from "@omnesis/types";
import { sourcePermissionScopeDigest } from "@omnesis/core";
import { assertManagedSourceAccess } from "./managed-source-access.js";
import { CollectorSourcePermissions } from "./source-permissions.js";
import { DoctorReadAccess } from "./doctor-read-access.js";
import { SyncEngine } from "./sync-engine.js";
import type { RegisteredSource } from "./sync-engine-types.js";

const requirements = [
  {
    id: "selected-folder",
    kind: "selected-folder" as const,
    summary: "Allow selected folder access",
    scope: "Selected local folder",
    blocking: true,
    actions: [{ kind: "retry-access" as const }],
  },
];
test("a large readable tree remains unknown without permanently stranding its configured reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-access-limit-"));
  const permission = new CollectorSourcePermissions(root);
  const probes = new DoctorReadAccess();
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        writeFile(join(root, `${i}.md`), "Invented source fixture"),
      ),
    );
    const probe = () =>
      probeTreeReadAccess({
        roots: [{ path: root }],
        fileExtensions: [".md"],
        signal: new AbortController().signal,
      });
    expect((await probe()).status).toBe("unavailable");
    const sync = vi.fn(async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: { bookmark: 1 },
      hasMore: false,
    }));
    const source: RegisteredSource = {
      id: SourceId("fixture:local"),
      permissionScopeDigest: sourcePermissionScopeDigest("fixture", "local", { root }),
      providerId: ProviderId("fixture:local"),
      name: "Fixture",
      family: { name: "Fixture" },
      permissionRequirements: requirements,
      instance: { sync, probeReadAccess: probe },
    };
    const descriptor: SourceDescriptor = {
      id: SourceType("fixture"),
      provider: { id: ProviderType("fixture"), name: "Fixture" },
      name: "Fixture",
      description: "Invented local source",
      authType: "local",
      permissionRequirements: requirements,
    };
    const observation = await permission.check(
      { descriptorId: "fixture", sourceId: "fixture:local" },
      descriptor,
      source,
    );
    expect(observation.status).toBe("unavailable");
    expect(observation.target).toBe("unverified");
    await expect(
      assertManagedSourceAccess(source, probes, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(sync).not.toHaveBeenCalled(); // This endpoint never collects or fabricates a positive grant.
  } finally {
    await permission.close();
    await probes.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "publication evidence follows the engine's actual guarded runner (%s)",
  async (enforceReadAccess) => {
    const engine = new SyncEngine({} as never, { enforceReadAccess });
    try {
      expect(engine.publicationGuard).toBe(enforceReadAccess ? "managed-v1" : undefined);
    } finally {
      engine.stopSyncLoop();
      await engine.permissionAccess.close();
    }
  },
);
