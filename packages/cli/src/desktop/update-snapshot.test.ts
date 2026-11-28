// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { desktopProfile } from "./environment.js";
import { desktopRootIdentity } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import {
  createDesktopUpdateSnapshot,
  desktopUpdateSnapshotPath,
  restoreDesktopUpdateSnapshot,
  measureDesktopUpdateSnapshot,
} from "./update-snapshot.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-snapshot-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture() {
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  for (const directory of ["cloud-relay", "provider-local", "models", "logs", "keyring"]) {
    await mkdir(join(profile.configDir, directory), { mode: 0o700 });
  }
  for (const [path, value] of Object.entries({
    "omnesis.db": "invented-encrypted-store",
    "cloud-relay/cli-device.json": "invented-sealed-pairing",
    "cloud-relay/cli.key": "invented-sealed-private-key",
    "provider-local/cursor": "invented-old-cursor",
    "keyring/storage-keys": "invented-wrapped-storage-key",
    "models/weights": "invented-regenerable-weights",
    "logs/current.log": "invented-diagnostic",
  }))
    await writeFile(join(profile.configDir, path), value, { mode: 0o600 });
  await writeFile(join(home, "original.txt"), "invented-original-source");
  await symlink(join(home, "original.txt"), join(profile.configDir, "source-link"));
  const root = (await desktopRootIdentity(profile))!;
  const leases = await acquireDesktopRuntimeLeases(profile, {
    signal: signal(),
    expectedRoot: root,
  });
  return { profile, leases, root, operationId: randomUUID() };
}
describe.skipIf(process.platform === "win32")("owned desktop update snapshots", () => {
  test("read-only capacity inventory shares exact copy exclusions and counts", async () => {
    const f = await fixture();
    try {
      for (const name of [
        "exports",
        "codex-runtimes",
        "codex-home",
        "codex-home-pool",
        "codex-workspace",
        "codex-workspace-pool",
      ]) {
        await mkdir(join(f.profile.configDir, name), { mode: 0o700 });
        await writeFile(
          join(f.profile.configDir, name, "regenerable.data"),
          "excluded fixture payload",
          { mode: 0o600 },
        );
      }
      const measured = await measureDesktopUpdateSnapshot(f.profile, signal());
      const snapshot = await createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() });
      const manifest = JSON.parse(
        await readFile(
          join(desktopUpdateSnapshotPath(f.profile, f.operationId), "snapshot.json"),
          "utf8",
        ),
      );
      expect(measured.bytes).toBe(snapshot.bytes);
      expect(measured.entries).toBe(manifest.entries.length);
      expect(
        manifest.entries.some((entry: { path: string }) => /^(?:exports|codex-)/u.test(entry.path)),
      ).toBe(false);
    } finally {
      f.leases.release();
    }
  });
  test("excluded SDK state never hides unresolved plaintext credentials", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.profile.configDir, "codex-home"), { mode: 0o700 });
      await writeFile(
        join(f.profile.configDir, "codex-home", "auth.json"),
        "invented-unprotected-auth",
        { mode: 0o600 },
      );
      await expect(measureDesktopUpdateSnapshot(f.profile, signal())).rejects.toThrow(
        "unprotected credentials",
      );
      await expect(
        createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() }),
      ).rejects.toThrow("unprotected credentials");
      await expect(access(desktopUpdateSnapshotPath(f.profile, f.operationId))).rejects.toThrow();
    } finally {
      f.leases.release();
    }
  });
  test("hardlinked files cannot become a recovery copy's data authority", async () => {
    const f = await fixture();
    try {
      await link(join(f.profile.configDir, "omnesis.db"), join(f.profile.configDir, "shared.db"));
      await expect(measureDesktopUpdateSnapshot(f.profile, signal())).rejects.toThrow(
        "shared identity",
      );
      await expect(
        createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() }),
      ).rejects.toThrow("shared identity");
    } finally {
      f.leases.release();
    }
  });
  test("restores sealed identity, provider state and stores while retaining models, logs and original sources", async () => {
    const f = await fixture();
    try {
      const snapshot = await createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() });
      const root = desktopUpdateSnapshotPath(f.profile, f.operationId);
      expect(await readdir(join(root, "files"))).not.toContain("models");
      expect(await readdir(join(root, "files"))).not.toContain("backups");
      await writeFile(join(f.profile.configDir, "omnesis.db"), "invented-migrated-store");
      await writeFile(join(f.profile.configDir, "provider-local/cursor"), "invented-new-cursor");
      await writeFile(join(f.profile.configDir, "new-generation"), "invented-new-state");
      await restoreDesktopUpdateSnapshot(f.profile, { ...f, snapshot, signal: signal() });
      expect(await readFile(join(f.profile.configDir, "omnesis.db"), "utf8")).toBe(
        "invented-encrypted-store",
      );
      expect(await readFile(join(f.profile.configDir, "cloud-relay/cli.key"), "utf8")).toBe(
        "invented-sealed-private-key",
      );
      expect(await readFile(join(f.profile.configDir, "cloud-relay/cli-device.json"), "utf8")).toBe(
        "invented-sealed-pairing",
      );
      expect(await readFile(join(f.profile.configDir, "provider-local/cursor"), "utf8")).toBe(
        "invented-old-cursor",
      );
      expect(await readFile(join(f.profile.configDir, "models/weights"), "utf8")).toBe(
        "invented-regenerable-weights",
      );
      expect(await readFile(join(home, "original.txt"), "utf8")).toBe("invented-original-source");
      expect(await readlink(join(f.profile.configDir, "source-link"))).toBe(
        join(home, "original.txt"),
      );
      await expect(access(join(f.profile.configDir, "new-generation"))).rejects.toThrow();
      expect(await desktopRootIdentity(f.profile)).toEqual(f.root);
    } finally {
      f.leases.release();
    }
  });
  test("corruption is rejected before any current library file is changed", async () => {
    const f = await fixture();
    try {
      const snapshot = await createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() });
      await writeFile(
        join(desktopUpdateSnapshotPath(f.profile, f.operationId), "files/omnesis.db"),
        "tampered-backup",
      );
      await writeFile(join(f.profile.configDir, "omnesis.db"), "invented-current-library");
      await expect(
        restoreDesktopUpdateSnapshot(f.profile, { ...f, snapshot, signal: signal() }),
      ).rejects.toThrow();
      expect(await readFile(join(f.profile.configDir, "omnesis.db"), "utf8")).toBe(
        "invented-current-library",
      );
    } finally {
      f.leases.release();
    }
  });
  test("a FIFO inventory refuses before waiting for a writer or changing the current library", async () => {
    const f = await fixture();
    let writer: Promise<void> | undefined;
    let rescue: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() });
      const path = join(desktopUpdateSnapshotPath(f.profile, f.operationId), "snapshot.json");
      await rm(path, { force: true });
      execFileSync("mkfifo", ["-m", "600", path]);
      await writeFile(join(f.profile.configDir, "omnesis.db"), "invented-current-library");
      let neededWriter = false;
      // Drain a regressed blocking open before the fixture releases its owned lease.
      rescue = setTimeout(() => {
        neededWriter = true;
        writer = open(path, constants.O_RDWR | constants.O_NONBLOCK).then((file) => file.close());
      }, 2_000);
      await expect(
        restoreDesktopUpdateSnapshot(f.profile, { ...f, snapshot, signal: signal() }),
      ).rejects.toThrow("The desktop recovery inventory is unsafe");
      expect(neededWriter).toBe(false);
      expect(await readFile(join(f.profile.configDir, "omnesis.db"), "utf8")).toBe(
        "invented-current-library",
      );
    } finally {
      clearTimeout(rescue);
      try {
        await writer;
      } finally {
        f.leases.release();
      }
    }
  });
  test("caller-created and released lease handles cannot authorize a snapshot", async () => {
    const f = await fixture();
    f.leases.release();
    await expect(
      createDesktopUpdateSnapshot(f.profile, { ...f, signal: signal() }),
    ).rejects.toThrow("exclusively reserved");
    await expect(
      createDesktopUpdateSnapshot(f.profile, { ...f, leases: { release() {} }, signal: signal() }),
    ).rejects.toThrow("exclusively reserved");
  });
  test("cancellation leaves the original state and no published or partial snapshot", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(
        createDesktopUpdateSnapshot(f.profile, { ...f, signal: abort.signal }),
      ).rejects.toThrow();
      expect(await readdir(join(f.profile.configDir, "backups"))).toEqual([]);
      expect(await readFile(join(f.profile.configDir, "omnesis.db"), "utf8")).toBe(
        "invented-encrypted-store",
      );
    } finally {
      f.leases.release();
    }
  });
});
