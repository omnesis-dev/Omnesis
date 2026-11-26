// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  assertDesktopReleaseContext,
  cleanupDesktopSigning,
  buildDesktopRelease,
  desktopSigningInputs,
  releaseToolEnvironment,
  signDesktopRelease,
} from "./release-build.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { readDesktopReleasePolicy } from "../release/desktop-artifacts.mjs";
const roots = [],
  sha = "a".repeat(40),
  identity = "B".repeat(40);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-sign-test-")));
  roots.push(root);
  return root;
}
function environment() {
  return {
    GITHUB_REPOSITORY: "omnesis-dev/Omnesis",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v1.2.3",
    GITHUB_WORKFLOW_REF: "omnesis-dev/Omnesis/.github/workflows/release.yml@refs/tags/v1.2.3",
    RELEASE_TAG: "v1.2.3",
    RELEASE_SHA: sha,
    OMNESIS_DESKTOP_SIGNING_P12_BASE64: Buffer.from("invented-certificate").toString("base64"),
    OMNESIS_DESKTOP_SIGNING_P12_PASSWORD: "invented-private-password",
    OMNESIS_DESKTOP_SIGNING_IDENTITY: identity,
    OMNESIS_DESKTOP_TEAM_ID: "A1B2C3D4E5",
    OMNESIS_DESKTOP_NOTARY_PRIVATE_KEY: [
      "-----BEGIN" + " PRIVATE KEY-----",
      "YWJj",
      "-----END" + " PRIVATE KEY-----",
      "",
    ].join("\n"),
    OMNESIS_DESKTOP_NOTARY_KEY_ID: "F1G2H3J4K5",
    OMNESIS_DESKTOP_NOTARY_ISSUER_ID: "12345678-1234-1234-1234-123456789abc",
    PATH: "/usr/bin:/bin",
    GH_TOKEN: "invented-github-secret",
  };
}
function security(commands) {
  return (command, args, options) => {
    commands.push({ command, args, options });
    return args[0] === "find-identity"
      ? `1) ${identity} "Developer ID Application: example.com (A1B2C3D4E5)"`
      : "";
  };
}
test("only canonical tag pushes and main dispatch can enter credentialed desktop release", () => {
  const env = environment();
  expect(() => assertDesktopReleaseContext(env)).not.toThrow();
  expect(() =>
    assertDesktopReleaseContext({
      ...env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "omnesis-dev/Omnesis/.github/workflows/release.yml@refs/heads/main",
    }),
  ).not.toThrow();
  for (const change of [
    { GITHUB_REPOSITORY: "example/fork" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_WORKFLOW_REF: "omnesis-dev/Omnesis/.github/workflows/release.yml@refs/heads/feature" },
    { RELEASE_TAG: "v1.2.3-beta" },
  ])
    expect(() => assertDesktopReleaseContext({ ...env, ...change })).toThrow();
});
test("missing or malformed signing input refuses without leaking values or invoking tools", async () => {
  const env = environment(),
    run = vi.fn();
  for (const key of [
    "OMNESIS_DESKTOP_NOTARY_PRIVATE_KEY",
    "OMNESIS_DESKTOP_SIGNING_P12_PASSWORD",
  ]) {
    await expect(
      signDesktopRelease({
        build: "/unused",
        artifacts: "/unused",
        architecture: "arm64",
        version: "1.2.3",
        sha,
        environment: { ...env, [key]: "" },
        platform: "darwin",
        run,
      }),
    ).rejects.toThrow("configuration is incomplete");
  }
  expect(run).not.toHaveBeenCalled();
  expect(() =>
    desktopSigningInputs({ ...env, OMNESIS_DESKTOP_SIGNING_IDENTITY: "invented-secret-invalid" }),
  ).toThrow("configuration is invalid");
  expect(releaseToolEnvironment(env)).toEqual({ PATH: "/usr/bin:/bin" });
});
test("signing uses only its private Keychain and publishes only finalized notarized bytes", async () => {
  const build = await scratch(),
    artifacts = join(build, "artifacts"),
    commands = [];
  const packageApp = vi.fn(async (options) => {
    expect(options.notaryProfile).toMatch(/^desktop-/);
    expect(options.keychain).toContain("signing-");
    await writeFile(options.output, "invented-final-notarized-dmg");
    return { output: options.output, notarized: true };
  });
  const result = await signDesktopRelease({
    build,
    artifacts,
    architecture: "arm64",
    version: "1.2.3",
    sha,
    environment: environment(),
    platform: "darwin",
    run: security(commands),
    packageApp,
  });
  expect(result.name).toBe("Omnesis-1.2.3-macos-arm64.dmg");
  expect((await readdir(artifacts)).sort()).toEqual([result.name, "manifest.json"].sort());
  expect(await readFile(join(artifacts, result.name), "utf8")).toBe("invented-final-notarized-dmg");
  expect((await readdir(build)).filter((name) => name.startsWith("signing-"))).toEqual([]);
  expect(commands.at(-1).args[0]).toBe("delete-keychain");
  expect(
    commands.some(
      (c) =>
        c.args.includes("-A") ||
        c.args.includes("list-keychains") ||
        c.args.includes("default-keychain"),
    ),
  ).toBe(false);
  for (const command of commands) {
    expect(command.options.env.GH_TOKEN).toBeUndefined();
    expect(command.options.env.OMNESIS_DESKTOP_NOTARY_PRIVATE_KEY).toBeUndefined();
  }
});
test.each(["tool-failure", "not-notarized", "wrong-identity"])(
  "failed signing cannot emit a release manifest and cleans up its private credentials: %s",
  async (failure) => {
    const build = await scratch(),
      artifacts = join(build, "artifacts"),
      commands = [];
    const record = security(commands);
    const run = (command, args, options) => {
      const result = record(command, args, options);
      if (failure === "tool-failure" && args[0] === "import")
        throw new Error("secret-p12-password");
      if (failure === "wrong-identity" && args[0] === "find-identity")
        return "no accepted identity";
      return result;
    };
    const packageApp = vi.fn(async () => ({ notarized: false }));
    await expect(
      signDesktopRelease({
        build,
        artifacts,
        architecture: "x64",
        version: "1.2.3",
        sha,
        environment: environment(),
        platform: "darwin",
        run,
        packageApp,
      }),
    ).rejects.toThrow(/Desktop/);
    expect(await readdir(build)).toEqual([]);
    expect(commands.at(-1).args[0]).toBe("delete-keychain");
    if (failure !== "not-notarized") expect(packageApp).not.toHaveBeenCalled();
  },
);
test("native build preserves the exact Release shell → runtime qualifier → app qualifier ordering", async () => {
  const source = await scratch(),
    output = join(source, "output"),
    events = [];
  await mkdir(join(source, "packages/core"), { recursive: true });
  await writeFile(join(source, "packages/core/package.json"), '{"version":"1.2.3"}');
  const run = (command, args) => {
    events.push([command, args]);
    if (command === "git") return sha;
    if (args[0] === "-version") return "Xcode 26.3\nBuild version invented";
    return "";
  };
  const prepare = vi.fn(async (options) => {
    events.push(["prepare", options]);
  });
  const assemble = vi.fn(async (options) => {
    events.push(["assemble", options]);
  });
  await buildDesktopRelease({
    output,
    source,
    architecture: "arm64",
    version: "1.2.3",
    sha,
    platform: "darwin",
    hostArchitecture: "arm64",
    nodeVersion: NODE_RUNTIME.version,
    run,
    prepare,
    assemble,
  });
  const release = events.findIndex(
      (e) => e[0] === "/usr/bin/xcodebuild" && e[1].includes("Release"),
    ),
    preparation = events.findIndex((e) => e[0] === "prepare"),
    assembly = events.findIndex((e) => e[0] === "assemble");
  expect(release).toBeLessThan(preparation);
  expect(preparation).toBeLessThan(assembly);
  expect(
    events.filter((e) => Array.isArray(e[1]) && e[1][0]?.endsWith("smoke-runtime.mjs")),
  ).toHaveLength(2);
  expect(prepare.mock.calls[0][0].runtimeExec).toContain("Release/OmnesisRuntimeExec");
  await expect(
    buildDesktopRelease({
      output: join(source, "wrong"),
      source,
      architecture: "x64",
      version: "1.2.3",
      sha,
      platform: "darwin",
      hostArchitecture: "arm64",
      nodeVersion: NODE_RUNTIME.version,
      run,
      prepare,
      assemble,
    }),
  ).rejects.toThrow(/native architecture/);
});

