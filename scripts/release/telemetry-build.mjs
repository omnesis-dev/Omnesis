// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://github.com/omnesis-dev/Omnesis.git";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PROOF_PATH = "packages/gateway/telemetry-build.json";

// These are the runtime-build stage's COPY inputs. Tests bind this list to the
// Dockerfile. Dependency outputs are excluded; npm installs them from the lockfile.
export const TELEMETRY_BUILD_INPUTS = [
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "packages",
  "patches",
  "scripts",
];

/** Match the Docker context exclusions affecting the declared build inputs. */
function excluded(path) {
  const parts = path.split("/");
  return (
    path === PROOF_PATH ||
    parts.some((part) => ["node_modules", "dist", "__tests__"].includes(part)) ||
    path.endsWith(".tsbuildinfo") ||
    path.endsWith(".test.ts") ||
    /^packages\/gateway\/duckdb-extensions\/v[^/]*(?:\/|$)/.test(path)
  );
}

/** Bind archive provenance to exactly the source bytes the Docker build consumes. */
export function telemetryBuildDigest(root) {
  const hash = createHash("sha256");
  const visit = (path) => {
    if (excluded(path)) return;
    const full = join(root, path);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      const kind = stat.isSymbolicLink() ? "link" : "file";
      const bytes = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
      hash.update(
        JSON.stringify([
          path,
          kind,
          stat.mode & 0o111,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      );
      hash.update("\n");
    } else {
      throw new Error("Unsupported build input");
    }
  };
  const roots = [
    ...TELEMETRY_BUILD_INPUTS,
    ...readdirSync(root).filter((name) => /^tsconfig.*\.json$/.test(name)),
  ];
  for (const path of roots.sort()) visit(path);
  return hash.digest("hex");
}

function archiveCommit(root) {
  try {
    const proof = JSON.parse(readFileSync(join(root, PROOF_PATH), "utf8"));
    if (proof.schemaVersion !== 1 || !SHA.test(proof.gitCommit) || !DIGEST.test(proof.inputDigest))
      return "custom";
    return proof.inputDigest === telemetryBuildDigest(root) ? proof.gitCommit : "custom";
  } catch {
    return "custom";
  }
}

/** Prove provenance without ever sending a local (possibly private) SHA upstream. */
export function telemetryBuildCommit(
  root,
  { run = execFileSync, env = process.env, allowArchiveProof = false } = {},
) {
  // Staging tests and isolated install fixtures must never make a network request.
  if (env.VITEST || env.NODE_ENV === "test" || env.OMNESIS_RUNTIME_MODE === "test") return "custom";
  // Only a git-less build context may consume CI's content-bound archive proof.
  // A checkout must prove its current history, even when an old proof remains.
  if (allowArchiveProof && !existsSync(join(root, ".git"))) return archiveCommit(root);
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const gitEnv = {
    ...inherited,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
  };
  const git = (args, cwd = root) =>
    run("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv,
    }).trim();
  const remoteRefs = () => {
    // Local/global URL rewrites must never replace the public upstream with a
    // private fork. An empty directory also prevents repository config discovery.
    const scratch = mkdtempSync(join(tmpdir(), "omnesis-telemetry-upstream-"));
    try {
      return run("git", ["ls-remote", UPSTREAM, "refs/heads/main", "refs/tags/*"], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...gitEnv, GIT_CEILING_DIRECTORIES: tmpdir() },
      }).trim();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  try {
    if (git(["status", "--porcelain", "--untracked-files=normal"])) return "custom";
    const local = git(["rev-parse", "HEAD"]);
    if (!SHA.test(local)) return "custom";
    // Only the constant public repository and reference are sent to the network.
    const refs = remoteRefs()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        ([sha, ref]) =>
          SHA.test(sha) && (ref === "refs/heads/main" || ref?.startsWith("refs/tags/")),
      );
    // Exact advertised refs also prove shallow release clones without fetching history.
    if (refs.some(([sha]) => sha === local)) return local;
    const upstream = refs.find(([, ref]) => ref === "refs/heads/main")?.[0];
    if (!upstream) return "custom";
    git(["merge-base", "--is-ancestor", local, upstream]);
    return local;
  } catch {
    return "custom";
  }
}

/** Write before building an official image, while the checkout still has Git. */
export function writeTelemetryBuildProof(root, options = {}) {
  const gitCommit = telemetryBuildCommit(root, { ...options, allowArchiveProof: false });
  let proof = { schemaVersion: 1, gitCommit: "custom" };
  if (gitCommit !== "custom") {
    try {
      proof = { schemaVersion: 1, gitCommit, inputDigest: telemetryBuildDigest(root) };
    } catch {
      /* An incomplete build context has no provenance. */
    }
  }
  writeFileSync(join(root, PROOF_PATH), `${JSON.stringify(proof)}\n`);
  return proof.gitCommit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--write-proof") throw new Error("Expected --write-proof");
  try {
    writeTelemetryBuildProof(fileURLToPath(new URL("../../", import.meta.url)));
  } catch {
    // An absent proof simply makes the image report custom.
    process.stderr.write("Telemetry build provenance unavailable; image will report custom.\n");
  }
}
