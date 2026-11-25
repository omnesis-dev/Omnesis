// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { realpath, mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateInstallRootKey, readPackageVersion } from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopJournalPath } from "./profile.js";
import { desktopRootIdentity } from "./retirement.js";
import { DesktopBackupRestoreService } from "./restore-service.js";
import {
  applyDesktopRestoreTransaction,
  recoverDesktopRestoreTransaction,
} from "./restore-transaction.js";
import { buildDesktopRestorePublication } from "./restore-publication.js";
import { desktopRestoreExpandedBytes } from "./restore-capacity.js";
import type { DesktopRestoreFileSelection } from "./restore-imports.js";

// These tests exercise transport, capability consumption, and rollback orchestration.
// SQLCipher reconstruction and native identity preservation have separate real-addon tests.
const seams = vi.hoisted(() => ({ root: "", inspect: vi.fn(), prepare: vi.fn(), closed: vi.fn() }));
vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return {
    ...actual,
    decodeSecretTextFileValue: async (path: string, raw: string, options: { configDir: string }) =>
      actual.openSecretFileValueAsync(raw, {
        rootKey: seams.root,
        scope: actual.secretFileScope(path, options.configDir),
      }),
  };
});
vi.mock("./restore-protection.js", () => ({
  DesktopRestoreProtection: class {
    static async capture(profile: DesktopProfile) {
      const root = (await desktopRootIdentity(profile))!;
      return {
        key: () => seams.root,
        identity: () => ({
          root,
          keyDigest: "1".repeat(64),
          markerDigest: "2".repeat(64),
          rootChangeTime: "fixture",
        }),
        matches: () => true,
        matchesProtection: () => true,
        close: () => {},
      };
    }
  },
}));
vi.mock("./restore-store-keys.js", () => ({
  DesktopRestoreStoreKeys: class {
    static async prepare() {
      return {
        source: () => null,
        target: () => Buffer.alloc(32, 3),
        wrapped: () => null,
        close: seams.closed,
      };
    }
  },
}));
vi.mock("@omnesis/gateway/restore", () => ({
  inspectDesktopMainEntry: (...args: unknown[]) => seams.inspect(...args),
  inspectDesktopRestoredDatabase: async () => ({
    schemaVersion: 123,
    documents: 4,
    sources: 2,
    devices: 1,
    legacy: false,
  }),
  reconcileDesktopMainEntry: (...args: unknown[]) => seams.prepare(...args),
  reconcileDesktopAuxiliaryEntry: async () => {
    throw new Error("Unexpected auxiliary request in this fixture");
  },
}));
let directory: string, profile: DesktopProfile, service: DesktopBackupRestoreService;
test("the production service constructs without a test operation adapter", async () => {
  const production = new DesktopBackupRestoreService(profile);
  await production.close();
});
beforeEach(async () => {
  seams.root = generateInstallRootKey();
  seams.inspect.mockReset();
  seams.prepare.mockReset();
  seams.closed.mockReset();
  directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-service-")));
  profile = desktopProfile(directory);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { mode: 0o700 });
  await writeFile(
    desktopJournalPath(profile),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      mode: "home",
      phase: "configured",
      embedder: null,
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  await writeFile(join(profile.configDir, "omnesis.db"), "invented previous ciphertext", {
    mode: 0o600,
  });
  await writeFile(join(profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
  await writeFile(join(profile.configDir, "token"), "invented-current-token", { mode: 0o600 });
  seams.inspect.mockResolvedValue({
    schemaVersion: 123,
    documents: 4,
    sources: 2,
    devices: 1,
    legacy: false,
  });
  seams.prepare.mockImplementation(async (options: { destinationPath: string }) => {
    await writeFile(options.destinationPath, "invented rebuilt ciphertext", { mode: 0o600 });
    return {
      sourcesPaused: 2,
      foreignDevicesRetained: 1,
      targetDevicesPreserved: 1,
      targetLabs: { brain: false, tasks: false, watches: false },
    };
  });
  service = new DesktopBackupRestoreService(profile, {
    apply: (profile, input, signal) =>
      applyDesktopRestoreTransaction(
        profile,
        {
          expandedBytes: desktopRestoreExpandedBytes(input.archive),
          archiveSha256: input.archive.sha256,
          archiveBytes: input.archive.bytes,
          protection: input.protection,
          stagingRoot: input.stagingRoot,
          build: ({ signal: active }) =>
            buildDesktopRestorePublication({
              profile,
              archive: input.archive,
              entries: input.entries,
              keys: input.keys,
              directory: input.stagingRoot,
              signal: active,
            }),
        },
        signal,
        { authorize: () => {} },
      ),
    recover: (profile, id, signal) =>
      recoverDesktopRestoreTransaction(profile, id, signal, { authorize: () => {} }),
  });
});
afterEach(async () => {
  await service.close();
  await rm(directory, { recursive: true, force: true });
});
async function archive(): Promise<DesktopRestoreFileSelection> {
  const tar = pack(),
    blocks: Buffer[] = [];
  const read = (async () => {
    for await (const block of tar) blocks.push(Buffer.from(block as Uint8Array));
  })();
  tar.entry(
    { name: "backup/omnesis.db" },
    "invented input database, native parsing substituted at facade seam",
  );
  tar.entry(
    { name: "backup/backup-manifest.json" },
    JSON.stringify({
      version: readPackageVersion(import.meta.url),
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      includeIndex: false,
      files: [
        {
          name: "omnesis.db",
          bytes: Buffer.byteLength(
            "invented input database, native parsing substituted at facade seam",
          ),
        },
      ],
    }),
  );
  tar.finalize();
  await read;
  const path = join(directory, "selected.tar");
  await writeFile(path, Buffer.concat(blocks), { mode: 0o600 });
  const metadata = await stat(path, { bigint: true });
  return {
    path,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    bytes: Number(metadata.size),
    mtimeSeconds: String(metadata.mtimeNs / 1_000_000_000n),
    mtimeNanoseconds: String(metadata.mtimeNs % 1_000_000_000n),
  };
}
async function imported() {
  const slot = await service.prepare(new AbortController().signal),
    selection = await archive();
  expect(
    await service.ingest(slot.importId, selection, new AbortController().signal),
  ).toMatchObject({ imported: true });
  return { slot, selection };
}

test("requires its own one-use preview confirmation and reports committed pending actual startup verification", async () => {
  const { slot } = await imported();
  await expect(service.apply("a".repeat(64), new AbortController().signal)).rejects.toThrow(
    "confirm replacing",
  );
  expect(seams.prepare).not.toHaveBeenCalled();
  const preview = await service.preview(slot.importId, {}, new AbortController().signal);
  expect(preview).toMatchObject({
    status: "ready",
    willCreateRecoveryCopy: true,
    willPauseModelRoles: true,
    willPauseAutomaticDeletion: true,
    protection: "plaintext",
    summary: { documents: 4, sources: 2 },
  });
  if (preview.status !== "ready") throw new Error("Expected actual ready capability");
  expect(preview.summary.watches).toBeUndefined();
  expect(preview.summary.analyticsRows).toBeUndefined();
  expect(seams.inspect.mock.calls[0]?.[2]).toEqual(profile);
  expect(await service.apply(preview.confirmationId, new AbortController().signal)).toEqual({
    kind: "desktopRestoreResult",
    status: "committed",
    runtimeStopped: true,
    recoveryCopyRetained: true,
    sourcesPaused: 2,
    watchesPaused: 0,
    modelRolesPaused: true,
    automaticDeletionPaused: true,
  });
  expect(await service.status()).toMatchObject({
    status: "pending",
    canRecover: true,
    recoveryCopyRetained: true,
  });
  await expect(service.apply(preview.confirmationId, new AbortController().signal)).rejects.toThrow(
    "Preview",
  );
  expect(seams.prepare).toHaveBeenCalledTimes(1);
  expect(seams.closed).toHaveBeenCalled();
  expect(await readFile(join(profile.configDir, "token"), "utf8")).toBe("invented-current-token");
});

test("a cancelled selection deletes its owned encrypted spool while retaining the selected original", async () => {
  const { slot, selection } = await imported(),
    before = createHash("sha256")
      .update(await readFile(selection.path))
      .digest("hex");
  await service.preview(slot.importId, {}, new AbortController().signal);
  expect(await service.cancel(slot.importId)).toBeNull();
  await expect(
    stat(join(`${profile.configDir}.bootstrap`, "restore-imports", slot.importId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    createHash("sha256")
      .update(await readFile(selection.path))
      .digest("hex"),
  ).toBe(before);
  await expect(service.preview(slot.importId, {}, new AbortController().signal)).rejects.toThrow(
    "Select the backup again",
  );
});

test("closing the bridge aborts and drains a preview before deleting only its owned stage", async () => {
  const { slot } = await imported();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  seams.inspect.mockImplementation(
    (_options: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
  const preview = service.preview(slot.importId, {}, new AbortController().signal);
  const refused = expect(preview).rejects.toMatchObject({ name: "AbortError" });
  await waiting;
  await service.close();
  await refused;
  await expect(
    stat(join(`${profile.configDir}.bootstrap`, "restore-imports", slot.importId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(
    "invented previous ciphertext",
  );
});

test("tampered encrypted staging fails before database inspection or publication", async () => {
  const { slot } = await imported();
  const spool = join(
      `${profile.configDir}.bootstrap`,
      "restore-imports",
      slot.importId,
      "input.tar.enc",
    ),
    raw = await readFile(spool);
  raw[raw.length - 1] ^= 1;
  await writeFile(spool, raw);
  await expect(service.preview(slot.importId, {}, new AbortController().signal)).rejects.toThrow();
  expect(seams.inspect).not.toHaveBeenCalled();
  expect(seams.prepare).not.toHaveBeenCalled();
  expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(
    "invented previous ciphertext",
  );
});
