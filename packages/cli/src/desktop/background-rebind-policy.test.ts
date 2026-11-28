// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { writeDesktopPrivateRecord } from "./private-record.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { writeDesktopUpdateState, type DesktopUpdateState } from "./update-state.js";
import { validateDesktopBackgroundHandoff } from "./background-rebind-policy.js";
let home: string, profile: DesktopProfile, state: DesktopUpdateState;
const old = "a".repeat(64),
  candidate = "b".repeat(64),
  signal = () => new AbortController().signal;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-helper-handoff-")));
  profile = desktopProfile(join(home, "library"));
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  await writeFile(
    join(profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      phase: "configured",
      mode: "home",
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: "fixture",
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  await writeDesktopPrivateRecord(profile, "process-authority.json", {
    version: 3,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  await writeDesktopActiveRuntime(profile, old, "1.2.2");
  state = {
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    phase: "installer-opened",
    mode: "home",
    oldEpoch: old,
    candidateEpoch: candidate,
    oldVersion: "1.2.2",
    candidateVersion: "1.2.3",
    artifactSha256: "c".repeat(64),
    root: (await desktopRootIdentity(profile))!,
    backup: { manifestSha256: "d".repeat(64), bytes: 16 },
  };
  await writeDesktopUpdateState(profile, state);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const binding = () => ({
  version: 1 as const,
  scope: { format: 1 as const, ...profile },
  epoch: old,
  pid: 123,
  birth: { seconds: "1", microseconds: "2" },
  origin: { state: "verified" as const },
});
test("candidate validation verifies actual backup without claiming epoch or changing intent", async () => {
  const before = await readFile(join(`${profile.configDir}.bootstrap`, "update.json"));
  const verifySnapshot = vi.fn(async () => {});
  expect(
    await validateDesktopBackgroundHandoff(profile, candidate, binding(), signal(), {
      verifySnapshot,
    }),
  ).toEqual({ kind: "candidate", mode: "home" });
  expect(verifySnapshot).toHaveBeenCalledExactlyOnceWith(profile, {
    operationId: state.operationId,
    manifestSha256: state.backup!.manifestSha256,
    signal: expect.any(AbortSignal),
  });
  expect(await readFile(join(`${profile.configDir}.bootstrap`, "update.json"))).toEqual(before);
});
test("snapshot corruption refuses before helper handoff", async () => {
  await expect(
    validateDesktopBackgroundHandoff(profile, candidate, binding(), signal(), {
      verifySnapshot: async () => {
        throw new Error("Fixture backup unavailable");
      },
    }),
  ).rejects.toThrow("backup unavailable");
});
test.each(["verified", "stopping", "recovery-required"] as const)(
  "%s cannot authorize candidate replacement",
  async (phase) => {
    await writeDesktopUpdateState(profile, { ...state, phase });
    await expect(
      validateDesktopBackgroundHandoff(profile, candidate, binding(), signal()),
    ).rejects.toThrow();
  },
);
test("an unrelated running epoch cannot be rebound using an update receipt", async () => {
  await expect(
    validateDesktopBackgroundHandoff(
      profile,
      candidate,
      { ...binding(), epoch: "e".repeat(64) },
      signal(),
    ),
  ).rejects.toThrow();
});
test("previous app requires completed rollback, never automatic restore replay", async () => {
  await writeDesktopUpdateState(profile, { ...state, phase: "resumed" });
  expect(
    await validateDesktopBackgroundHandoff(
      profile,
      old,
      { ...binding(), epoch: candidate },
      signal(),
      {
        verifySnapshot: async () => {},
      },
    ),
  ).toMatchObject({ kind: "previous" });
  await writeDesktopUpdateState(profile, { ...state, phase: "recovery-required" });
  await expect(
    validateDesktopBackgroundHandoff(profile, old, { ...binding(), epoch: candidate }, signal()),
  ).rejects.toThrow();
});
test("unknown legacy process authority cannot authorize even a signed helper change", async () => {
  await writeDesktopPrivateRecord(profile, "process-authority.json", {
    version: 2,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  await expect(
    validateDesktopBackgroundHandoff(profile, candidate, binding(), signal()),
  ).rejects.toThrow();
});

test("fresh generation requires the exact previous completed erase and current certified namespace", async () => {
  const { desktopConfigIdentity, desktopGenerationPath, desktopProfileForGeneration } =
    await import("./generation.js");
  const generation = randomUUID(),
    retirementId = randomUUID(),
    previous = profile;
  await rm(join(`${profile.configDir}.bootstrap`, "update.json"), { force: true });
  await rm(join(`${profile.configDir}.bootstrap`, "active-runtime.json"), { force: true });
  await writeDesktopPrivateRecord(profile, "retirement.json", {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: retirementId,
    mode: "erase-data",
    phase: "complete",
    root: state.root,
  });
  await writeFile(
    desktopGenerationPath(profile.configDir),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      configIdentity: desktopConfigIdentity(profile.configDir),
      generation,
      previous: {
        instance: previous.instance,
        secretService: previous.secretService,
        retirementId,
      },
    }),
    { mode: 0o600 },
  );
  profile = desktopProfileForGeneration(profile.configDir, generation);
  await writeFile(
    join(profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      phase: "configured",
      mode: "home",
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: "fixture",
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  await writeDesktopPrivateRecord(profile, "process-authority.json", {
    version: 3,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  const oldBinding = { ...binding(), scope: { format: 1 as const, ...previous } };
  expect(await validateDesktopBackgroundHandoff(profile, candidate, oldBinding, signal())).toEqual({
    kind: "fresh-install",
    mode: "home",
  });
  await writeDesktopPrivateRecord(profile, "retirement.json", {
    version: 1,
    owner: "omnesis-desktop",
    instance: previous.instance,
    secretService: previous.secretService,
    operationId: retirementId,
    mode: "erase-data",
    phase: "keyCleanupPending",
    root: state.root,
  });
  await expect(
    validateDesktopBackgroundHandoff(profile, candidate, oldBinding, signal()),
  ).rejects.toThrow();
});

test("matching ordinary helper does not clear or reject pending restore policy", async () => {
  await rm(join(`${profile.configDir}.bootstrap`, "update.json"), { force: true });
  expect(await validateDesktopBackgroundHandoff(profile, old, binding(), signal())).toBeNull();
  expect(
    await readFile(join(`${profile.configDir}.bootstrap`, "active-runtime.json"), "utf8"),
  ).toContain(old);
});

test.each(["pending", "unavailable"] as const)(
  "explicit same-code %s origin repair needs configured owned current root and consistent active epoch",
  async (originState) => {
    await rm(join(`${profile.configDir}.bootstrap`, "update.json"), { force: true });
    const origin =
      originState === "pending"
        ? { state: originState, client: { pid: 456, birth: { seconds: "3", microseconds: "4" } } }
        : { state: originState };
    const observation = { ...binding(), origin };
    expect(await validateDesktopBackgroundHandoff(profile, old, observation, signal())).toEqual({
      kind: "origin-recovery",
      mode: "home",
    });
    await expect(
      validateDesktopBackgroundHandoff(profile, candidate, observation, signal()),
    ).rejects.toThrow();
    await writeDesktopActiveRuntime(profile, candidate, "1.2.3");
    await expect(
      validateDesktopBackgroundHandoff(profile, old, observation, signal()),
    ).rejects.toThrow();
  },
);

test("origin retry preserves the candidate snapshot policy even after helper scope and epoch match", async () => {
  const observation = { ...binding(), epoch: candidate, origin: { state: "unavailable" as const } };
  const verifySnapshot = vi.fn(async () => {
    throw new Error("Fixture backup was removed");
  });
  await expect(
    validateDesktopBackgroundHandoff(profile, candidate, observation, signal(), { verifySnapshot }),
  ).rejects.toThrow("backup was removed");
  expect(verifySnapshot).toHaveBeenCalledOnce();
});
