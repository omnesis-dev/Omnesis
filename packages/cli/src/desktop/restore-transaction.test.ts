// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { realpath, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  acquireGatewayLock,
  generateInstallRootKey,
  renderSecureMarker,
  secureMarkerPath,
} from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopJournalPath } from "./profile.js";
import { DesktopRestoreProtection } from "./restore-protection.js";
import { DesktopRestoreFailure } from "./restore-errors.js";
import {
  readDesktopRestoreIntent,
  writeDesktopRestoreIntent,
  desktopRestoreBlocked,
} from "./restore-intent.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { registerVerifiedDesktopRestoreSnapshot } from "./snapshot-retention.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { desktopRootIdentity } from "./retirement.js";
import {
  createDesktopUpdateSnapshot,
  desktopUpdateSnapshotPath,
  restoreDesktopUpdateSnapshot,
} from "./update-snapshot.js";
import {
  applyDesktopRestoreTransaction,
  recoverDesktopRestoreTransaction,
  type DesktopRestoreTransactionPlan,
} from "./restore-transaction.js";

let home: string, profile: DesktopProfile, stage: string, plan: DesktopRestoreTransactionPlan;
let capture: typeof DesktopRestoreProtection.capture;
const signal = () => new AbortController().signal;
const original = "invented original sealed database",
  incoming = "invented incoming sealed database";
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-transaction-")));
  profile = desktopProfile(home);
  await mkdir(join(profile.configDir, "keyring"), { recursive: true, mode: 0o700 });
  await writeFile(
    desktopJournalPath(profile),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      mode: "home",
      phase: "configured",
      embedder: null,
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  const key = generateInstallRootKey();
  for (const kind of ["storage-encryption", "secret-files"] as const)
    await writeFile(secureMarkerPath(kind, profile.configDir), renderSecureMarker(kind, key), {
      mode: 0o600,
    });
  await writeFile(join(profile.configDir, "omnesis.db"), original, { mode: 0o600 });
  await writeFile(join(profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
  await writeFile(join(profile.configDir, "token"), "invented current machine authority", {
    mode: 0o600,
  });
  stage = join(`${profile.configDir}.bootstrap`, "restore-imports", randomUUID());
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await writeFile(join(stage, "main.enc"), incoming, { mode: 0o600 });
  await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await writeFile(
    join(`${profile.configDir}.bootstrap`, "process-authority.json"),
    JSON.stringify({
      version: 3,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
    }),
    { mode: 0o600 },
  );
  capture = (p, s) =>
    DesktopRestoreProtection.capture(p, s, {
      read: async () => key,
      mirror: async () => "required",
      inspect: async () => ({
        keyName: "install-root-key-v1",
        present: true,
        valid: true,
        store: {
          requestedBackend: "macos-keychain",
          backend: "macos-keychain",
          available: true,
          secure: true,
          detail: "Invented fixture key store",
          writeExposure: "process-argv",
        },
      }),
    });
  const protection = await capture(profile, signal());
  plan = {
    expandedBytes: 1024,
    archiveSha256: "a".repeat(64),
    archiveBytes: 1024,
    protection: protection.identity(),
    stagingRoot: stage,
    build: async () => ({
      place: [{ rel: "omnesis.db", from: join(stage, "main.enc") }],
      remove: [],
      sourcesPaused: 2,
      watchesPaused: 3,
      verify: async () => {
        expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(incoming);
        expect(await readFile(join(profile.configDir, "token"), "utf8")).toBe(
          "invented current machine authority",
        );
      },
    }),
  };
  protection.close();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const dependencies = () => ({ capture, stop: async () => false, authorize: () => {} });

test("default mutation helpers refuse missing native authority before snapshot or publication", async () => {
  const stop = vi.fn(async () => false),
    snapshot = vi.fn();
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), { capture, stop, snapshot }),
  ).rejects.toThrow("native exclusive authority");
  await expect(
    recoverDesktopRestoreTransaction(profile, randomUUID(), signal(), { capture, stop, snapshot }),
  ).rejects.toThrow("native exclusive authority");
  expect(stop).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(await readDesktopRestoreIntent(profile)).toBeNull();
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});

