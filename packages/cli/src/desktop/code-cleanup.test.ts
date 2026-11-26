// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { writeDesktopUpdateState } from "./update-state.js";
import { writeDesktopRestoreIntent } from "./restore-intent.js";
import { DesktopCodeCleanup } from "./code-cleanup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "omnesis-code-retention-"));
  roots.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  const cache = join(
    dirname(profile.configDir),
    ["Omnesis", "Desktop", "Runtime"].join(" "),
    "runtime",
  );
  const applications = join(dirname(cache), "applications");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await mkdir(applications, { mode: 0o700 });
  async function epoch(tag: string) {
    const bytes = Buffer.from(
      JSON.stringify({
        format: 1,
        codeUsageProtocol: 1,
        processAuthorityProtocol: 3,
        runtimeLauncher: "runtime-exec",
        tag,
      }),
    );
    const epoch = createHash("sha256").update(bytes).digest("hex");
    const runtime = join(cache, epoch),
      archive = join(applications, epoch),
      app = join(archive, "Omnesis.app");
    await mkdir(runtime, { mode: 0o700 });
    await writeFile(join(runtime, "desktop-runtime.json"), bytes);
    await mkdir(app, { recursive: true, mode: 0o700 });
    const directory = await lstat(archive),
      application = await lstat(app);
    await writeFile(
      join(archive, ".desktop-archive.json"),
      JSON.stringify({
        format: 1,
        owner: "omnesis-desktop-application-archive",
        epoch,
        identity: {
          device: directory.dev,
          inode: directory.ino,
          appDevice: application.dev,
          appInode: application.ino,
        },
      }),
      { mode: 0o600 },
    );
    return epoch;
  }
  const current = await epoch("current"),
    previous = await epoch("previous"),
    older = await epoch("older");
  const root = (await desktopRootIdentity(profile))!;
  await writeDesktopActiveRuntime(profile, current, "1.2.3");
  await writeDesktopUpdateState(profile, {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "complete",
    mode: "home",
    oldEpoch: previous,
    candidateEpoch: current,
    oldVersion: "1.2.2",
    candidateVersion: "1.2.3",
    artifactSha256: "a".repeat(64),
    root,
    backup: { manifestSha256: "b".repeat(64), bytes: 1024 },
  });
  const remove = vi.fn(async () => true),
    verifySnapshot = vi.fn(async () => {});
  const dependencies = {
    epoch: () => current,
    ready: async () => ({ phase: "ready", encrypted: true }),
    remove,
    verifySnapshot,
  };
  return { profile, cache, applications, current, previous, older, root, dependencies };
}
const signal = () => new AbortController().signal;

test("explicit cleanup retains current and one previous verified app while reporting kernel vetoes", async () => {
  const f = await fixture();
  const cleanup = new DesktopCodeCleanup(f.profile, f.dependencies);
  const preview = await cleanup.handle("updateCleanupPreview", {}, signal());
  expect(preview.codeCleanup).toMatchObject({ removedEpochs: 0, retainedEpochs: 3 });
  expect(preview.codeCleanup!.reclaimableBytes).toBeGreaterThan(0);
  expect(f.dependencies.remove).not.toHaveBeenCalled();
  f.dependencies.remove.mockResolvedValueOnce(false);
  const result = await cleanup.handle(
    "updateCleanup",
    { confirmationId: preview.codeCleanup!.confirmationId },
    signal(),
  );
  expect(result.codeCleanup).toMatchObject({ removedEpochs: 0, retainedEpochs: 3 });
  expect(f.dependencies.remove).toHaveBeenCalledWith(
    f.profile,
    f.cache,
    f.current,
    f.older,
    expect.any(AbortSignal),
  );
  expect(f.dependencies.verifySnapshot).toHaveBeenCalledTimes(2);
});

test("changed plans and unverified retained app ownership never authorize removal", async () => {
  const f = await fixture();
  const cleanup = new DesktopCodeCleanup(f.profile, f.dependencies);
  const preview = await cleanup.handle("updateCleanupPreview", {}, signal());
  await writeFile(join(f.cache, f.older, "new-code-file"), "invented code change");
  await expect(
    cleanup.handle(
      "updateCleanup",
      { confirmationId: preview.codeCleanup!.confirmationId },
      signal(),
    ),
  ).rejects.toThrow("changed");
  expect(f.dependencies.remove).not.toHaveBeenCalled();
  await rm(join(f.applications, f.older, ".desktop-archive.json"));
  const unknown = await cleanup.handle("updateCleanupPreview", {}, signal());
  expect(unknown.codeCleanup!.reclaimableBytes).toBe(0);
});

test("an interrupted restore blocks code cleanup even when the current update was verified", async () => {
  const f = await fixture();
  await writeDesktopRestoreIntent(f.profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: f.profile.instance,
    secretService: f.profile.secretService,
    operationId: randomUUID(),
    phase: "stopping",
    root: f.root,
    targetKeyDigest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 512,
    backup: null,
  });
  const cleanup = new DesktopCodeCleanup(f.profile, f.dependencies);
  await expect(cleanup.handle("updateCleanupPreview", {}, signal())).rejects.toThrow(
    "backup recovery",
  );
  expect(f.dependencies.remove).not.toHaveBeenCalled();
});

test("interrupted native cleanup remains actionable after deleting manifests or the whole code tree", async () => {
  const f = await fixture();
  const runtime = join(f.cache, f.older),
    archive = join(f.applications, f.older);
  const info = await lstat(runtime);
  const ownership = JSON.parse(await readFile(join(archive, ".desktop-archive.json"), "utf8"));
  await writeFile(
    join(f.cache, `.cleanup-${f.older}.json`),
    JSON.stringify({
      format: 2,
      owner: "omnesis-desktop-runtime-cleanup",
      epoch: f.older,
      device: info.dev,
      inode: info.ino,
      archive: ownership.identity,
    }),
    { mode: 0o600 },
  );
  await rm(join(runtime, "desktop-runtime.json"));
  await writeFile(join(runtime, "remaining-code"), "invented leftover code");
  await rm(join(archive, ".desktop-archive.json"));
  const cleanup = new DesktopCodeCleanup(f.profile, f.dependencies);
  let preview = await cleanup.handle("updateCleanupPreview", {}, signal());
  expect(preview.codeCleanup!.reclaimableBytes).toBeGreaterThan(0);
  await rm(runtime, { recursive: true, force: true });
  await rm(archive, { recursive: true, force: true });
  preview = await cleanup.handle("updateCleanupPreview", {}, signal());
  const result = await cleanup.handle(
    "updateCleanup",
    { confirmationId: preview.codeCleanup!.confirmationId },
    signal(),
  );
  expect(result.codeCleanup!.removedEpochs).toBe(1);
  expect(f.dependencies.remove).toHaveBeenCalledWith(
    f.profile,
    f.cache,
    f.current,
    f.older,
    expect.any(AbortSignal),
  );
});
