// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { waitForChild } from "../lib/check-process.mjs";
import { ensureBundledExtensions } from "../duckdb-extensions.mjs";

if (!process.env.OMNESIS_TEST_SCHEDULER_ACTIVE && process.env.CI !== "true") {
  throw new Error("Run this fixture through the installed E2E admission queue");
}
const root = await realpath(resolve("."));
const require = createRequire(import.meta.url);
const playwright = require("playwright/package.json").version;
const modules = dirname(dirname(await realpath(require.resolve("vitest/package.json"))));
const mountedDependencies = "/run/desktop-account-dependencies/node_modules";
const dependencyAliases = modules.startsWith(root + "/")
  ? []
  : ["--mount", `type=bind,source=${modules},target=${modules},readonly`];
const dockerfile = join(root, "scripts/desktop/account-test.Dockerfile");
const image =
  "omnesis-desktop-account-e2e:" +
  createHash("sha256")
    .update(await readFile(dockerfile))
    .update(playwright)
    .digest("hex")
    .slice(0, 16);
const nonce = randomUUID();
const name = "omnesis-desktop-e2e-" + nonce;
// This directory is never mounted: child input cannot alter Docker control or receipts.
if (
  ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].some(
    (key) => process.env[key],
  )
)
  throw Error("Account fixture requires the local default Docker endpoint");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "omnesis-account-container-")));
for (const mounted of [root, modules]) {
  if (scratch === mounted || scratch.startsWith(mounted + "/") || mounted.startsWith(scratch + "/"))
    throw Error("Account private control overlaps a mounted input");
}
const dockerConfig = join(scratch, "docker-config");
const input = join(scratch, "child-input");
await mkdir(dockerConfig, { mode: 0o700 });
await mkdir(input, { mode: 0o700 });
const marker = join(input, "container.json");
await writeFile(
  marker,
  JSON.stringify({ format: 1, owner: "omnesis-desktop-account-e2e", nonce, hostname: name }),
  { mode: 0o600, flag: "wx" },
);
const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
const label = "dev.omnesis.test.desktop-account";
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
let failure, cleanupFailure, clientCleanupFailure, id, imageId;
let createAttempted = false,
  verified = false,
  stopped = false,
  removed = false;
