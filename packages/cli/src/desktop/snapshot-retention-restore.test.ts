// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import { writeDesktopRestoreIntent, type DesktopRestoreIntent } from "./restore-intent.js";
import { writeDesktopUpdateState, type DesktopUpdateState } from "./update-state.js";
import {
  registerVerifiedDesktopRestoreSnapshot,
  registerVerifiedDesktopSnapshot,
  retainDesktopUpdateBeforeReplacement,
} from "./snapshot-retention.js";
import {
  captureDesktopRestoreBackupRuntime,
  retainDesktopRestoreBeforeReplacement,
} from "./snapshot-retention-restore.js";
import { readDesktopSnapshotRetention } from "./snapshot-retention-record.js";
import {
  prepareDesktopSnapshotCleanupLocked,
  stageDesktopSnapshotCleanupLocked,
} from "./snapshot-retention-prepare.js";
import { finishDesktopSnapshotCleanup } from "./snapshot-retention-delete.js";
import { desktopRecoveryCopiesCatalog } from "./snapshot-retention-catalog.js";
import { desktopSnapshotStagingPath, writeDesktopSnapshotOwner } from "./snapshot-owner.js";
const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-retention-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "invented.data"), "current sealed fixture data", {
    mode: 0o600,
  });
  const root = (await desktopRootIdentity(profile))!,
    epoch = "a".repeat(64);
  await withDesktopInstallLease(profile, signal(), () =>
    writeDesktopActiveRuntime(profile, epoch, "1.2.2"),
  );
  async function backup() {
    const operationId = randomUUID(),
      leases = await acquireDesktopRuntimeLeases(profile, { expectedRoot: root, signal: signal() });
    try {
      return {
        operationId,
        backup: await createDesktopUpdateSnapshot(profile, {
          operationId,
          leases,
          signal: signal(),
        }),
      };
    } finally {
      leases.release();
    }
  }
  async function restore(known = true) {
    const copy = await backup();
    const intent: DesktopRestoreIntent = {
      version: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      ...copy,
      root,
      phase: "complete",
      targetKeyDigest: "c".repeat(64),
      archiveSha256: "d".repeat(64),
      archiveBytes: 1234,
      ...(known ? { backupRuntime: { epoch, version: "1.2.2" } } : {}),
    };
    await withDesktopInstallLease(profile, signal(), async () => {
      await writeDesktopRestoreIntent(profile, intent);
      await registerVerifiedDesktopRestoreSnapshot(profile, intent, signal());
    });
    return intent;
  }
  return { profile, root, epoch, backup, restore };
}
test("sixteen completed restores on one live epoch retain their backstops and can reclaim an older copy for the next restore", async () => {
  const f = await fixture(),
    states: DesktopRestoreIntent[] = [];
  for (let index = 0; index < 16; index++) {
    await withDesktopInstallLease(f.profile, signal(), () =>
      retainDesktopRestoreBeforeReplacement(f.profile, signal()),
    );
    states.push(await f.restore());
  }
  const first = states[0]!,
    current = states[15]!;
  await expect(
    withDesktopInstallLease(f.profile, signal(), () =>
      retainDesktopRestoreBeforeReplacement(f.profile, signal()),
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_COPIES_FULL" });
  expect(
    (await readDesktopSnapshotRetention(f.profile))?.records.every(
      (row) => row.purpose === "restore",
    ),
  ).toBe(true);
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: first.operationId, currentEpoch: f.epoch },
      signal(),
    );
    expect(plan.receipt.journals).toEqual({ updateId: null, restoreId: current.operationId });
    expect(plan.receipt.mode).toBe("redundant-snapshot");
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
      assert: (_profile, receipt) => {
        expect(receipt.mode).toBe("redundant-snapshot");
      },
    });
    await retainDesktopRestoreBeforeReplacement(f.profile, signal());
  });
  await f.restore();
  expect((await readDesktopSnapshotRetention(f.profile))?.records).toHaveLength(16);
  expect(await readFile(join(f.profile.configDir, "invented.data"), "utf8")).toBe(
    "current sealed fixture data",
  );
});
test("a historical copy without actual runtime evidence stays unknown and is never assigned a guessed version", async () => {
  const f = await fixture(),
    old = await f.restore(false);
  expect(await readDesktopSnapshotRetention(f.profile)).toBeNull();
  await withDesktopInstallLease(f.profile, signal(), () =>
    retainDesktopRestoreBeforeReplacement(f.profile, signal()),
  );
  await f.restore();
  const catalog = await desktopRecoveryCopiesCatalog(f.profile, signal());
  expect(catalog.unregisteredCopies).toBe(1);
  expect(catalog.items).toHaveLength(1);
  expect(catalog.items[0]?.purpose).toBe("restore");
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
  ).resolves.toBeUndefined();
});
test("the shared cap includes a completed restore even when the next operation is an application update", async () => {
  const f = await fixture();
  let update: DesktopUpdateState | undefined;
  for (let index = 0; index < 15; index++) {
    const copy = await f.backup();
    update = {
      format: 1,
      owner: "omnesis-desktop",
      instance: f.profile.instance,
      secretService: f.profile.secretService,
      ...copy,
      root: f.root,
      phase: "resumed",
      mode: "home",
      oldEpoch: f.epoch,
      candidateEpoch: "b".repeat(64),
      oldVersion: "1.2.2",
      candidateVersion: "1.2.3",
      artifactSha256: "d".repeat(64),
    };
    const state = update;
    await withDesktopInstallLease(f.profile, signal(), async () => {
      await writeDesktopUpdateState(f.profile, state);
      await registerVerifiedDesktopSnapshot(f.profile, state, signal());
    });
  }
  await f.restore();
  await expect(
    withDesktopInstallLease(f.profile, signal(), () =>
      retainDesktopUpdateBeforeReplacement(f.profile, update!, signal()),
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_COPIES_FULL" });
  expect((await readDesktopSnapshotRetention(f.profile))?.records).toHaveLength(16);
});
test("a rolled-back restore's owned partial stage is reviewed without requiring any application-update journal", async () => {
  const f = await fixture(),
    operationId = randomUUID();
  await withDesktopInstallLease(f.profile, signal(), async () => {
    await writeDesktopRestoreIntent(f.profile, {
      version: 1,
      owner: "omnesis-desktop",
      instance: f.profile.instance,
      secretService: f.profile.secretService,
      operationId,
      root: f.root,
      phase: "rolled-back",
      backup: null,
      backupRuntime: { epoch: f.epoch, version: "1.2.2" },
      targetKeyDigest: "c".repeat(64),
      archiveSha256: "d".repeat(64),
      archiveBytes: 1234,
    });
    const path = desktopSnapshotStagingPath(f.profile, operationId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeDesktopSnapshotOwner(f.profile, operationId, path);
    await writeFile(join(path, "invented.partial"), "incomplete sealed bytes", { mode: 0o600 });
    await expect(retainDesktopRestoreBeforeReplacement(f.profile, signal())).rejects.toMatchObject({
      code: "RECOVERY_COPY_INCOMPLETE",
    });
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: operationId, currentEpoch: f.epoch, incompleteStaging: true },
      signal(),
    );
    expect(plan.receipt.journals).toEqual({ updateId: null, restoreId: operationId });
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
      assert: (_profile, receipt) => {
        expect(receipt.mode).toBe("incomplete-owned");
      },
    });
    await retainDesktopRestoreBeforeReplacement(f.profile, signal());
  });
});
test("runtime capture requires the actual active managed epoch; source fixtures preserve their explicit unknown state", async () => {
  const f = await fixture();
  await expect(
    captureDesktopRestoreBackupRuntime(f.profile, { epoch: () => f.epoch, source: () => false }),
  ).resolves.toEqual({ epoch: f.epoch, version: "1.2.2" });
  await expect(
    captureDesktopRestoreBackupRuntime(f.profile, {
      epoch: () => "b".repeat(64),
      source: () => false,
    }),
  ).rejects.toThrow("active application");
  await expect(
    captureDesktopRestoreBackupRuntime(f.profile, { epoch: () => null, source: () => false }),
  ).rejects.toThrow("active application");
  await expect(
    captureDesktopRestoreBackupRuntime(f.profile, { epoch: () => null, source: () => true }),
  ).resolves.toBeUndefined();
});
