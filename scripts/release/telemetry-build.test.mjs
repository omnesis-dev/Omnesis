// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  telemetryBuildCommit,
  TELEMETRY_BUILD_INPUTS,
  writeTelemetryBuildProof,
} from "./telemetry-build.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const local = "a".repeat(40);
const upstream = "b".repeat(40);

function fixture({ dirty = false, unknown = false, tagOnly = false } = {}) {
  const run = vi.fn((_command, args) => {
    if (args[0] === "status") return dirty ? " M private.ts\n" : "";
    if (args[0] === "rev-parse") return `${local}\n`;
    if (args[0] === "ls-remote")
      return tagOnly ? `${local}\trefs/tags/v1.0.0^{}\n` : `${upstream}\trefs/heads/main\n`;
    if (args[0] === "merge-base") {
      if (unknown) throw new Error("Not a public ancestor");
      return "";
    }
    throw new Error("Unexpected command");
  });
  return run;
}

describe("packaged telemetry provenance", () => {
  test("reports only a clean ancestor of the constant public upstream", () => {
    const run = fixture();
    expect(telemetryBuildCommit("/fixture", { run, env: {} })).toBe(local);
    expect(run.mock.calls[0][1]).toEqual(["status", "--porcelain", "--untracked-files=normal"]);
    const networkCalls = run.mock.calls.filter(([, args]) => args[0] === "ls-remote");
    expect(networkCalls).toHaveLength(1);
    expect(networkCalls[0][1]).toEqual([
      "ls-remote",
      "https://github.com/omnesis-dev/Omnesis.git",
      "refs/heads/main",
      "refs/tags/*",
    ]);
    expect(JSON.stringify(networkCalls)).not.toContain(local);
  });

  test("an exact public tag proves shallow release clones without a local upstream object", () => {
    const run = fixture({ tagOnly: true, unknown: true });
    expect(telemetryBuildCommit("/fixture", { run, env: {} })).toBe(local);
    expect(run.mock.calls.some(([, args]) => args[0] === "merge-base")).toBe(false);
  });

  test("private changes and unknown forks report custom", () => {
    const dirtyRun = fixture({ dirty: true });
    expect(telemetryBuildCommit("/fixture", { run: dirtyRun, env: {} })).toBe("custom");
    expect(dirtyRun).toHaveBeenCalledTimes(1);
    expect(telemetryBuildCommit("/fixture", { run: fixture({ unknown: true }), env: {} })).toBe(
      "custom",
    );
  });

  test("network errors never fail staging", () => {
    expect(
      telemetryBuildCommit("/fixture", {
        run: () => {
          throw new Error("offline");
        },
        env: {},
      }),
    ).toBe("custom");
  });

  test.each([{ VITEST: "true" }, { NODE_ENV: "test" }, { OMNESIS_RUNTIME_MODE: "test" }])(
    "staging in test runtime does not even inspect provenance: %j",
    (env) => {
      const run = vi.fn();
      expect(telemetryBuildCommit("/fixture", { run, env })).toBe("custom");
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("content-bound Docker build provenance", () => {
  function archiveFixture() {
    const root = mkdtempSync(join(tmpdir(), "omnesis-telemetry-build-"));
    roots.push(root);
    for (const path of TELEMETRY_BUILD_INPUTS) {
      if (["packages", "patches", "scripts"].includes(path)) mkdirSync(join(root, path));
      else writeFileSync(join(root, path), `${path}\n`);
    }
    mkdirSync(join(root, "packages/gateway/src"), { recursive: true });
    writeFileSync(join(root, "packages/gateway/src/index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    return root;
  }

  const archiveOptions = { env: {}, allowArchiveProof: true };

  test("a git-less context uses a verified content-bound proof without a network call", () => {
    const root = archiveFixture();
    expect(writeTelemetryBuildProof(root, { run: fixture(), env: {} })).toBe(local);
    const noNetwork = vi.fn(() => {
      throw new Error("Network forbidden");
    });
    expect(telemetryBuildCommit(root, { ...archiveOptions, run: noNetwork })).toBe(local);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  test.each(["modified", "added", "deleted"])(
    "a stale archive proof reports custom for %s source",
    (change) => {
      const root = archiveFixture();
      writeTelemetryBuildProof(root, { run: fixture(), env: {} });
      const path = join(root, "packages/gateway/src/index.ts");
      if (change === "modified") writeFileSync(path, "export const value = 2;\n");
      if (change === "added")
        writeFileSync(join(root, "packages/gateway/src/custom.ts"), "private implementation\n");
      if (change === "deleted") rmSync(path);
      expect(telemetryBuildCommit(root, archiveOptions)).toBe("custom");
    },
  );

  test("a live checkout ignores old archive proof and revalidates its current source", () => {
    const root = archiveFixture();
    writeTelemetryBuildProof(root, { run: fixture(), env: {} });
    mkdirSync(join(root, ".git"));
    const run = fixture({ dirty: true });
    expect(telemetryBuildCommit(root, { ...archiveOptions, run })).toBe("custom");
    expect(run).toHaveBeenCalled();
  });

  test("absent, malformed and unverified archive proofs report custom", () => {
    const root = archiveFixture();
    expect(telemetryBuildCommit(root, archiveOptions)).toBe("custom");
    for (const value of [
      "not json",
      "{}",
      JSON.stringify({ schemaVersion: 1, gitCommit: local, inputDigest: "0".repeat(64) }),
    ]) {
      writeFileSync(join(root, "packages/gateway/telemetry-build.json"), value);
      expect(telemetryBuildCommit(root, archiveOptions)).toBe("custom");
    }
  });

  test("compilation/dependency outputs and Docker-excluded fixtures cannot stale a proof", () => {
    const root = archiveFixture();
    writeTelemetryBuildProof(root, { run: fixture(), env: {} });
    for (const path of [
      "packages/gateway/dist/output.js",
      "packages/gateway/node_modules/library.js",
      "packages/gateway/src/__tests__/fixture.ts",
      "packages/gateway/duckdb-extensions/v1/native.duckdb_extension",
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "generated\n");
    }
    writeFileSync(join(root, "packages/gateway/src/index.test.ts"), "test fixture\n");
    writeFileSync(join(root, "packages/gateway/tsconfig.tsbuildinfo"), "incremental\n");
    expect(telemetryBuildCommit(root, archiveOptions)).toBe(local);
  });

  test("runtime prompt markdown is a build input, not an ignored root README", () => {
    const root = archiveFixture();
    writeTelemetryBuildProof(root, { run: fixture(), env: {} });
    writeFileSync(join(root, "packages/gateway/src/prompt.md"), "changed instruction\n");
    expect(telemetryBuildCommit(root, archiveOptions)).toBe("custom");
  });

  test("test runtime refuses an otherwise valid archive proof", () => {
    const root = archiveFixture();
    writeTelemetryBuildProof(root, { run: fixture(), env: {} });
    expect(telemetryBuildCommit(root, { env: { VITEST: "true" }, allowArchiveProof: true })).toBe(
      "custom",
    );
  });

  test("local, global and ambient URL rewrites cannot bless a private fork (real Git, offline)", () => {
    const root = archiveFixture();
    const home = mkdtempSync(join(tmpdir(), "omnesis-telemetry-git-home-"));
    roots.push(home);
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "build@example.com"]);
    git(["add", "."]);
    git([
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Fictional private source",
    ]);
    const privateUrl = pathToFileURL(root).href;
    const upstreamUrl = "https://github.com/omnesis-dev/Omnesis.git";
    git(["config", `url.${privateUrl}.insteadOf`, upstreamUrl]);
    const globalConfig = join(home, ".gitconfig");
    writeFileSync(globalConfig, `[url "${privateUrl}"]\n  insteadOf = ${upstreamUrl}\n`);
    const run = vi.fn((command, args, options) => {
      // Forbid HTTPS before transport opens. An inherited rewrite to file://
      // would still succeed and incorrectly advertise this private repository.
      return execFileSync(
        command,
        args[0] === "ls-remote" ? ["-c", "protocol.https.allow=never", ...args] : args,
        options,
      );
    });
    expect(
      telemetryBuildCommit(root, {
        run,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          GIT_DIR: join(root, ".git"),
          GIT_WORK_TREE: root,
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${privateUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: upstreamUrl,
        },
      }),
    ).toBe("custom");
    const remote = run.mock.calls.find(([, args]) => args[0] === "ls-remote");
    expect(remote).toBeDefined();
    expect(remote[2].cwd).not.toBe(root);
    expect(remote[2].env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(remote[2].env.GIT_DIR).toBeUndefined();
    expect(remote[2].env.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(remote[2].env.GIT_GRAFT_FILE).toBe(devNull);
  });

  test("Docker exclusions remain audited alongside the build digest", () => {
    const patterns = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(patterns).toEqual([
      "**/node_modules",
      "**/dist",
      "**/*.tsbuildinfo",
      ".git",
      ".env",
      ".env.*",
      "!.env.example",
      "docs",
      "**/*.test.ts",
      "**/__tests__",
      "*.md",
      "!packages/**/README.md",
      ".claude",
      "packages/gateway/duckdb-extensions/v*",
    ]);
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8").split(
      "RUN node scripts/runtime/stage-runtime.mjs",
    )[0];
    for (const match of dockerfile.matchAll(/^COPY (.+)$/gm)) {
      const sources = match[1].split(/\s+/).slice(0, -1);
      for (const source of sources) {
        const path = source.replace(/\/$/, "");
        expect(
          TELEMETRY_BUILD_INPUTS.some((input) => input === path || path.startsWith(`${input}/`)) ||
            path === "tsconfig*.json",
        ).toBe(true);
      }
    }
  });
});
