// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureDesktopSnapshotWitness } from "./snapshot-retention-witness.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import {
  assertDesktopSnapshotRetentionCapacity,
  listRetainedDesktopSnapshots,
  pinRetainedDesktopSnapshot,
  registerVerifiedDesktopSnapshot,
} from "./snapshot-retention.js";
import {
  desktopSnapshotRetentionPath,
  MAX_RETAINED_DESKTOP_SNAPSHOTS,
  parseDesktopSnapshotRetention,
  readDesktopSnapshotRetention,
  writeDesktopSnapshotRetention,
} from "./snapshot-retention-record.js";
import type { DesktopUpdateState } from "./update-state.js";

const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-retention-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "invented.data"), "sealed fixture payload", {
    mode: 0o600,
  });
  const root = (await desktopRootIdentity(profile))!;
  await withDesktopInstallLease(profile, signal(), async () => {});
  const leases = await acquireDesktopRuntimeLeases(profile, {
    expectedRoot: root,
    signal: signal(),
  });
  const operationId = randomUUID();
  let backup;
  try {
    backup = await createDesktopUpdateSnapshot(profile, { leases, operationId, signal: signal() });
  } finally {
    leases.release();
  }
  const state: DesktopUpdateState = {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId,
    phase: "complete",
    mode: "home",
    oldEpoch: "a".repeat(64),
    candidateEpoch: "b".repeat(64),
    oldVersion: "1.2.2",
    candidateVersion: "1.2.3",
    artifactSha256: "c".repeat(64),
    root,
    backup,
  };
  const register = () =>
    withDesktopInstallLease(profile, signal(), () =>
      registerVerifiedDesktopSnapshot(profile, state, signal()),
    );
  return { home, profile, state, register };
}
test("registers a fully verified snapshot once and preserves an explicit pin across retries", async () => {
  const f = await fixture();
  await f.register();
  expect(await listRetainedDesktopSnapshots(f.profile)).toEqual([
    {
      id: f.state.operationId,
      purpose: "update",
      oldVersion: f.state.oldVersion,
      registeredAt: expect.any(String),
      bytes: f.state.backup!.bytes,
      pinned: false,
      order: 1,
    },
  ]);
  await pinRetainedDesktopSnapshot(f.profile, f.state.operationId, true, signal());
  await f.register();
  expect((await readDesktopSnapshotRetention(f.profile))?.records).toHaveLength(1);
  expect((await listRetainedDesktopSnapshots(f.profile))[0]?.pinned).toBe(true);
  await pinRetainedDesktopSnapshot(f.profile, f.state.operationId, false, signal());
  expect((await listRetainedDesktopSnapshots(f.profile))[0]?.pinned).toBe(false);
});
test("unverified, partial, corrupt and inode-replaced snapshots never become registered ownership", async () => {
  const f = await fixture();
  const path = desktopUpdateSnapshotPath(f.profile, f.state.operationId);
  await expect(
    registerVerifiedDesktopSnapshot(
      f.profile,
      { ...f.state, phase: "candidate-started" },
      signal(),
    ),
  ).rejects.toThrow("completed");
  await f.register();
  await rename(path, `${path}-previous`);
  await mkdir(path, { mode: 0o700 });
  await expect(f.register()).rejects.toThrow("changed identity");
  await rm(path, { recursive: true });
  await rename(`${path}-previous`, path);
  const manifest = await readFile(join(path, "snapshot.json"));
  await writeFile(join(path, "snapshot.json"), "invalid manifest");
  await expect(f.register()).rejects.toThrow();
  await writeFile(join(path, "snapshot.json"), manifest);
  await expect(f.register()).resolves.toBeUndefined();
});
test("sixteen tracked copies refuse the next update without evicting pinned or unknown backups", async () => {
  const f = await fixture();
  await f.register();
  await mkdir(join(f.profile.configDir, "backups", "personal-backup"), { mode: 0o700 });
  const ledger = (await readDesktopSnapshotRetention(f.profile))!;
  const first = ledger.records[0]!;
  ledger.records = Array.from({ length: MAX_RETAINED_DESKTOP_SNAPSHOTS }, (_, index) => ({
    ...first,
    operationId: index ? randomUUID() : first.operationId,
    order: index + 1,
    pinned: true,
  }));
  ledger.sequence = MAX_RETAINED_DESKTOP_SNAPSHOTS;
  await withDesktopInstallLease(f.profile, signal(), () =>
    writeDesktopSnapshotRetention(f.profile, ledger),
  );
  await expect(assertDesktopSnapshotRetentionCapacity(f.profile)).rejects.toThrow(
    "personal backup",
  );
  expect(
    await readFile(
      join(desktopUpdateSnapshotPath(f.profile, f.state.operationId), "snapshot.json"),
      "utf8",
    ),
  ).toContain(f.state.operationId);
  expect(await listRetainedDesktopSnapshots(f.profile)).toHaveLength(16);
});
test("pending deletion prevents pin and journal changes; a malformed or foreign ledger cannot authorize cleanup", async () => {
  const f = await fixture();
  await f.register();
  const ledger = (await readDesktopSnapshotRetention(f.profile))!;
  ledger.pending = {
    operationId: randomUUID(),
    snapshotId: f.state.operationId,
    journals: { updateId: randomUUID(), restoreId: null },
    oldEpoch: f.state.oldEpoch,
    mode: "last-copy-old-epoch",
    target: await captureDesktopSnapshotWitness(
      f.profile,
      f.state.operationId,
      false,
      "manifest",
      signal(),
    ),
    keeper: null,
    currentEpoch: f.state.candidateEpoch,
    phase: "planned",
  };
  await withDesktopInstallLease(f.profile, signal(), () =>
    writeDesktopSnapshotRetention(f.profile, ledger),
  );
  await expect(
    pinRetainedDesktopSnapshot(f.profile, f.state.operationId, true, signal()),
  ).rejects.toThrow("pending");
  await expect(f.register()).rejects.toThrow("pending");
  expect(() =>
    parseDesktopSnapshotRetention({ ...ledger, records: [...ledger.records, ...ledger.records] }),
  ).toThrow();
  expect(() => parseDesktopSnapshotRetention({ ...ledger, unknown: "untrusted" })).toThrow();
  await writeFile(
    desktopSnapshotRetentionPath(f.profile),
    JSON.stringify({ ...ledger, instance: "desktop-" + "f".repeat(16) }),
    { mode: 0o600 },
  );
  await expect(readDesktopSnapshotRetention(f.profile)).rejects.toThrow("another installation");
});
test("record aliases, shared files, permissive modes and stale root identity are refused", async () => {
  const f = await fixture();
  await f.register();
  const path = desktopSnapshotRetentionPath(f.profile),
    body = await readFile(path);
  await rename(path, `${path}.saved`);
  await symlink(`${path}.saved`, path);
  await expect(readDesktopSnapshotRetention(f.profile)).rejects.toThrow();
  await rm(path);
  await link(`${path}.saved`, path);
  await expect(readDesktopSnapshotRetention(f.profile)).rejects.toThrow();
  await rm(path);
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o644);
  await expect(readDesktopSnapshotRetention(f.profile)).rejects.toThrow();
  await chmod(path, 0o600);
  await rename(f.profile.configDir, `${f.profile.configDir}.old`);
  await mkdir(f.profile.configDir, { mode: 0o700 });
  await expect(listRetainedDesktopSnapshots(f.profile)).rejects.toThrow("earlier library");
});
test("cancellation before registration publication leaves no ownership or pin change", async () => {
  const f = await fixture();
  const cancelled = AbortSignal.abort();
  await expect(registerVerifiedDesktopSnapshot(f.profile, f.state, cancelled)).rejects.toThrow();
  expect(await readDesktopSnapshotRetention(f.profile)).toBeNull();
  await f.register();
  await expect(
    pinRetainedDesktopSnapshot(f.profile, f.state.operationId, true, cancelled),
  ).rejects.toThrow();
  expect((await listRetainedDesktopSnapshots(f.profile))[0]?.pinned).toBe(false);
});
