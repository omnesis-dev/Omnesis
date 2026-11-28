// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withDesktopInstallLease } from "./bootstrap.js";
import { DesktopCoordinator } from "./coordinator.js";
import { DesktopInteractionBroker } from "./protocol.js";
import { handleDesktopRetention } from "./coordinator-retention.js";
import { handleDesktopRecoveryCleanup } from "./coordinator-retention-cleanup.js";
import { desktopRecoveryCopiesCatalog } from "./snapshot-retention-catalog.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { writeDesktopUpdateState, type DesktopUpdateState } from "./update-state.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import {
  assertDesktopSnapshotRetentionCapacity,
  cancelDesktopSnapshotCleanup,
  registerVerifiedDesktopSnapshot,
  pinRetainedDesktopSnapshot,
  retainDesktopUpdateBeforeReplacement,
} from "./snapshot-retention.js";
import {
  prepareDesktopSnapshotCleanupLocked,
  stageDesktopSnapshotCleanupLocked,
} from "./snapshot-retention-prepare.js";
import { finishDesktopSnapshotCleanup } from "./snapshot-retention-delete.js";
import {
  readDesktopSnapshotRetention,
  writeDesktopSnapshotRetention,
  type DesktopSnapshotCleanupReceipt,
} from "./snapshot-retention-record.js";
import { desktopSnapshotStagingPath, writeDesktopSnapshotOwner } from "./snapshot-owner.js";