const clients = [];
async function command(args, { cancellable = true, capture = false, milliseconds } = {}) {
  if (cancellable) controller.signal.throwIfAborted();
  const child = spawn("docker", args, {
    env,
    detached: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const signals = new EventEmitter();
  const closed = new Promise((done) => child.once("close", done));
  const receipt = { stage: args[0], closed: false, treeJoined: false };
  const joined = waitForChild(child, {
    signalEmitter: signals,
    onJoined: () => {
      receipt.treeJoined = true;
    },
  });
  void joined.catch(() => {});
  clients.push(receipt);
  let forced = false,
    output = "",
    bytes = 0;
  const stop = () => {
    forced = true;
    signals.emit("SIGTERM");
  };
  const timer = milliseconds === undefined ? undefined : setTimeout(stop, milliseconds);
  if (cancellable) controller.signal.addEventListener("abort", stop, { once: true });
  if (capture)
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", stop);
      stream.on("data", (part) => {
        bytes += part.length;
        if (bytes > 1024 * 1024) stop();
        else if (stream === child.stdout) output += part.toString("utf8");
      });
    }
  let code, error;
  try {
    if (cancellable && controller.signal.aborted) stop();
    code = await joined;
  } catch (cause) {
    error = cause;
  }
  // Even error/abort cannot release a client before its pipes and process close.
  await closed;
  receipt.closed = true;
  receipt.exitCode = Number.isInteger(code) ? code : null;
  receipt.forced = forced;
  receipt.failed = error !== undefined || forced || code !== 0;
  clearTimeout(timer);
  if (cancellable) controller.signal.removeEventListener("abort", stop);
  if (!receipt.treeJoined) {
    clientCleanupFailure = Object.assign(
      new Error("Account Docker client tree retirement unconfirmed", { cause: error }),
      { cleanupFailure: "account-client" },
    );
    throw clientCleanupFailure;
  }
  if (error) throw error;
  if (forced || code !== 0) throw Error("Desktop account fixture command failed");
  return output.trim();
}
const control = (args) => command(args, { cancellable: false, capture: true, milliseconds: 30000 });
function owned(value, expected) {
  if (!Array.isArray(value) || value.length !== 1)
    throw Error("Account container ownership unconfirmed");
  const item = value[0];
  if (
    !/^[a-f0-9]{64}$/.test(item?.Id) ||
    (expected !== undefined && item.Id !== expected) ||
    item.Image !== imageId ||
    item.Name !== "/" + name ||
    item.Config?.Hostname !== name ||
    item.Config?.Labels?.[label] !== nonce
  )
    throw Error("Account container ownership unconfirmed");
  const state = item.State;
  if (
    typeof state?.Running !== "boolean" ||
    !["created", "running", "exited"].includes(state.Status) ||
    typeof state.StartedAt !== "string" ||
    !Number.isSafeInteger(state.ExitCode) ||
    typeof state.OOMKilled !== "boolean"
  )
    throw Error("Account container state unconfirmed");
  return item;
}
const inspect = async () => owned(JSON.parse(await control(["container", "inspect", id])), id);
async function recordIdentity() {
  await writeFile(
    join(scratch, "identity.json"),
    JSON.stringify({ format: 1, id, nonce, name, imageId }),
    { mode: 0o600, flag: "wx" },
  );
  verified = true;
}
try {
  process.stdout.write("Preparing pinned DuckDB extensions for the isolated account fixture.\n");
  await ensureBundledExtensions({ packageDir: join(root, "packages/gateway") });
  process.stdout.write("Preparing the isolated browser and Node fixture image.\n");
  await command([
    "build",
    "--file",
    dockerfile,
    "--build-arg",
    `PLAYWRIGHT_VERSION=${playwright}`,
    "--tag",
    image,
    join(root, "scripts/desktop"),
  ]);
  const images = JSON.parse(await control(["image", "inspect", image]));
  if (!Array.isArray(images) || images.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(images[0]?.Id))
    throw Error("Account image identity unconfirmed");
  imageId = images[0].Id;
  const entry = `set -euo pipefail
mkdir -p "$OMNESIS_ACCOUNT_SOURCE_ROOT"
tar -C /input --exclude=.git --exclude=.nx --exclude=node_modules --exclude=macos/build --exclude=macos/.node-fixture --exclude=macos/.codex-keychain-fixture --exclude=macos/.codex-backend-fixture --exclude=macos/.analytics-build-fixture -cf - . | tar -C "$OMNESIS_ACCOUNT_SOURCE_ROOT" -xf -
cd "$OMNESIS_ACCOUNT_SOURCE_ROOT"
node scripts/desktop/container-workspace.mjs
exec timeout --foreground 900 npm run test:e2e -- packages/collector/src/e2e/desktop-account.e2e.test.ts`;
  process.stdout.write("Running actual account onboarding with container-owned DNS and trust.\n");
  controller.signal.throwIfAborted();
  await writeFile(
    join(scratch, "creation.json"),
    JSON.stringify({ format: 1, nonce, name, imageId }),
    { mode: 0o600, flag: "wx" },
  );
  createAttempted = true;
  id = await command(
    [
      "create",
      "--init",
      "--network",
      "none",
      "--memory",
      "8g",
      "--cpus",
      "4",
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      `${label}=${nonce}`,
      "--mount",
      `type=bind,source=${root},target=/input,readonly`,
      "--mount",
      `type=bind,source=${modules},target=${mountedDependencies},readonly`,
      ...dependencyAliases,
      "--mount",
      `type=bind,source=${marker},target=/run/desktop-account-container.json,readonly`,
      "--env",
      `OMNESIS_ACCOUNT_SOURCE_ROOT=${root}`,
      "--env",
      `OMNESIS_ACCOUNT_DEPENDENCIES=${mountedDependencies}`,
      "--env",
      "OMNESIS_ACCOUNT_INPUT_ROOT=/input",
      "--env",
      `OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE=${nonce}`,
      "--env",
      "OMNESIS_TEST_SCHEDULER_ACTIVE",
      "--env",
      "OMNESIS_E2E_WORKERS=1",
      imageId,
      "bash",
      "-c",
      entry,
    ],
    { capture: true },
  );
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Account container creation receipt missing");
  await inspect();
  await recordIdentity();
  await command(["start", "--attach", id]);
} catch (error) {
  failure = error;
}
try {
  if (clientCleanupFailure) throw clientCleanupFailure;
  if (createAttempted && !verified) {
    // A lost create reply is not permission to signal a name. Establish full identity first.
    const recovered = owned(
      JSON.parse(await control(["container", "inspect", name])),
      /^[a-f0-9]{64}$/.test(id) ? id : undefined,
    );
    id = recovered.Id;
    await recordIdentity();
  }
  if (verified) {
    const before = (await inspect()).State;
    if (before.Running) await control(["stop", "--time", "10", id]);
    if (before.Status === "created" && !before.Running && before.StartedAt.startsWith("0001-")) {
      failure ??= Error("Account cohort never started");
    } else {
      const exit = await control(["wait", id]);
      const after = (await inspect()).State;
      if (
        after.Running ||
        after.Status !== "exited" ||
        !/^\d+$/.test(exit) ||
        Number(exit) !== after.ExitCode
      )
        throw Error("Account container exit receipt unconfirmed");
      if (after.ExitCode !== 0 || after.OOMKilled)
        failure ??= Error("Account cohort did not complete successfully");
    }
    stopped = true;
    // Revalidate immutable identity after the exit proof; removal never targets a name.
    const final = (await inspect()).State;
    if (final.Running || !["created", "exited"].includes(final.Status))
      throw Error("Account container retirement unconfirmed");
    if ((await control(["rm", id])) !== id) throw Error("Account removal receipt unconfirmed");
    removed = true;
  }
} catch (error) {
  cleanupFailure = error;
}
try {
  await writeFile(
    join(scratch, "cleanup.json"),
    JSON.stringify({
      format: 1,
      nonce,
      name,
      imageId,
      id,
      createAttempted,
      verified,
      stopped,
      removed,
      // A retained receipt never certifies final control-directory deletion.
      cleanupConfirmed: false,
      containerCleanupConfirmed: !cleanupFailure && (!createAttempted || removed),
      controlCleanup: "pending",
      commandFailed: failure !== undefined,
      cleanupFailed: cleanupFailure !== undefined,
      clients,
    }),
    { mode: 0o600, flag: "wx" },
  );
} catch (error) {
  cleanupFailure = new AggregateError(
    [...(cleanupFailure ? [cleanupFailure] : []), error],
    "Account cleanup receipt failed",
  );
}
process.off("SIGTERM", abort);
process.off("SIGINT", abort);
if (cleanupFailure)
  throw Object.assign(
    new AggregateError(
      [...(failure ? [failure] : []), cleanupFailure],
      "Desktop account fixture cleanup unconfirmed; private control retained",
    ),
    { cleanupFailure: "account-container" },
  );
try {
  await rm(scratch, { recursive: true, force: true });
} catch (error) {
  // Removal can be partial: retain remaining evidence without recreating deleted control state.
  throw Object.assign(
    new AggregateError(
      [...(failure ? [failure] : []), error],
      "Desktop account control cleanup unconfirmed; remaining evidence retained",
    ),
    { cleanupFailure: "account-control" },
  );
}
if (failure) throw failure;
