// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bashExecutable, prependPath, localSshFixturePath } from "../lib/test-shell.mjs";

test("Windows shell fixtures select Git Bash rather than WSL from PATH", () => {
  const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
  expect(
    bashExecutable({
      platform: "win32",
      env: { ProgramFiles: String.raw`C:\Program Files`, PATH: String.raw`C:\Windows\System32` },
      exists: (path) => path === gitBash,
    }),
  ).toBe(gitBash);
});
test("a missing Git Bash fails rather than silently using WSL", () => {
  expect(() => bashExecutable({ platform: "win32", env: {}, exists: () => false })).toThrow(
    "Git for Windows Bash is required",
  );
});
test("POSIX shell discovery and native PATH separators remain explicit", () => {
  expect(bashExecutable({ platform: "darwin" })).toBe("bash");
  expect(prependPath(String.raw`C:\fake tools`, String.raw`C:\Windows;C:\Node`, ";")).toBe(
    String.raw`C:\fake tools;C:\Windows;C:\Node`,
  );
  expect(prependPath("/fake tools", "/usr/bin:/bin", ":")).toBe("/fake tools:/usr/bin:/bin");
});

test("bridge guard fixtures execute locally and refuse transfer", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-ssh-fixture-"));
  try {
    const path = localSshFixturePath(directory);
    const env = { ...process.env, PATH: path };
    expect(
      execFileSync(bashExecutable(), ["-c", 'ssh ignored-fixture-host "printf fixture-success"'], {
        env,
        encoding: "utf8",
      }),
    ).toBe("fixture-success");
    const transfer = spawnSync(bashExecutable(), ["-c", "rsync ignored"], {
      env,
      encoding: "utf8",
    });
    expect(transfer.status).toBe(91);
    expect(transfer.stderr).toContain("Unexpected transfer");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
