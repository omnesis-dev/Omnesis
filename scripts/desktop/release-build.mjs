#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntime } from "./prepare-runtime.mjs";
import { assembleApp } from "./assemble-app.mjs";
import { distribute } from "./distribute.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { desktopArtifactName, writeDesktopArtifact } from "../release/desktop-artifacts.mjs";
import { parseArguments } from "./arguments.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const signingKeys = [
  "OMNESIS_DESKTOP_SIGNING_P12_BASE64",
  "OMNESIS_DESKTOP_SIGNING_P12_PASSWORD",
  "OMNESIS_DESKTOP_SIGNING_IDENTITY",
  "OMNESIS_DESKTOP_TEAM_ID",
  "OMNESIS_DESKTOP_NOTARY_PRIVATE_KEY",
  "OMNESIS_DESKTOP_NOTARY_KEY_ID",
  "OMNESIS_DESKTOP_NOTARY_ISSUER_ID",
];
/** Children get build tools, never the signing step's inherited secrets or GitHub credential. */
export function releaseToolEnvironment(environment = process.env) {
  return Object.fromEntries(
    ["HOME", "PATH", "TMPDIR", "LANG", "DEVELOPER_DIR"]
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, environment[key]]),
  );
}
export function assertDesktopReleaseContext(environment) {
  if (environment.GITHUB_REPOSITORY !== "omnesis-dev/Omnesis")
    throw new Error("Desktop signing requires the canonical repository");
  const tag = environment.RELEASE_TAG;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag ?? ""))
    throw new Error("Desktop signing requires a stable product tag");
  const ref =
    environment.GITHUB_EVENT_NAME === "push"
      ? `refs/tags/${tag}`
      : environment.GITHUB_EVENT_NAME === "workflow_dispatch"
        ? "refs/heads/main"
        : null;
  if (
    !ref ||
    environment.GITHUB_REF !== ref ||
    environment.GITHUB_WORKFLOW_REF !== `omnesis-dev/Omnesis/.github/workflows/release.yml@${ref}`
  )
    throw new Error("Desktop signing requires a tag push or the main release workflow");
}
export function desktopSigningInputs(environment) {
  for (const key of signingKeys)
    if (
      typeof environment[key] !== "string" ||
      !environment[key].length ||
      environment[key].length > 2 * 1024 * 1024
    )
      throw new Error("Desktop signing configuration is incomplete");
  const input = Object.fromEntries(
    signingKeys.map((key) => [key.replace("OMNESIS_DESKTOP_", ""), environment[key]]),
  );
  const pem = input.NOTARY_PRIVATE_KEY.trim().split(/\r?\n/u),
    keyType = "PRIVATE KEY";
  const validPem =
    pem[0] === ["-----BEGIN", `${keyType}-----`].join(" ") &&
    pem.at(-1) === ["-----END", `${keyType}-----`].join(" ") &&
    /^[A-Za-z0-9+/=]+$/u.test(pem.slice(1, -1).join(""));
  if (
    !/^[a-fA-F0-9]{40}$/u.test(input.SIGNING_IDENTITY) ||
    !/^[A-Z0-9]{10}$/u.test(input.TEAM_ID) ||
    !/^[A-Z0-9]{10}$/u.test(input.NOTARY_KEY_ID) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(input.NOTARY_ISSUER_ID) ||
    !validPem ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.SIGNING_P12_BASE64) ||
    input.SIGNING_P12_PASSWORD.length > 4096
  )
    throw new Error("Desktop signing configuration is invalid");
  return input;
}
/** Build on each native architecture, before the job exposes any signing secrets. */
export async function buildDesktopRelease({
  output,
  architecture,
  version,
  sha,
  source = repository,
  platform = process.platform,
  hostArchitecture = process.arch,
  nodeVersion = process.versions.node,
  run = execFileSync,
  prepare = prepareRuntime,
  assemble = assembleApp,
}) {
  if (
    platform !== "darwin" ||
    hostArchitecture !== architecture ||
    nodeVersion !== NODE_RUNTIME.version
  )
    throw new Error("Desktop release requires its native architecture and pinned Node");
  desktopArtifactName(version, architecture);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Desktop release source revision is invalid");
  const invoke = (command, args, capture = false) =>
    run(command, args, {
      cwd: source,
      env: releaseToolEnvironment(),
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      maxBuffer: 16 * 1024 * 1024,
    });
  if (
    String(invoke("git", ["rev-parse", "HEAD"], true)).trim() !== sha ||
    JSON.parse(await readFile(join(source, "packages/core/package.json"), "utf8")).version !==
      version
  )
    throw new Error("Desktop release source differs from the verified release revision");
  if (
    !/^Xcode (?:2[6-9]|[3-9]\d)\./u.test(String(invoke("/usr/bin/xcodebuild", ["-version"], true)))
  )
    throw new Error("Desktop release requires Xcode 26 or newer");
  output = resolve(output);
  await mkdir(output, { mode: 0o700 });
  const shell = join(output, "shell");
  invoke("xcodegen", ["generate", "--spec", join(source, "macos/project.yml")]);
  invoke("/usr/bin/xcodebuild", [
    "-project",
    join(source, "macos/OmnesisDesktop.xcodeproj"),
    "-scheme",
    "OmnesisDesktop",
    "-configuration",
    "Release",
    "-destination",
    "platform=macOS",
    "-derivedDataPath",
    shell,
    `ARCHS=${architecture === "x64" ? "x86_64" : architecture}`,
    "ONLY_ACTIVE_ARCH=YES",
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "build",
  ]);
  const runtime = join(output, "runtime");
  await prepare({
    architecture,
    output: runtime,
    cache: join(output, "cache"),
    runtimeExec: join(shell, "Build/Products/Release/OmnesisRuntimeExec"),
  });
  invoke(process.execPath, [
    join(source, "scripts/desktop/smoke-runtime.mjs"),
    "--runtime",
    runtime,
  ]);
  const app = join(output, "Omnesis.app");
  await assemble({
    runtime,
    shellApp: join(shell, "Build/Products/Release/Omnesis.app"),
    output: app,
    architecture,
    version,
  });
  invoke(process.execPath, [
    join(source, "scripts/desktop/smoke-runtime.mjs"),
    "--runtime",
    join(app, "Contents/Resources/runtime"),
  ]);
  return app;
}
/** Fixed signing tools use an attempt-owned Keychain; no user search-list/default changes. */
export async function signDesktopRelease({
  build,
  artifacts,
  architecture,
  version,
  sha,
  environment = process.env,
  platform = process.platform,
  run = execFileSync,
  packageApp = distribute,
}) {
  if (platform !== "darwin") throw new Error("Desktop signing requires macOS");
  assertDesktopReleaseContext(environment);
  const input = desktopSigningInputs(environment);
  const name = desktopArtifactName(version, architecture);
  if (
    environment.RELEASE_TAG !== `v${version}` ||
    environment.RELEASE_SHA !== sha ||
    !/^[a-f0-9]{40}$/u.test(sha)
  )
    throw new Error("Desktop signing release binding changed");
  build = await realpath(build);
  const privateRoot = await mkdtemp(join(build, "signing-"));
  const keychain = join(privateRoot, "signing.keychain-db"),
    p12 = join(privateRoot, "identity.p12"),
    apiKey = join(privateRoot, "notary.p8"),
    password = randomBytes(32).toString("hex"),
    profile = `desktop-${randomUUID()}`;
  let created = false;
  const invoke = (command, args) => {
    try {
      return run(command, args, {
        env: releaseToolEnvironment(environment),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      throw new Error("Desktop signing or qualification tool refused the release");
    }
  };
  try {
    await writeFile(p12, Buffer.from(input.SIGNING_P12_BASE64, "base64"), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(apiKey, input.NOTARY_PRIVATE_KEY, { flag: "wx", mode: 0o600 });
    invoke("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    created = true;
    invoke("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    invoke("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    invoke("/usr/bin/security", [
      "import",
      p12,
      "-P",
      input.SIGNING_P12_PASSWORD,
      "-T",
      "/usr/bin/codesign",
      "-k",
      keychain,
    ]);
    invoke("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    const identities = String(
      invoke("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", keychain]),
    );
    const matching = identities
      .split("\n")
      .filter(
        (line) =>
          line.toUpperCase().includes(input.SIGNING_IDENTITY.toUpperCase()) &&
          line.includes("Developer ID Application:") &&
          line.includes(`(${input.TEAM_ID})`),
      );
    if (matching.length !== 1) throw new Error("Desktop signing identity or team does not match");
    invoke("/usr/bin/xcrun", [
      "notarytool",
      "store-credentials",
      profile,
      "--key",
      apiKey,
      "--key-id",
      input.NOTARY_KEY_ID,
      "--issuer",
      input.NOTARY_ISSUER_ID,
      "--keychain",
      keychain,
    ]);
    const output = join(privateRoot, name);
    const result = await packageApp({
      app: join(build, "Omnesis.app"),
      architecture,
      identity: input.SIGNING_IDENTITY,
      output,
      notaryProfile: profile,
      keychain,
      run: invoke,
      platform,
    });
    if (result.notarized !== true || result.output !== output)
      throw new Error("Desktop release notarization was not completed");
    // Copy only the finalized DMG. Keychain inputs, signing logs and the app never become workflow artifacts.
    await mkdir(artifacts, { mode: 0o700 });
    await cp(output, join(artifacts, name), { errorOnExist: true, force: false });
    return writeDesktopArtifact(artifacts, { architecture, version, sha, notarized: true });
  } finally {
    try {
      if (created) invoke("/usr/bin/security", ["delete-keychain", keychain]);
    } finally {
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
}

/** Last-resort cleanup for cancellation of the credentialed step, confined to this job's build. */
export async function cleanupDesktopSigning(build, run = execFileSync) {
  if (process.platform === "win32")
    throw new Error("Temporary signing Keychain cleanup is not supported on Windows");
  build = await realpath(build);
  for (const name of await readdir(build)) {
    if (!/^signing-[A-Za-z0-9]+$/u.test(name)) continue;
    const path = join(build, name),
      info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new Error("Signing cleanup path is not owned and private");
    try {
      try {
        await lstat(join(path, "signing.keychain-db"));
      } catch (error) {
        if (error.code === "ENOENT") {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
      run("/usr/bin/security", ["delete-keychain", join(path, "signing.keychain-db")], {
        env: releaseToolEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Temporary signing Keychain cleanup did not complete");
    }
    await rm(path, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2), {
      values: ["mode", "out", "arch", "build"],
      required: ["mode"],
    });
    const common = {
      version: (process.env.RELEASE_TAG ?? "").replace(/^v/u, ""),
      sha: process.env.RELEASE_SHA,
      architecture: options.get("arch"),
    };
    if (options.get("mode") === "preflight") {
      assertDesktopReleaseContext(process.env);
      desktopSigningInputs(process.env);
    } else if (options.get("mode") === "cleanup" && options.get("build"))
      await cleanupDesktopSigning(options.get("build"));
    else if (options.get("mode") === "build" && options.get("out") && options.get("arch"))
      await buildDesktopRelease({ ...common, output: options.get("out") });
    else if (
      options.get("mode") === "sign" &&
      options.get("out") &&
      options.get("arch") &&
      options.get("build")
    )
      await signDesktopRelease({
        ...common,
        artifacts: options.get("out"),
        build: options.get("build"),
      });
    else throw new Error("Invalid desktop release mode or missing fixed arguments");
  } catch {
    process.stderr.write(
      "Desktop release build, signing or cleanup refused. No release artifact is qualified.\n",
    );
    process.exitCode = 1;
  }
}
