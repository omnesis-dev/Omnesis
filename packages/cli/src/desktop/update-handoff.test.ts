// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGatewayLock } from "@omnesis/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { desktopEpochMayStart } from "./update-admission.js";
import { desktopUpdateConfirmation, handoffDesktopUpdate } from "./update-handoff.js";
import { desktopUpdateSnapshotPath } from "./update-snapshot.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-handoff-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "omnesis.db"), "invented sealed store bytes", {
    mode: 0o600,
  });
  const state: DesktopUpdateState = {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "verified",
    mode: "home",
    oldEpoch: "a".repeat(64),
    candidateEpoch: "b".repeat(64),
    oldVersion: "1.2.2",
    candidateVersion: "1.2.3",
    artifactSha256: "c".repeat(64),
    root: (await desktopRootIdentity(profile))!,
    backup: null,
  };
  await withDesktopInstallLease(profile, new AbortController().signal, () =>
    writeDesktopUpdateState(profile, state),
  );
  const controller = new AbortController();
  return {
    profile,
    state,
    controller,
    options: {
      confirmationId: desktopUpdateConfirmation(state),
      currentEpoch: state.oldEpoch,
      signal: controller.signal,
    },
  };
}

describe.skipIf(process.platform === "win32")("desktop update handoff", () => {
  test("a missing daemon listener still requires every real owner lease and a verified snapshot", async () => {
    const f = await fixture();
    const openInstaller = vi.fn(async (state: DesktopUpdateState) => {
      expect(state.phase).toBe("backed-up");
      expect(
        await readFile(
          join(desktopUpdateSnapshotPath(f.profile, state.operationId), "files/omnesis.db"),
          "utf8",
        ),
      ).toBe("invented sealed store bytes");
      await expect(
        acquireDesktopRuntimeLeases(f.profile, {
          expectedRoot: state.root,
          signal: f.options.signal,
        }),
      ).rejects.toThrow();
    });
    const result = await handoffDesktopUpdate(f.profile, f.options, {
      stop: async () => false,
      openInstaller,
    });
    expect(result.phase).toBe("installer-opened");
    expect(openInstaller).toHaveBeenCalledOnce();
    expect(await desktopEpochMayStart(f.profile, f.state.oldEpoch)).toBe(false);
    expect(await desktopEpochMayStart(f.profile, f.state.candidateEpoch)).toBe(true);
  });
  test("an independently running gateway refuses handoff and leaves both epochs fenced", async () => {
    const f = await fixture();
    const gateway = await acquireGatewayLock(f.profile.configDir);
    const openInstaller = vi.fn();
    try {
      await expect(
        handoffDesktopUpdate(f.profile, f.options, { stop: async () => false, openInstaller }),
      ).rejects.toThrow();
      expect(openInstaller).not.toHaveBeenCalled();
      expect((await readDesktopUpdateState(f.profile))?.phase).toBe("recovery-required");
      for (const epoch of [f.state.oldEpoch, f.state.candidateEpoch])
        expect(await desktopEpochMayStart(f.profile, epoch)).toBe(false);
    } finally {
      gateway.release();
    }
  });
  test("native failure preserves recovery bytes and never silently restarts old code", async () => {
    const f = await fixture();
    await expect(
      handoffDesktopUpdate(f.profile, f.options, {
        stop: async () => false,
        openInstaller: async () => {
          throw new Error("fixture native refusal");
        },
      }),
    ).rejects.toThrow("fixture native refusal");
    const state = await readDesktopUpdateState(f.profile);
    expect(state).toMatchObject({
      phase: "recovery-required",
      backup: { bytes: expect.any(Number) },
    });
    expect(await readFile(join(f.profile.configDir, "omnesis.db"), "utf8")).toBe(
      "invented sealed store bytes",
    );
    const leases = await acquireDesktopRuntimeLeases(f.profile, {
      expectedRoot: f.state.root,
      signal: f.options.signal,
    });
    leases.release();
  });
  test("stale confirmation refuses before stop or any installation mutation", async () => {
    const f = await fixture();
    const stop = vi.fn(async () => true);
    await writeDesktopUpdateState(f.profile, { ...f.state, artifactSha256: "d".repeat(64) });
    await expect(
      handoffDesktopUpdate(f.profile, f.options, { stop, openInstaller: vi.fn() }),
    ).rejects.toThrow("changed");
    expect(stop).not.toHaveBeenCalled();
    expect((await readDesktopUpdateState(f.profile))?.phase).toBe("verified");
  });
});