const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(count = 2) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-retention-cleanup-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "invented.data"), "retained encrypted fixture payload", {
    mode: 0o600,
  });
  const root = (await desktopRootIdentity(profile))!;
  await withDesktopInstallLease(profile, signal(), async () => {});
  const states: DesktopUpdateState[] = [];
  const make = async () => {
    const operationId = randomUUID(),
      leases = await acquireDesktopRuntimeLeases(profile, { expectedRoot: root, signal: signal() });
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
    const state: DesktopUpdateState = {
      format: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      operationId,
      phase: "resumed",
      mode: "home",
      oldEpoch: "a".repeat(64),
      candidateEpoch: "b".repeat(64),
      oldVersion: "1.2.2",
      candidateVersion: "1.2.3",
      artifactSha256: "c".repeat(64),
      root,
      backup,
    };
    await withDesktopInstallLease(profile, signal(), async () => {
      await writeDesktopActiveRuntime(profile, state.oldEpoch, state.oldVersion);
      await writeDesktopUpdateState(profile, state);
      await registerVerifiedDesktopSnapshot(profile, state, signal());
    });
    states.push(state);
    return state;
  };
  for (let index = 0; index < count; index++) await make();
  return { profile, root, states, make };
}
function fixtureAuthority(receipt: DesktopSnapshotCleanupReceipt): void {
  // Explicit OS-boundary substitute; real native lease/PID proof is a separate admitted native test.
  if (receipt.mode === "last-copy-old-epoch" && receipt.oldEpoch === receipt.currentEpoch)
    throw new Error("fixture current epoch is still in use");
}
test("sixteen resumed updates on the live epoch can explicitly reclaim a redundant copy and admit the seventeenth", async () => {
  const f = await fixture(16),
    first = f.states[0]!,
    last = f.states[15]!;
  expect(
    f.states.every((state) => state.phase === "resumed" && state.oldEpoch === last.oldEpoch),
  ).toBe(true);
  await expect(retainDesktopUpdateBeforeReplacement(f.profile, last, signal())).rejects.toThrow(
    "full",
  );
  const before = await readFile(join(f.profile.configDir, "invented.data"));
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: first.operationId, currentEpoch: last.oldEpoch },
      signal(),
    );
    expect(plan.receipt.mode).toBe("redundant-snapshot");
    expect(plan.receipt.keeper?.operationId).toBe(last.operationId);
    expect(await readDesktopSnapshotRetention(f.profile)).toMatchObject({ pending: null });
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    const result = await finishDesktopSnapshotCleanup(
      f.profile,
      plan.receipt.operationId,
      signal(),
      { assert: (_profile, receipt) => fixtureAuthority(receipt) },
    );
    expect(result.status).toBe("removed");
  });
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, first.operationId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.profile.configDir, "invented.data"))).toEqual(before);
  await expect(assertDesktopSnapshotRetentionCapacity(f.profile)).resolves.toBeUndefined();
  await f.make();
  expect((await readDesktopSnapshotRetention(f.profile))?.records).toHaveLength(16);
  await expect(assertDesktopSnapshotRetentionCapacity(f.profile)).rejects.toThrow("full");
});
test("newest/current copies cannot be selected and cancellation before mutation retains the planned copy", async () => {
  const f = await fixture(),
    latest = f.states[1]!,
    old = f.states[0]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    await expect(
      prepareDesktopSnapshotCleanupLocked(
        f.profile,
        { snapshotId: latest.operationId, currentEpoch: latest.oldEpoch },
        signal(),
      ),
    ).rejects.toThrow("Keep");
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: latest.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, AbortSignal.abort(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
      }),
    ).rejects.toThrow();
  });
  expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("planned");
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
  ).resolves.toBeUndefined();
});
test("a failed partial deletion stays durable and retry removes only the same original inode", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
        remove: async (path) => {
          await unlink(join(String(path), "snapshot.json"));
          throw new Error("invented interrupted cleanup");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("deleting");
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
      }),
    ).resolves.toMatchObject({ status: "removed" });
  });
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
});
test("a corrupted retained keeper refuses deletion before the selected snapshot is touched", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await writeFile(
      join(desktopUpdateSnapshotPath(f.profile, current.operationId), "snapshot.json"),
      "invalid retained inventory",
    );
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
      }),
    ).rejects.toThrow("changed");
  });
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
  ).resolves.toBeUndefined();
  expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("planned");
});
test("an owned interrupted stage has an explicit cleanup remedy without replacing or ingesting the current library", async () => {
  const f = await fixture(1),
    state = {
      ...f.states[0]!,
      operationId: randomUUID(),
      phase: "verified" as const,
      backup: null,
    };
  await withDesktopInstallLease(f.profile, signal(), async () => {
    await writeDesktopUpdateState(f.profile, state);
    const pending = desktopSnapshotStagingPath(f.profile, state.operationId);
    await mkdir(pending, { mode: 0o700 });
    await writeDesktopSnapshotOwner(f.profile, state.operationId, pending);
    await mkdir(join(pending, "files"), { mode: 0o700 });
    await writeFile(join(pending, "files", "invented.partial"), "incomplete sealed bytes", {
      mode: 0o600,
    });
    await expect(retainDesktopUpdateBeforeReplacement(f.profile, state, signal())).rejects.toThrow(
      "incomplete",
    );
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: state.operationId, currentEpoch: state.oldEpoch, incompleteStaging: true },
      signal(),
    );
    expect(plan.receipt.mode).toBe("incomplete-owned");
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
      assert: (_profile, receipt) => fixtureAuthority(receipt),
    });
    await expect(
      retainDesktopUpdateBeforeReplacement(f.profile, state, signal()),
    ).resolves.toBeUndefined();
  });
  expect(await readFile(join(f.profile.configDir, "invented.data"), "utf8")).toBe(
    "retained encrypted fixture payload",
  );
});

