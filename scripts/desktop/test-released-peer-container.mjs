// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { waitForChild } from "../lib/check-process.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { treeFingerprint } from "../nx/tree-state.mjs";

const repository = "ghcr.io/omnesis-dev/omnesis-collector";
export const releasedCollector = Object.freeze({
  revision: "2ae3aa097c6ab49dc8dedc65a514c7f8e2062913",
  version: "0.8.1",
  index: "sha256:af10b10a36943486532f778ef328f36e3befb5e9ce18776c2056f9334e0bb4fd",
  arm64: Object.freeze({
    platform: "linux/arm64",
    manifest: "sha256:b5efb78100d825058207431d8684914bd877ef16c876be0dc3817a781a9e8cca",
    config: "sha256:6acb07e9d1a09f52d75bd8864e625670ea1d6f3a7c0add0cf2ff683a191a9f55",
  }),
  x64: Object.freeze({
    platform: "linux/amd64",
    manifest: "sha256:b3fda717200c3260721bee2489bc1f819aa973e11ec89211a029194430a8baef",
    config: "sha256:042910b8f219872f78b4b0ff0e3c280a1ff61e4ef3f82757fef24a9e9bf58b32",
  }),
});
export const releasedGateway = Object.freeze({
  revision: releasedCollector.revision,
  version: releasedCollector.version,
  index: "sha256:dbd68dc65235e830d84b97c2a7e065dcdfa1420bf02348c2f5b742308461e55c",
  arm64: Object.freeze({
    platform: "linux/arm64",
    manifest: "sha256:045ca61f4c428e5824a46313c46e0b10d14f5c076523de548310b3708e942a62",
    config: "sha256:266cc9b17a14a03e0036b5ae877ed0516111ad116266cbee134a7044f424a899",
  }),
  x64: Object.freeze({
    platform: "linux/amd64",
    manifest: "sha256:ab635b6ccf6d76ccc4cf10894ea5150caa2b5dc979a869ab40dc990fc43b65cd",
    config: "sha256:133cef6423cc14b8094b89f7dffac20ea549c5b690ae78dd50269596ab84d194",
  }),
});
export function releasedDirection(value = "released-collector") {
  if (value !== "released-collector" && value !== "released-gateway")
    throw Error("Released peer direction unsupported");
  return value;
}
export function releasedDirectionArgs(args) {
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith("--direction=")))
    throw Error("Use one explicit released peer direction");
  return releasedDirection(args[0]?.slice("--direction=".length));
}

function cohortFile(direction) {
  return direction === "released-gateway"
    ? "packages/collector/src/e2e/released-gateway-current-collector.e2e.test.ts"
    : "packages/collector/src/e2e/released-collector-current-gateway.e2e.test.ts";
}
const label = "dev.omnesis.test.released-peer";
function selected(architecture, direction = "released-collector") {
  releasedDirection(direction);
  if (architecture !== "arm64" && architecture !== "x64")
    throw Error("Native released collector architecture unsupported");
  const release = direction === "released-gateway" ? releasedGateway : releasedCollector;
  const pin = release[architecture];
  const imageRepository =
    direction === "released-gateway" ? "ghcr.io/omnesis-dev/omnesis-gateway" : repository;
  return { ...pin, reference: `${imageRepository}@${pin.manifest}` };
}
export function verifyReleasedCollectorImage(
  value,
  architecture,
  direction = "released-collector",
) {
  const pin = selected(architecture, direction);
  if (!Array.isArray(value) || value.length !== 1) throw Error("Released image inspection refused");
  const image = value[0],
    config = image?.Config;
  if (
    image?.Id !== pin.config ||
    image.Os !== "linux" ||
    image.Architecture !== pin.platform.split("/")[1] ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(pin.reference) ||
    config?.WorkingDir !== "/app" ||
    config.User !== "10001:10001" ||
    JSON.stringify(config.Cmd) !==
      JSON.stringify([
        "node",
        direction === "released-gateway"
          ? "packages/gateway/dist/index.js"
          : "packages/collector/dist/main.js",
      ]) ||
    (direction === "released-gateway"
      ? JSON.stringify(config.Entrypoint) !==
        JSON.stringify(["/app/scripts/seeded-state/entrypoint.sh"])
      : Object.hasOwn(config, "Entrypoint") &&
        config.Entrypoint !== null &&
        (!Array.isArray(config.Entrypoint) || config.Entrypoint.length !== 0)) ||
    config.Labels?.["org.opencontainers.image.revision"] !== releasedCollector.revision ||
    config.Labels?.["org.opencontainers.image.version"] !== releasedCollector.version ||
    config.Labels?.["org.opencontainers.image.source"] !== "https://github.com/omnesis-dev/Omnesis"
  )
    throw Error("Released image identity or metadata differs");
  return pin;
}

