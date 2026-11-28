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
  statSync,
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

test("logic filters accept a single named suite or case and reject flags or shell syntax", () => {
  const env = {
    OMNESIS_EPIC_MACOS_HOST: "fixture",
    OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE: "/tmp/owned-fixture",
  };
  for (const filter of [
    "BackgroundOriginRegistrationTests",
    "DesktopCoreTests.BackgroundOriginRegistrationTests/testActualOwnedClientExitProvidesDeathProofWithoutTimeoutOrExpiry",
  ]) {
    expect(nativeCheckOptions(["logic", "--filter", filter], env)).toMatchObject({
      lane: "logic",
      filter,
    });
  }
  for (const flags of [
    ["--filter"],
    ["--filter", "--package"],
    ["--filter", "Suite;touch marker"],
    ["--filter", "$(command)"],
    ["--filter", "Suite/../Other"],
    ["--filter", "Suite", "--filter", "Other"],
    ["--filter", "Suite", "--build-only"],
  ]) {
    expect(() => nativeCheckOptions(["logic", ...flags], env)).toThrow(/Usage/);
  }
  expect(() => nativeCheckOptions(["test", "--filter", "Suite"], env)).toThrow(/Usage/);
});

test("hosted filters accept one bounded class or test method only with hosted-only scope", () => {
  const env = {
    OMNESIS_EPIC_MACOS_HOST: "fixture",
    OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE: "/tmp/owned-fixture",
  };
  for (const filter of [
    "DesktopSourceSetupTests",
    "DesktopSourceSetupTests/testFailedRegistrationRetainsAnAccountRecoveryActionAfterSignInCompleted",
    "A".repeat(128) + "/test" + "x".repeat(124),
  ]) {
    expect(nativeCheckOptions(["test", "--hosted-only", "--filter", filter], env)).toMatchObject({
      lane: "test",
      hostedOnly: true,
      filter,
      buildOnly: false,
      package: false,
    });
  }
  for (const filter of [
    "",
    "/testCase",
    "Suite/",
    "Suite/otherMethod",
    "Suite/testCase()",
    "Module.Suite",
    "OmnesisDesktopUITests/Suite/testCase",
    "Suite//testCase",
    "Suite/../Other",
    "Suite;touch marker",
    "$(command)",
    "Suite\n",
    "Suite\0",
    "A".repeat(129),
    "Suite/test" + "x".repeat(125),
  ]) {
    expect(() => nativeCheckOptions(["test", "--hosted-only", "--filter", filter], env)).toThrow(
      /Usage/,
    );
  }
  for (const flags of [
    ["--filter", "Suite"],
    ["--hosted-only", "--filter"],
    ["--filter", "Suite", "--hosted-only"],
    ["--hosted-only", "--filter", "Suite", "--filter", "Other"],
    ["--build-only", "--hosted-only", "--filter", "Suite"],
    ["--hosted-only", "--filter", "Suite", "--package"],
  ])
    expect(() => nativeCheckOptions(["test", ...flags], env)).toThrow(/Usage/);
});