test("a last epoch copy requires absence authority, while a live epoch's redundant copies do not", async () => {
  const f = await fixture(3),
    first = f.states[0]!,
    current = f.states[2]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const ledger = (await readDesktopSnapshotRetention(f.profile))!;
    ledger.records[0]!.oldEpoch = "c".repeat(64);
    await writeDesktopSnapshotRetention(f.profile, ledger);
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: first.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    expect(plan.receipt.mode).toBe("last-copy-old-epoch");
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: () => {
          throw new Error("fixture old epoch remains in use");
        },
      }),
    ).rejects.toThrow("in use");
    expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("planned");
    await finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
      assert: (_profile, receipt) => {
        expect(receipt.oldEpoch).not.toBe(receipt.currentEpoch);
        fixtureAuthority(receipt);
      },
    });
  });
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, first.operationId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test("an inode replacement after interrupted deletion stays untouched and pending", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
        remove: async () => {
          throw new Error("invented interruption");
        },
      }),
    ).rejects.toThrow();
    const path = desktopUpdateSnapshotPath(f.profile, old.operationId);
    await rename(path, `${path}-original`);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "unrelated.fixture"), "keep this replacement", { mode: 0o600 });
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
      }),
    ).rejects.toThrow("replaced");
    expect(await readFile(join(path, "unrelated.fixture"), "utf8")).toBe("keep this replacement");
    expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("deleting");
  });
});
test("a pin changed after preview invalidates its pending-deletion publication", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  const plan = await withDesktopInstallLease(f.profile, signal(), () =>
    prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    ),
  );
  await pinRetainedDesktopSnapshot(f.profile, old.operationId, true, signal());
  await expect(
    withDesktopInstallLease(f.profile, signal(), () =>
      stageDesktopSnapshotCleanupLocked(f.profile, plan, signal()),
    ),
  ).rejects.toThrow("changed");
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
});

test("an empty pre-marker draft is removed nonrecursively before another update, while unknown contents stay kept", async () => {
  const f = await fixture(1),
    state = { ...f.states[0]!, operationId: randomUUID(), phase: "resumed" as const, backup: null };
  await withDesktopInstallLease(f.profile, signal(), async () => {
    await writeDesktopUpdateState(f.profile, state);
    const path = desktopSnapshotStagingPath(f.profile, state.operationId);
    await mkdir(path, { mode: 0o700 });
    await expect(
      retainDesktopUpdateBeforeReplacement(f.profile, state, signal()),
    ).resolves.toBeUndefined();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "unrelated.fixture"), "keep unknown contents", { mode: 0o600 });
    await expect(
      retainDesktopUpdateBeforeReplacement(f.profile, state, signal()),
    ).rejects.toMatchObject({ code: "RECOVERY_COPY_INCOMPLETE" });
    await expect(
      prepareDesktopSnapshotCleanupLocked(
        f.profile,
        { snapshotId: state.operationId, currentEpoch: state.oldEpoch, incompleteStaging: true },
        signal(),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(path, "unrelated.fixture"), "utf8")).toBe("keep unknown contents");
  });
});
test("cleaning an owned leftover stage never removes its already registered final recovery copy", async () => {
  const f = await fixture(1),
    current = f.states[0]!;
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const path = desktopSnapshotStagingPath(f.profile, current.operationId);
    await mkdir(path, { mode: 0o700 });
    await writeDesktopSnapshotOwner(f.profile, current.operationId, path);
    await writeFile(join(path, "invented.partial"), "unused sealed partial bytes", { mode: 0o600 });
    await expect(
      retainDesktopUpdateBeforeReplacement(f.profile, current, signal()),
    ).rejects.toThrow("incomplete");
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: current.operationId, currentEpoch: current.oldEpoch, incompleteStaging: true },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    const result = await finishDesktopSnapshotCleanup(
      f.profile,
      plan.receipt.operationId,
      signal(),
      { assert: (_profile, receipt) => fixtureAuthority(receipt) },
    );
    expect(result.bytes).toBeNull();
    await expect(
      access(desktopUpdateSnapshotPath(f.profile, current.operationId)),
    ).resolves.toBeUndefined();
    expect((await readDesktopSnapshotRetention(f.profile))?.records).toHaveLength(1);
  });
});

