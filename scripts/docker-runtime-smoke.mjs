#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build/boot smoke for the published runtime images: the compiled, non-root
 * gateway (plus its seeded-state installer), the collector, and the one-shot
 * updater that carries a Docker client.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { gatewayBootBudgetMs } from "./lib/boot-budget.mjs";
import {
  SEEDED_STATE_MANIFEST,
  createSeededStateArtifact,
  seededStateTableSpec,
  sha256File,
} from "./seeded-state/artifact.mjs";

const image = process.env.OMNESIS_RUNTIME_SMOKE_IMAGE ?? "omnesis-gateway-runtime:smoke";
const collectorImage =
  process.env.OMNESIS_COLLECTOR_RUNTIME_SMOKE_IMAGE ?? "omnesis-collector-runtime:smoke";
const updaterImage = process.env.OMNESIS_UPDATER_SMOKE_IMAGE ?? "omnesis-updater:smoke";
const runtimeTargets = [
  ["gateway-runtime", image],
  ["collector-runtime", collectorImage],
  ["updater", updaterImage],
];
const productVersion = JSON.parse(
  readFileSync(new URL("../packages/gateway/package.json", import.meta.url), "utf8"),
).version;
const root = mkdtempSync(join(tmpdir(), "omnesis-runtime-smoke-"));
const firstState = join(root, "first-state");
const secondState = join(root, "second-state");
const artifact = join(root, "artifact");
const seedInput = join(root, "seed-input.json");
const suffix = `${process.pid}-${Date.now()}`;
const firstContainer = `omnesis-runtime-first-${suffix}`;
const secondContainer = `omnesis-runtime-seeded-${suffix}`;
const containers = [firstContainer, secondContainer];

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function containerDiagnostics(name) {
  const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  const state = spawnSync("docker", ["inspect", "--format", "{{json .State}}", name], {
    encoding: "utf8",
  });
  return `${state.stdout}${logs.stdout}${logs.stderr}`;
}

function prepareState(directory) {
  docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "sh",
    "--mount",
    `type=bind,source=${root},target=/scratch`,
    image,
    "-c",
    `mkdir -p /scratch/${directory === firstState ? "first-state" : "second-state"} && ` +
      `chown 10001:10001 /scratch/${directory === firstState ? "first-state" : "second-state"} && ` +
      `chmod 0700 /scratch/${directory === firstState ? "first-state" : "second-state"}`,
  );
}

function runGateway(name, state, extra = []) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001",
    "--mount",
    `type=bind,source=${state},target=/var/lib/omnesis`,
    ...extra,
    image,
  );
}

async function waitForHealth(name) {
  const deadline = Date.now() + gatewayBootBudgetMs();
  while (Date.now() < deadline) {
    const state = docker(
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.Health.Status}}",
      name,
    ).trim();
    if (state === "running healthy") return;
    if (state.startsWith("exited") || state.endsWith("unhealthy")) {
      throw new Error(`${name} failed health check:\n${containerDiagnostics(name)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${name} did not become healthy:\n${containerDiagnostics(name)}`);
}

function stop(name) {
  const result = spawnSync("docker", ["stop", "--timeout", "20", name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const exit = docker("inspect", "--format", "{{.State.ExitCode}}", name).trim();
  if (exit !== "0") throw new Error(`${name} exited with ${exit}`);
}

function makeReadable(directory) {
  docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "chown",
    "--mount",
    `type=bind,source=${directory},target=/state`,
    image,
    "-R",
    `${process.getuid()}:${process.getgid()}`,
    "/state",
  );
}

/** Run a shell one-liner in a throwaway container, bypassing the image entrypoint. */
function shell(target, script) {
  return docker("run", "--rm", "--entrypoint", "sh", target, "-c", script);
}

/**
 * The published images invoke node directly. A package manager in one is both
 * an unused executable surface and a way for a compromised container to fetch
 * more code.
 */
function assertNoPackageManagers(target, distEntry) {
  shell(
    target,
    `test ! -w ${distEntry} && ` +
      "test ! -w /app/node_modules/better-sqlite3/package.json && " +
      'for command in npm npx corepack pnpm pnpx yarn yarnpkg; do ! command -v "$command" || exit 1; done && ' +
      "test ! -e /usr/local/lib/node_modules/npm && " +
      "test ! -e /usr/local/lib/node_modules/corepack && " +
      "! find /opt -maxdepth 1 -name 'yarn-v*' -print -quit | grep -q .",
  );
}

/**
 * `docker compose exec <service> omnesis …` is the supported way to drive an
 * install, so every image must resolve `omnesis` on PATH and report the one
 * lockstep product version.
 */
function assertOmnesisBinary(target) {
  const reported = docker("run", "--rm", "--entrypoint", "omnesis", target, "--version").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(reported)) {
    throw new Error(`${target} omnesis --version printed a non-semver value: ${reported}`);
  }
  if (reported !== productVersion) {
    throw new Error(
      `${target} ships CLI ${reported}, expected the product version ${productVersion}`,
    );
  }
}

