#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const PROBE = `
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const entry=process.argv[1],require=createRequire(entry),root=process.argv[2];
const addon=require('node-gyp-build');const binary=addon.path(root);
if(process.argv[3]==='built'&&!binary.includes('/build/Release/'))process.exit(3);
if(typeof addon(root).hardwareAccelerationAvailable()!=='string')process.exit(2);
const {Index,MetricKind,ScalarKind}=await import(pathToFileURL(entry));
const config={dimensions:768,metric:MetricKind.Cos,quantization:ScalarKind.F32,connectivity:16,expansion_add:128,expansion_search:64,multi:false};
const index=new Index(config),vectors=[0,1,2].map(n=>{const v=new Float32Array(768);v[n]=1;return v;});
index.add([1n,2n,3n],vectors,1);
function check(value){const r=value.search(vectors[0],3,1);if(value.size()!==3||r.keys[0]!==1n||Math.abs(r.distances[0])>1e-5)process.exit(2);}
check(index);index.save('probe.usearch');const restored=new Index(config);restored.load('probe.usearch');check(restored);
`;

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH")
      throw new Error("Could not retire native compatibility subprocess", { cause: error });
  }
}

function groupRunning(group) {
  const output = execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s*$/u.exec(line);
    return match && Number(match[1]) === group && !match[2].startsWith("Z");
  });
}

async function drainGroup(child) {
  signalGroup(child, "SIGTERM");
  await delay(100);
  signalGroup(child, "SIGKILL");
  const deadline = Date.now() + 10_000;
  while (groupRunning(child.pid)) {
    if (Date.now() >= deadline)
      throw new Error("Native compatibility process group did not retire");
    await delay(50);
  }
}

/** Own the whole session, including build descendants after their parent exits. */
export async function runOwned(command, args, { cwd, env, timeoutMs, retire = drainGroup }) {
  let child;
  let timer;
  let timedOut = false;
  let interrupted = false;
  let primaryError;
  let outcome;
  let completed;
  let exited = false;
  let wake;
  const cancelled = new Promise((resolveCancelled) => {
    wake = resolveCancelled;
  });
  // Signal/timer callbacks only wake the awaited controller. Retirement happens
  // synchronously in its finally path, never as an unhandled callback throw.
  const cancel = () => {
    interrupted = true;
    wake();
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: "ignore" });
    completed = new Promise((resolveResult) => {
      child.once("error", () => {
        exited = true;
        resolveResult({ code: 127, signal: null });
      });
      child.once("exit", (code, signal) => {
        exited = true;
        resolveResult({ code, signal });
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      wake();
    }, timeoutMs);
    outcome = await Promise.race([completed, cancelled]);
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
    try {
      if (child?.pid) {
        await retire(child);
        if (!exited)
          await Promise.race([
            completed,
            delay(1000).then(() => {
              throw new Error("Native compatibility child was not reaped");
            }),
          ]);
        outcome ??= await completed;
      }
    } catch (cleanupError) {
      const error = new AggregateError(
        [
          primaryError ??
            new Error("Native compatibility command did not complete", { cause: outcome }),
          cleanupError,
        ],
        "Native compatibility command cleanup failed",
        { cause: cleanupError },
      );
      error.ownedCleanupFailed = true;
      primaryError = error;
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
  }
  if (primaryError) throw primaryError;
  return {
    code: outcome?.code ?? child?.exitCode ?? null,
    signal: outcome?.signal ?? child?.signalCode ?? null,
    timedOut,
    interrupted,
  };
}

function succeeded(result) {
  return result.code === 0 && !result.signal && !result.timedOut && !result.interrupted;
}

export function resolveUsearch(packageDir) {
  const gateway = realpathSync(packageDir);
  if (JSON.parse(readFileSync(join(gateway, "package.json"), "utf8")).name !== "@omnesis/gateway") {
    throw new Error("Native vector compatibility requires the gateway package");
  }
  const entry = realpathSync(createRequire(join(gateway, "package.json")).resolve("usearch"));
  let root = dirname(entry);
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "usearch") {
        return { gateway, entry, root };
      }
    } catch {
      /* Compiled entry directories need not contain package manifests. */
    }
    const parent = dirname(root);
    if (parent === root) throw new Error("Could not locate the gateway's native vector dependency");
    root = parent;
  }
}

function npmInvocation(env, args) {
  if (env.npm_execpath === undefined) return { command: "npm", args };
  try {
    if (!isAbsolute(env.npm_execpath) || !statSync(env.npm_execpath).isFile()) {
      throw new Error("Invalid npm lifecycle executable");
    }
  } catch (error) {
    throw new Error("Native vector build requires an existing absolute npm_execpath.", {
      cause: error,
    });
  }
  return { command: process.execPath, args: [env.npm_execpath, ...args] };
}

function installationPrefix(dependencyRoot) {
  let prefix;
  for (
    let directory = dirname(dependencyRoot);
    dirname(directory) !== directory;
    directory = dirname(directory)
  ) {
    if (basename(directory) === "node_modules") prefix = dirname(directory);
  }
  if (!prefix) throw new Error("Native vector dependency is outside an npm installation tree");
  return prefix;
}

// Compilation uses the installer's existing Node-header cache and explicit
// toolchain/network trust settings. The native probe never receives these or
// the operator's HOME. Model credentials and arbitrary Node preloads stay out.
const BUILD_ENV_KEYS = [
  "HOME",
  "XDG_CACHE_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "CC",
  "CXX",
  "AR",
  "CFLAGS",
  "CXXFLAGS",
  "LDFLAGS",
  "SDKROOT",
  "MACOSX_DEPLOYMENT_TARGET",
  "DEVELOPER_DIR",
  "PYTHON",
  "npm_config_ignore_scripts",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "npm_config_allow_scripts",
  "NPM_CONFIG_ALLOW_SCRIPTS",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "npm_config_cache",
  "npm_config_devdir",
  "npm_config_nodedir",
  "npm_config_python",
  "npm_config_node_gyp",
  "npm_config_disturl",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_cafile",
  "npm_config_strict_ssl",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_DEVDIR",
  "NPM_CONFIG_NODEDIR",
  "NPM_CONFIG_PYTHON",
  "NPM_CONFIG_NODE_GYP",
  "NPM_CONFIG_DISTURL",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_STRICT_SSL",
];

function buildEnvironment(probeEnv, env) {
  return {
    ...probeEnv,
    ...Object.fromEntries(
      BUILD_ENV_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
    ),
    npm_config_build_from_source: "true",
    npm_config_jobs: "2",
    MAKEFLAGS: "-j2",
  };
}

export async function ensureNativeVectorCompatibility({
  packageDir,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = runOwned,
  locate = resolveUsearch,
} = {}) {
  // No filesystem writes, dependency lookup or subprocess on unaffected hosts.
  if (platform !== "darwin" || arch !== "x64") return { repaired: false, applicable: false };
  const located = locate(resolve(packageDir ?? "."));
  const scratch = mkdtempSync(join(tmpdir(), "omnesis-native-vector-"));
  const childEnv = {
    PATH: env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    OMNESIS_CONFIG_DIR: join(scratch, "config"),
    NODE_OPTIONS: "--max-old-space-size=512",
    TZ: "UTC",
    CI: "true",
  };
  const probe = (built) =>
    run(
      process.execPath,
      ["--input-type=module", "-e", PROBE, located.entry, located.root, built ? "built" : "any"],
      { cwd: scratch, env: childEnv, timeoutMs: 20_000 },
    );
  let cleanupSafe = true;
  try {
    const initial = await probe(false);
    if (initial.interrupted) throw new Error("Native vector compatibility check interrupted");
    if (succeeded(initial)) return { repaired: false, applicable: true };
    const tools = await run("xcode-select", ["-p"], {
      cwd: scratch,
      env: childEnv,
      timeoutMs: 10_000,
    });
    if (!succeeded(tools))
      throw new Error(
        "Intel macOS native vector support requires Xcode Command Line Tools. Install them with xcode-select --install, then retry the Omnesis installation.",
      );
    // Rebuild only this dependency: no root lifecycle recursion, no global npm changes.
    const prefix = installationPrefix(located.root);
    const npm = npmInvocation(env, [
      "rebuild",
      located.root,
      "--prefix",
      prefix,
      "--workspaces=false",
    ]);
    const build = await run(npm.command, npm.args, {
      cwd: prefix,
      timeoutMs: 600_000,
      env: buildEnvironment(childEnv, env),
    });
    if (!succeeded(build))
      throw new Error(
        "Could not compile native vector support on Intel macOS; verify Xcode Command Line Tools and retry the installation.",
      );
    const verified = await probe(true);
    if (verified.code === 3 && !verified.signal && !verified.timedOut && !verified.interrupted)
      throw new Error(
        "Native vector rebuild did not produce a compiled binding. Approve the usearch native build in your existing npm script policy, then retry installation.",
      );
    if (!succeeded(verified))
      throw new Error(
        "Compiled native vector support failed its compatibility check on Intel macOS.",
      );
    return { repaired: true, applicable: true };
  } catch (error) {
    if (error?.ownedCleanupFailed) cleanupSafe = false;
    throw error;
  } finally {
    if (cleanupSafe) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--package-dir");
  try {
    if (index < 0 || !process.argv[index + 1] || process.argv.length !== 4)
      throw new Error("Expected --package-dir PATH");
    await ensureNativeVectorCompatibility({ packageDir: process.argv[index + 1] });
  } catch (error) {
    // Only fixed helper diagnostics, never native/npm output or unexpected path-bearing errors.
    const message =
      error instanceof Error &&
      /^(Intel macOS native vector|Native vector compatibility check interrupted|Native vector rebuild|Native vector dependency|Native vector build|Could not compile native vector support|Compiled native vector support)/u.test(
        error.message,
      )
        ? error.message
        : "Native vector compatibility setup failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