test("planned cleanup can be cancelled without deleting a copy, while interrupted deletion cannot be unfenced", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  const operationId = await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    return plan.receipt.operationId;
  });
  await expect(
    cancelDesktopSnapshotCleanup(f.profile, operationId, signal(), {
      releaseReservation: async () => {
        throw new Error("fixture native refusal");
      },
    }),
  ).rejects.toThrow("fixture native refusal");
  expect((await readDesktopSnapshotRetention(f.profile))?.pending?.operationId).toBe(operationId);
  await expect(
    cancelDesktopSnapshotCleanup(f.profile, operationId, signal(), {
      releaseReservation: async (profile, id, _signal, action) => {
        expect(action).toBe("cancel");
        expect(id).toBe(operationId);
        expect((await readDesktopSnapshotRetention(profile))?.pending?.operationId).toBe(id);
      },
    }),
  ).resolves.toEqual({
    cancelled: true,
  });
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
  ).resolves.toBeUndefined();
  const started = await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: old.operationId, currentEpoch: current.oldEpoch },
      signal(),
    );
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
    await expect(
      finishDesktopSnapshotCleanup(f.profile, plan.receipt.operationId, signal(), {
        assert: (_profile, receipt) => fixtureAuthority(receipt),
        remove: async () => {
          throw new Error("invented interruption");
        },
      }),
    ).rejects.toThrow();
    return plan.receipt.operationId;
  });
  await expect(cancelDesktopSnapshotCleanup(f.profile, started, signal())).rejects.toMatchObject({
    code: "RECOVERY_CLEANUP_PENDING",
  });
  expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("deleting");
});

test("the native catalog exposes measured metadata and keeps unknown or unavailable copies honest", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  const unknown = join(f.profile.configDir, "backups", `desktop-update-${randomUUID()}`);
  await mkdir(unknown, { mode: 0o700 });
  await writeFile(join(unknown, "unrelated.fixture"), "keep unknown data", { mode: 0o600 });
  const pending = desktopSnapshotStagingPath(f.profile, current.operationId);
  await mkdir(pending, { mode: 0o700 });
  await writeFile(join(pending, "unrelated.fixture"), "keep unverified stage", { mode: 0o600 });
  const catalog = await desktopRecoveryCopiesCatalog(f.profile, signal());
  expect(catalog.unregisteredCopies).toBe(1);
  expect(catalog.items.find((row) => row.id === old.operationId)).toMatchObject({
    oldVersion: "1.2.2",
    registeredAt: expect.any(String),
    canReview: true,
    disposition: "redundant-snapshot",
  });
  expect(catalog.partialCopies).toEqual([
    {
      id: current.operationId,
      purpose: "update",
      staging: true,
      ownership: "unknown",
      canReview: false,
    },
  ]);
  const json = JSON.stringify(catalog);
  for (const privateValue of [
    f.profile.configDir,
    f.profile.secretService,
    "manifestSha256",
    "oldEpoch",
  ])
    expect(json).not.toContain(privateValue);
  await pinRetainedDesktopSnapshot(f.profile, old.operationId, true, signal());
  expect(
    (await desktopRecoveryCopiesCatalog(f.profile, signal())).items.find(
      (row) => row.id === old.operationId,
    ),
  ).toMatchObject({ pinned: true, canReview: false, disposition: "pinned" });
  await rm(desktopUpdateSnapshotPath(f.profile, old.operationId), { recursive: true });
  expect(
    (await desktopRecoveryCopiesCatalog(f.profile, signal())).items.find(
      (row) => row.id === old.operationId,
    ),
  ).toMatchObject({ canReview: false, disposition: "unavailable" });
  expect(await readFile(join(unknown, "unrelated.fixture"), "utf8")).toBe("keep unknown data");
});

