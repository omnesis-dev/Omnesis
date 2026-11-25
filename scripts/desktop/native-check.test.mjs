// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nativeCheckOptions, runNativeCheck, shellArgument } from "./native-check.mjs";

// This POSIX build bridge uses SSH, Python and rsync; it is not a Windows runtime lane.
const posixTest = test.skipIf(process.platform === "win32");

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-desktop-native-")));
  roots.push(root);
  return {
    root,
    options: {
      host: "fixture-build-host",
      worktree: join(root, "scratch"),
      lane: "logic",
      buildOnly: false,
    },
  };
}
function runner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "ssh" && options.input?.includes("marker =")) {
      return spawnSync("sh", ["-c", args[1]], { input: options.input, encoding: "utf8" });
    }
    return { status: 0 };
  };
}

test("requires explicit host and owned scratch configuration", () => {
  expect(() => nativeCheckOptions(["logic"], {})).toThrow(/HOST/);
  expect(() =>
    nativeCheckOptions(["logic"], { OMNESIS_EPIC_MACOS_HOST: "-oProxyCommand=unsafe" }),
  ).toThrow(/HOST/);
  expect(() => nativeCheckOptions(["logic"], { OMNESIS_EPIC_MACOS_HOST: "fixture" })).toThrow(
    /WORKTREE/,
  );
  expect(() => nativeCheckOptions(["logic", "--build-only"], {})).toThrow(/Usage/);
});

posixTest("shell arguments preserve literal spaces, quotes and command substitutions", () => {
  const value = "a path with 'quotes' and $(an-untrusted-command)";
  const result = spawnSync("sh", ["-c", `printf '%s' ${shellArgument(value)}`], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(value);
});

posixTest("claims a private scratch directory before syncing only pure native sources", () => {
  const { options } = fixture();
  const calls = [];
  runNativeCheck(options, runner(calls));
  expect(calls[0].command).toBe("ssh");
  expect(existsSync(join(options.worktree, ".omnesis-desktop-scratch"))).toBe(true);
  const syncs = calls.filter((call) => call.command === "rsync");
  expect(syncs).toHaveLength(1);
  expect(syncs[0].args.at(-2)).toMatch(/\/macos\/$/);
  expect(calls.at(-1).options.input).toContain("swift test --package-path macos");
});

posixTest("an occupied unclaimed directory is refused before any rsync", () => {
  const { options } = fixture();
  mkdirSync(options.worktree, { mode: 0o700 });
  writeFileSync(join(options.worktree, "keep.txt"), "unrelated data");
  const calls = [];
  expect(() => runNativeCheck(options, runner(calls))).toThrow(/ssh failed/);
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(options.worktree, "keep.txt"), "utf8")).toBe("unrelated data");
});

posixTest("a claimed scratch cannot redirect source sync through a symbolic link", () => {
  const { options, root } = fixture();
  mkdirSync(options.worktree, { mode: 0o700 });
  writeFileSync(join(options.worktree, ".omnesis-desktop-scratch"), "desktop-native-v1\n");
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "unrelated data");
  symlinkSync(unrelated, join(options.worktree, "macos"));
  const calls = [];
  expect(() => runNativeCheck(options, runner(calls))).toThrow(/ssh failed/);
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("unrelated data");
});

posixTest(
  "application checks sync shared Swift client code and keep build-only signing disabled",
  () => {
    const { options } = fixture();
    const calls = [];
    runNativeCheck({ ...options, lane: "test", buildOnly: true }, runner(calls));
    expect(calls.filter((call) => call.command === "rsync")).toHaveLength(2);
    expect(calls.at(-1).args[1]).toContain("'yes'");
    expect(calls.at(-1).options.input).toContain(
      'if [ "$action" = build ]; then\n    signing_allowed=NO',
    );
    expect(calls.at(-1).options.input).toContain('CODE_SIGN_IDENTITY="$signing_identity"');
  },
);

posixTest("UI tests use ad-hoc Debug signing without a paid team identity", () => {
  const { options } = fixture();
  const calls = [];
  runNativeCheck({ ...options, lane: "test" }, runner(calls));
  const script = calls.at(-1).options.input;
  expect(script).toContain("signing_allowed=YES\n  signing_required=YES\n  signing_identity=-");
  expect(script).toContain("CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=''");
  expect(script).toContain("CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES");
});

posixTest("real rsync preserves a remote filespec with spaces and quotes", () => {
  const { options, root } = fixture();
  const source = join(root, "source");
  mkdirSync(join(source, "macos"), { recursive: true });
  writeFileSync(join(source, "macos", "Package.swift"), "// fixture package\n");
  const ssh = join(root, "fixture-ssh");
  writeFileSync(ssh, '#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  const calls = [];
  const mock = runner(calls);
  const run = (command, args, config) =>
    command === "rsync"
      ? spawnSync(command, args, {
          ...config,
          stdio: "pipe",
          env: { ...process.env, ...config.env, RSYNC_RSH: ssh },
        })
      : mock(command, args, config);
  const worktree = join(root, "scratch with 'quote'");
  runNativeCheck({ ...options, worktree }, run, source);
  expect(readFileSync(join(worktree, "macos", "Package.swift"), "utf8")).toBe(
    "// fixture package\n",
  );
});

posixTest("artifact retrieval does not replace the original native check failure", () => {
  const { options, root } = fixture();
  const calls = [];
  const mock = runner(calls);
  const run = (command, args, config) => {
    if (command === "ssh" && config.input?.includes("swift test")) return { status: 1 };
    if (command === "rsync" && args.at(-2).includes("evidence")) return { status: 23 };
    return mock(command, args, config);
  };
  expect(() => runNativeCheck({ ...options, output: join(root, "output") }, run)).toThrow(
    "Desktop native ssh failed",
  );
});

posixTest(
  "the remote check script has valid shell syntax and retains failure-aware screenshot collection",
  () => {
    const { options } = fixture();
    const calls = [];
    runNativeCheck({ ...options, lane: "test" }, runner(calls));
    const script = calls.filter((call) => call.command === "ssh").at(-1).options.input;
    expect(spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" }).status).toBe(0);
    expect(script).toContain("trap collect_screenshots EXIT");
    expect(script).toContain('exit "$status"');
  },
);
