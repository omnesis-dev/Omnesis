// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPrivateScratch } from "./private-scratch.js";
import { openSqliteSnapshot } from "./sqlite-snapshot.js";
import { ensurePrivateDirSync } from "./security-files.js";
import { copyWindowsPrivateFileSync } from "./windows-private-file.js";

const temporary = vi.hoisted(() => ({ base: "", actual: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  temporary.actual = actual.tmpdir();
  return { ...actual, tmpdir: () => temporary.base || actual.tmpdir() };
});
vi.mock("./security-files.js", async (original) => {
  const actual = await original<typeof import("./security-files.js")>();
  return { ...actual, ensurePrivateDirSync: vi.fn(actual.ensurePrivateDirSync) };
});
vi.mock("./windows-private-file.js", async (original) => {
  const actual = await original<typeof import("./windows-private-file.js")>();
  return { ...actual, copyWindowsPrivateFileSync: vi.fn(actual.copyWindowsPrivateFileSync) };
});

const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", nativePlatform);
  vi.restoreAllMocks();
  vi.mocked(ensurePrivateDirSync).mockReset();
  vi.mocked(copyWindowsPrivateFileSync).mockReset();
  if (temporary.base) rmSync(temporary.base, { recursive: true, force: true });
  temporary.base = "";
});

test.each([false, true])(
  "an unjoined native snapshot survives parent-death recovery (%s)",
  (nested) => {
    temporary.base = mkdtempSync(join(temporary.actual, "snapshot-retained-owner-"));
    const source = join(temporary.base, "History");
    writeFileSync(source, "invented source bytes");
    Object.defineProperty(process, "platform", { ...nativePlatform, value: "win32" });
    vi.mocked(ensurePrivateDirSync).mockImplementation(() => {});
    const marker = { cleanupFailure: undefined };
    const failure = Object.assign(
      new Error("Invented unjoined copy", nested ? { cause: marker } : undefined),
      nested ? {} : marker,
    );
    let scratch = "";
    vi.mocked(copyWindowsPrivateFileSync).mockImplementation((_from, to) => {
      scratch = dirname(to);
      // The fence must predate the worker, including an interrupted first write.
      expect(existsSync(join(scratch, ".process-join-required"))).toBe(true);
      writeFileSync(to, "invented incomplete bytes");
      throw failure;
    });
    expect(() => openSqliteSnapshot(source)).toThrow(failure);
    const retained = join(dirname(scratch), "2147483647-retained-snapshot");
    renameSync(scratch, retained);
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483647)
        throw Object.assign(new Error("Invented dead parent"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    const next = createPrivateScratch("next-snapshot");
    try {
      expect(readFileSync(join(retained, "History"), "utf8")).toBe("invented incomplete bytes");
      expect(readFileSync(source, "utf8")).toBe("invented source bytes");
    } finally {
      next.cleanup();
    }
  },
);