test("coordinator catalog and pin commands use the actual owned ledger without starting a runtime", async () => {
  const f = await fixture(),
    old = f.states[0]!;
  await writeFile(
    join(f.profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      mode: "home",
      instance: f.profile.instance,
      secretService: f.profile.secretService,
      embedder: null,
      memoryLimitMb: 512,
      phase: "configured",
    }),
    { mode: 0o600 },
  );
  const coordinator = new DesktopCoordinator(f.profile),
    interactions = new DesktopInteractionBroker(() =>
      Promise.reject(new Error("metadata cannot ask enrollment")),
    );
  try {
    const result = await coordinator.handle(
      { version: 1, id: "catalog", command: "recoveryCopies" },
      { signal: signal(), interactions },
    );
    expect(result).toMatchObject({ kind: "desktopRecoveryCopies", limit: 16 });
    const pinned = await coordinator.handle(
      {
        version: 1,
        id: "pin",
        command: "recoveryCopyPin",
        params: { id: old.operationId, pinned: true },
      },
      { signal: signal(), interactions },
    );
    expect(pinned).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: old.operationId, pinned: true, canReview: false }),
      ]),
    });
    await expect(
      coordinator.handle(
        {
          version: 1,
          id: "invalid",
          command: "recoveryCopyPin",
          params: { id: "../outside", pinned: false },
        },
        { signal: signal(), interactions },
      ),
    ).rejects.toThrow();
    await expect(
      coordinator.handle(
        {
          version: 1,
          id: "no-legacy-cleanup",
          command: "recoveryCopyRemove",
          params: { id: old.operationId, confirmationId: "a".repeat(64) },
        },
        { signal: signal(), interactions },
      ),
    ).rejects.toMatchObject({ code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED" });
    await expect(
      access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
    ).resolves.toBeUndefined();
  } finally {
    interactions.close();
    await coordinator.close();
  }
});
test("an unconfigured catalog stays empty and never adopts or creates a library", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-retention-empty-")));
  homes.push(home);
  const profile = desktopProfile(home);
  expect(await handleDesktopRetention(profile, "recoveryCopies", {}, signal())).toMatchObject({
    kind: "desktopRecoveryCopies",
    items: [],
  });
  await expect(access(profile.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(`${profile.configDir}.bootstrap`)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    handleDesktopRetention(
      profile,
      "recoveryCopyPin",
      { id: randomUUID(), pinned: true },
      signal(),
    ),
  ).rejects.toThrow("unavailable");
});

test("cleanup preview binds actual verified copies and a source caller cannot turn confirmation into deletion authority", async () => {
  const f = await fixture(),
    old = f.states[0]!,
    current = f.states[1]!;
  await writeFile(
    join(`${f.profile.configDir}.bootstrap`, "process-authority.json"),
    JSON.stringify({
      version: 3,
      owner: "omnesis-desktop",
      instance: f.profile.instance,
      secretService: f.profile.secretService,
    }),
    { mode: 0o600 },
  );
  const preview = await handleDesktopRecoveryCleanup(
    f.profile,
    "recoveryCopyPreview",
    { id: old.operationId },
    signal(),
    {
      ready: async () => {},
      epoch: () => current.oldEpoch,
    },
  );
  expect(preview).toMatchObject({
    kind: "desktopRecoveryCleanup",
    phase: "preview",
    id: old.operationId,
    mode: "redundant-snapshot",
  });
  expect(JSON.stringify(preview)).not.toContain(f.profile.configDir);
  expect(JSON.stringify(preview)).not.toContain(current.oldEpoch);
  if (!("phase" in preview) || preview.phase !== "preview") throw new Error("Missing preview");
  expect(preview.bytes).toBeGreaterThanOrEqual(0);
  expect(preview.selected).toMatchObject({
    id: old.operationId,
    purpose: "update",
    oldVersion: old.oldVersion,
    order: 1,
  });
  expect(preview.keeper).toMatchObject({
    id: current.operationId,
    purpose: "update",
    oldVersion: current.oldVersion,
    order: 2,
  });
  expect(preview.confirmationId).toMatch(/^[a-f0-9]{64}$/u);
  await expect(
    handleDesktopRecoveryCleanup(
      f.profile,
      "recoveryCopyRemove",
      {
        id: old.operationId,
        confirmationId: preview.confirmationId,
      },
      signal(),
    ),
  ).rejects.toThrow();
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, old.operationId)),
  ).resolves.toBeUndefined();
  await expect(
    handleDesktopRecoveryCleanup(
      f.profile,
      "recoveryCopyRemove",
      {
        id: old.operationId,
        confirmationId: preview.confirmationId,
        path: "/fixture/not-accepted",
      },
      signal(),
    ),
  ).rejects.toThrow();
});
