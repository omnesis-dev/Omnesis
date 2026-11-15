// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { execWindowsJob } from "../src/windows-job-exec.js";
import { inspectWindowsPrivatePathSync } from "../src/windows-private-file.js";
import {
  denyOwnedDirectoryReads,
  snapshotWindowsFixtureAcl,
  windowsFixtureCleanupMustWait,
} from "./security-fixture-acl.js";

vi.mock("../src/windows-job-exec.js", () => ({ execWindowsJob: vi.fn() }));
vi.mock("../src/windows-process-tree.js", () => ({
  windowsPowerShellExecutable: () => "fictional-powershell.exe",
}));
vi.mock("../src/windows-private-file.js", () => ({ inspectWindowsPrivatePathSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test.each(["own", "cause"] as const)(
  "a %s undefined marker preserves the affected fixture root and descendants only",
  async (placement) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-acl-uncertain-"));
    const independent = mkdtempSync(join(tmpdir(), "doctor-acl-independent-"));
    const path = join(root, "keyring", "marker");
    const marker = { cleanupFailure: undefined };
    const error =
      placement === "own" ? marker : new Error("Invented nested helper failure", { cause: marker });
    vi.mocked(execWindowsJob).mockRejectedValueOnce(error);
    try {
      await expect(snapshotWindowsFixtureAcl(path)).rejects.toBe(error);
      expect(windowsFixtureCleanupMustWait(root)).toBe(true);
      expect(windowsFixtureCleanupMustWait(join(root, "keyring"))).toBe(true);
      expect(windowsFixtureCleanupMustWait(path)).toBe(true);
      expect(windowsFixtureCleanupMustWait(independent)).toBe(false);
      expect(windowsFixtureCleanupMustWait(`${root}-sibling`)).toBe(false);
    } finally {
      // The injected seam started no process; these two synthetic roots are joined.
      rmSync(root, { recursive: true, force: true });
      rmSync(independent, { recursive: true, force: true });
    }
  },
);

test("a joined ordinary helper failure does not retain fixture cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-acl-joined-"));
  const error = new Error("Invented ordinary ACL failure");
  vi.mocked(execWindowsJob).mockRejectedValueOnce(error);
  try {
    await expect(snapshotWindowsFixtureAcl(join(root, "marker"))).rejects.toBe(error);
    expect(windowsFixtureCleanupMustWait(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private inspection uncertainty before ACL capture also retains its owned root", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-private-uncertain-"));
  const directory = join(root, "keyring");
  const child = join(directory, "marker");
  mkdirSync(directory);
  writeFileSync(child, "invented marker");
  const error = { cleanupFailure: undefined };
  vi.mocked(inspectWindowsPrivatePathSync).mockImplementationOnce(() => {
    throw error;
  });
  try {
    await expect(denyOwnedDirectoryReads(directory, child)).rejects.toBe(error);
    expect(execWindowsJob).not.toHaveBeenCalled();
    expect(windowsFixtureCleanupMustWait(root)).toBe(true);
    expect(windowsFixtureCleanupMustWait(join(directory, "nested"))).toBe(true);
  } finally {
    // No native helper ran: uncertainty is wholly injected at the held seam.
    rmSync(root, { recursive: true, force: true });
  }
});