/** Both daemons and the updater run as the same fixed unprivileged identity. */
function assertUnprivilegedIdentity(target) {
  const identity = shell(target, "id -u; id -g").split("\n").slice(0, 2).join(":");
  if (identity !== "10001:10001") {
    throw new Error(`${target} ran as ${identity}, expected 10001:10001`);
  }
  const configured = docker("inspect", "--format", "{{.Config.User}}", target).trim();
  if (configured !== "10001:10001") {
    throw new Error(`${target} declares USER ${configured || "(none)"}, expected 10001:10001`);
  }
}

try {
  if (process.argv.includes("--build")) {
    for (const [target, tag] of runtimeTargets) {
      execFileSync("docker", ["build", "--target", target, "-t", tag, "."], { stdio: "inherit" });
    }
  }

  assertNoPackageManagers(image, "/app/packages/gateway/dist/index.js");
  assertUnprivilegedIdentity(image);
  assertOmnesisBinary(image);

  assertNoPackageManagers(collectorImage, "/app/packages/collector/dist/main.js");
  assertUnprivilegedIdentity(collectorImage);
  assertOmnesisBinary(collectorImage);

  // The updater is the only image with a Docker client: it is handed the host
  // socket for one invocation so `omnesis update` can replace the containers
  // that cannot replace themselves. Everything else about it is the gateway
  // runtime, so it answers the same questions.
  assertNoPackageManagers(updaterImage, "/app/packages/gateway/dist/index.js");
  assertUnprivilegedIdentity(updaterImage);
  assertOmnesisBinary(updaterImage);
  shell(updaterImage, "command -v docker >/dev/null && docker compose version >/dev/null");

  prepareState(firstState);
  runGateway(firstContainer, firstState);
  await waitForHealth(firstContainer);
  if (docker("inspect", "--format", "{{.Config.User}}", firstContainer).trim() !== "10001:10001") {
    throw new Error("compiled gateway did not run as the fixed non-root user");
  }
  docker(
    "exec",
    firstContainer,
    "curl",
    "--fail",
    "--insecure",
    "--silent",
    "https://127.0.0.1:7600/portal/",
  );
  stop(firstContainer);
  makeReadable(firstState);

  const source = new Database(join(firstState, "omnesis.db"), { readonly: true });
  const tables = source
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all()
    .map((name) =>
      seededStateTableSpec(
        name,
        source.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(name),
      ),
    )
    .filter((table) => table !== null);
  const views = source
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name")
    .pluck()
    .all();
  const schemaVersion = source.pragma("user_version", { simple: true });
  source.close();

  writeFileSync(seedInput, '{"fixture":"empty-runtime-smoke"}\n');
  createSeededStateArtifact(
    {
      formatVersion: 1,
      productVersion,
      schemaVersion,
      seed: { name: "empty-runtime-smoke", inputs: [{ name: "seed.json", path: seedInput }] },
      databases: [{ source: join(firstState, "omnesis.db"), target: "omnesis.db", tables, views }],
      expected: { rowCounts: { "omnesis.db": { documents: 0 } } },
    },
    artifact,
  );
  const manifestSha = sha256File(join(artifact, SEEDED_STATE_MANIFEST));
  const artifactDatabaseSha = sha256File(join(artifact, "omnesis.db"));
  const firstTokenSha = sha256File(join(firstState, "token"));

  prepareState(secondState);
  runGateway(secondContainer, secondState, [
    "--mount",
    `type=bind,source=${artifact},target=/opt/omnesis-seed,readonly`,
    "--env",
    "OMNESIS_SEEDED_STATE_DIR=/opt/omnesis-seed",
    "--env",
    `OMNESIS_SEEDED_STATE_MANIFEST_SHA256=${manifestSha}`,
  ]);
  await waitForHealth(secondContainer);
  stop(secondContainer);
  makeReadable(secondState);

  if (sha256File(join(secondState, "token")) === firstTokenSha) {
    throw new Error("seeded starts reused bootstrap credentials");
  }
  if (sha256File(join(artifact, "omnesis.db")) !== artifactDatabaseSha) {
    throw new Error("seeded start mutated the immutable artifact");
  }
  console.log("compiled non-root gateway, collector, updater and seeded-state boot smoke passed");
} finally {
  for (const container of containers) {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  // A root-owned state can remain after an early container failure. Reclaim it
  // through the image before removing this uniquely-created temporary root.
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "chown",
      "--mount",
      `type=bind,source=${root},target=/scratch`,
      image,
      "-R",
      `${process.getuid()}:${process.getgid()}`,
      "/scratch",
    ],
    { stdio: "ignore" },
  );
  rmSync(root, { recursive: true, force: true });
}