test("release workflow executes strict enablement and gates headless publication behind both native jobs", async () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  const arming = workflow.jobs.verify.steps.find((step) => step.id === "arming");
  const root = await scratch(),
    output = join(root, "outputs");
  const base = {
    PATH: process.env.PATH,
    ...environment(),
    GITHUB_OUTPUT: output,
    ARMED: "false",
    IMAGE_PUBLISH: "0",
  };
  for (const [flag, expected] of [
    ["0", "false"],
    ["1", "true"],
  ]) {
    await writeFile(output, "");
    execFileSync("bash", ["-eu", "-c", arming.run], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...base, OMNESIS_DESKTOP_RELEASE: flag },
      stdio: "pipe",
    });
    expect(await readFile(output, "utf8")).toContain(`desktop=${expected}`);
  }
  for (const change of [
    { OMNESIS_DESKTOP_RELEASE: "true" },
    { OMNESIS_DESKTOP_RELEASE: "1", GITHUB_REPOSITORY: "example/fork" },
  ])
    expect(() =>
      execFileSync("bash", ["-eu", "-c", arming.run], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...base, ...change },
        stdio: "pipe",
      }),
    ).toThrow();
  expect(workflow.jobs.packages.needs).toContain("desktop");
  expect(workflow.jobs.images.needs).toContain("packages");
  expect(workflow.jobs["github-release"].needs).toContain("desktop");
  expect(workflow.jobs.desktop.strategy.matrix.include).toEqual([
    { arch: "arm64", os: "macos-26" },
    { arch: "x64", os: "macos-26-intel" },
  ]);
  expect(workflow.jobs.desktop.environment).toBe("desktop-release");
  const buildStep = workflow.jobs.desktop.steps.find((step) => step.id === "build");
  expect(
    Object.keys(buildStep.env).some((key) => key.includes("SIGNING") || key.includes("NOTARY")),
  ).toBe(false);
  expect(
    workflow.jobs.desktop.steps.some(
      (step) => step.if?.includes("always()") && step.run?.includes("--mode cleanup"),
    ),
  ).toBe(true);
  const headless = workflow.jobs["github-release"].steps.find(
    (step) => step.name === "Create the GitHub Release",
  );
  expect(headless.run).not.toContain("desktop-release.json");
  expect(headless.if).toContain("!= 'true'");
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps ?? [])
      if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
});

