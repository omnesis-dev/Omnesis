// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BACKUP_MANIFEST_NAME, writeOfflineBackup } from "./backup-layout.js";
import { ensurePrivateDirSync } from "./security-files.js";
import { copyWindowsPrivateFileSync } from "./windows-private-file.js";

vi.mock("./security-files.js", async (original) => {
  const actual = await original<typeof import("./security-files.js")>();
  return { ...actual, ensurePrivateDirSync: vi.fn(actual.ensurePrivateDirSync) };
});
vi.mock("./windows-private-file.js", async (original) => {
  const actual = await original<typeof import("./windows-private-file.js")>();
  return { ...actual, copyWindowsPrivateFileSync: vi.fn(actual.copyWindowsPrivateFileSync) };
});

const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", nativePlatform);
  vi.mocked(ensurePrivateDirSync).mockReset();
  vi.mocked(copyWindowsPrivateFileSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(
  [false, true].flatMap((nested) =>
    [undefined, new Error("Invented copy join failure")].map((cleanupFailure) => ({
      nested,
      cleanupFailure,
    })),
  ),
)("an unjoined backup copy retains its unpublished directory ($nested)", (shape) => {
  const configDir = mkdtempSync(join(tmpdir(), "backup-copy-uncertain-"));
  roots.push(configDir);
  const source = join(configDir, ".env");
  writeFileSync(source, "INVENTED_FIXTURE=retained\n");
  Object.defineProperty(process, "platform", { ...nativePlatform, value: "win32" });
  vi.mocked(ensurePrivateDirSync).mockImplementation(() => {});
  const marker = { cleanupFailure: shape.cleanupFailure };
  const failure = Object.assign(
    new Error("Invented copy refusal", shape.nested ? { cause: marker } : undefined),
    { code: "EPRIVATE", ...(shape.nested ? {} : marker) },
  );
  let destination = "";
  const copy = vi.mocked(copyWindowsPrivateFileSync).mockImplementation((_from, to) => {
    destination = to;
    writeFileSync(to, "invented unpublished bytes");
    throw failure;
  });
  let observed: unknown;
  try {
    writeOfflineBackup({
      configDir,
      stores: [],
      includeIndex: false,
      version: "9.9.0",
      purpose: "operator",
      statfs: () => ({ bavail: 1_000_000, bsize: 4096 }),
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(copy).toHaveBeenCalledOnce();
  expect(existsSync(destination)).toBe(true);
  expect(readFileSync(destination, "utf8")).toBe("invented unpublished bytes");
  expect(existsSync(join(dirname(destination), BACKUP_MANIFEST_NAME))).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("INVENTED_FIXTURE=retained\n");
});
