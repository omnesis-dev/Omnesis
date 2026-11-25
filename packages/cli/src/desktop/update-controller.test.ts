// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopUpdateController } from "./update-controller.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { DesktopInteractionBroker } from "./protocol.js";
import { claimDesktopUpdateEpoch } from "./update-claim.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { readDesktopUpdateState, writeDesktopUpdateState } from "./update-state.js";
import {
  finishDesktopUpdateSnapshot,
  finishDesktopUpdateRollback,
} from "./update-data-operation.js";
import type { DesktopUpdateMetadata } from "./update-plan.js";
import type { DesktopUpdateRelease } from "./update-release.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
function metadata(productVersion: string): DesktopUpdateMetadata {
  return {
    format: 1,
    bundleIdentifier: "dev.omnesis.desktop",
    productVersion,
    architecture: "arm64",
    compat: {
      productVersion,
      stores: {
        mainDb: { policy: "numbered-migrations", version: 4 },
        config: { policy: "in-place", version: 2 },
      },
      protocols: { ws: 3 },
    },
  };
}
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-controller-")));
  homes.push(home);
  const profile = desktopProfile(home),
    signal = new AbortController().signal;
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      mode: "home",
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: null,
      memoryLimitMb: 512,
      phase: "configured",
    }),
    { mode: 0o600 },
  );
  await writeFile(join(profile.configDir, "library.data"), "invented sealed data", { mode: 0o600 });
  await writeFile(join(profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
  const oldEpoch = "a".repeat(64),
    candidateEpoch = "b".repeat(64);
  await withDesktopInstallLease(profile, signal, () =>
    writeDesktopActiveRuntime(profile, oldEpoch, "1.2.2"),
  );
  let epoch = oldEpoch,
    current = metadata("1.2.2");
  const release = {
    version: "1.2.3",
    architecture: "arm64" as const,
    bytes: 1024,
    sha256: "c".repeat(64),
    url: "https://github.com/omnesis-dev/Omnesis/releases/download/v1.2.3/Omnesis-1.2.3-macos-arm64.dmg",
  };
  const receipt = {
    verified: true,
    receiptId: randomUUID(),
    metadata: metadata("1.2.3"),
    candidateEpoch,
    payloadBytes: 2048,
    applicationBytes: 3072,
    oldApplicationBytes: 4096,
  };
  const interactions: string[] = [];
  let rejectStage = false;
  const broker = new DesktopInteractionBroker(async ({ interaction }) => {
    interactions.push(interaction.kind);
    const value =
      interaction.kind === "desktopUpdateProgress"
        ? "continue"
        : interaction.kind === "verifyDesktopInstaller"
          ? receipt
          : interaction.kind === "verifyCurrentDesktopApplication"
            ? { ...receipt, oldEpoch, previousMetadata: metadata("1.2.2") }
            : interaction.kind.startsWith("stage")
              ? { ready: true }
              : { opened: true };
    if (rejectStage && interaction.kind.startsWith("stage")) broker.cancel(interaction.id);
    else broker.respond(interaction.id, value);
  });
  const operations = {
    dataOperation: (
      profile: ReturnType<typeof desktopProfile>,
      id: string,
      purpose: "update-snapshot" | "update-rollback",
      signal: AbortSignal,
    ) =>
      (purpose === "update-snapshot" ? finishDesktopUpdateSnapshot : finishDesktopUpdateRollback)(
        profile,
        id,
        signal,
        { authorize: () => {}, stop: async () => false },
      ),
    metadata: async () => current,
    epoch: () => epoch,
    discover: vi.fn(async () => release),
    observe: vi.fn(async () => ({
      mode: "home" as const,
      observed: { mainDbVersion: 4, configVersion: 2 },
      backupBytes: 1024,
      freeBytes: 1024 ** 3,
    })),
    download: vi.fn(
      async (
        _release: DesktopUpdateRelease,
        directory: string,
        _signal: AbortSignal,
        deps?: { progress?(bytes: number, total: number): void | Promise<void> },
      ) => {
        await deps?.progress?.(1024, 1024);
        const path = join(directory, `${release.sha256}.dmg`);
        await writeFile(path, "invented installer", { mode: 0o600 });
        return path;
      },
    ),
    closeTransport: vi.fn(async () => {}),
    startCurrent: vi.fn(async () => {}),
    ready: vi.fn(async () => ({ phase: "ready", encrypted: true })),
  };
  const controller = new DesktopUpdateController(profile, operations);
  return {
    profile,
    controller,
    operations,
    interactions,
    receipt,
    broker,
    context: { signal, interactions: broker },
    oldEpoch,
    candidateEpoch,
    setCurrent: () => {
      epoch = candidateEpoch;
      current = metadata("1.2.3");
    },
    rejectStage: () => {
      rejectStage = true;
    },
  };
}

test("official discovery and download prepare only after native verification/staging and preserve the running epoch", async () => {
  const f = await fixture();
  const available = await f.controller.handle("updateCheck", {}, f.context);
  expect(available.phase).toBe("available");
  const verified = await f.controller.handle(
    "updateDownload",
    { confirmationId: available.confirmationId },
    f.context,
  );
  expect(verified.phase).toBe("verified");
  expect(f.interactions).toEqual([
    "desktopUpdateProgress",
    "verifyDesktopInstaller",
    "stageDesktopInstaller",
  ]);
  expect(await readDesktopUpdateState(f.profile)).toMatchObject({
    oldEpoch: f.oldEpoch,
    candidateEpoch: f.candidateEpoch,
    backup: null,
  });
  expect(f.operations.startCurrent).not.toHaveBeenCalled();
});
test("a declined native staging interaction never publishes an update intent", async () => {
  const f = await fixture();
  f.rejectStage();
  const available = await f.controller.handle("updateCheck", {}, f.context);
  await expect(
    f.controller.handle("updateDownload", { confirmationId: available.confirmationId }, f.context),
  ).rejects.toThrow();
  expect(await readDesktopUpdateState(f.profile)).toBeNull();
  expect(f.operations.startCurrent).not.toHaveBeenCalled();
});
test("manual current-application preparation is explicitly bound to native old/new epochs", async () => {
  const f = await fixture();
  f.setCurrent();
  const prepared = await f.controller.handle("updatePrepareCurrent", {}, f.context);
  expect(prepared.phase).toBe("verified");
  expect(await readDesktopUpdateState(f.profile)).toMatchObject({
    source: "current-application",
    oldEpoch: f.oldEpoch,
    candidateEpoch: f.candidateEpoch,
  });
  expect(f.operations.discover).not.toHaveBeenCalled();
  expect(f.operations.download).not.toHaveBeenCalled();
  expect(f.interactions).toEqual([
    "verifyCurrentDesktopApplication",
    "stageCurrentDesktopApplication",
  ]);
});
test("stale release confirmations and completing before candidate admission cannot mutate lifecycle", async () => {
  const f = await fixture();
  await expect(
    f.controller.handle("updateDownload", { confirmationId: "f".repeat(64) }, f.context),
  ).rejects.toThrow("Review");
  expect(f.operations.download).not.toHaveBeenCalled();
  const available = await f.controller.handle("updateCheck", {}, f.context);
  const prepared = await f.controller.handle(
    "updateDownload",
    { confirmationId: available.confirmationId },
    f.context,
  );
  await expect(
    f.controller.handle("updateFinish", { confirmationId: prepared.confirmationId }, f.context),
  ).rejects.toThrow("claimed");
  expect((await readDesktopUpdateState(f.profile))?.phase).toBe("verified");
});
test("new discovery after a completed operation still offers the next release", async () => {
  const f = await fixture();
  const available = await f.controller.handle("updateCheck", {}, f.context);
  await f.controller.handle(
    "updateDownload",
    { confirmationId: available.confirmationId },
    f.context,
  );
  const state = (await readDesktopUpdateState(f.profile))!;
  await withDesktopInstallLease(f.profile, f.context.signal, async () => {
    await writeDesktopUpdateState(f.profile, {
      ...state,
      phase: "complete",
      backup: { manifestSha256: "d".repeat(64), bytes: 1 },
    });
    await writeDesktopActiveRuntime(f.profile, f.candidateEpoch, "1.2.3");
  });
  f.setCurrent();
  const priorRelease = await f.operations.discover();
  f.operations.discover.mockResolvedValue({ ...priorRelease, version: "1.2.4" });
  expect((await f.controller.handle("updateCheck", {}, f.context)).phase).toBe("available");
});

test("completion requires actual candidate claim, fresh protection/readiness and intact recovery bytes", async () => {
  const f = await fixture();
  const available = await f.controller.handle("updateCheck", {}, f.context);
  const prepared = await f.controller.handle(
    "updateDownload",
    { confirmationId: available.confirmationId },
    f.context,
  );
  const installed = await f.controller.handle(
    "updateInstall",
    { confirmationId: prepared.confirmationId },
    f.context,
  );
  expect(installed.phase).toBe("installer-opened");
  expect(f.operations.closeTransport).toHaveBeenCalledOnce();
  expect(await claimDesktopUpdateEpoch(f.profile, f.context.signal, f.candidateEpoch)).toBe(true);
  f.setCurrent();
  const status = await f.controller.handle("updateStatus", {}, f.context);
  expect(status.phase).toBe("candidate-started");
  const completed = await f.controller.handle(
    "updateFinish",
    { confirmationId: status.confirmationId },
    f.context,
  );
  expect(completed.phase).toBe("complete");
  expect(f.operations.ready).toHaveBeenCalledOnce();
  expect(f.operations.observe).toHaveBeenCalledTimes(2);
});
