// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  bashExecutable,
  bashEnvironment,
  bashFixturePath,
  bashScriptArguments,
  prependPath,
  localSshFixturePath,
} from "../lib/test-shell.mjs";

test("Windows shell fixtures select Git Bash rather than WSL from PATH", () => {
  const gitBash = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;
  expect(
    bashExecutable({
      platform: "win32",
      env: { ProgramFiles: String.raw`C:\Program Files`, PATH: String.raw`C:\Windows\System32` },
      exists: (path) => path === gitBash,
    }),
  ).toBe(gitBash);
});
test("Windows fixtures prefer the interpreter when the PATH-rewriting redirector also exists", () => {
  expect(
    bashExecutable({
      platform: "win32",
      env: { ProgramFiles: String.raw`C:\Program Files` },
      exists: () => true,
    }),
  ).toBe(String.raw`C:\Program Files\Git\usr\bin\bash.exe`);
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
    const nestedTransfer = spawnSync(
      bashExecutable(),
      ["-c", 'ssh ignored-fixture-host "rsync ignored"'],
      {
        env,
        encoding: "utf8",
      },
    );
    expect(nestedTransfer.status).toBe(91);
    expect(nestedTransfer.stderr).toContain("Unexpected transfer");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bash environment keeps Windows tool overrides first with one native PATH key", () => {
  const env = {
    PATH: String.raw`C:\fixture;C:\Windows`,
    Path: "ignored duplicate",
    NODE_OPTIONS: "--no-warnings",
    INVENTED: "retained",
  };
  const prepared = bashEnvironment(env, {
    platform: "win32",
    executable: String.raw`C:\Git\usr\bin\bash.exe`,
  });
  expect(prepared).toEqual({
    PATH: String.raw`C:\fixture;C:\Windows;C:\Git\usr\bin`,
    MSYS: "winsymlinks:nativestrict",
    NODE_OPTIONS: "--no-warnings",
    INVENTED: "retained",
  });
  expect(env.Path).toBe("ignored duplicate");
  expect(
    bashEnvironment(prepared, {
      platform: "win32",
      executable: String.raw`C:\Git\usr\bin\bash.exe`,
    }),
  ).toEqual(prepared);
  expect(bashEnvironment(env, { platform: "linux" })).toEqual(env);
});

test("Bash fixtures normalize drive-path data without rewriting command text or caller environment", () => {
  const path = String.raw`C:\fixture space's\configuration`;
  const command = String.raw`C:\tools\node.exe --literal \n`;
  const env = {
    PATH: String.raw`C:\fixture`,
    OMNESIS_CONFIG_DIR: path,
    FIXTURE_COMMAND: command,
    msys: "other-fixture-option winsymlinks:lnk",
  };
  const prepared = bashEnvironment(env, {
    platform: "win32",
    executable: String.raw`C:\Git\usr\bin\bash.exe`,
    pathKeys: ["OMNESIS_CONFIG_DIR"],
  });
  expect(prepared.OMNESIS_CONFIG_DIR).toBe("C:/fixture space's/configuration");
  expect(prepared.FIXTURE_COMMAND).toBe(command);
  expect(prepared.MSYS).toBe("other-fixture-option winsymlinks:nativestrict");
  expect(prepared).not.toHaveProperty("msys");
  expect(env.msys).toBe("other-fixture-option winsymlinks:lnk");
  expect(bashScriptArguments(["-c", command, "--", path], "win32")).toEqual([
    "-c",
    command,
    "--",
    path,
  ]);
  expect(bashScriptArguments([path, command], "win32")).toEqual([
    "C:/fixture space's/configuration",
    command,
  ]);
  expect(env.OMNESIS_CONFIG_DIR).toBe(path);
  expect(bashFixturePath(path, "win32")).toBe("C:/fixture space's/configuration");
  expect(bashFixturePath(path, "linux")).toBe(path);
  expect(bashFixturePath("/tmp/fixture", "win32")).toBe("/tmp/fixture");
  expect(bashFixturePath("\\rooted-without-a-drive", "win32")).toBe("\\rooted-without-a-drive");
});
