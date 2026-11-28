// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopProfile } from "./profile.js";
import {
  desktopConfigIdentity,
  desktopGenerationPath,
  desktopProfileForGeneration,
} from "./generation.js";
import {
  assertDesktopProcessAuthority,
  certifyFreshDesktopProcessAuthority,
} from "./process-authority.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-process-authority-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  const journal = {
    phase: "claimed",
    processAuthorityVersion: 3 as const,
    instance: profile.instance,
    secretService: profile.secretService,
  };
  await writeFile(join(profile.configDir, "desktop-install.json"), JSON.stringify(journal), {
    mode: 0o600,
  });
  const certify = () =>
    withDesktopInstallLease(profile, new AbortController().signal, () =>
      certifyFreshDesktopProcessAuthority(profile, journal),
    );
  return {
    profile,
    journal,
    certify,
    path: join(`${profile.configDir}.bootstrap`, "process-authority.json"),
  };
}
test("only an empty newly claimed v3 incarnation receives a certificate", async () => {
  const f = await fixture();
  await expect(assertDesktopProcessAuthority(f.profile)).rejects.toMatchObject({
    code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED",
  });
  await f.certify();
  await assertDesktopProcessAuthority(f.profile);
  const before = await readFile(f.path, "utf8");
  await f.certify();
  expect(await readFile(f.path, "utf8")).toBe(before);
});
test("legacy claimed journals and existing data never acquire ownership by absence", async () => {
  const f = await fixture();
  await expect(
    certifyFreshDesktopProcessAuthority(f.profile, {
      ...f.journal,
      processAuthorityVersion: undefined,
    }),
  ).rejects.toThrow();
  await writeFile(join(f.profile.configDir, "retained.data"), "invented sealed bytes");
  await expect(f.certify()).rejects.toThrow();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.profile.configDir, "retained.data"), "utf8")).toBe(
    "invented sealed bytes",
  );
});
test("fresh generation rotation requires the retained matching completed erase certificate", async () => {
  const f = await fixture();
  await f.certify();
  const generation = randomUUID(),
    retirementId = randomUUID();
  const next = desktopProfileForGeneration(f.profile.configDir, generation);
  await writeFile(
    desktopGenerationPath(f.profile.configDir),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      configIdentity: desktopConfigIdentity(f.profile.configDir),
      generation,
      previous: {
        instance: f.profile.instance,
        secretService: f.profile.secretService,
        retirementId,
      },
    }),
    { mode: 0o600 },
  );
  const journal = { ...f.journal, instance: next.instance, secretService: next.secretService };
  await writeFile(join(next.configDir, "desktop-install.json"), JSON.stringify(journal), {
    mode: 0o600,
  });
  const rotate = () =>
    withDesktopInstallLease(next, new AbortController().signal, () =>
      certifyFreshDesktopProcessAuthority(next, journal),
    );
  await expect(rotate()).rejects.toThrow();
  const retirement = {
    version: 1,
    owner: "omnesis-desktop",
    instance: f.profile.instance,
    secretService: f.profile.secretService,
    operationId: retirementId,
    mode: "erase-data",
    phase: "keyCleanupPending",
    root: { device: "1", inode: "2" },
  };
  await writeFile(
    join(`${next.configDir}.bootstrap`, "retirement.json"),
    JSON.stringify(retirement),
    { mode: 0o600 },
  );
  await expect(rotate()).rejects.toThrow();
  await writeFile(
    join(`${next.configDir}.bootstrap`, "retirement.json"),
    JSON.stringify({ ...retirement, phase: "complete" }),
    { mode: 0o600 },
  );
  await rotate();
  await assertDesktopProcessAuthority(next);
  expect(JSON.parse(await readFile(f.path, "utf8")).instance).toBe(next.instance);
});

test("a known v2 certificate cannot be silently upgraded even when its claim is otherwise empty", async () => {
  const f = await fixture();
  await mkdir(`${f.profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  const legacy = {
    version: 2,
    owner: "omnesis-desktop",
    instance: f.profile.instance,
    secretService: f.profile.secretService,
  };
  await writeFile(f.path, JSON.stringify(legacy), { mode: 0o600 });
  await expect(f.certify()).rejects.toThrow();
  await expect(assertDesktopProcessAuthority(f.profile)).rejects.toMatchObject({
    code: "DESKTOP_PROCESS_AUTHORITY_REQUIRED",
  });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(legacy);
});