/** Fixed copied-current entry; /app remains the genuine released image closure. */
const entry = (direction) => `set -euo pipefail
umask 077
command -v tar >/dev/null
command -v openssl >/dev/null
mkdir -p /tmp/omnesis-c6/current /tmp/omnesis-c6/harness
export HOME=/tmp/omnesis-c6/harness
export USERPROFILE="$HOME"
tar -C /input --null --verbatim-files-from -T /run/c6-source-files -cf - | tar -C /tmp/omnesis-c6/current -xf -
cd /tmp/omnesis-c6/current
node scripts/desktop/container-workspace.mjs
exec node node_modules/vitest/vitest.mjs run ${cohortFile(direction)} --no-file-parallelism --maxWorkers=1`;

function verifyModuleMount(root, modules, result) {
  if (basename(modules) !== "node_modules" || root === modules || root.startsWith(modules + "/"))
    throw Error("Released dependency mount root refused");
  for (const target of [
    "/app",
    "/input",
    "/tmp/omnesis-c6/current",
    "/results",
    "/run/c6-dependencies",
    result,
  ]) {
    if (modules === target || modules.startsWith(target + "/") || target.startsWith(modules + "/"))
      throw Error("Released dependency alias overlaps a protected target");
  }
}

function verifyControlMounts(root, modules, control, result, marker, files) {
  if (
    typeof control !== "string" ||
    !control.startsWith("/") ||
    resolve(control) !== control ||
    dirname(result) !== control ||
    basename(result) !== "child-results" ||
    marker !== join(control, "container.json") ||
    files !== join(control, "source-files")
  )
    throw Error("Released control and result layout refused");
  for (const source of [root, modules]) {
    if (source === control || source.startsWith(control + "/") || control.startsWith(source + "/"))
      throw Error("Released input alias exposes private control state");
  }
}
async function verifyOwnedDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw Error("Released private directory ownership refused");
}

