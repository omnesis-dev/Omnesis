// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveSubprocessEntry, spawnOwnedChildProcess } from "@omnesis/core";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopEnvironment, desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { writeDesktopUpdateState, type DesktopUpdateState } from "./update-state.js";
import { registerVerifiedDesktopSnapshot } from "./snapshot-retention.js";
import {
  prepareDesktopSnapshotCleanupLocked,
  stageDesktopSnapshotCleanupLocked,
} from "./snapshot-retention-prepare.js";
import { desktopSnapshotCleanupBinding } from "./snapshot-retention-request.js";
import { runDesktopSnapshotGcPhaseOne } from "./snapshot-retention-phase-one.js";
import { readDesktopSnapshotRetention } from "./snapshot-retention-record.js";
const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-gc-phase-one-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await withDesktopInstallLease(profile, signal(), async () => {});
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
  const root = (await desktopRootIdentity(profile))!,
    states: DesktopUpdateState[] = [];
  for (let index = 0; index < 2; index++) {
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
      await writeDesktopUpdateState(profile, state);
      await writeDesktopActiveRuntime(profile, state.oldEpoch, state.oldVersion);
      await registerVerifiedDesktopSnapshot(profile, state, signal());
    });
    states.push(state);
  }
  const selected = states[0]!,
    epoch = states[1]!.oldEpoch;
  const plan = await withDesktopInstallLease(profile, signal(), () =>
    prepareDesktopSnapshotCleanupLocked(
      profile,
      { snapshotId: selected.operationId, currentEpoch: epoch },
      signal(),
    ),
  );
  const request = {
    version: 1 as const,
    profile,
    snapshotId: selected.operationId,
    expectedBinding: desktopSnapshotCleanupBinding(profile, plan),
  };
  return { profile, request, epoch, selected };
}
test("phase one stages the bound receipt under its own install owner before the same-PID transition", async () => {
  const f = await fixture(),
    id = randomUUID(),
    seen: string[] = [];
  await expect(
    runDesktopSnapshotGcPhaseOne(id, f.request, signal(), {
      epoch: () => f.epoch,
      ready: async () => {
        await withDesktopInstallLease(f.profile, signal(), async () => {
          seen.push("ready-before-install");
        });
      },
      reserve: async (profile, operationId) => {
        expect(profile).toEqual(f.profile);
        expect((await readDesktopSnapshotRetention(profile))?.pending?.operationId).toBe(
          operationId,
        );
        seen.push("reserved-before-transition");
      },
      invocation: (profile, operationId) => {
        expect(profile).toEqual(f.profile);
        expect(operationId).toBe(id);
        return { command: "/fixture/native-reservation", args: ["--gc-snapshot", id] };
      },
      execve: (file, args, env) => {
        const installOwner: unknown = JSON.parse(
          readFileSync(join(`${f.profile.configDir}.bootstrap`, "gateway.lock"), "utf8"),
        );
        expect(installOwner).toMatchObject({ pid: process.pid });
        expect(file).toBe("/fixture/native-reservation");
        expect(args).toEqual([file, "--gc-snapshot", id]);
        expect(env?.OMNESIS_SECRET_SERVICE).toBe(f.profile.secretService);
        seen.push("same-pid-transition");
        throw new Error("fixture transition");
      },
    }),
  ).rejects.toThrow("fixture transition");
  expect(seen).toEqual([
    "ready-before-install",
    "reserved-before-transition",
    "same-pid-transition",
  ]);
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toMatchObject({
    operationId: id,
    phase: "planned",
    snapshotId: f.selected.operationId,
  });
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, f.selected.operationId)),
  ).resolves.toBeUndefined();
});
test("a changed confirmation and pre-start cancellation never stage native cleanup", async () => {
  const f = await fixture(),
    invoke = vi.fn(() => ({ command: "/fixture/native", args: [] })),
    execve = vi.fn(() => {
      throw new Error("unexpected transition");
    });
  const ready = vi.fn(() => Promise.resolve());
  await expect(
    runDesktopSnapshotGcPhaseOne(
      randomUUID(),
      { ...f.request, expectedBinding: "0".repeat(64) },
      signal(),
      { ready, epoch: () => f.epoch, invocation: invoke, execve },
    ),
  ).rejects.toThrow("changed");
  await expect(
    runDesktopSnapshotGcPhaseOne(randomUUID(), f.request, AbortSignal.abort(), {
      ready,
      epoch: () => f.epoch,
      invocation: invoke,
      execve,
    }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  expect(execve).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledTimes(1);
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
});
test("retry preserves the original operation and refuses selecting another copy", async () => {
  const f = await fixture(),
    id = randomUUID();
  const operations = {
    ready: () => Promise.resolve(),
    epoch: () => f.epoch,
    invocation: () => ({ command: "/fixture/native", args: [] }),
    reserve: async () => {},
    execve: (): never => {
      throw new Error("fixture transition");
    },
  };
  await expect(runDesktopSnapshotGcPhaseOne(id, f.request, signal(), operations)).rejects.toThrow(
    "fixture transition",
  );
  await expect(
    runDesktopSnapshotGcPhaseOne(
      id,
      { version: 1, profile: f.profile, retry: true },
      signal(),
      operations,
    ),
  ).rejects.toThrow("fixture transition");
  expect((await readDesktopSnapshotRetention(f.profile))?.pending?.operationId).toBe(id);
  await expect(
    runDesktopSnapshotGcPhaseOne(id, { ...f.request, retry: true }, signal(), operations),
  ).rejects.toThrow("cannot select");
});
test("the fixed phase-two source entry refuses without native authority and never prints request values", async () => {
  const f = await fixture(),
    entry = resolveSubprocessEntry("./snapshot-retention-host.ts", import.meta.url);
  const id = randomUUID();
  await withDesktopInstallLease(f.profile, signal(), async () => {
    const plan = await prepareDesktopSnapshotCleanupLocked(
      f.profile,
      { snapshotId: f.selected.operationId, currentEpoch: f.epoch },
      signal(),
    );
    plan.receipt.operationId = id;
    await stageDesktopSnapshotCleanupLocked(f.profile, plan, signal());
  });
  const owner = spawnOwnedChildProcess(entry.command, [...entry.args, "--perform", id], {
    env: desktopEnvironment(f.profile),
  });
  let output = "";
  owner.child.stdout?.on("data", (part: Buffer) => {
    output += part.toString();
  });
  owner.child.stderr?.resume();
  try {
    await owner.ready;
    await owner.joined;
    expect(owner.child.exitCode).toBe(70);
    expect(JSON.parse(output)).toEqual({
      version: 1,
      ok: false,
      error: { code: "RECOVERY_CLEANUP_REFUSED" },
    });
    expect(output).not.toContain(f.profile.configDir);
    expect((await readDesktopSnapshotRetention(f.profile))?.pending?.phase).toBe("planned");
    await expect(
      access(desktopUpdateSnapshotPath(f.profile, f.selected.operationId)),
    ).resolves.toBeUndefined();
  } finally {
    if (!owner.joinedConfirmed) await owner.stop();
    owner.child.stdin?.destroy();
  }
});

test("legacy process uncertainty is refused before readiness, a cleanup intent or native transition", async () => {
  const f = await fixture();
  await rm(join(`${f.profile.configDir}.bootstrap`, "process-authority.json"));
  const ready = vi.fn(() => Promise.resolve()),
    invocation = vi.fn(() => ({ command: "/fixture/native", args: [] }));
  await expect(
    runDesktopSnapshotGcPhaseOne(randomUUID(), f.request, signal(), {
      epoch: () => f.epoch,
      ready,
      invocation,
    }),
  ).rejects.toMatchObject({ code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED" });
  expect(ready).not.toHaveBeenCalled();
  expect(invocation).not.toHaveBeenCalled();
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toBeNull();
});

test("a failed native reservation or cancellation after reservation never begins the destructive handoff", async () => {
  const f = await fixture(),
    id = randomUUID(),
    controller = new AbortController();
  const execve = vi.fn((): never => {
    throw new Error("unexpected transition");
  });
  const operations = {
    epoch: () => f.epoch,
    ready: async () => {},
    invocation: () => ({ command: "/fixture/native", args: [] }),
    execve,
    reserve: async () => {
      throw new Error("fixture reservation refused");
    },
  };
  await expect(runDesktopSnapshotGcPhaseOne(id, f.request, signal(), operations)).rejects.toThrow(
    "fixture reservation refused",
  );
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toMatchObject({
    operationId: id,
    phase: "planned",
  });
  await expect(
    runDesktopSnapshotGcPhaseOne(
      id,
      { version: 1, profile: f.profile, retry: true },
      controller.signal,
      {
        ...operations,
        reserve: async () => {
          controller.abort();
        },
      },
    ),
  ).rejects.toThrow();
  expect(execve).not.toHaveBeenCalled();
  expect((await readDesktopSnapshotRetention(f.profile))?.pending).toMatchObject({
    operationId: id,
    phase: "planned",
  });
  await expect(
    access(desktopUpdateSnapshotPath(f.profile, f.selected.operationId)),
  ).resolves.toBeUndefined();
});