test.each([1, 2])(
  "capacity admission failure at phase %i never publishes incoming bytes",
  async (failAt) => {
    const build = vi.fn(plan.build);
    plan.build = build;
    let checks = 0;
    const capacity = vi.fn(async () => {
      if (++checks === failAt) throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
    });
    const measure = vi.fn(async () => ({ bytes: 8192, entries: 10 }));
    await expect(
      applyDesktopRestoreTransaction(profile, plan, signal(), {
        ...dependencies(),
        capacity,
        measure,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CAPACITY_REQUIRED" });
    expect(capacity.mock.calls.length).toBe(failAt);
    expect(build).not.toHaveBeenCalled();
    expect((await readDesktopRestoreIntent(profile))?.phase).toBe("rolled-back");
    expect((await readDesktopRestoreIntent(profile))?.backup !== null).toBe(failAt === 2);
    expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
  },
);

test("publishes only after a retained recovery snapshot, preserving machine authority and root identity", async () => {
  const root = await desktopRootIdentity(profile),
    build = plan.build;
  plan.build = async (context) => {
    const intent = (await readDesktopRestoreIntent(profile))!;
    expect(intent.phase).toBe("backed-up");
    expect(
      await readFile(
        join(desktopUpdateSnapshotPath(profile, intent.operationId), "files", "omnesis.db"),
        "utf8",
      ),
    ).toBe(original);
    return build(context);
  };
  expect(
    await applyDesktopRestoreTransaction(profile, plan, signal(), dependencies()),
  ).toMatchObject({ sourcesPaused: 2, watchesPaused: 3 });
  expect(await desktopRootIdentity(profile)).toEqual(root);
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("committed");
  expect(await desktopRestoreBlocked(profile)).toBe(true);
  await writeDesktopRestoreIntent(profile, {
    ...(await readDesktopRestoreIntent(profile))!,
    phase: "complete",
  });
  await expect(
    recoverDesktopRestoreTransaction(
      profile,
      (await readDesktopRestoreIntent(profile))!.operationId,
      signal(),
      dependencies(),
    ),
  ).rejects.toThrow("no matching");
});

test("a verification failure restores the complete prior snapshot and releases every runtime lease", async () => {
  const build = plan.build;
  plan.build = async (context) => ({
    ...(await build(context)),
    verify: async () => {
      throw new Error("invented verify refusal");
    },
  });
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), dependencies()),
  ).rejects.toMatchObject({ code: "RESTORE_ROLLED_BACK" });
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("rolled-back");
  const lock = await acquireGatewayLock(profile.configDir, { waitMs: 0 });
  lock.release();
});

test("a missing daemon acknowledgement does not bypass a live gateway lock", async () => {
  const lock = await acquireGatewayLock(profile.configDir, { waitMs: 0 });
  const fresh = await capture(profile, signal());
  plan.protection = fresh.identity();
  fresh.close();
  const build = vi.spyOn(plan, "build");
  try {
    await expect(
      applyDesktopRestoreTransaction(profile, plan, signal(), dependencies()),
    ).rejects.toMatchObject({ code: "RESTORE_ROLLED_BACK" });
    expect(build).not.toHaveBeenCalled();
    expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
  } finally {
    lock.release();
  }
});

test("cancellation before publication retains the prior library; cancellation during commit completes verification", async () => {
  const abort = new AbortController(),
    build = plan.build;
  plan.build = async (context) => {
    const result = await build(context);
    abort.abort();
    return result;
  };
  await expect(
    applyDesktopRestoreTransaction(profile, plan, abort.signal, dependencies()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
  // A new explicit preview binds the current directory identity after the first operation.
  const fresh = await capture(profile, signal());
  plan.protection = fresh.identity();
  fresh.close();
  const after = new AbortController();
  plan.build = async (context) => {
    const result = await build(context);
    return {
      ...result,
      verify: async () => {
        after.abort();
        await result.verify();
      },
    };
  };
  await expect(
    applyDesktopRestoreTransaction(profile, plan, after.signal, dependencies()),
  ).resolves.toMatchObject({ sourcesPaused: 2 });
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("committed");
});

test("failed recovery stays fenced and a later explicit retry uses only its own backstop", async () => {
  const build = plan.build;
  plan.build = async (context) => ({
    ...(await build(context)),
    verify: async () => {
      throw new Error("invented verify failure");
    },
  });
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), {
      ...dependencies(),
      rollback: async () => {
        throw new Error("invented unavailable recovery");
      },
    }),
  ).rejects.toMatchObject({ code: "RESTORE_RECOVERY_REQUIRED" });
  const record = (await readDesktopRestoreIntent(profile))!;
  expect(await desktopRestoreBlocked(profile)).toBe(true);
  const rollback = vi.fn(restoreDesktopUpdateSnapshot);
  await expect(
    recoverDesktopRestoreTransaction(profile, randomUUID(), signal(), {
      ...dependencies(),
      rollback,
    }),
  ).rejects.toThrow("no matching");
  expect(rollback).not.toHaveBeenCalled();
  await expect(
    recoverDesktopRestoreTransaction(profile, record.operationId, signal(), {
      ...dependencies(),
      rollback,
    }),
  ).resolves.toEqual({ recoveryCopyRetained: true });
  expect(await desktopRestoreBlocked(profile)).toBe(false);
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});