export function releasedContainerArguments({
  architecture,
  direction = "released-collector",
  root,
  modules,
  marker,
  files,
  result,
  control,
  nonce,
  uid,
  gid,
}) {
  verifyModuleMount(root, modules, result);
  verifyControlMounts(root, modules, control, result, marker, files);
  const pin = selected(architecture, direction);
  const dependencies = "/run/c6-dependencies/node_modules";
  const mounts = [
    [root, "/input", true],
    [modules, dependencies, true],
    [marker, "/run/desktop-c6-container.json", true],
    [files, "/run/c6-source-files", true],
    [result, "/results", false],
    ...(!modules.startsWith(root + "/") ? [[modules, modules, true]] : []),
  ];
  for (const [source, target] of mounts)
    if (
      !source.startsWith("/") ||
      source.includes(",") ||
      !target.startsWith("/") ||
      target.startsWith("/app")
    )
      throw Error("Released fixture bind refused");
  return [
    "create",
    "--platform",
    pin.platform,
    "--pull",
    "never",
    "--network",
    "none",
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "8g",
    "--cpus",
    "4",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,size=2g,mode=1777",
    "--user",
    `${uid}:${gid}`,
    "--name",
    `omnesis-released-peer-${nonce}`,
    "--hostname",
    `omnesis-released-peer-${nonce}`,
    "--label",
    `${label}=${nonce}`,
    ...mounts.flatMap(([source, target, readonly]) => [
      "--mount",
      `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
    ]),
    ...Object.entries({
      HOME: "/tmp/omnesis-c6/harness",
      OMNESIS_CONFIG_DIR: "/tmp/omnesis-c6/harness/config",
      NODE_ENV: "test",
      OMNESIS_RUNTIME_MODE: "test",
      OMNESIS_TELEMETRY: "off",
      OMNESIS_E2E_RELEASED_PEER: nonce,
      OMNESIS_E2E_RELEASED_DIRECTION: releasedDirection(direction),
      OMNESIS_E2E_DISABLE_DEFAULT_RELAY: "1",
      OMNESIS_E2E_DISABLE_RELEASE_CHECK: "1",
      OMNESIS_E2E_DISABLE_ICON_FETCH: "1",
      OMNESIS_E2E_WORKERS: "1",
      OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: nonce,
      OMNESIS_ACCOUNT_INPUT_ROOT: "/input",
      OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
    }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    pin.reference,
    "/bin/bash",
    "-c",
    entry(direction),
  ];
}

async function command(executable, args, { signal, env, cwd, milliseconds = 30000, onClosed }) {
  signal?.throwIfAborted();
  const deadline = performance.now() + milliseconds;
  const child = spawn(executable, args, {
    env,
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signals = new EventEmitter();
  const closed = new Promise((done) => child.once("close", done));
  const joined = waitForChild(child, { signalEmitter: signals });
  void joined.catch(() => {});
  let tail = Buffer.alloc(0),
    stdoutBytes = 0,
    stderrBytes = 0;
  let stdout = "",
    bytes = 0,
    forced = false;
  const stop = () => {
    forced = true;
    signals.emit("SIGTERM");
  };
  const timer = setTimeout(stop, milliseconds);
  signal?.addEventListener("abort", stop, { once: true });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("error", stop);
    stream.on("data", (part) => {
      bytes += part.length;
      if (stream === child.stdout) stdoutBytes += part.length;
      else stderrBytes += part.length;
      tail =
        part.length >= 65536
          ? Buffer.from(part.subarray(-65536))
          : Buffer.from(Buffer.concat([tail, part]).subarray(-65536));
      if (bytes > 4 * 1024 * 1024) stop();
      else if (stream === child.stdout) stdout += part.toString("utf8");
    });
  }
  let code, failure;
  try {
    if (signal?.aborted) stop();
    code = await joined;
  } catch (error) {
    failure = error;
  }
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  await closed;
  onClosed?.({ tail, seenBytes: bytes, stdoutBytes, stderrBytes, rootClosed: true });
  forced ||= performance.now() >= deadline;
  if (failure) throw failure;
  if (forced || code !== 0) throw Error("Released fixture command failed");
  return stdout.trim();
}

function ownedContainer(value, id, nonce, pin) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0]?.Id !== id ||
    value[0]?.Image !== pin.config ||
    value[0]?.Config?.Labels?.[label] !== nonce ||
    value[0]?.Name !== `/omnesis-released-peer-${nonce}`
  )
    throw Error("Released container ownership unconfirmed");
  const state = value[0].State;
  if (
    !state ||
    typeof state.Running !== "boolean" ||
    typeof state.StartedAt !== "string" ||
    !["created", "running", "exited", "paused", "restarting", "removing", "dead"].includes(
      state.Status,
    ) ||
    !Number.isInteger(state.ExitCode)
  )
    throw Error("Released container state unconfirmed");
  return state;
}

async function receipt(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 4096
    )
      throw Error("Released receipt ownership or bound refused");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      bytesRead > 4096 ||
      info.size !== bytesRead ||
      before.ino !== info.ino ||
      before.size !== info.size ||
      before.mtimeMs !== info.mtimeMs ||
      before.ctimeMs !== info.ctimeMs
    )
      throw Error("Released receipt bound refused");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Docker executable is injectable only by unit callers, never via the runtime environment. */
export async function runReleasedPeerContainer({
  root,
  modules,
  architecture = process.arch,
  direction = "released-collector",
  signal,
  docker = "docker",
  env = process.env,
}) {
  direction = releasedDirection(direction);
  if (process.platform !== "linux") throw Error("Released peer container requires Linux");
  if (architecture !== process.arch)
    throw Error("Released peer container refuses architecture emulation");
  if (
    ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].some(
      (key) => env[key],
    )
  )
    throw Error("Released peer runner requires the local default Docker endpoint");
  root = await realpath(root);
  if (root !== (await realpath(process.cwd())))
    throw Error("Released runner requires the current admitted checkout");
  modules = await realpath(modules);
  verifyModuleMount(root, modules, "/results");
  const pin = selected(architecture, direction),
    nonce = randomUUID();
  const scratch = await mkdtemp(join(tmpdir(), "omnesis-released-oci-"));
  const dockerConfig = join(scratch, "docker-config"),
    result = join(scratch, "child-results");
  await mkdir(dockerConfig, { mode: 0o700 });
  await mkdir(result, { mode: 0o700 });
  await verifyOwnedDirectory(scratch);
  await verifyOwnedDirectory(dockerConfig);
  await verifyOwnedDirectory(result);
  env = { ...env, DOCKER_CONFIG: dockerConfig };
  const marker = join(scratch, "container.json"),
    files = join(scratch, "source-files");
  verifyControlMounts(root, modules, scratch, result, marker, files);
  const sourceFingerprint = treeFingerprint("HEAD").fingerprint;
  let id,
    verified = false,
    createAttempted = false,
    failure,
    retired = false;
  const phases = [];
  let phaseNumber = 0;
  const capture = (stage) => {
    if (
      ![
        "info",
        "pull",
        "image",
        "source-list",
        "create",
        "container",
        "start",
        "stop",
        "wait",
        "rm",
      ].includes(stage)
    )
      throw Error("Released command stage refused");
    const number = ++phaseNumber;
    return (closed) => phases.push({ ...closed, number, stage });
  };
  const execute = (args, cancellable = true, milliseconds = 30000) =>
    command(docker, args, {
      signal: cancellable ? signal : undefined,
      env,
      cwd: root,
      milliseconds,
      onClosed: capture(args[0]),
    });
  const inspect = async () =>
    ownedContainer(JSON.parse(await execute(["container", "inspect", id], false)), id, nonce, pin);
  try {
    const daemon = await execute(["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
    const native =
      architecture === "arm64" ? ["linux/arm64", "linux/aarch64"] : ["linux/amd64", "linux/x86_64"];
    if (!native.includes(daemon))
      throw Error("Released collector requires a matching native Linux Docker daemon");
    process.stdout.write(`Preparing the digest-pinned ${direction} image.\n`);
    await execute(["pull", "--platform", pin.platform, pin.reference], true, 900000);
    verifyReleasedCollectorImage(
      JSON.parse(await execute(["image", "inspect", pin.reference])),
      architecture,
      direction,
    );
    const list = await command(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { signal, env, cwd: root, onClosed: capture("source-list") },
    );
    if (!list || list.split("\0").filter(Boolean).length > 100000)
      throw Error("Released fixture public source list refused");
    await writeFile(
      marker,
      JSON.stringify({
        format: 1,
        owner: "omnesis-released-peer",
        nonce,
        image: pin.config,
        reference: pin.reference,
        dependencyAlias: modules,
        direction,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(files, list, { mode: 0o600, flag: "wx" });
    const createArgs = releasedContainerArguments({
      architecture,
      direction,
      root,
      modules,
      marker,
      files,
      result,
      control: scratch,
      nonce,
      uid: process.getuid(),
      gid: process.getgid(),
    });
    signal?.throwIfAborted();
    createAttempted = true;
    id = await execute(createArgs);
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Released container create receipt missing");
    await inspect();
    verified = true;
    await execute(["start", "--attach", id], true, 900000);
  } catch (error) {
    failure = error;
  }
  if (createAttempted && !verified) {
    failure = Object.assign(
      new Error("Released container creation ambiguous; ownership retained", { cause: failure }),
      { cleanupFailure: "container-create" },
    );
  } else if (verified) {
    try {
      const before = await inspect();
      if (before.Status !== "created") {
        if (before.Running) await execute(["stop", "--time", "10", id], false);
        const exit = await execute(["wait", id], false);
        const after = await inspect();
        if (
          after.Running !== false ||
          after.Status !== "exited" ||
          !/^\d+$/.test(exit) ||
          Number(exit) !== after.ExitCode
        )
          throw Error("Released container exit receipt unconfirmed");
        if (after.ExitCode !== 0 || after.OOMKilled)
          failure ??= Error("Released cohort did not complete successfully");
      } else if (before.Running !== false || !String(before.StartedAt).startsWith("0001-")) {
        throw Error("Released container never-started receipt unconfirmed");
      }
      if (before.Status === "created") failure ??= Error("Released cohort never started");
      if (!failure) {
        try {
          if (treeFingerprint("HEAD").fingerprint !== sourceFingerprint)
            throw Error("Released cohort current source changed");
          await verifyOwnedDirectory(scratch);
          await verifyOwnedDirectory(result);
          const cohort = await receipt(join(result, "cohort.json"));
          const runtime = await receipt(join(result, "runtime.json"));
          for (const key of [
            "initialSyncSettled",
            "independentDeviceIds",
            ...(direction === "released-gateway"
              ? ["realPublishedGateway", "desktopProtectionUnavailable", "independentDesktopGrants"]
              : ["realPublishedCollector"]),
            "pauseConsumedBeforeNewFile",
            direction === "released-gateway"
              ? "releasedSiblingProgressWhileCurrentPaused"
              : "currentProgressWhilePaused",
            "resumedFileIngested",
            "stableDocumentIds",
          ])
            if (cohort[key] !== true) throw Error("Released cohort positive receipt incomplete");
          if (
            cohort.format !== 1 ||
            cohort.operatingSystems !== 1 ||
            runtime.format !== 1 ||
            runtime.direction !== direction ||
            runtime.node !== "v24.22.3" ||
            runtime.releasedVersion !== "0.8.1" ||
            runtime.currentProductResolutionOwned !== true ||
            runtime.releasedProductResolutionOwned !== true ||
            runtime.currentPackagedNodeQualified !== false
          )
            throw Error("Released runtime receipt differs");
        } catch (error) {
          failure = Error("Released cohort evidence incomplete", { cause: error });
        }
      }
      await execute(["rm", id], false);
      retired = true;
    } catch (error) {
      failure = Object.assign(
        new AggregateError(
          [...(failure ? [failure] : []), error],
          "Released container retirement unconfirmed",
          { cause: failure ?? error },
        ),
        { cleanupFailure: "container-retirement" },
      );
    }
  }
  try {
    await verifyOwnedDirectory(scratch);
    if (failure) {
      const metadata = [];
      for (const phase of phases) {
        const leaf = `phase-${String(phase.number).padStart(2, "0")}-${phase.stage}.log`;
        await writeFile(join(scratch, leaf), phase.tail, { mode: 0o600, flag: "wx" });
        metadata.push({
          stage: phase.stage,
          leaf,
          seenBytes: phase.seenBytes,
          stdoutBytes: phase.stdoutBytes,
          stderrBytes: phase.stderrBytes,
          capturedBytes: phase.tail.length,
          truncated: phase.seenBytes > phase.tail.length,
          rootClosed: phase.rootClosed,
        });
      }
      await writeFile(
        join(scratch, "phase-evidence.json"),
        JSON.stringify({ format: 1, phases: metadata, causality: "output-observation-only" }),
        { mode: 0o600, flag: "wx" },
      );
    }
    await writeFile(
      join(scratch, "runner.json"),
      JSON.stringify({
        format: 1,
        reference: pin.reference,
        config: pin.config,
        index: direction === "released-gateway" ? releasedGateway.index : releasedCollector.index,
        direction,
        revisionLabel: releasedCollector.revision,
        versionLabel: releasedCollector.version,
        architecture,
        currentSourceFingerprint: sourceFingerprint,
        createAttempted,
        containerId: /^[a-f0-9]{64}$/.test(id ?? "") ? id : null,
        verified,
        retired,
        passed: !failure,
        provenance: "digest-bound-labels-not-signature",
        sourceRuntime: "current-source-on-image-node-not-packaged-native",
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    throw Object.assign(
      new AggregateError(
        [...(failure ? [failure] : []), error],
        "Released runner receipt unavailable",
        { cause: failure ?? error },
      ),
      {
        cleanupFailure: failure?.cleanupFailure ?? "released-evidence",
        evidenceDirectory: scratch,
      },
    );
  }
  if (failure) throw Object.assign(failure, { evidenceDirectory: scratch });
  return { evidenceDirectory: scratch, reference: pin.reference };
}

if (isEntryScript(import.meta.url)) {
  if (!process.env.OMNESIS_TEST_SCHEDULER_ACTIVE && process.env.CI !== "true")
    throw Error("Use normal E2E admission for the released peer cohort");
  const direction = releasedDirectionArgs(process.argv.slice(2));
  const require = createRequire(import.meta.url),
    controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  try {
    await runReleasedPeerContainer({
      direction,
      root: resolve("."),
      modules: dirname(dirname(await realpath(require.resolve("vitest/package.json")))),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
}
