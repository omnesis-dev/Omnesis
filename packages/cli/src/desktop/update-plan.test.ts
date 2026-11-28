// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  planDesktopUpdate,
  planDesktopCurrentApplicationReplacement,
  desktopUpdateMetadataSchema,
} from "./update-plan.js";

function metadata(productVersion: string, mainDb = 4, config = 2) {
  return {
    format: 1,
    bundleIdentifier: "dev.omnesis.desktop",
    productVersion,
    architecture: "arm64",
    compat: {
      productVersion,
      stores: {
        mainDb: { policy: "numbered-migrations", version: mainDb },
        config: { policy: "in-place", version: config },
      },
      protocols: { ws: 3 },
    },
  };
}
function fixture() {
  return {
    current: metadata("1.2.2"),
    candidate: metadata("1.2.3", 5),
    mode: "home" as const,
    release: {
      version: "1.2.3",
      architecture: "arm64" as const,
      bytes: 1024,
      sha256: "a".repeat(64),
      url: "https://github.com/omnesis-dev/Omnesis/releases/download/v1.2.3/Omnesis-1.2.3-macos-arm64.dmg",
    },
    observed: { mainDbVersion: 4, configVersion: 2 },
    payloadBytes: 2048,
    applicationBytes: 3072,
    oldApplicationBytes: 4096,
    backupBytes: 4096,
    freeBytes: 1024 ** 3,
  };
}
test("forward migrations require a backup and reserve download, immutable staging and backup headroom", () => {
  expect(planDesktopUpdate(fixture())).toMatchObject({
    migration: true,
    backupRequired: true,
    requiredFreeBytes: 1024 + 2048 + 3072 + 4096 + 4096 + 512 * 1024 ** 2,
    recovery: "resume-before-start-or-restore-backup-after-start",
  });
});
test("no-migration updates still protect provider state through mandatory recovery backup", () => {
  const options = fixture();
  options.candidate = metadata("1.2.3");
  expect(planDesktopUpdate(options)).toMatchObject({ migration: false, backupRequired: true });
});
test("observed newer database or configuration refuses downgrade even when product version increases", () => {
  const options = fixture();
  expect(() =>
    planDesktopUpdate({ ...options, observed: { mainDbVersion: 6, configVersion: 2 } }),
  ).toThrow("newer data");
  expect(() =>
    planDesktopUpdate({ ...options, observed: { mainDbVersion: 4, configVersion: 3 } }),
  ).toThrow("newer data");
});
test("replayed versions, architecture swaps and metadata disagreement are refused", () => {
  const options = fixture();
  for (const candidate of [
    metadata("1.2.2"),
    metadata("1.2.1"),
    metadata("1.2.4"),
    { ...metadata("1.2.3"), architecture: "x64" },
  ]) {
    expect(() => planDesktopUpdate({ ...options, candidate })).toThrow();
  }
  expect(
    desktopUpdateMetadataSchema.safeParse({ ...metadata("1.2.3"), productVersion: "1.02.3" })
      .success,
  ).toBe(false);
  expect(
    desktopUpdateMetadataSchema.safeParse({
      ...metadata("1.2.3"),
      bundleIdentifier: "dev.other.app",
    }).success,
  ).toBe(false);
});
test("joined collectors must remain wire-compatible with the independently running home", () => {
  const options = fixture();
  expect(() => planDesktopUpdate({ ...options, mode: "joined" })).toThrow("home library");
  expect(() =>
    planDesktopUpdate({
      ...options,
      mode: "joined",
      observed: { ...options.observed, remoteWsVersion: 2 },
    }),
  ).toThrow("home library");
  expect(
    planDesktopUpdate({
      ...options,
      mode: "joined",
      observed: { ...options.observed, remoteWsVersion: 3 },
    }).targetVersion,
  ).toBe("1.2.3");
});
test("low disk, missing measurements, and unsafe integer overflow refuse preparation", () => {
  const options = fixture();
  for (const changed of [
    { freeBytes: 1 },
    { backupBytes: -1 },
    { payloadBytes: 0 },
    { payloadBytes: Number.MAX_SAFE_INTEGER },
    { backupBytes: Number.NaN },
  ]) {
    expect(() => planDesktopUpdate({ ...options, ...changed })).toThrow();
  }
});

test("current-application replacement permits only explicit distinct epochs without downgrades", () => {
  const options = {
    ...fixture(),
    candidate: metadata("1.2.2"),
    oldEpoch: "a".repeat(64),
    candidateEpoch: "b".repeat(64),
  };
  expect(planDesktopCurrentApplicationReplacement(options)).toMatchObject({
    source: "current-application",
    targetVersion: "1.2.2",
    backupRequired: true,
  });
  expect(() => planDesktopUpdate(options)).toThrow("strictly newer");
  expect(() =>
    planDesktopCurrentApplicationReplacement({ ...options, candidateEpoch: options.oldEpoch }),
  ).toThrow("already active");
  expect(() =>
    planDesktopCurrentApplicationReplacement({ ...options, candidate: metadata("1.2.1") }),
  ).toThrow();
  expect(() =>
    planDesktopCurrentApplicationReplacement({ ...options, candidate: metadata("1.2.2", 3) }),
  ).toThrow("newer data");
});