test("cancellation cleanup retires only its owned signing directory and leaves other build outputs", async () => {
  const build = await scratch(),
    privateRoot = join(build, "signing-invented"),
    other = join(build, "other-output"),
    calls = [];
  await mkdir(privateRoot, { mode: 0o700 });
  await writeFile(join(privateRoot, "signing.keychain-db"), "invented keychain");
  await mkdir(other);
  if (process.platform === "win32") {
    await expect(
      cleanupDesktopSigning(build, () => {
        throw new Error("must not invoke tools");
      }),
    ).rejects.toThrow("not supported on Windows");
    expect(await readdir(build)).toContain("signing-invented");
    return;
  }
  await cleanupDesktopSigning(build, (command, args) => {
    calls.push([command, args]);
  });
  expect(calls).toEqual([
    ["/usr/bin/security", ["delete-keychain", join(privateRoot, "signing.keychain-db")]],
  ]);
  expect(await readdir(build)).toEqual(["other-output"]);
});

test("main workflow can dispatch an older headless tag without any new desktop scripts", async () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  const arming = workflow.jobs.verify.steps.find((step) => step.id === "arming");
  const policy = workflow.jobs.packages.steps.find(
    (step) => step.name === "Record this run's desktop release policy",
  );
  for (const value of [undefined, "", "0"]) {
    const root = await scratch(),
      output = join(root, "outputs");
    await mkdir(join(root, "release"));
    await writeFile(output, "");
    const env = {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      ARMED: "false",
      IMAGE_PUBLISH: "0",
      RELEASE_TAG: "v1.2.3",
      RELEASE_SHA: sha,
      ...(value === undefined ? {} : { OMNESIS_DESKTOP_RELEASE: value }),
    };
    execFileSync("bash", ["-eu", "-c", arming.run], { cwd: root, env, stdio: "pipe" });
    expect(await readFile(output, "utf8")).toContain("desktop=false");
    execFileSync("bash", ["-eu", "-c", policy.run], {
      cwd: root,
      env: { ...env, OMNESIS_DESKTOP_RELEASE: "0" },
      stdio: "pipe",
    });
    expect(readDesktopReleasePolicy(root + "/release")).toEqual({
      format: 1,
      enabled: false,
      version: "1.2.3",
      sha,
    });
    let refused;
    try {
      execFileSync("bash", ["-eu", "-c", arming.run], {
        cwd: root,
        env: {
          ...environment(),
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          OMNESIS_DESKTOP_RELEASE: "1",
        },
        stdio: "pipe",
      });
    } catch (error) {
      refused = error;
    }
    expect(String(refused?.stderr)).toContain("ERR_MODULE_NOT_FOUND");
  }
});
