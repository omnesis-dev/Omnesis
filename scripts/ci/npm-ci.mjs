// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Dependency installation must also work before workspace aliases exist.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrapWindowsPlatform } from "../lib/bootstrap-platform.mjs";
import { installParentShutdownHandler } from "../../packages/core/src/parent-shutdown.ts";
import { waitForChild } from "../lib/check-process-runtime.mjs";

/** npm's own JavaScript entry, never a Windows batch shim or an npm on PATH. */
export async function npmJavaScriptEntry(
  env = process.env,
  nodePath = process.execPath,
  cwd = process.cwd(),
) {
  const candidates = [
    env.npm_execpath,
    join(dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(nodePath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  // Compare physical paths on both sides: macOS temporary directories and
  // source checkouts can be reached through directory aliases.
  let removableRoot = join(await realpath(cwd), "node_modules");
  try {
    removableRoot = await realpath(removableRoot);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !/\.[cm]?js$/iu.test(candidate)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const entry = await realpath(candidate);
      const local = relative(removableRoot, entry);
      // npm ci removes this tree before running scripts. A CLI inside it
      // cannot safely install itself or survive a retry.
      if (local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)))
        continue;
      return entry;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("Cannot locate the JavaScript npm CLI bundled with this Node installation");
}

/** Reject partial or different-version headers before any native install runs. */
export async function completeNodeHeaders(
  root,
  version,
  platform = process.platform,
  arch = process.arch,
) {
  try {
    for (const name of ["node.h", "node_api.h", "common.gypi", "config.gypi"]) {
      const text = (await readFile(join(root, "include", "node", name), "utf8")).trim();
      if (!text || (name.endsWith(".gypi") && !text.endsWith("}"))) return false;
    }
    const header = await readFile(join(root, "include", "node", "node_version.h"), "utf8");
    const parts = ["MAJOR", "MINOR", "PATCH"].map(
      (part) => new RegExp(`^#define\\s+NODE_${part}_VERSION\\s+(\\d+)`, "mu").exec(header)?.[1],
    );
    if (parts.join(".") !== version) return false;
    if (platform === "win32" && (await readFile(join(root, arch, "node.lib"))).length === 0)
      return false;
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

async function runNode(args, { env, cwd, signal, timeoutMs }) {
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    const { runWindowsJob } = await bootstrapWindowsPlatform();
    const result = await runWindowsJob(process.execPath, args, {
      env,
      cwd,
      signal,
      timeoutMs,
      completion: "root",
      stdout: "inherit",
      onStderr: (bytes) => process.stderr.write(bytes),
    });
    if (result.failure)
      throw new Error(
        `Dependency subprocess ${result.failure}${result.failureMessage ? `: ${result.failureMessage}` : ""}`,
      );
    return result.exitCode ?? 1;
  }
  const child = spawn(process.execPath, args, { env, cwd, stdio: "inherit", detached: true });
  const signals = new EventEmitter();
  const onAbort = () => signals.emit("SIGTERM");
  const waiting = waitForChild(child, { signalEmitter: signals });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(onAbort, timeoutMs);
  timer.unref();
  try {
    return await waiting;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function droppedOptionalPackages(logs, requireOptional = false) {
  const dropped = new Set();
  const lacking = new Set();
  for (const line of logs.split(/\r?\n/u)) {
    const match = / failed optional dependency (.+)$/u.exec(line);
    if (!match) continue;
    const path = match[1].replaceAll("\\", "/");
    if (!requireOptional && /\/node_modules\/smart-whisper(?:\/|$)/u.test(path)) {
      lacking.add("smart-whisper");
      continue;
    }
    const name = path.split("/node_modules/").at(-1);
    if (/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) dropped.add(name);
  }
  return { dropped: [...dropped].sort(), lacking: [...lacking].sort() };
}

function positiveInteger(value, fallback, name, allowZero = false) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1))
    throw new Error(`Invalid ${name}`);
  return number;
}

/** One isolated header installation precedes all npm retries; it is retained until every child joins. */
export async function npmCi(
  args = [],
  {
    env = process.env,
    cwd = process.cwd(),
    signal,
    run = runNode,
    platform = process.platform,
    arch = process.arch,
    version = process.versions.node,
    nodePath = process.execPath,
    output = (message) => process.stderr.write(message),
  } = {},
) {
  const attempts = positiveInteger(env.NPM_CI_ATTEMPTS, 3, "NPM_CI_ATTEMPTS");
  const retrySeconds = positiveInteger(env.NPM_CI_RETRY_SECONDS, 10, "NPM_CI_RETRY_SECONDS", true);
  const npmCli = await npmJavaScriptEntry(env, nodePath, cwd);
  const nodeGyp = createRequire(pathToFileURL(npmCli)).resolve("node-gyp/bin/node-gyp.js");
  const scratch = await mkdtemp(join(tmpdir(), "omnesis-npm-ci-"));
  const childEnv = { ...env };
  // Old npm spellings warn, and inherited cross-build/header settings must
  // not redirect native builds away from this running Node installation.
  for (const key of Object.keys(childEnv)) {
    if (
      /^npm_(?:package_config_node_gyp|config)_(?:arch|target|target_arch|nodedir|devdir)$/iu.test(
        key,
      )
    )
      delete childEnv[key];
  }
  childEnv.npm_package_config_node_gyp_arch = arch;
  childEnv.npm_package_config_node_gyp_target = version;
  childEnv.npm_package_config_node_gyp_devdir = join(scratch, "headers");
  try {
    signal?.throwIfAborted();
    const bundled = resolve(dirname(nodePath), "..");
    let headers = bundled;
    if (platform === "win32" || !(await completeNodeHeaders(bundled, version, platform, arch))) {
      const devdir = join(scratch, "headers");
      const code = await run(
        [nodeGyp, "install", version, `--devdir=${devdir}`, `--arch=${arch}`, "--ensure"],
        {
          env: childEnv,
          cwd,
          signal,
          timeoutMs: 180_000,
          completion: "root",
        },
      );
      headers = join(devdir, version);
      if (code !== 0 || !(await completeNodeHeaders(headers, version, platform, arch)))
        throw new Error(
          "Could not prepare complete headers for the running Node version and architecture",
        );
      if (platform === "win32") {
        // With explicit nodedir, node-gyp links $(Configuration)/node.lib.
        for (const configuration of ["Release", "Debug"]) {
          await mkdir(join(headers, configuration), { recursive: true });
          await copyFile(join(headers, arch, "node.lib"), join(headers, configuration, "node.lib"));
        }
      }
    }
    childEnv.npm_package_config_node_gyp_nodedir = headers;
    const logs = join(scratch, "logs");
    let lacking = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      await rm(logs, { recursive: true, force: true });
      await mkdir(logs);
      let code;
      try {
        code = await run([npmCli, "ci", "--logs-dir", logs, ...args], {
          env: childEnv,
          cwd,
          signal,
          timeoutMs: 20 * 60_000,
          completion: "root",
        });
      } catch (error) {
        signal?.throwIfAborted();
        output(`npm ci subprocess failed: ${error.message}\n`);
        code = 1;
      }
      let problem = "npm ci failed";
      if (code === 0) {
        const entries = await readdir(logs);
        const text = (
          await Promise.all(
            entries
              .filter((name) => name.endsWith(".log"))
              .map((name) => readFile(join(logs, name), "utf8")),
          )
        ).join("\n");
        const result = droppedOptionalPackages(text, env.NPM_CI_REQUIRE_OPTIONAL === "1");
        lacking = result.lacking;
        if (result.dropped.length === 0) {
          if (lacking.length)
            output(
              `::notice::npm ci could not build ${lacking.join(" ")} on this host; this tree runs without it\n`,
            );
          return 0;
        }
        problem = `npm ci dropped optional packages that failed to install: ${result.dropped.join(" ")}`;
      }
      if (attempt === attempts) {
        if (code !== 0) {
          output(`npm ci failed after ${attempt} attempts\n`);
          return 1;
        }
        if (env.NPM_CI_REQUIRE_OPTIONAL === "1") {
          output(`${problem}, after ${attempt} attempts, and this build requires them\n`);
          return 1;
        }
        output(`::warning::${problem}, after ${attempt} attempts; this tree lacks them\n`);
        if (lacking.length)
          output(
            `::notice::npm ci could not build ${lacking.join(" ")} on this host; this tree runs without it\n`,
          );
        return 0;
      }
      output(
        `${problem} (attempt ${attempt} of ${attempts}); retrying in ${attempt * retrySeconds}s\n`,
      );
      await sleep(attempt * retrySeconds * 1000, undefined, { signal });
    }
    return 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Older Node 24 releases do not expose import.meta.main. */
async function legacyMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

if (import.meta.main ?? (await legacyMainEntry())) {
  const controller = new AbortController();
  let interruptedSignal = "SIGTERM";
  const removeParentShutdown = installParentShutdownHandler(() =>
    controller.abort(new Error("Dependency installation stopped by its owner")),
  );
  const onParentDisconnect = () =>
    controller.abort(new Error("Dependency installation owner disconnected"));
  if (typeof process.send === "function") process.once("disconnect", onParentDisconnect);
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => {
        interruptedSignal = signal;
        controller.abort(new Error(`Dependency installation interrupted by ${signal}`));
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    process.exitCode = await npmCi(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = controller.signal.aborted
      ? 128 + (constants.signals[interruptedSignal] ?? 0)
      : 1;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    removeParentShutdown();
    process.removeListener("disconnect", onParentDisconnect);
    if (process.connected) process.disconnect();
  }
}
