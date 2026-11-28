// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { generateInstallRootKey, openRecoveryEnvelope, recoveryEnvelopePath } from "@omnesis/core";
import { DesktopRecoveryService } from "./recovery.js";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity, writeDesktopRetirement } from "./retirement.js";
import type { DesktopInstall } from "./bootstrap.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;

async function fixture(mode: "home" | "joined" = "home") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-recovery-")));
  homes.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  const install = {
    version: 1,
    owner: "omnesis-desktop",
    mode,
    instance: profile.instance,
    secretService: profile.secretService,
    embedder: null,
    memoryLimitMb: 512,
    phase: "configured",
  } satisfies DesktopInstall;
  await writeFile(join(profile.configDir, "desktop-install.json"), JSON.stringify(install), {
    mode: 0o600,
  });
  let key: string | null = generateInstallRootKey();
  let now = 1_900_000_000_000;
  const readKey = vi.fn(() => Promise.resolve(key));
  const service = new DesktopRecoveryService(profile, { readKey, now: () => now });
  return {
    home,
    profile,
    service,
    readKey,
    key: () => key!,
    setKey: (value: string | null) => {
      key = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("preparing recovery creates no persistent envelope and uses the existing scoped root key", async () => {
  const f = await fixture();
  const draft = await f.service.prepare({ signal: signal() });
  expect(openRecoveryEnvelope(draft.envelope, draft.recoveryCode)).toBe(f.key());
  expect(f.readKey).toHaveBeenCalledWith({
    backend: "macos-keychain",
    configDir: f.profile.configDir,
    service: f.profile.secretService,
  });
  await expect(stat(recoveryEnvelopePath(f.profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.service.status(signal())).toEqual({
    available: true,
    hasEnvelope: false,
    envelopeValid: false,
  });
});

test.skipIf(process.platform === "win32")(
  "recovery status refuses a FIFO envelope without waiting for a writer",
  async () => {
    const f = await fixture();
    const path = recoveryEnvelopePath(f.profile.configDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", path]);
    let neededWriter = false;
    let writer: Promise<void> | undefined;
    // Release a regressed blocking open so the fixture can drain it before cleanup.
    const rescue = setTimeout(() => {
      neededWriter = true;
      writer = open(path, constants.O_RDWR | constants.O_NONBLOCK).then((file) => file.close());
    }, 2_000);
    try {
      await expect(f.service.status(signal())).rejects.toThrow(
        "The recovery envelope must be a private file owned by you",
      );
      expect(neededWriter).toBe(false);
    } finally {
      clearTimeout(rescue);
      await writer;
    }
  },
);

test("explicit commit writes only the existing-format sealed envelope with private permissions", async () => {
  const f = await fixture();
  const draft = await f.service.prepare({ signal: signal() });
  await expect(f.service.commit(draft.draftId, signal())).resolves.toEqual({ saved: true });
  const path = recoveryEnvelopePath(f.profile.configDir);
  const persisted = await readFile(path, "utf8");
  expect(JSON.parse(persisted)).toEqual(draft.envelope);
  expect(persisted).not.toContain(draft.recoveryCode);
  expect(persisted).not.toContain(f.key());
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect((await stat(dirname(path))).mode & 0o077).toBe(0);
  expect(await f.service.status(signal())).toEqual({
    available: true,
    hasEnvelope: true,
    envelopeValid: true,
  });
});

test("replacement requires explicit consent and cancelling its draft preserves the saved envelope", async () => {
  const f = await fixture();
  const first = await f.service.prepare({ signal: signal() });
  await f.service.commit(first.draftId, signal());
  const path = recoveryEnvelopePath(f.profile.configDir);
  const before = await readFile(path, "utf8");
  await expect(f.service.prepare({ signal: signal() })).rejects.toThrow("Confirm replacement");
  const replacement = await f.service.prepare({ replaceExisting: true, signal: signal() });
  f.service.cancel(replacement.draftId);
  await expect(f.service.commit(replacement.draftId, signal())).rejects.toThrow("cancelled");
  expect(await readFile(path, "utf8")).toBe(before);
});

test("expired and closed drafts cannot publish a recovery envelope", async () => {
  const f = await fixture();
  const expired = await f.service.prepare({ signal: signal() });
  f.advance(5 * 60_000);
  await expect(f.service.commit(expired.draftId, signal())).rejects.toThrow("expired");
  const closed = await f.service.prepare({ signal: signal() });
  f.service.close();
  await expect(f.service.commit(closed.draftId, signal())).rejects.toThrow("cancelled");
  await expect(stat(recoveryEnvelopePath(f.profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a changed or missing root key cannot commit a stale recovery draft or remint a key", async () => {
  const f = await fixture();
  const draft = await f.service.prepare({ signal: signal() });
  f.setKey(generateInstallRootKey());
  await expect(f.service.commit(draft.draftId, signal())).rejects.toThrow("protection changed");
  f.setKey(null);
  await expect(f.service.prepare({ signal: signal() })).rejects.toThrow("Unlock");
  await expect(stat(recoveryEnvelopePath(f.profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("retirement fences a draft prepared before removal", async () => {
  const f = await fixture();
  const draft = await f.service.prepare({ signal: signal() });
  await writeDesktopRetirement(f.profile, {
    version: 1,
    owner: "omnesis-desktop",
    instance: f.profile.instance,
    secretService: f.profile.secretService,
    operationId: "00000000-0000-4000-8000-000000000001",
    mode: "keep-data",
    phase: "complete",
    root: (await desktopRootIdentity(f.profile))!,
  });
  await expect(f.service.commit(draft.draftId, signal())).rejects.toThrow("retired");
  await expect(stat(recoveryEnvelopePath(f.profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("another recovery publisher invalidates the reviewed envelope state", async () => {
  const f = await fixture();
  const second = new DesktopRecoveryService(f.profile, { readKey: f.readKey });
  const a = await f.service.prepare({ signal: signal() });
  const b = await second.prepare({ signal: signal() });
  await second.commit(b.draftId, signal());
  const before = await readFile(recoveryEnvelopePath(f.profile.configDir), "utf8");
  await expect(f.service.commit(a.draftId, signal())).rejects.toThrow("Another recovery envelope");
  expect(await readFile(recoveryEnvelopePath(f.profile.configDir), "utf8")).toBe(before);
});

test("joined Macs cannot create recovery material for their own unrelated local key", async () => {
  const f = await fixture("joined");
  expect(await f.service.status(signal())).toEqual({
    available: false,
    hasEnvelope: false,
    envelopeValid: false,
  });
  await expect(f.service.prepare({ signal: signal() })).rejects.toThrow(
    "computer that keeps your library",
  );
  expect(f.readKey).not.toHaveBeenCalled();
});

test("a symlinked recovery folder is refused without writing through it", async () => {
  const f = await fixture();
  const outside = join(f.home, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(f.profile.configDir, "keyring"));
  await expect(f.service.prepare({ signal: signal() })).rejects.toThrow("not a symbolic link");
  await expect(stat(join(outside, "recovery-envelope.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("malformed existing recovery files still need deliberate replacement", async () => {
  const f = await fixture();
  const path = recoveryEnvelopePath(f.profile.configDir);
  await mkdir(dirname(path), { mode: 0o700 });
  await writeFile(path, "{not-json", { mode: 0o600 });
  expect(await f.service.status(signal())).toEqual({
    available: true,
    hasEnvelope: true,
    envelopeValid: false,
  });
  await expect(f.service.prepare({ signal: signal() })).rejects.toThrow("Confirm replacement");
  expect(await readFile(path, "utf8")).toBe("{not-json");
});

test("cancelled preparation changes neither saved envelope nor draft state", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.service.prepare({ signal: controller.signal })).rejects.toThrow();
  expect(f.readKey).not.toHaveBeenCalled();
  await expect(stat(recoveryEnvelopePath(f.profile.configDir))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