test.each([
  "token",
  "tls/server.key",
  "keyring/foreign/credentials.json",
  "models/foreign/credentials.json",
  "cloud-relay/cli-device.json",
  "../outside",
  "sweeps/../token",
])("refuses publication of authority or traversal path %s", async (rel) => {
  const build = plan.build;
  plan.build = async (context) => ({
    ...(await build(context)),
    place: [{ rel, from: join(stage, "main.enc") }],
  });
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), dependencies()),
  ).rejects.toMatchObject({ code: "RESTORE_ROLLED_BACK" });
  expect(await readFile(join(profile.configDir, "token"), "utf8")).toBe(
    "invented current machine authority",
  );
});

test("refuses staged bytes outside the owned import slot", async () => {
  const path = join(home, "foreign.enc");
  await writeFile(path, incoming, { mode: 0o600 });
  const build = plan.build;
  plan.build = async (context) => ({
    ...(await build(context)),
    place: [{ rel: "omnesis.db", from: path }],
  });
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), dependencies()),
  ).rejects.toMatchObject({ code: "RESTORE_ROLLED_BACK" });
  expect(await readFile(path, "utf8")).toBe(incoming);
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});

test("inline legacy model keys refuse before stop or any recovery snapshot", async () => {
  const secret = "invented-inline-credential";
  await writeFile(
    join(profile.configDir, "omnesis.json"),
    JSON.stringify({
      inference: {
        backends: { scripted: { type: "http", url: "http://127.0.0.1:17601", apiKey: secret } },
      },
    }),
    { mode: 0o600 },
  );
  const stop = vi.fn(async () => false),
    snapshot = vi.fn();
  const error = await applyDesktopRestoreTransaction(profile, plan, signal(), {
    authorize: () => {},
    capture,
    stop,
    snapshot,
  }).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "RESTORE_TARGET_SECRETS_UNPROTECTED" });
  expect((error as Error).message).not.toContain(secret);
  expect(stop).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(await readDesktopRestoreIntent(profile)).toBeNull();
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});

test("legacy process uncertainty refuses restore before a stopping intent or daemon stop", async () => {
  await rm(join(`${profile.configDir}.bootstrap`, "process-authority.json"));
  const stop = vi.fn(() => Promise.resolve(false));
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), { ...dependencies(), stop }),
  ).rejects.toMatchObject({ code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED" });
  expect(stop).not.toHaveBeenCalled();
  expect(await readDesktopRestoreIntent(profile)).toBeNull();
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});

test("the shared recovery-copy cap refuses a real restore transaction before stop or a new journal", async () => {
  const root = (await desktopRootIdentity(profile))!;
  let previousId = "";
  for (let index = 0; index < 16; index++) {
    await withDesktopInstallLease(profile, signal(), async () => {
      const operationId = randomUUID(),
        leases = await acquireDesktopRuntimeLeases(profile, {
          expectedRoot: root,
          signal: signal(),
        });
      let backup;
      try {
        backup = await createDesktopUpdateSnapshot(profile, {
          operationId,
          leases,
          signal: signal(),
        });
      } finally {
        leases.release();
      }
      const intent = {
        version: 1 as const,
        owner: "omnesis-desktop" as const,
        instance: profile.instance,
        secretService: profile.secretService,
        operationId,
        root,
        phase: "complete" as const,
        backup,
        backupRuntime: { epoch: "a".repeat(64), version: "1.2.2" },
        targetKeyDigest: plan.protection.keyDigest,
        archiveSha256: "b".repeat(64),
        archiveBytes: 1234,
      };
      await writeDesktopRestoreIntent(profile, intent);
      await registerVerifiedDesktopRestoreSnapshot(profile, intent, signal());
      previousId = operationId;
    });
  }
  const protection = await capture(profile, signal());
  plan = { ...plan, protection: protection.identity() };
  protection.close();
  const stop = vi.fn(() => Promise.resolve(false));
  await expect(
    applyDesktopRestoreTransaction(profile, plan, signal(), { ...dependencies(), stop }),
  ).rejects.toMatchObject({ code: "RECOVERY_COPIES_FULL" });
  expect(stop).not.toHaveBeenCalled();
  expect((await readDesktopRestoreIntent(profile))?.operationId).toBe(previousId);
  expect((await readDesktopRestoreIntent(profile))?.phase).toBe("complete");
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(original);
});
