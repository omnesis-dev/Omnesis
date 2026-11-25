// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { realpath, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { CAPABILITY_ROLES } from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import {
  writeDesktopRestoreIntent,
  readDesktopRestoreIntent,
  desktopRestoreBlocked,
} from "./restore-intent.js";
import { verifyDesktopRestoreActivation } from "./restore-activation.js";
import { startCommittedDesktopRestore } from "./restore-start.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";
const seams = vi.hoisted(() => ({ captureKey: "1".repeat(64) }));
vi.mock("./restore-protection.js", () => ({
  DesktopRestoreProtection: class {
    static async capture(profile: DesktopProfile) {
      return {
        identity: () => desktopIdentity(profile),
        close: () => {},
      };
    }
  },
}));
let home: string, profile: DesktopProfile, root: { device: string; inode: string };
function desktopIdentity(_profile: DesktopProfile) {
  return {
    root,
    keyDigest: seams.captureKey,
    markerDigest: "2".repeat(64),
    rootChangeTime: "fixture",
  };
}
let operations: Pick<
  CoordinatorDependencies,
  "stopDaemon" | "startDaemon" | "request" | "connection" | "sleep"
>;
const token = "invented existing desktop identity";
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-start-")));
  profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  root = (await desktopRootIdentity(profile))!;
  seams.captureKey = "1".repeat(64);
  const config = JSON.stringify({
    inference: { assignments: Object.fromEntries(CAPABILITY_ROLES.map((role) => [role, null])) },
  });
  await writeFile(join(profile.configDir, "omnesis.json"), config, { mode: 0o600 });
  await writeDesktopRestoreIntent(profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "committed",
    root,
    targetKeyDigest: "1".repeat(64),
    archiveSha256: "3".repeat(64),
    archiveBytes: 1024,
    backup: { manifestSha256: "4".repeat(64), bytes: 4096 },
    verification: {
      schemaVersion: 321,
      documents: 4,
      sources: 2,
      tokenDigest: createHash("sha256").update(token).digest("hex"),
      configDigest: createHash("sha256").update(config).digest("hex"),
    },
  });
  operations = {
    stopDaemon: vi.fn(async () => false),
    startDaemon: vi.fn(async (p, authorization) => {
      expect(authorization).toBeDefined();
      expect(await verifyDesktopRestoreActivation(p, authorization!, { mode: "pending" })).toBe(
        true,
      );
      expect(await verifyDesktopRestoreActivation(p, authorization!, { mode: "claim" })).toBe(true);
    }),
    request: vi.fn(async (_p, path) =>
      path === "/health"
        ? {
            status: "ok",
            storageProtection: { version: 1, atRest: "encrypted" },
            compat: { schema: 321 },
          }
        : path === "/whoami"
          ? { tokenId: randomUUID(), scopes: ["read", "admin"] }
          : path === "/admin/config"
            ? {
                config: {
                  inference: {
                    assignments: Object.fromEntries(CAPABILITY_ROLES.map((role) => [role, null])),
                  },
                },
              }
            : path === "/admin/sources"
              ? { items: [{ enabled: false }, { enabled: false }], pageInfo: { hasMore: false } }
              : { documents: { total: 4 }, lab: { brain: false, tasks: false, watches: false } },
    ),
    connection: vi.fn(async () => ({
      url: "https://127.0.0.1:17601",
      token,
      certificatePEM: "invented certificate",
    })),
    sleep: vi.fn(async () => {
      throw new Error("Invented failing readiness wait");
    }),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
test("only an explicit start creates one claimed activation and persists complete after protected identity/data readiness", async () => {
  expect(await desktopRestoreBlocked(profile)).toBe(true);
  expect(
    await startCommittedDesktopRestore(profile, new AbortController().signal, operations),
  ).toBe(true);
  const record = (await readDesktopRestoreIntent(profile))!;
  expect(record.phase).toBe("complete");
  expect(record.verification?.verifiedAt).toBeDefined();
  expect(await desktopRestoreBlocked(profile)).toBe(false);
  expect(operations.startDaemon).toHaveBeenCalledTimes(1);
  expect(
    await startCommittedDesktopRestore(profile, new AbortController().signal, operations),
  ).toBe(false);
});
test("a claimed authorization cannot be claimed or used as a fresh daemon admission twice", async () => {
  const record = (await readDesktopRestoreIntent(profile))!,
    authorization = { operationId: record.operationId, attemptId: randomUUID(), epoch: null };
  await writeDesktopRestoreIntent(profile, {
    ...record,
    phase: "starting",
    activation: { attemptId: authorization.attemptId, epoch: null, claimed: false },
  });
  expect(await verifyDesktopRestoreActivation(profile, authorization, { mode: "child" })).toBe(
    false,
  );
  expect(await verifyDesktopRestoreActivation(profile, authorization, { mode: "claim" })).toBe(
    true,
  );
  expect(await verifyDesktopRestoreActivation(profile, authorization, { mode: "claim" })).toBe(
    false,
  );
  expect(await verifyDesktopRestoreActivation(profile, authorization, { mode: "pending" })).toBe(
    false,
  );
  expect(await verifyDesktopRestoreActivation(profile, authorization, { mode: "child" })).toBe(
    true,
  );
  expect(
    await verifyDesktopRestoreActivation(
      profile,
      { ...authorization, attemptId: randomUUID() },
      { mode: "child" },
    ),
  ).toBe(false);
  expect(
    await verifyDesktopRestoreActivation(
      profile,
      { ...authorization, epoch: "other" },
      { mode: "child" },
    ),
  ).toBe(false);
});
test("unprotected health, a changed machine identity or missing restored documents never produce complete", async () => {
  for (const kind of ["protection", "identity", "data"] as const) {
    const record = (await readDesktopRestoreIntent(profile))!;
    await writeDesktopRestoreIntent(profile, {
      ...record,
      phase: "committed",
      activation: undefined,
    });
    vi.mocked(operations.request).mockImplementation(async (_p, path) =>
      path === "/health"
        ? {
            status: "ok",
            storageProtection: {
              version: 1,
              atRest: kind === "protection" ? "unprotected" : "encrypted",
            },
            compat: { schema: 321 },
          }
        : path === "/whoami"
          ? { tokenId: randomUUID(), scopes: ["read", "admin"] }
          : path === "/admin/config"
            ? {
                config: {
                  inference: {
                    assignments: Object.fromEntries(CAPABILITY_ROLES.map((role) => [role, null])),
                  },
                },
              }
            : path === "/admin/sources"
              ? { items: [{ enabled: false }, { enabled: false }], pageInfo: { hasMore: false } }
              : {
                  documents: { total: kind === "data" ? 3 : 4 },
                  lab: { brain: false, tasks: false, watches: false },
                },
    );
    vi.mocked(operations.connection).mockResolvedValue({
      url: "https://127.0.0.1:17601",
      token: kind === "identity" ? "changed" : token,
      certificatePEM: "invented certificate",
    });
    await expect(
      startCommittedDesktopRestore(profile, new AbortController().signal, operations),
    ).rejects.toThrow("has not been verified");
    expect((await readDesktopRestoreIntent(profile))?.phase).toBe("starting");
    expect(await desktopRestoreBlocked(profile)).toBe(true);
  }
});

test("trusted startup projections may add documents without invalidating the authenticated offline rebuild", async () => {
  const original = operations.request;
  operations.request = async (profile, path, options) =>
    path === "/status"
      ? { documents: { total: 6 }, lab: { brain: false, tasks: false, watches: false } }
      : original(profile, path, options);
  expect(
    await startCommittedDesktopRestore(profile, new AbortController().signal, operations),
  ).toBe(true);
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("complete");
});
test("a changed protected root refuses activation before starting any child", async () => {
  seams.captureKey = "9".repeat(64);
  await expect(
    startCommittedDesktopRestore(profile, new AbortController().signal, operations),
  ).rejects.toThrow("original protection");
  expect(operations.startDaemon).not.toHaveBeenCalled();
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("committed");
});
