// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { readDesktopActiveRuntime, writeDesktopActiveRuntime } from "./update-active.js";
import { desktopUpdateConfirmation } from "./update-handoff.js";
import { finishDesktopUpdateRollback } from "./update-data-operation.js";
import { recoverDesktopUpdate } from "./update-recovery.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";

const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-recovery-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "library.data"), "invented old sealed data", {
    mode: 0o600,
  });
  const root = (await desktopRootIdentity(profile))!;
  const operationId = randomUUID();
  let state!: DesktopUpdateState;
  await withDesktopInstallLease(profile, signal(), async () => {
    const leases = await acquireDesktopRuntimeLeases(profile, {
      expectedRoot: root,
      signal: signal(),
    });
    try {
      state = {
        format: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId,
        phase: "candidate-started",
        mode: "home",
        oldEpoch: "a".repeat(64),
        candidateEpoch: "b".repeat(64),
        oldVersion: "1.2.2",
        candidateVersion: "1.2.3",
        artifactSha256: "c".repeat(64),
        root,
        backup: await createDesktopUpdateSnapshot(profile, {
          operationId,
          leases,
          signal: signal(),
        }),
      };
      await writeDesktopUpdateState(profile, state);
      await writeDesktopActiveRuntime(profile, state.candidateEpoch, state.candidateVersion);
    } finally {
      leases.release();
    }
  });
  await writeFile(join(profile.configDir, "library.data"), "invented newer format data");
  await writeFile(join(profile.configDir, "candidate-only.data"), "invented candidate data");
  return {
    profile,
    state,
    executeRollback: (
      profile: ReturnType<typeof desktopProfile>,
      id: string,
      signal: AbortSignal,
    ) =>
      finishDesktopUpdateRollback(profile, id, signal, {
        authorize: () => {},
        stop: async () => false,
      }),
    options: { confirmationId: desktopUpdateConfirmation(state), signal: signal() },
  };
}
describe.skipIf(process.platform === "win32")("desktop update recovery", () => {
  test("only verified recovery data is restored before selecting and opening the old complete application", async () => {
    const f = await fixture();
    const verifyPrevious = vi.fn(async () => {});
    const openPrevious = vi.fn(async () => {
      expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
        "invented old sealed data",
      );
      await expect(access(join(f.profile.configDir, "candidate-only.data"))).rejects.toThrow();
      expect(await readDesktopActiveRuntime(f.profile)).toMatchObject({ epoch: f.state.oldEpoch });
    });
    expect(
      (
        await recoverDesktopUpdate(f.profile, f.options, {
          stop: async () => false,
          executeRollback: f.executeRollback,
          verifyPrevious,
          openPrevious,
        })
      ).phase,
    ).toBe("resumed");
    expect(verifyPrevious).toHaveBeenCalledOnce();
    expect(openPrevious).toHaveBeenCalledOnce();
  });
  test("explicitly reviewed completed update can restore its retained verified recovery snapshot", async () => {
    const f = await fixture();
    const state = { ...f.state, phase: "complete" as const };
    await withDesktopInstallLease(f.profile, signal(), () =>
      writeDesktopUpdateState(f.profile, state),
    );
    const result = await recoverDesktopUpdate(
      f.profile,
      { ...f.options, confirmationId: desktopUpdateConfirmation(state) },
      {
        stop: async () => false,
        executeRollback: f.executeRollback,
        verifyPrevious: async () => {},
        openPrevious: async () => {},
      },
    );
    expect(result.phase).toBe("resumed");
    expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
      "invented old sealed data",
    );
  });
  test("retrying failed presentation launch never re-restores over newly collected data", async () => {
    const f = await fixture();
    const operations = {
      stop: async () => false,
      executeRollback: f.executeRollback,
      verifyPrevious: async () => {},
      openPrevious: async () => {
        throw new Error("fixture launch failure");
      },
    };
    await expect(recoverDesktopUpdate(f.profile, f.options, operations)).rejects.toThrow(
      "fixture launch failure",
    );
    const resumed = (await readDesktopUpdateState(f.profile))!;
    expect(resumed.phase).toBe("resumed");
    await writeFile(
      join(f.profile.configDir, "library.data"),
      "invented fresh old-version collection",
    );
    await recoverDesktopUpdate(
      f.profile,
      { ...f.options, confirmationId: desktopUpdateConfirmation(resumed) },
      { ...operations, openPrevious: async () => {} },
    );
    expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
      "invented fresh old-version collection",
    );
  });
  test("unavailable or untrusted previous presentation refuses before any store mutation", async () => {
    const f = await fixture();
    const stop = vi.fn(async () => false);
    await expect(
      recoverDesktopUpdate(f.profile, f.options, {
        stop,
        verifyPrevious: async () => {
          throw new Error("fixture unavailable");
        },
        openPrevious: vi.fn(),
      }),
    ).rejects.toThrow("fixture unavailable");
    expect(stop).not.toHaveBeenCalled();
    expect((await readDesktopUpdateState(f.profile))?.phase).toBe("candidate-started");
    expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
      "invented newer format data",
    );
  });
  test("corrupted recovery bytes refuse before drain and retain candidate data untouched", async () => {
    const f = await fixture();
    await writeFile(
      join(desktopUpdateSnapshotPath(f.profile, f.state.operationId), "files/library.data"),
      "corrupted",
    );
    const stop = vi.fn(async () => false);
    await expect(
      recoverDesktopUpdate(f.profile, f.options, {
        stop,
        verifyPrevious: async () => {},
        openPrevious: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
    expect(await readFile(join(f.profile.configDir, "library.data"), "utf8")).toBe(
      "invented newer format data",
    );
  });
});
