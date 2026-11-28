// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity, writeDesktopRetirement } from "./retirement.js";
import { readDesktopRestoreIntent, writeDesktopRestoreIntent } from "./restore-intent.js";
import { DesktopRestoreProtection } from "./restore-protection.js";
import { desktopEpochMayStart, desktopUpdateBlocked } from "./update-admission.js";
import { claimDesktopUpdateEpoch } from "./update-claim.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import {
  desktopRestoreActivationArguments,
  readDesktopRestoreActivationArguments,
} from "./restore-start-arguments.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-start-")));
  roots.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  const root = (await desktopRootIdentity(profile))!;
  const authorization = { operationId: randomUUID(), attemptId: randomUUID(), epoch: null };
  const intent = {
    version: 1 as const,
    owner: "omnesis-desktop" as const,
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: authorization.operationId,
    phase: "starting" as const,
    root,
    targetKeyDigest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 512,
    backup: { manifestSha256: "c".repeat(64), bytes: 1024 },
    activation: { attemptId: authorization.attemptId, epoch: null, claimed: false },
  };
  await writeDesktopRestoreIntent(profile, intent);
  vi.spyOn(DesktopRestoreProtection, "capture").mockResolvedValue({
    identity: () => ({ root, keyDigest: intent.targetKeyDigest }),
    close: () => {},
  } as unknown as DesktopRestoreProtection);
  return { profile, authorization, intent };
}

test("restore authorization has a bounded strict internal argv representation", () => {
  const authorization = { operationId: randomUUID(), attemptId: randomUUID(), epoch: null };
  expect(
    readDesktopRestoreActivationArguments(desktopRestoreActivationArguments(authorization)),
  ).toEqual(authorization);
  expect(readDesktopRestoreActivationArguments([])).toBeUndefined();
  for (const args of [
    ["--restore-start"],
    ["--other", "{}"],
    ["--restore-start", "{}"],
    ["--restore-start", "x".repeat(1025)],
    ["--restore-start", JSON.stringify({ ...authorization, bypass: true })],
  ]) {
    expect(() => readDesktopRestoreActivationArguments(args)).toThrow("Invalid managed restore");
  }
});

test("only one exact pending restore attempt admits a daemon; children require its claimed attempt", async () => {
  const { profile, authorization } = await fixture();
  expect(await desktopEpochMayStart(profile, null)).toBe(false);
  expect(await desktopUpdateBlocked(profile, null, authorization)).toBe(true);
  expect(
    await desktopEpochMayStart(profile, null, { ...authorization, attemptId: randomUUID() }),
  ).toBe(false);
  expect(await desktopEpochMayStart(profile, null, authorization)).toBe(true);
  expect(
    await claimDesktopUpdateEpoch(profile, new AbortController().signal, null, authorization),
  ).toBe(true);
  expect((await readDesktopRestoreIntent(profile))?.activation?.claimed).toBe(true);
  expect(await desktopEpochMayStart(profile, null, authorization)).toBe(false);
  expect(
    await claimDesktopUpdateEpoch(profile, new AbortController().signal, null, authorization),
  ).toBe(false);
  expect(await desktopUpdateBlocked(profile, null)).toBe(true);
  expect(await desktopUpdateBlocked(profile, null, authorization)).toBe(false);
});

test("restore authorization cannot consume an attempt across a runtime epoch mismatch or retirement", async () => {
  const { profile, authorization, intent } = await fixture();
  await writeDesktopActiveRuntime(profile, "d".repeat(64), "1.2.3");
  expect(await desktopEpochMayStart(profile, null, authorization)).toBe(false);
  expect(
    await claimDesktopUpdateEpoch(profile, new AbortController().signal, null, authorization),
  ).toBe(false);
  expect((await readDesktopRestoreIntent(profile))?.activation?.claimed).toBe(false);
  await writeDesktopRetirement(profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: randomUUID(),
    mode: "keep-data",
    phase: "complete",
    root: intent.root,
  });
  expect(
    await claimDesktopUpdateEpoch(profile, new AbortController().signal, null, authorization),
  ).toBe(false);
  expect((await readDesktopRestoreIntent(profile))?.activation?.claimed).toBe(false);
});