function hostedShellFixture({
  hostedOnly = true,
  filter,
  summary,
  summaryStatus = 0,
  schemaStatus = 0,
  testStatus = 0,
  buildStatus = 0,
  compileTests = false,
}) {
  const { root, options } = fixture();
  const calls = [],
    mock = runner(calls);
  const capture = join(root, "xcode-arguments"),
    tools = join(root, "tools");
  const xcrunCapture = join(root, "xcrun-arguments"),
    summaryPath = join(root, "summary.json");
  mkdirSync(tools, { mode: 0o700 });
  writeFileSync(
    summaryPath,
    summary ??
      JSON.stringify({ totalTestCount: 2, passedTests: 1, failedTests: 0, skippedTests: 1 }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(tools, "xcrun"),
    `#!/bin/sh
printf '%s\\0' "$@" > "$FIXTURE_XCRUN_CAPTURE"
cat "$FIXTURE_SUMMARY"
exit "$FIXTURE_SUMMARY_STATUS"
`,
    { mode: 0o700 },
  );
  let execution;
  const run = (command, args, config) => {
    if (command === "ssh" && config.input?.includes('if [ "$2" = logic ]')) {
      calls.push({ command, args, options: config });
      execution = spawnSync("bash", ["-c", args[1]], {
        input:
          `xcodegen() { return 0; }
xcodebuild() { printf '%s\\0' "$@" >> "$FIXTURE_CAPTURE"; printf '\\0' >> "$FIXTURE_CAPTURE"; printf '%s\\n' "\${@: -1}" >> "$FIXTURE_CAPTURE.phases"; if [ "\${@: -1}" = test-without-building ]; then return "$FIXTURE_TEST_STATUS"; fi; return "$FIXTURE_BUILD_STATUS"; }
python3() { if [ "\${1-}" = Tests/Support/capture-generated-test-schema.py ]; then printf 'schema\\n' >> "$FIXTURE_CAPTURE.phases"; return "$FIXTURE_SCHEMA_STATUS"; fi; cat >/dev/null; }
` + config.input,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          FIXTURE_CAPTURE: capture,
          FIXTURE_TOOLS: tools,
          FIXTURE_XCRUN_CAPTURE: xcrunCapture,
          FIXTURE_SUMMARY: summaryPath,
          FIXTURE_SUMMARY_STATUS: String(summaryStatus),
          FIXTURE_SCHEMA_STATUS: String(schemaStatus),
          FIXTURE_TEST_STATUS: String(testStatus),
          FIXTURE_BUILD_STATUS: String(buildStatus),
        },
      });
      return execution;
    }
    const result = mock(command, args, config);
    if (command === "ssh" && config.input?.includes("marker =")) {
      mkdirSync(join(options.worktree, "macos/.node-fixture"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(options.worktree, "macos/.node-fixture/node"),
        `#!/bin/sh
printf '%s\\n' "$1" >> "$FIXTURE_CAPTURE.node"
if [ "$1" = --input-type=module ]; then
  export PATH="$FIXTURE_TOOLS:/usr/bin:/bin"
  exec ${shellArgument(process.execPath)} "$@"
fi
[ "$1" = Tests/Support/normalize-test-runner-signature.mjs ] || exit 99
`,
        { mode: 0o700 },
      );
    }
    return result;
  };
  return {
    calls,
    capture,
    xcrunCapture,
    worktree: options.worktree,
    execute: () =>
      runNativeCheck(
        { ...options, lane: "test", hostedOnly, filter, buildOnly: compileTests, compileTests },
        run,
      ),
    execution: () => execution,
    receipt: () => {
      const args = readFileSync(xcrunCapture, "utf8").split("\0").slice(0, -1);
      expect(args.slice(0, -1)).toEqual([
        "xcresulttool",
        "get",
        "test-results",
        "summary",
        "--path",
      ]);
      const directory = join(options.worktree, "macos", args.at(-1) + ".filtered-hosted");
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      for (const file of ["summary.json", "receipt.json"])
        expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
      return JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
    },
  };
}

posixTest.each([
  { hostedOnly: true, filter: "DesktopSourceSetupTests" },
  {
    hostedOnly: true,
    filter:
      "DesktopSourceSetupTests/testFailedRegistrationRetainsAnAccountRecoveryActionAfterSignInCompleted",
  },
  { hostedOnly: true, filter: undefined },
  { hostedOnly: false, filter: undefined },
])(
  "actual hosted shell preserves the fixed target and subset scope (%j)",
  ({ hostedOnly, filter }) => {
    const fixture = hostedShellFixture({ hostedOnly, filter });
    fixture.execute();
    const invocations = readFileSync(fixture.capture, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((value) => value.split("\0"));
    expect(invocations).toHaveLength(2);
    expect(invocations[0].at(-1)).toBe("build-for-testing");
    expect(invocations[1].at(-1)).toBe("test-without-building");
    expect(invocations[0].filter((arg) => arg.startsWith("-only-testing:"))).toEqual([]);
    expect(invocations[1].filter((arg) => arg.startsWith("-only-testing:"))).toEqual(
      hostedOnly ? [`-only-testing:OmnesisDesktopTests${filter ? "/" + filter : ""}`] : [],
    );
    if (filter) {
      expect(
        fixture.calls
          .find(
            (call) => call.command === "ssh" && call.options.input?.includes('if [ "$2" = logic ]'),
          )
          .args[1].endsWith(shellArgument(filter)),
      ).toBe(true);
      expect(fixture.execution().stdout).toContain(
        `FILTERED hosted application subset OmnesisDesktopTests/${filter}`,
      );
      expect(fixture.execution().stdout).toContain("NOT the complete hosted/Core/external-UI gate");
      expect(fixture.receipt()).toMatchObject({
        qualified: true,
        selector: filter,
        counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
      });
    } else {
      expect(fixture.execution().stdout).not.toContain("FILTERED");
      expect(existsSync(fixture.xcrunCapture)).toBe(false);
    }
  },
);

posixTest("real selected-run validator accepts an entirely passing selected case", () => {
  const fixture = hostedShellFixture({
    filter: "Suite/testCase",
    summary: JSON.stringify({ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0 }),
  });
  fixture.execute();
  expect(fixture.execution().status).toBe(0);
  expect(fixture.receipt()).toMatchObject({
    qualified: true,
    counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
  });
});

posixTest.each([
  { totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0 },
  { totalTestCount: 2, passedTests: 0, failedTests: 0, skippedTests: 2 },
  { totalTestCount: 2, passedTests: 1, failedTests: 1, skippedTests: 0 },
  { totalTestCount: 1, passedTests: "1", failedTests: 0, skippedTests: 0 },
  { totalTestCount: 1, passedTests: true, failedTests: 0, skippedTests: 0 },
  { totalTestCount: 1, passedTests: 1, failedTests: -1, skippedTests: 1 },
  { totalTestCount: 1, passedTests: 0.5, failedTests: 0, skippedTests: 0.5 },
  { totalTestCount: 1, passedTests: 1, failedTests: 0 },
  { totalTestCount: 1000001, passedTests: 1000001, failedTests: 0, skippedTests: 0 },
  { totalTestCount: 2, passedTests: 1, failedTests: 0, skippedTests: 0 },
  null,
  [],
])(
  "real selected-run validator refuses invalid or nonpassing counts despite Xcode success (%j)",
  (summary) => {
    const fixture = hostedShellFixture({
      filter: "Suite/testCase",
      summary: JSON.stringify(summary),
    });
    expect(() => fixture.execute()).toThrow();
    expect(fixture.execution().status).not.toBe(0);
    expect(fixture.receipt().qualified).toBe(false);
  },
);

posixTest.each([
  { summary: "not JSON", summaryStatus: 0 },
  { summary: " ".repeat(1024 * 1024 + 1), summaryStatus: 0 },
  {
    summary: JSON.stringify({ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0 }),
    summaryStatus: 1,
  },
])("real selected-run validator refuses malformed, oversized or failed summary tool", (options) => {
  const fixture = hostedShellFixture({ ...options, filter: "Suite" });
  expect(() => fixture.execute()).toThrow();
  expect(fixture.execution().status).not.toBe(0);
  expect(fixture.receipt().qualified).toBe(false);
});

posixTest(
  "the actual logic shell dispatch passes only the selected case as one Swift argument",
  () => {
    const { root, options } = fixture();
    const calls = [];
    const mock = runner(calls);
    const capture = join(root, "swift-arguments");
    const filter =
      "BackgroundOriginRegistrationTests/testActualOwnedClientExitProvidesDeathProofWithoutTimeoutOrExpiry";
    const run = (command, args, config) => {
      if (command === "ssh" && config.input?.includes('if [ "$2" = logic ]')) {
        calls.push({ command, args, options: config });
        return spawnSync("bash", ["-c", args[1]], {
          input: 'swift() { printf "%s\\0" "$@" > "$OMNESIS_LOGIC_ARGUMENTS"; }\n' + config.input,
          encoding: "utf8",
          env: { ...process.env, OMNESIS_LOGIC_ARGUMENTS: capture },
        });
      }
      return mock(command, args, config);
    };
    runNativeCheck({ ...options, filter }, run);
    expect(readFileSync(capture, "utf8").split("\0")).toEqual([
      "test",
      "--package-path",
      "macos",
      "--filter",
      filter,
      "",
    ]);
    runNativeCheck(options, run);
    expect(readFileSync(capture, "utf8").split("\0")).toEqual([
      "test",
      "--package-path",
      "macos",
      "",
    ]);
  },
);

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

posixTest("scratch ownership markers are never followed or rewritten through aliases", () => {
  const { options, root } = fixture();
  mkdirSync(options.worktree, { mode: 0o700 });
  const unrelated = join(root, "unrelated-marker");
  writeFileSync(unrelated, "desktop-native-v1\n");
  symlinkSync(unrelated, join(options.worktree, ".omnesis-desktop-scratch"));
  const calls = [];
  expect(() => runNativeCheck(options, runner(calls))).toThrow(/ssh failed/);
  expect(calls).toHaveLength(1);
  expect(readFileSync(unrelated, "utf8")).toBe("desktop-native-v1\n");
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
    expect(calls.at(-1).options.input).toContain("configuration=Release");
    expect(calls.at(-1).options.input).toContain('-configuration "$configuration"');
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
  expect(script).toContain("-parallel-testing-enabled NO");
  expect(script).toContain("--inspect-products");
  expect(script).toContain("test-runner-signature-after.json");
  expect(script.indexOf("desktop_xcodebuild build-for-testing")).toBeLessThan(
    script.indexOf("normalize-test-runner-signature.mjs --products"),
  );
  expect(script.indexOf("normalize-test-runner-signature.mjs --products")).toBeLessThan(
    script.indexOf('desktop_xcodebuild -resultBundlePath "$result" test-without-building'),
  );
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

test("hosted-only diagnosis is an explicit mutually exclusive test scope", () => {
  const env = {
    OMNESIS_EPIC_MACOS_HOST: "fixture",
    OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE: "/tmp/fixture-native",
  };
  expect(nativeCheckOptions(["test", "--hosted-only"], env)).toMatchObject({
    hostedOnly: true,
    buildOnly: false,
  });
  expect(() => nativeCheckOptions(["logic", "--hosted-only"], env)).toThrow("Usage");
  expect(() => nativeCheckOptions(["test", "--hosted-only", "--build-only"], env)).toThrow("Usage");
});

test("whole-package qualification requires the explicit Release build scope", () => {
  const env = {
    OMNESIS_EPIC_MACOS_HOST: "fixture",
    OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE: "/tmp/fixture-native",
  };
  expect(nativeCheckOptions(["test", "--build-only", "--package"], env)).toMatchObject({
    package: true,
    buildOnly: true,
    hostedOnly: false,
  });
  for (const args of [
    ["test", "--package"],
    ["logic", "--package"],
    ["test", "--hosted-only", "--package"],
    ["test", "--build-only", "--package", "--package"],
  ])
    expect(() => nativeCheckOptions(args, env)).toThrow("Usage");
});

posixTest("package checks transfer the normalized fixture and extract before building", () => {
  const { options } = fixture();
  const calls = [];
  runNativeCheck({ ...options, lane: "test", buildOnly: true, package: true }, runner(calls));
  expect(calls.filter((call) => call.command === "rsync")).toHaveLength(2);
  const extraction = calls.findIndex((call) =>
    call.options.input?.includes("extract.mjs --fixture"),
  );
  const build = calls.findIndex((call) => call.options.input?.includes("swift test"));
  expect(extraction).toBeGreaterThan(0);
  expect(extraction).toBeLessThan(build);
  expect(calls.at(-1).options.input).toContain(
    "package-source/source/scripts/desktop/native-package.mjs",
  );
});

posixTest(
  "hosted-only execution records its scope and leaves the full UI runner as default",
  () => {
    const { options } = fixture();
    const calls = [];
    runNativeCheck({ ...options, lane: "test", hostedOnly: true }, runner(calls));
    const script = calls.at(-1).options.input;
    expect(calls.at(-1).args[1]).toMatch(/'no' 'yes' 'no'$/u);
    expect(script).toContain('if [ "$4" = yes ]; then');
    expect(script).toContain("-only-testing:OmnesisDesktopTests test-without-building");
    expect(script).toContain(
      'else\n      desktop_xcodebuild -resultBundlePath "$result" test-without-building',
    );
  },
);

posixTest.each([false, true])(
  "emitted Release shell runs analytics once through the selected package path (%s)",
  (packageMode) => {
    const { options, root } = fixture();
    const calls = [];
    runNativeCheck(
      { ...options, lane: "test", buildOnly: true, package: packageMode },
      runner(calls),
    );
    const tools = join(root, "owned-tools.sh"),
      log = join(root, "commands.log");
    writeFileSync(
      tools,
      `xcodegen() { printf 'generate\\n' >> "$FIXTURE_LOG"; }
xcodebuild() { printf 'xcode:%s\\n' "$*" >> "$FIXTURE_LOG"; }
python3() { return 0; }
`,
      { mode: 0o600 },
    );
    const node = join(options.worktree, "macos/.node-fixture/node");
    mkdirSync(join(options.worktree, "macos/.node-fixture"), { recursive: true, mode: 0o700 });
    writeFileSync(
      node,
      `#!/bin/sh
case "$1" in
  *build-analytics.mjs) printf 'analytics\\n' >> "$FIXTURE_LOG" ;;
  *native-package.mjs) printf 'package\\n' >> "$FIXTURE_LOG" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o700 },
    );
    const env = { PATH: "/usr/bin:/bin", HOME: root, BASH_ENV: tools, FIXTURE_LOG: log };
    const check = calls.find(
      (call) => call.command === "ssh" && call.options.input?.includes("swift test --package-path"),
    );
    expect(check).toBeDefined();
    expect(check.args[1].endsWith(shellArgument(packageMode ? "yes" : "no"))).toBe(true);
    const result = spawnSync("bash", ["-c", check.args[1]], {
      env,
      input: check.options.input,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    const packageCall = calls.find(
      (call) =>
        call.command === "ssh" &&
        call.options.input?.includes(
          "exec macos/.node-fixture/node package-source/source/scripts/desktop/native-package.mjs",
        ),
    );
    if (packageMode) {
      expect(packageCall).toBeDefined();
      const packaged = spawnSync("bash", ["-c", packageCall.args[1]], {
        env,
        input: packageCall.options.input,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(packaged.status, packaged.stderr).toBe(0);
    } else expect(packageCall).toBeUndefined();
    const commands = readFileSync(log, "utf8").trim().split("\n");
    expect(commands[0]).toBe("generate");
    expect(commands[1]).toContain("-configuration Release");
    expect(commands[1]).toContain(" build");
    expect(commands.slice(2)).toEqual([packageMode ? "package" : "analytics"]);
  },
);

posixTest.each([0, 23])(
  "generated-schema diagnostic failure preserves actual native test status (%s)",
  (testStatus) => {
    const fixture = hostedShellFixture({ hostedOnly: false, schemaStatus: 77, testStatus });
    const run = () => fixture.execute();
    if (testStatus === 0) expect(run).not.toThrow();
    else expect(run).toThrow();
    expect(fixture.execution().status).toBe(testStatus);
    expect(
      readFileSync(fixture.capture + ".phases", "utf8")
        .trim()
        .split("\n"),
    ).toEqual(["build-for-testing", "schema", "test-without-building"]);
  },
);

test("test compilation requires its closed build-only combination", () => {
  const env = {
    OMNESIS_EPIC_MACOS_HOST: "fixture",
    OMNESIS_EPIC_MACOS_DESKTOP_WORKTREE: "/tmp/owned-compile-fixture",
  };
  expect(nativeCheckOptions(["test", "--build-only", "--compile-tests"], env)).toMatchObject({
    buildOnly: true,
    compileTests: true,
    package: false,
    hostedOnly: false,
    filter: undefined,
  });
  for (const args of [
    ["test", "--compile-tests"],
    ["logic", "--compile-tests"],
    ["logic", "--build-only", "--compile-tests"],
    ["test", "--compile-tests", "--compile-tests"],
    ["test", "--build-only", "--compile-tests", "--package"],
    ["test", "--build-only", "--compile-tests", "--hosted-only"],
    ["test", "--build-only", "--compile-tests", "--filter", "FixtureTests"],
    ["test", "--build-only", "--compile-tests;unsafe"],
  ])
    expect(() => nativeCheckOptions(args, env)).toThrow("Usage");
});

posixTest.each([0, 19])(
  "actual compile-only shell builds Debug test products without launching tests or analytics (%s)",
  (buildStatus) => {
    const fixture = hostedShellFixture({
      compileTests: true,
      hostedOnly: false,
      buildStatus,
      schemaStatus: 77,
    });
    if (buildStatus === 0) expect(() => fixture.execute()).not.toThrow();
    else expect(() => fixture.execute()).toThrow();
    expect(fixture.execution().status).toBe(buildStatus);
    const invocations = readFileSync(fixture.capture, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((v) => v.split("\0"));
    expect(invocations).toHaveLength(1);
    const args = invocations[0];
    expect(args.at(-1)).toBe("build-for-testing");
    expect(args[args.indexOf("-configuration") + 1]).toBe("Debug");
    expect(args).toEqual(
      expect.arrayContaining([
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGNING_REQUIRED=YES",
      ]),
    );
    expect(args.filter((v) => v.startsWith("-only-testing:"))).toEqual([]);
    expect(existsSync(fixture.capture + ".node")).toBe(false);
    expect(existsSync(fixture.xcrunCapture)).toBe(false);
    expect(
      readFileSync(fixture.capture + ".phases", "utf8")
        .trim()
        .split("\n"),
    ).toEqual(buildStatus === 0 ? ["build-for-testing", "schema"] : ["build-for-testing"]);
    const remote = fixture.calls.find(
      (call) => call.command === "ssh" && call.options.input?.includes('if [ "$2" = logic ]'),
    );
    expect(remote.args[1]).toContain("'compile-tests'");
    const result = args[args.indexOf("-resultBundlePath") + 1];
    const receipt = join(fixture.worktree, "macos", result + ".compilation.txt");
    expect(existsSync(receipt)).toBe(buildStatus === 0);
    if (buildStatus === 0) {
      expect(readFileSync(receipt, "utf8")).toContain("scope=debug-test-compilation\n");
      expect(readFileSync(receipt, "utf8")).toContain("testsExecuted=false\n");
      expect(statSync(receipt).mode & 0o777).toBe(0o600);
    }
  },
);
