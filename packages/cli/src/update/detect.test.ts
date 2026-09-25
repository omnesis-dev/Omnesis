// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { launchdPlistPath, systemdUnitPath } from "@omnesis/core";
import {
  assertImageTag,
  activeSourceApplyState,
  assessSourceApplyEvidence,
  assessUpdate,
  channelToDistTag,
  CLI_PACKAGE,
  compareSemver,
  detectDockerInstall,
  detectDockerRoles,
  detectInstallMethod,
  detectHostRoles,
  dockerApplyPlan,
  dockerComposeSpec,
  dockerRestartSpec,
  formatCommandSpec,
  harnessNeedsAuthorization,
  harnessRefreshSpec,
  harnessRestartSpec,
  isUpToDate,
  manualUpdateInstructions,
  npmGlobalApplyPlan,
  planHostUpdate,
  runsInstalledBuild,
  planUpdate,
  newestStableTag,
  stableTagForVersion,
  normalizeVersion,
  npmGlobalInstallSpec,
  npmViewVersionSpec,
  packageIndexUrl,
  parseChannel,
  readImageTag,
  serviceUnitInstalled,
  serviceUnitInstances,
  sourceAncestrySpec,
  sourceMergeBaseSpec,
  sourceApplyPlan,
  sourceHeadSpec,
  sourceUpdateSpecs,
  sourceFetchSpec,
  sourceManagedSpec,
  sourceRemoteTagsSpec,
  sourceStatusSpec,
  sourceTargetVersionSpec,
  completedSourceApplyState,
  parseSourceApplyState,
  serializeUpdateApplyState,
  versionFromStableTag,
  activeDockerApplyState,
  assessDockerApplyEvidence,
  completedDockerApplyState,
  parseUpdateApplyState,
} from "./detect.js";
import type { DetectFs, HostRoles, HostScanFs, UpdateStep } from "./detect.js";

// ── Fakes ───────────────────────────────────────────────────────────────

/**
 * Build a `DetectFs` over an in-memory layout. `realpaths` maps shim paths
 * to their symlink targets (identity otherwise); `files` maps paths to
 * contents; `dirs` lists directories that exist.
 */
function fakeFs(layout: {
  realpaths?: Record<string, string>;
  files?: Record<string, string>;
  dirs?: string[];
}): DetectFs {
  const files = layout.files ?? {};
  const dirs = new Set(layout.dirs ?? []);
  return {
    realpath: (p) => {
      const target = layout.realpaths?.[p] ?? p;
      if (!(target in files) && !dirs.has(target)) throw new Error(`ENOENT: ${target}`);
      return target;
    },
    exists: (p) => p in files || dirs.has(p),
    readFile: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
}

/**
 * A `HostScanFs` over a set of present paths and their contents. `listDir`
 * answers from the same set, so a unit file placed in `dirs` is both
 * `exists`-visible and listed by its parent directory.
 */
function fakeHostFs(files: Record<string, string>, dirs: string[] = []): HostScanFs {
  const present = new Set([...Object.keys(files), ...dirs]);
  return {
    exists: (p) => present.has(p),
    readFile: (p) => files[p] ?? null,
    listDir: (dir) =>
      [...present]
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1)),
  };
}

// ── detectInstallMethod ─────────────────────────────────────────────────

describe("detectInstallMethod", () => {
  test("npm-global: bin shim resolving into node_modules/omnesis", () => {
    const fs = fakeFs({
      realpaths: {
        "/usr/local/bin/omnesis": "/usr/local/lib/node_modules/omnesis/dist/index.js",
      },
      files: { "/usr/local/lib/node_modules/omnesis/dist/index.js": "" },
    });
    expect(detectInstallMethod("/usr/local/bin/omnesis", fs)).toEqual({ method: "npm-global" });
  });

  test("npm-global wins even when a repo-like ancestor exists", () => {
    const entry = "/repo/node_modules/omnesis/dist/index.js";
    const fs = fakeFs({
      files: {
        [entry]: "",
        "/repo/package.json": JSON.stringify({ name: "omnesis" }),
      },
      dirs: ["/repo/.git"],
    });
    expect(detectInstallMethod(entry, fs)).toEqual({ method: "npm-global" });
  });

  test("source: walks up past intermediate package.json files to the repo root", () => {
    const fs = fakeFs({
      realpaths: {
        "/home/dev/omnesis/node_modules/.bin/omnesis":
          "/home/dev/omnesis/packages/cli/src/index.ts",
      },
      files: {
        "/home/dev/omnesis/packages/cli/src/index.ts": "",
        // The entry package shares the product name, but without .git it is
        // still only an intermediate package directory.
        "/home/dev/omnesis/packages/cli/package.json": JSON.stringify({ name: "omnesis" }),
        "/home/dev/omnesis/package.json": JSON.stringify({ name: "omnesis" }),
      },
      dirs: ["/home/dev/omnesis/.git"],
    });
    expect(detectInstallMethod("/home/dev/omnesis/node_modules/.bin/omnesis", fs)).toEqual({
      method: "source",
      rootDir: "/home/dev/omnesis",
    });
  });

  test("source: .git as a file (git worktree) still counts", () => {
    const fs = fakeFs({
      files: {
        "/wt/omnesis/packages/cli/src/index.ts": "",
        "/wt/omnesis/package.json": JSON.stringify({ name: "omnesis" }),
        "/wt/omnesis/.git": "gitdir: /repo/.git/worktrees/omnesis",
      },
    });
    expect(detectInstallMethod("/wt/omnesis/packages/cli/src/index.ts", fs)).toEqual({
      method: "source",
      rootDir: "/wt/omnesis",
    });
  });

  test("source: malformed intermediate package.json is skipped, root still found", () => {
    const fs = fakeFs({
      files: {
        "/repo/packages/cli/src/index.ts": "",
        "/repo/packages/cli/package.json": "{not json",
        "/repo/package.json": JSON.stringify({ name: "omnesis" }),
      },
      dirs: ["/repo/.git"],
    });
    expect(detectInstallMethod("/repo/packages/cli/src/index.ts", fs)).toEqual({
      method: "source",
      rootDir: "/repo",
    });
  });

  test("unknown: omnesis package.json without a .git entry", () => {
    const fs = fakeFs({
      files: {
        "/extracted/omnesis/bin/index.js": "",
        "/extracted/omnesis/package.json": JSON.stringify({ name: "omnesis" }),
      },
    });
    expect(detectInstallMethod("/extracted/omnesis/bin/index.js", fs)).toEqual({
      method: "unknown",
    });
  });

  test("unknown: no matching ancestor at all", () => {
    const fs = fakeFs({
      files: {
        "/opt/tools/run.js": "",
        "/opt/tools/package.json": JSON.stringify({ name: "some-other-tool" }),
      },
    });
    expect(detectInstallMethod("/opt/tools/run.js", fs)).toEqual({ method: "unknown" });
  });

  test("unknown: entry path that can't be realpathed", () => {
    const fs = fakeFs({});
    expect(detectInstallMethod("/does/not/exist", fs)).toEqual({ method: "unknown" });
  });

  test("unknown: empty argv[1]", () => {
    const fs = fakeFs({});
    expect(detectInstallMethod("", fs)).toEqual({ method: "unknown" });
  });
});

// ── Channels ────────────────────────────────────────────────────────────

// ── Docker installs ─────────────────────────────────────────────────────

describe("detectDockerInstall", () => {
  const CONFIG_DIR = "/home/maya/.config/omnesis";
  const MARKER = `${CONFIG_DIR}/install-method`;
  const COMPOSE = `${CONFIG_DIR}/docker-compose.yml`;
  const PROJECT = "services:\n  gateway:\n    image: ghcr.io/example/gateway:0.4.2\n";

  test("a marker naming docker beside a compose project", () => {
    const fs = fakeFs({ files: { [MARKER]: "docker\n", [COMPOSE]: PROJECT } });
    expect(detectDockerInstall(CONFIG_DIR, fs)).toEqual({
      method: "docker",
      composeFile: COMPOSE,
      projectDir: CONFIG_DIR,
    });
  });

  test("only the first line of the marker decides", () => {
    const fs = fakeFs({ files: { [MARKER]: "docker\nnotes follow\n", [COMPOSE]: PROJECT } });
    expect(detectDockerInstall(CONFIG_DIR, fs)).toMatchObject({ method: "docker" });
  });

  test("no marker at all is not a docker install", () => {
    expect(detectDockerInstall(CONFIG_DIR, fakeFs({ files: { [COMPOSE]: PROJECT } }))).toBeNull();
  });

  test("a marker naming another install method is not one either", () => {
    const fs = fakeFs({ files: { [MARKER]: "source\n", [COMPOSE]: PROJECT } });
    expect(detectDockerInstall(CONFIG_DIR, fs)).toBeNull();
  });

  // Without the project there is nothing to act on, so the marker alone must
  // not send the update down a path whose every command needs that file.
  test("a marker with no compose project is not one either", () => {
    expect(detectDockerInstall(CONFIG_DIR, fakeFs({ files: { [MARKER]: "docker\n" } }))).toBeNull();
  });

  test("an unreadable marker falls through instead of throwing", () => {
    const fs: DetectFs = {
      realpath: (path) => path,
      exists: () => true,
      readFile: () => {
        throw new Error("EACCES");
      },
    };
    expect(detectDockerInstall(CONFIG_DIR, fs)).toBeNull();
  });
});

describe("detectDockerRoles", () => {
  const COMPOSE_FILE = "/home/maya/.config/omnesis/docker-compose.yml";

  test("a gateway-only project has one daemon, and it can restart it", () => {
    const roles = detectDockerRoles(
      ["services:", "  gateway:", "    image: g:0.4.2", ""].join("\n"),
      COMPOSE_FILE,
    );
    // Restarting one of these is recreating its container: there is no
    // service manager inside a container for `omnesis service restart`.
    expect(roles.gateway).toEqual({
      present: true,
      supervised: true,
      manualRestart: `docker compose -f ${COMPOSE_FILE} up -d --no-deps gateway`,
    });
    expect(roles.collector.present).toBe(false);
    expect(roles.collector.manualRestart).toBeNull();
    // A harness plugin runs inside the harness process, never in a container.
    expect(roles.harnesses).toEqual([]);
  });

  test("a project with both daemons has both", () => {
    // The shape the installer writes: a project name above the block, and
    // another top-level key below it.
    const roles = detectDockerRoles(
      [
        "name: omnesis",
        "services:",
        "  gateway:",
        "    image: g:0.4.2",
        "    restart: unless-stopped",
        "  collector:",
        "    image: c:0.4.2",
        "volumes:",
        "  data:",
      ].join("\n"),
      COMPOSE_FILE,
    );
    expect(roles.gateway.present).toBe(true);
    expect(roles.collector.present).toBe(true);
  });

  // The updater is this command's own container: a service, but not a daemon
  // the update restarts.
  test("the updater service is not a role", () => {
    const roles = detectDockerRoles(
      [
        "services:",
        "  gateway:",
        "    image: g:0.4.2",
        "  updater:",
        "    profiles: [update]",
      ].join("\n"),
      COMPOSE_FILE,
    );
    expect(roles.gateway.present).toBe(true);
    expect(roles.collector.present).toBe(false);
  });

  test("a nested gateway key is not a service", () => {
    const roles = detectDockerRoles(
      [
        "services:",
        "  collector:",
        "    image: c:0.4.2",
        "    depends_on:",
        "      gateway:",
        "        condition: service_healthy",
      ].join("\n"),
      COMPOSE_FILE,
    );
    expect(roles.collector.present).toBe(true);
    expect(roles.gateway.present).toBe(false);
  });

  test("comments and blank lines do not open or close the block", () => {
    const roles = detectDockerRoles(
      [
        "# the omnesis containers",
        "services:",
        "",
        "  # the corpus",
        "  gateway:",
        "    image: g",
      ].join("\n"),
      COMPOSE_FILE,
    );
    expect(roles.gateway.present).toBe(true);
  });

  test("a project with no services declares no daemons", () => {
    expect(detectDockerRoles("volumes:\n  data:\n", COMPOSE_FILE).gateway.present).toBe(false);
  });

  // The scan reads one compose dialect. A project written in another is not a
  // project without daemons — it is a project this scan cannot read, which is
  // why the caller refuses on a reading with nothing in it rather than
  // planning around it.
  test("a dialect the scan does not read yields no services either", () => {
    const quoted = detectDockerRoles(
      ["services:", '  "gateway":', "    image: g:0.4.2"].join("\n"),
      COMPOSE_FILE,
    );
    expect(quoted.gateway.present).toBe(false);
    const flow = detectDockerRoles("services: {gateway: {image: 'g:0.4.2'}}\n", COMPOSE_FILE);
    expect(flow.gateway.present).toBe(false);
  });
});

describe("the recorded image tag", () => {
  test("reads the value the compose project resolves its images at", () => {
    expect(readImageTag("OMNESIS_IMAGE_TAG=0.4.2\n")).toBe("0.4.2");
    expect(readImageTag("OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=main\n")).toBe("main");
  });

  // Compose itself takes the last assignment of a repeated key, so reading
  // any other one would name a tag the containers are not running.
  test("a repeated key reads as its last assignment", () => {
    expect(readImageTag("OMNESIS_IMAGE_TAG=0.4.1\nOMNESIS_IMAGE_TAG=0.4.2\n")).toBe("0.4.2");
  });

  // The gateway loads this same file as its own environment, so it carries
  // lines this command did not write. Reading them more narrowly than every
  // other reader does would report a tag as missing that the containers
  // resolve perfectly well — and that refusal tells the operator to reinstall.
  test("the shapes an env file is allowed to carry all read as the tag", () => {
    expect(readImageTag('OMNESIS_IMAGE_TAG="0.4.2"\n')).toBe("0.4.2");
    expect(readImageTag("OMNESIS_IMAGE_TAG='0.4.2'\n")).toBe("0.4.2");
    expect(readImageTag("OMNESIS_IMAGE_TAG=0.4.2 # pinned by the last update\n")).toBe("0.4.2");
    expect(readImageTag('OMNESIS_IMAGE_TAG="0.4.2" # pinned\n')).toBe("0.4.2");
    expect(readImageTag("export OMNESIS_IMAGE_TAG=0.4.2\n")).toBe("0.4.2");
    expect(
      readImageTag("OMNESIS_KEYRING_PASSPHRASE_FILE=/c/k\r\nOMNESIS_IMAGE_TAG=0.4.2\r\n"),
    ).toBe("0.4.2");
  });

  // Compose reads a key with a trailing space as a different key, so this
  // line does not name the tag its services resolve.
  test("whitespace before the = is a different key", () => {
    expect(readImageTag("OMNESIS_IMAGE_TAG =0.4.2\n")).toBeNull();
  });

  test("an absent or unusable value reads as absent", () => {
    expect(readImageTag("OMNESIS_GATEWAY_PORT=7600\n")).toBeNull();
    expect(readImageTag("OMNESIS_IMAGE_TAG=\n")).toBeNull();
    expect(readImageTag("OMNESIS_IMAGE_TAG=0.4.2 && rm -rf /\n")).toBeNull();
    expect(readImageTag("# OMNESIS_IMAGE_TAG=0.4.2\n")).toBeNull();
  });

  // The value reaches a docker image reference, so a tag that could carry
  // anything else into it is refused rather than recorded.
  test("a tag that is not a tag is refused", () => {
    for (const tag of ["", "-flag", "0.4.2 --privileged", "latest;rm -rf /", "a/b"]) {
      expect(() => assertImageTag(tag)).toThrow();
    }
    // Docker's own ceiling on a tag.
    expect(() => assertImageTag("v".repeat(128))).not.toThrow();
    expect(() => assertImageTag("v".repeat(129))).toThrow();
  });

  test("a tag the read accepts is a tag the write accepts", () => {
    for (const tag of ["0.4.2", "main", "0.4.2-beta.1"]) {
      expect(readImageTag(`OMNESIS_IMAGE_TAG=${tag}\n`)).toBe(tag);
      expect(() => assertImageTag(tag)).not.toThrow();
    }
  });
});

describe("packageIndexUrl", () => {
  test("uses the product package", () => {
    expect(CLI_PACKAGE).toBe("omnesis");
  });

  test("defaults to the npm registry's document for the dist-tag", () => {
    expect(packageIndexUrl("latest", {})).toBe("https://registry.npmjs.org/omnesis/latest");
  });

  // The same variable, with the same default, that the installer resolves the
  // newest release from — so a fork or a mirror answers for both.
  test("OMNESIS_PACKAGE_INDEX_URL moves the index", () => {
    expect(
      packageIndexUrl("latest", { OMNESIS_PACKAGE_INDEX_URL: "https://npm.example.com/@acme/cli" }),
    ).toBe("https://npm.example.com/@acme/cli/latest");
    expect(
      packageIndexUrl("beta", { OMNESIS_PACKAGE_INDEX_URL: "https://npm.example.com/@acme/cli/" }),
    ).toBe("https://npm.example.com/@acme/cli/beta");
    // An empty override is an unset one, not an index at the filesystem root.
    expect(packageIndexUrl("latest", { OMNESIS_PACKAGE_INDEX_URL: "" })).toBe(
      "https://registry.npmjs.org/omnesis/latest",
    );
  });
});

describe("channelToDistTag", () => {
  test("stable maps to latest", () => {
    expect(channelToDistTag("stable")).toBe("latest");
  });

  test("beta maps to beta", () => {
    expect(channelToDistTag("beta")).toBe("beta");
  });
});

describe("parseChannel", () => {
  test("accepts known channels", () => {
    expect(parseChannel("stable")).toBe("stable");
    expect(parseChannel("beta")).toBe("beta");
  });

  test("rejects anything else", () => {
    expect(parseChannel("nightly")).toBeNull();
    expect(parseChannel("latest")).toBeNull();
    expect(parseChannel("")).toBeNull();
    expect(parseChannel("Stable")).toBeNull();
  });
});

// ── Version comparison ──────────────────────────────────────────────────

describe("normalizeVersion", () => {
  test("trims whitespace (npm view output has a trailing newline)", () => {
    expect(normalizeVersion("0.2.0\n")).toBe("0.2.0");
    expect(normalizeVersion("  0.2.0  ")).toBe("0.2.0");
  });

  test("strips a leading v", () => {
    expect(normalizeVersion("v0.2.0")).toBe("0.2.0");
  });

  test("plain version passes through", () => {
    expect(normalizeVersion("1.0.0-beta.3")).toBe("1.0.0-beta.3");
  });
});

describe("isUpToDate", () => {
  test("equal versions short-circuit the update", () => {
    expect(isUpToDate("0.2.0", "0.2.0")).toBe(true);
    expect(isUpToDate("0.2.0", "0.2.0\n")).toBe(true);
    expect(isUpToDate("v0.2.0", "0.2.0")).toBe(true);
  });

  test("different versions trigger the update", () => {
    expect(isUpToDate("0.2.0", "0.3.0")).toBe(false);
    expect(isUpToDate("0.2.0", "0.2.0-beta.1")).toBe(false);
  });
});

// ── Command specs ───────────────────────────────────────────────────────

describe("npmViewVersionSpec", () => {
  test("queries the dist-tag's version", () => {
    expect(npmViewVersionSpec("latest")).toEqual({
      command: "npm",
      args: ["view", "omnesis@latest", "version"],
    });
  });

  test("honors --registry", () => {
    expect(npmViewVersionSpec("beta", "https://registry.example.com")).toEqual({
      command: "npm",
      args: ["view", "omnesis@beta", "version", "--registry", "https://registry.example.com"],
    });
  });
});

describe("npmGlobalInstallSpec", () => {
  test("installs the dist-tag globally", () => {
    expect(npmGlobalInstallSpec("latest")).toEqual({
      command: "npm",
      args: ["install", "-g", "omnesis@latest"],
    });
  });

  test("honors --registry", () => {
    expect(npmGlobalInstallSpec("beta", "https://registry.example.com")).toEqual({
      command: "npm",
      args: ["install", "-g", "omnesis@beta", "--registry", "https://registry.example.com"],
    });
  });
});

describe("sourceUpdateSpecs", () => {
  test("checks out the selected tag, installs deterministically, and builds", () => {
    expect(sourceUpdateSpecs("/home/dev/omnesis", "v0.10.0")).toEqual([
      { command: "git", args: ["checkout", "--detach", "v0.10.0"], cwd: "/home/dev/omnesis" },
      {
        command: "npm",
        args: ["ci"],
        cwd: "/home/dev/omnesis",
        retry: {
          reset: { command: "rm", args: ["-rf", "node_modules"], cwd: "/home/dev/omnesis" },
          why: "installing the dependencies again from an empty node_modules",
        },
      },
      { command: "npm", args: ["run", "build"], cwd: "/home/dev/omnesis" },
    ]);
  });

  test("provides read, fetch, and remote-tag command specs", () => {
    expect(sourceStatusSpec("/repo").args).toEqual(["status", "--porcelain"]);
    expect(sourceManagedSpec("/repo").args).toEqual([
      "config",
      "--local",
      "--no-includes",
      "--get-all",
      "omnesis.install",
    ]);
    expect(sourceRemoteTagsSpec("/repo").args).toEqual([
      "ls-remote",
      "--tags",
      "--refs",
      "origin",
      "refs/tags/v*",
    ]);
    expect(sourceFetchSpec("/repo", false, "v0.3.0").args).toEqual([
      "fetch",
      "--no-tags",
      "origin",
      "refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
    expect(sourceFetchSpec("/repo", true, "origin/main").args).toEqual([
      "fetch",
      "origin",
      "+main:refs/remotes/origin/main",
    ]);
    expect(sourceTargetVersionSpec("/repo", "v0.3.0").args).toEqual([
      "show",
      "v0.3.0:packages/cli/package.json",
    ]);
    expect(sourceAncestrySpec("/repo", "v0.3.0").args).toEqual([
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "v0.3.0",
    ]);
    expect(sourceAncestrySpec("/repo", "v0.3.0", "abc123").args).toEqual([
      "merge-base",
      "--is-ancestor",
      "abc123",
      "v0.3.0",
    ]);
  });
});

describe("stable source tags", () => {
  test("selects numerically newest stable tag and ignores prereleases", () => {
    const output = [
      "a\trefs/tags/v0.9.0",
      "b\trefs/tags/v0.10.0",
      "c\trefs/tags/v1.0.0-beta.1",
      "d\trefs/tags/epic-internal",
    ].join("\n");
    expect(newestStableTag(output)).toBe("v0.10.0");
  });

  test("returns null without a strict stable tag", () => {
    expect(newestStableTag("a\trefs/tags/v0.3.0-beta.1\n")).toBeNull();
    expect(newestStableTag("a\trefs/tags/v01.3.0\n")).toBeNull();
  });

  test("extracts only strict stable versions", () => {
    expect(versionFromStableTag("v2.3.4")).toBe("2.3.4");
    expect(versionFromStableTag("v2.3.4-beta.1")).toBeNull();
    expect(versionFromStableTag("v02.3.4")).toBeNull();
  });

  test("a named version resolves only to a tag the remote actually carries", () => {
    const remote = ["a\trefs/tags/v0.9.0", "b\trefs/tags/v0.10.0"].join("\n");
    expect(stableTagForVersion(remote, "0.9.0")).toBe("v0.9.0");
    expect(stableTagForVersion(remote, "v0.10.0")).toBe("v0.10.0");
    // Not on this remote: the refusal that keeps a version arriving over a
    // socket from becoming a checkout.
    expect(stableTagForVersion(remote, "0.11.0")).toBeNull();
    expect(stableTagForVersion(remote, "9.9.9")).toBeNull();
  });

  test("a version that is not a strict release never resolves", () => {
    const remote = "a\trefs/tags/v0.9.0\n";
    expect(stableTagForVersion(remote, "0.9.0-beta.1")).toBeNull();
    expect(stableTagForVersion(remote, "main")).toBeNull();
    expect(stableTagForVersion(remote, "0.9")).toBeNull();
    // A tag name smuggled in as a version must not become a ref.
    expect(stableTagForVersion(remote, "0.9.0 --exec=evil")).toBeNull();
  });
});

describe("formatCommandSpec", () => {
  test("renders a copy-pasteable shell line", () => {
    expect(formatCommandSpec({ command: "npm", args: ["install", "-g", "omnesis@latest"] })).toBe(
      "npm install -g omnesis@latest",
    );
  });
});

describe("manualUpdateInstructions", () => {
  test("points at the installer for an unrecognized layout", () => {
    const lines = manualUpdateInstructions().join("\n");
    expect(lines).toContain("curl -fsSL https://omnesis.dev/install.sh | sh");
    expect(lines).not.toMatch(/not available yet/u);
  });
});

// ── Choosing an update path ─────────────────────────────────────────────

describe("planUpdate", () => {
  const flags = (overrides: Partial<Parameters<typeof planUpdate>[1]> = {}) => ({
    edge: false,
    channel: "stable",
    ...overrides,
  });
  const npmGlobal = { method: "npm-global" } as const;
  const source = { method: "source", rootDir: "/home/maya/omnesis" } as const;
  const docker = {
    method: "docker",
    composeFile: "/home/maya/.config/omnesis/docker-compose.yml",
    projectDir: "/home/maya/.config/omnesis",
  } as const;

  test("a package install follows its channel and registry", () => {
    expect(planUpdate(npmGlobal, flags())).toEqual({
      kind: "npm-global",
      channel: "stable",
      registry: undefined,
    });
    expect(
      planUpdate(npmGlobal, flags({ channel: "beta", registry: "https://r.example.com" })),
    ).toEqual({ kind: "npm-global", channel: "beta", registry: "https://r.example.com" });
  });

  test("a source checkout follows tags, and --edge follows main", () => {
    expect(planUpdate(source, flags())).toEqual({
      kind: "source",
      rootDir: "/home/maya/omnesis",
      edge: false,
    });
    expect(planUpdate(source, flags({ edge: true }))).toMatchObject({ kind: "source", edge: true });
  });

  test("--edge is refused on a package install rather than silently ignored", () => {
    const plan = planUpdate(npmGlobal, flags({ edge: true }));
    expect(plan.kind).toBe("refuse");
    expect(plan).toMatchObject({
      message: expect.stringMatching(/--edge follows the main branch/u),
    });
  });

  test("--registry and a non-default --channel are refused on a source checkout", () => {
    expect(planUpdate(source, flags({ registry: "https://r.example.com" }))).toMatchObject({
      kind: "refuse",
      message: expect.stringMatching(/--registry selects an npm registry/u),
    });
    expect(planUpdate(source, flags({ channel: "beta" }))).toMatchObject({
      kind: "refuse",
      message: expect.stringMatching(/--channel beta selects an npm dist-tag/u),
    });
  });

  test("a container install follows released image tags, and --edge follows main", () => {
    expect(planUpdate(docker, flags())).toEqual({
      kind: "docker",
      composeFile: docker.composeFile,
      projectDir: docker.projectDir,
      edge: false,
    });
    // Unlike a package install, --edge means something here: the release
    // pipeline moves the `main` image tag with the branch.
    expect(planUpdate(docker, flags({ edge: true }))).toMatchObject({ kind: "docker", edge: true });
  });

  test("--registry and a non-default --channel are refused on a container install", () => {
    // A container install does consult a package index for the release number,
    // so the refusal has to say what --registry does not select rather than
    // that no npm index is read at all.
    expect(planUpdate(docker, flags({ registry: "https://r.example.com" }))).toMatchObject({
      kind: "refuse",
      message: expect.stringMatching(/OMNESIS_PACKAGE_INDEX_URL/u),
    });
    expect(planUpdate(docker, flags({ channel: "beta" }))).toMatchObject({
      kind: "refuse",
      message: expect.stringMatching(/--channel beta selects an npm dist-tag/u),
    });
  });

  test("an unknown channel is refused before any path is chosen", () => {
    for (const detection of [npmGlobal, source, { method: "unknown" } as const]) {
      expect(planUpdate(detection, flags({ channel: "nightly" }))).toMatchObject({
        kind: "refuse",
        message: expect.stringMatching(/Unknown --channel: nightly/u),
      });
    }
  });

  test("an unrecognized layout falls back to the manual instructions", () => {
    expect(planUpdate({ method: "unknown" }, flags())).toEqual({ kind: "manual" });
  });
});

// ── Host roles ──────────────────────────────────────────────────────────

const HOME = "/home/maya";
const CONFIG = "/home/maya/.config/omnesis";
const GATEWAY_UNIT = "/home/maya/.config/systemd/user/omnesis-gateway.service";
const COLLECTOR_UNIT = "/home/maya/.config/systemd/user/omnesis-collector.service";
const OPENCLAW_INTEGRATION = "/home/maya/.openclaw/omnesis/integration.json";

/** A well-formed integration file whose grant renews without a human. */
const LIVE_INTEGRATION = JSON.stringify({
  gatewayUrl: "https://gateway.example.com:7600",
  oauth: { tokens: { access_token: "a", refresh_token: "r" } },
});

function layout(overrides: Partial<Parameters<typeof detectHostRoles>[0]> = {}) {
  return {
    platform: "linux" as NodeJS.Platform,
    homeDir: HOME,
    configDir: CONFIG,
    harnessHomes: [{ harness: "openclaw" as const, home: "/home/maya/.openclaw" }],
    ...overrides,
  };
}

describe("serviceUnitInstalled", () => {
  test("linux reads the systemd user unit path", () => {
    const fs = fakeHostFs({}, [GATEWAY_UNIT]);
    expect(serviceUnitInstalled("linux", HOME, "gateway", fs)).toBe(true);
    expect(serviceUnitInstalled("linux", HOME, "collector", fs)).toBe(false);
  });

  test("darwin reads the LaunchAgent plist path", () => {
    const fs = fakeHostFs({}, ["/home/maya/Library/LaunchAgents/dev.omnesis.collector.plist"]);
    expect(serviceUnitInstalled("darwin", HOME, "collector", fs)).toBe(true);
    expect(serviceUnitInstalled("darwin", HOME, "gateway", fs)).toBe(false);
  });

  test("other platforms never claim a service", () => {
    const fs = fakeHostFs({}, [GATEWAY_UNIT]);
    expect(serviceUnitInstalled("win32", HOME, "gateway", fs)).toBe(false);
  });
});

describe("harnessNeedsAuthorization", () => {
  test("a saved refresh token renews without a human", () => {
    expect(harnessNeedsAuthorization(LIVE_INTEGRATION)).toBe(false);
  });

  test("no refresh token needs a browser", () => {
    expect(harnessNeedsAuthorization(JSON.stringify({ oauth: { tokens: {} } }))).toBe(true);
  });

  test("an empty refresh token needs a browser", () => {
    expect(
      harnessNeedsAuthorization(JSON.stringify({ oauth: { tokens: { refresh_token: "" } } })),
    ).toBe(true);
  });

  // The update must never silently skip an integration it could not read.
  test("unreadable or malformed credentials need a human", () => {
    expect(harnessNeedsAuthorization(null)).toBe(true);
    expect(harnessNeedsAuthorization("{not json")).toBe(true);
  });
});

describe("detectHostRoles", () => {
  test("a gateway host: its store makes the role, its unit makes it restartable", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/omnesis.db`, GATEWAY_UNIT]);
    const roles = detectHostRoles(layout(), fs);
    expect(roles.gateway).toEqual({ present: true, supervised: true, manualRestart: null });
    expect(roles.collector).toEqual({ present: false, supervised: false, manualRestart: null });
    expect(roles.harnesses).toEqual([]);
  });

  test("a corpus with no service unit is a role this command cannot restart", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/omnesis.db`]);
    expect(detectHostRoles(layout(), fs).gateway).toEqual({
      present: true,
      supervised: false,
      manualRestart: null,
    });
  });

  test("a collector-only host is never mistaken for a gateway", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/collector-pairing-state.json`, COLLECTOR_UNIT]);
    const roles = detectHostRoles(layout(), fs);
    expect(roles.gateway.present).toBe(false);
    expect(roles.collector).toEqual({ present: true, supervised: true, manualRestart: null });
  });

  test("a unit with no state on disk still counts — the daemon has not run yet", () => {
    const fs = fakeHostFs({}, [COLLECTOR_UNIT]);
    expect(detectHostRoles(layout(), fs).collector).toEqual({
      present: true,
      supervised: true,
      manualRestart: null,
    });
  });

  test("an integration file under a harness home is a harness role", () => {
    const fs = fakeHostFs({ [OPENCLAW_INTEGRATION]: LIVE_INTEGRATION });
    expect(detectHostRoles(layout(), fs).harnesses).toEqual([
      { harness: "openclaw", home: "/home/maya/.openclaw", needsAuthorization: false },
    ]);
  });

  test("an installed harness without an integration file is not a role", () => {
    const fs = fakeHostFs({}, ["/home/maya/.openclaw"]);
    expect(detectHostRoles(layout(), fs).harnesses).toEqual([]);
  });

  // A hardened install puts the unit under /etc and the corpus under
  // /var/lib, so neither this account's config dir nor its unit directory
  // mentions it. Missing it would skip the backup on the one host that holds
  // the corpus.
  test("a hardened gateway is present, not restartable, and names the root command", () => {
    const fs = fakeHostFs({}, ["/etc/systemd/system/omnesis-gateway.service"]);
    expect(detectHostRoles(layout(), fs).gateway).toEqual({
      present: true,
      supervised: false,
      // Set up before the admin command existed: the install moves it.
      manualRestart: "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install",
      hardened: { adminInstalled: false },
    });
  });

  test("a hardened gateway with its admin command is moved by that command", () => {
    const fs = fakeHostFs({}, [
      "/etc/systemd/system/omnesis-gateway.service",
      "/usr/local/sbin/omnesis-gateway-admin",
    ]);
    expect(detectHostRoles(layout(), fs).gateway).toEqual({
      present: true,
      supervised: false,
      manualRestart: "sudo omnesis-gateway-admin update",
      hardened: { adminInstalled: true },
    });
  });

  // Only reachable when the update itself runs as root: systemd materializes
  // that directory at mode 0700 for a DynamicUser.
  test("a hardened gateway is also recognised by its state directory, when readable", () => {
    const fs = fakeHostFs({}, ["/var/lib/omnesis-gateway/omnesis.db"]);
    expect(detectHostRoles(layout(), fs).gateway.present).toBe(true);
  });

  test("a hardened unit on macOS is not a thing, and is not claimed", () => {
    const fs = fakeHostFs({}, ["/etc/systemd/system/omnesis-gateway.service"]);
    expect(detectHostRoles(layout({ platform: "darwin" }), fs).gateway.present).toBe(false);
  });

  test("this account's own unit reports a coexisting hardened gateway", () => {
    const fs = fakeHostFs({}, [GATEWAY_UNIT, "/etc/systemd/system/omnesis-gateway.service"]);
    expect(detectHostRoles(layout(), fs).gateway).toEqual({
      present: true,
      supervised: true,
      manualRestart: null,
      conflictingServices: ["omnesis-gateway.service"],
    });
  });

  test("an unnamed unit reports coexisting named instances", () => {
    const fs = fakeHostFs({}, [COLLECTOR_UNIT, systemdUnitPath(HOME, "collector", "staging")]);
    expect(detectHostRoles(layout(), fs).collector).toEqual({
      present: true,
      supervised: true,
      manualRestart: null,
      conflictingServices: ["collector --instance staging"],
    });
  });

  test.each([
    ["linux", systemdUnitPath(HOME, "gateway", "legacy_1")],
    ["darwin", launchdPlistPath(HOME, "gateway", "legacy_1")],
  ] as const)(
    "an unnamed %s unit reports an unaddressable instance as a conflict",
    (platform, unit) => {
      const fs = fakeHostFs({}, [
        platform === "linux" ? GATEWAY_UNIT : launchdPlistPath(HOME, "gateway"),
        unit,
      ]);
      expect(detectHostRoles(layout({ platform }), fs).gateway).toMatchObject({
        present: true,
        supervised: true,
        conflictingServices: ['gateway instance unit "legacy_1"'],
      });
    },
  );

  // `omnesis service install --instance staging` writes a unit this command
  // does not drive. Reporting it is the difference between a named command
  // and a silent no-op.
  // The unit file names come from the same helpers `omnesis service install`
  // writes with, so a rename there reddens this instead of quietly leaving
  // instances undetected. The two platforms separate the instance name
  // differently, which is exactly the detail a hand-written fixture gets
  // wrong.
  test("a named instance is present, not restartable, and names its own command", () => {
    const fs = fakeHostFs({}, [systemdUnitPath(HOME, "collector", "staging")]);
    expect(detectHostRoles(layout(), fs).collector).toEqual({
      present: true,
      supervised: false,
      manualRestart: "omnesis service restart collector --instance staging",
    });
  });

  test("every named instance is reported, not just the first", () => {
    const fs = fakeHostFs({}, [
      systemdUnitPath(HOME, "collector", "blue"),
      systemdUnitPath(HOME, "collector", "green"),
    ]);
    expect(detectHostRoles(layout(), fs).collector.manualRestart).toBe(
      "omnesis service restart collector --instance blue, " +
        "omnesis service restart collector --instance green",
    );
  });

  test("the unnamed unit is not read as an instance of itself", () => {
    const fs = fakeHostFs({}, [systemdUnitPath(HOME, "collector")]);
    expect(serviceUnitInstances("linux", HOME, "collector", fs)).toEqual([]);
  });

  test("another component's instance is not claimed", () => {
    const fs = fakeHostFs({}, [systemdUnitPath(HOME, "gateway", "staging")]);
    expect(serviceUnitInstances("linux", HOME, "collector", fs)).toEqual([]);
  });

  test("launchd instances are read from the LaunchAgents directory", () => {
    const fs = fakeHostFs({}, [launchdPlistPath(HOME, "gateway", "staging")]);
    expect(detectHostRoles(layout({ platform: "darwin" }), fs).gateway).toEqual({
      present: true,
      supervised: false,
      manualRestart: "omnesis service restart gateway --instance staging",
    });
  });

  test("the unnamed launchd plist is not read as an instance of itself", () => {
    const fs = fakeHostFs({}, [launchdPlistPath(HOME, "gateway")]);
    expect(serviceUnitInstances("darwin", HOME, "gateway", fs)).toEqual([]);
  });

  test("an unrelated unit in the same directory is not mistaken for an instance", () => {
    const fs = fakeHostFs({}, ["/home/maya/.config/systemd/user/other-app.service"]);
    expect(detectHostRoles(layout(), fs).collector.present).toBe(false);
  });

  test("a bare host has no roles at all", () => {
    expect(detectHostRoles(layout(), fakeHostFs({}))).toEqual({
      gateway: { present: false, supervised: false, manualRestart: null },
      collector: { present: false, supervised: false, manualRestart: null },
      harnesses: [],
    });
  });
});

// ── The per-host plan ───────────────────────────────────────────────────

describe("a gateway known not to be running", () => {
  test("a corpus with no running gateway is a stopped gateway role", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/omnesis.db`]);
    expect(detectHostRoles(layout({ gatewayRunning: false }), fs).gateway).toEqual({
      present: true,
      supervised: false,
      manualRestart: null,
      stopped: true,
    });
  });

  test("a registered gateway can be stopped too", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/omnesis.db`, GATEWAY_UNIT]);
    expect(detectHostRoles(layout({ gatewayRunning: false }), fs).gateway).toMatchObject({
      supervised: true,
      stopped: true,
    });
  });

  test("a running gateway, or one nobody asked about, is not marked stopped", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/omnesis.db`]);
    expect(detectHostRoles(layout({ gatewayRunning: true }), fs).gateway).not.toHaveProperty(
      "stopped",
    );
    expect(detectHostRoles(layout(), fs).gateway).not.toHaveProperty("stopped");
  });

  test("a host without a gateway role has no stopped gateway", () => {
    const fs = fakeHostFs({}, [`${CONFIG}/collector-pairing-state.json`]);
    expect(detectHostRoles(layout({ gatewayRunning: false }), fs).gateway).toEqual({
      present: false,
      supervised: false,
      manualRestart: null,
    });
  });
});

describe("runsInstalledBuild", () => {
  test("a daemon started at or after the install runs it", () => {
    expect(runsInstalledBuild(2_000, 1_000)).toBe(true);
    expect(runsInstalledBuild(1_000, 1_000)).toBe(true);
  });

  test("a daemon started before the install runs the previous build", () => {
    expect(runsInstalledBuild(1_000, 2_000)).toBe(false);
  });

  test("either time unknown leaves the answer unknown", () => {
    expect(runsInstalledBuild(null, 1_000)).toBeNull();
    expect(runsInstalledBuild(1_000, null)).toBeNull();
    expect(runsInstalledBuild(Number.NaN, 1_000)).toBeNull();
  });
});

describe("planHostUpdate", () => {
  const none = { present: false, supervised: false, manualRestart: null };
  const supervised = { present: true, supervised: true, manualRestart: null };
  const unsupervised = { present: true, supervised: false, manualRestart: null };

  const roles = (over: Partial<HostRoles> = {}): HostRoles => ({
    gateway: none,
    collector: none,
    harnesses: [],
    ...over,
  });
  const kinds = (steps: UpdateStep[]): string[] =>
    steps.map((step) =>
      step.kind === "restart" || step.kind === "restart-hint" || step.kind === "service-definition"
        ? `${step.kind}:${step.component}`
        : step.kind,
    );

  describe("on a host whose daemons run under units this command wrote", () => {
    const both = roles({ gateway: supervised, collector: supervised });

    test("each daemon's definition is brought to the release just before its restart", () => {
      expect(kinds(planHostUpdate(both, { backup: true, serviceDefinitions: true }))).toEqual([
        "backup",
        "apply",
        "service-definition:gateway",
        "restart:gateway",
        "await-health",
        "service-definition:collector",
        "restart:collector",
      ]);
    });

    test("--no-restart still brings them to the release, ahead of the hints", () => {
      expect(
        kinds(planHostUpdate(both, { backup: true, restart: false, serviceDefinitions: true })),
      ).toEqual([
        "backup",
        "apply",
        "service-definition:gateway",
        "restart-hint:gateway",
        "service-definition:collector",
        "restart-hint:collector",
      ]);
    });

    test("a stopped gateway's definition is ready for its next start", () => {
      expect(
        kinds(
          planHostUpdate(roles({ gateway: { ...supervised, stopped: true } }), {
            backup: true,
            restart: false,
            serviceDefinitions: true,
          }),
        ),
      ).toEqual(["backup", "apply", "service-definition:gateway", "gateway-stopped"]);
    });

    // A hardened gateway, a named instance and a daemon started by hand are
    // all unsupervised: none of them runs under the unit this command owns.
    test("a daemon this account does not supervise keeps its definition", () => {
      expect(
        kinds(
          planHostUpdate(roles({ gateway: unsupervised, collector: supervised }), {
            backup: true,
            serviceDefinitions: true,
          }),
        ),
      ).toEqual([
        "backup",
        "apply",
        "restart-hint:gateway",
        "service-definition:collector",
        "restart-hint:collector",
      ]);
    });

    test("a daemon already running the installed build is left alone", () => {
      expect(
        kinds(
          planHostUpdate(both, {
            backup: false,
            restart: false,
            serviceDefinitions: true,
            runningBuild: { gateway: true, collector: true },
          }),
        ),
      ).toEqual(["apply"]);
    });

    test("a container install has no unit to bring to the release", () => {
      expect(kinds(planHostUpdate(both, { backup: true }))).not.toContain(
        "service-definition:gateway",
      );
    });
  });

  test("nothing installed: the checkout is all there is to do", () => {
    expect(kinds(planHostUpdate(roles(), { backup: true }))).toEqual(["apply"]);
  });

  test("gateway only: back up first, apply, restart, then wait for health", () => {
    expect(kinds(planHostUpdate(roles({ gateway: supervised }), { backup: true }))).toEqual([
      "backup",
      "apply",
      "restart:gateway",
      "await-health",
    ]);
  });

  test("collector only: no backup — the corpus lives on another host", () => {
    expect(kinds(planHostUpdate(roles({ collector: supervised }), { backup: true }))).toEqual([
      "apply",
      "restart:collector",
    ]);
  });

  // The order IS the contract: the collector must not reconnect into a schema
  // that is still migrating, so the health wait sits between the two restarts.
  test("gateway and collector: the health wait separates the two restarts", () => {
    expect(
      kinds(
        planHostUpdate(roles({ gateway: supervised, collector: supervised }), { backup: true }),
      ),
    ).toEqual(["backup", "apply", "restart:gateway", "await-health", "restart:collector"]);
  });

  test("--no-backup drops only the backup, keeping the order of the rest", () => {
    expect(
      kinds(
        planHostUpdate(roles({ gateway: supervised, collector: supervised }), { backup: false }),
      ),
    ).toEqual(["apply", "restart:gateway", "await-health", "restart:collector"]);
  });

  /**
   * What a device commanded by a fleet update runs. The update executes as a
   * child of the very daemon its plan would restart, so restarting from
   * inside would kill the build; the daemon reports its result and exits for
   * its own supervisor instead.
   */
  test("--no-restart turns every restart into a hint and drops the health wait", () => {
    const steps = planHostUpdate(roles({ gateway: supervised, collector: supervised }), {
      backup: true,
      restart: false,
    });
    expect(kinds(steps)).toEqual([
      "backup",
      "apply",
      "restart-hint:gateway",
      "restart-hint:collector",
    ]);
    // A supervised component still knows the command that restarts it.
    for (const step of steps) {
      if (step.kind === "restart-hint") expect(step.command).toContain("omnesis service restart");
    }
  });

  test("--no-restart still refreshes a harness plugin, and names the restart it owes", () => {
    const steps = planHostUpdate(
      roles({ harnesses: [{ harness: "openclaw", home: "/home/dev", needsAuthorization: false }] }),
      { backup: true, restart: false },
    );
    expect(kinds(steps)).toEqual(["apply", "harness-refresh", "harness-restart-hint"]);
    const hint = steps.find((step) => step.kind === "harness-restart-hint");
    expect(hint).toMatchObject({ command: "openclaw gateway restart" });
  });

  test("an unsupervised gateway is reported, not restarted, and nothing is waited on", () => {
    expect(kinds(planHostUpdate(roles({ gateway: unsupervised }), { backup: true }))).toEqual([
      "backup",
      "apply",
      "restart-hint:gateway",
    ]);
  });

  // A collector is only restarted once its own gateway is known to be serving
  // the new build. Where that is not known, restarting it would reconnect it
  // to a gateway still running the previous build — the very thing the health
  // wait exists to prevent, reached by another branch.
  test("a gateway this command cannot restart withholds the collector restart too", () => {
    const plan = planHostUpdate(roles({ gateway: unsupervised, collector: supervised }), {
      backup: true,
    });
    expect(kinds(plan)).toEqual([
      "backup",
      "apply",
      "restart-hint:gateway",
      "restart-hint:collector",
    ]);
  });

  test("a collector on a host with no gateway at all is still restarted", () => {
    expect(kinds(planHostUpdate(roles({ collector: supervised }), { backup: true }))).toEqual([
      "apply",
      "restart:collector",
    ]);
  });

  test("an unsupervised collector is reported", () => {
    expect(kinds(planHostUpdate(roles({ collector: unsupervised }), { backup: true }))).toEqual([
      "apply",
      "restart-hint:collector",
    ]);
  });

  // A container install is supervised — this command recreates its containers
  // — but `omnesis service restart gateway` inside a container reaches no
  // service manager. The role carries the command that does work, so the hint
  // prints that one instead.
  test("a supervised role that carries its own command prints that one", () => {
    const recreate = "docker compose -f /cfg/docker-compose.yml up -d --no-deps gateway";
    const plan = planHostUpdate(
      roles({ gateway: { present: true, supervised: true, manualRestart: recreate } }),
      { backup: true, restart: false },
    );
    expect(plan).toContainEqual({ kind: "restart-hint", component: "gateway", command: recreate });
  });

  test("the hint carries the command the host knows, when it knows one", () => {
    const plan = planHostUpdate(
      roles({
        gateway: {
          present: true,
          supervised: false,
          manualRestart: "sudo systemctl restart omnesis-gateway.service",
        },
      }),
      { backup: true },
    );
    expect(plan).toContainEqual({
      kind: "restart-hint",
      component: "gateway",
      command: "sudo systemctl restart omnesis-gateway.service",
    });
  });

  test("harness only: refresh the plugin, then offer the restart", () => {
    const plan = planHostUpdate(
      roles({
        harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
      }),
      { backup: true },
    );
    expect(kinds(plan)).toEqual(["apply", "harness-refresh", "harness-restart"]);
  });

  test("a harness whose grant needs a human is reported and never restarted", () => {
    const plan = planHostUpdate(
      roles({
        harnesses: [{ harness: "hermes", home: "/h", needsAuthorization: true }],
      }),
      { backup: true },
    );
    expect(kinds(plan)).toEqual(["apply", "harness-authorize"]);
  });

  test("gateway plus harness: the gateway is healthy before the harness is touched", () => {
    const plan = planHostUpdate(
      roles({
        gateway: supervised,
        harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
      }),
      { backup: true },
    );
    expect(kinds(plan)).toEqual([
      "backup",
      "apply",
      "restart:gateway",
      "await-health",
      "harness-refresh",
      "harness-restart",
    ]);
  });

  test("every role at once, in one order", () => {
    const plan = planHostUpdate(
      roles({
        gateway: supervised,
        collector: supervised,
        harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
      }),
      { backup: true },
    );
    expect(kinds(plan)).toEqual([
      "backup",
      "apply",
      "restart:gateway",
      "await-health",
      "restart:collector",
      "harness-refresh",
      "harness-restart",
    ]);
  });

  // A gateway whose service is stopped, or whose install was never started
  // as one, still holds a corpus. Nothing serves the previous build, so
  // nothing is owed a restart hint and its collector need not wait for it.
  test("a stopped gateway is copied offline, noted, and holds no collector restart back", () => {
    const stopped = { ...unsupervised, stopped: true };
    expect(
      planHostUpdate(roles({ gateway: stopped, collector: supervised }), { backup: true }),
    ).toEqual([
      { kind: "backup", offline: true },
      { kind: "apply" },
      { kind: "gateway-stopped" },
      { kind: "restart", component: "collector" },
    ]);
  });

  test("--no-restart on a stopped gateway: the note, and the collector's own hint", () => {
    const stopped = { ...unsupervised, stopped: true };
    expect(
      kinds(
        planHostUpdate(roles({ gateway: stopped, collector: supervised }), {
          backup: true,
          restart: false,
        }),
      ),
    ).toEqual(["backup", "apply", "gateway-stopped", "restart-hint:collector"]);
  });

  test("a stopped gateway this command can start is started and waited on", () => {
    const stopped = { ...supervised, stopped: true };
    expect(
      kinds(planHostUpdate(roles({ gateway: stopped, collector: supervised }), { backup: true })),
    ).toEqual(["backup", "apply", "restart:gateway", "await-health", "restart:collector"]);
  });

  test("a build short of memory stops a supervised collector for the apply, and nothing else", () => {
    const tight = { backup: true, pauseCollectorForBuild: true };
    expect(
      kinds(planHostUpdate(roles({ gateway: supervised, collector: supervised }), tight)),
    ).toEqual([
      "backup",
      "pause-collector",
      "apply",
      "restart:gateway",
      "await-health",
      "restart:collector",
    ]);
    // A collector reported rather than restarted is still stopped for the build.
    expect(
      kinds(planHostUpdate(roles({ gateway: unsupervised, collector: supervised }), tight)),
    ).toEqual([
      "backup",
      "pause-collector",
      "apply",
      "restart-hint:gateway",
      "restart-hint:collector",
    ]);
    // Not a collector this command does not drive, and not on a run that
    // restarts nothing, where this command is the collector's own child.
    expect(kinds(planHostUpdate(roles({ collector: unsupervised }), tight))).not.toContain(
      "pause-collector",
    );
    expect(
      kinds(planHostUpdate(roles({ collector: supervised }), { ...tight, restart: false })),
    ).not.toContain("pause-collector");
    expect(kinds(planHostUpdate(roles({ collector: supervised }), { backup: true }))).not.toContain(
      "pause-collector",
    );
  });

  test("a daemon known to run the installed build is owed no restart hint", () => {
    const plan = planHostUpdate(roles({ gateway: unsupervised, collector: supervised }), {
      backup: false,
      restart: false,
      runningBuild: { gateway: true, collector: true },
    });
    expect(kinds(plan)).toEqual(["apply"]);
  });

  test("a gateway already on the installed build holds no collector restart back", () => {
    const plan = planHostUpdate(roles({ gateway: unsupervised, collector: supervised }), {
      backup: false,
      runningBuild: { gateway: true, collector: false },
    });
    expect(kinds(plan)).toEqual(["apply", "restart:collector"]);
  });

  test("a daemon whose build cannot be told gets a hint that says so", () => {
    const plan = planHostUpdate(roles({ collector: supervised }), {
      backup: false,
      restart: false,
      runningBuild: { collector: null },
    });
    expect(plan).toContainEqual({
      kind: "restart-hint",
      component: "collector",
      command: "omnesis service restart collector",
      uncertain: true,
    });
  });
});

// ── Applying, and the way back ──────────────────────────────────────────

describe("source apply completion evidence", () => {
  const rootDir = "/opt/omnesis";
  const previous = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
  const target = "1122334455667788990011223344556677889900";
  const raw = (state: ReturnType<typeof completedSourceApplyState>): string =>
    serializeUpdateApplyState(state);

  test("skips only when HEAD, target, root, and completed commit all match", () => {
    expect(
      assessSourceApplyEvidence(
        rootDir,
        target,
        target,
        raw(completedSourceApplyState(rootDir, target)),
      ),
    ).toMatchObject({ complete: true, previousCommit: target, recovery: "none" });

    expect(
      assessSourceApplyEvidence(
        rootDir,
        previous,
        target,
        raw(completedSourceApplyState(rootDir, target)),
      ),
    ).toMatchObject({ complete: false, previousCommit: target, recovery: "mismatch" });

    expect(
      assessSourceApplyEvidence(
        rootDir,
        previous,
        target,
        raw(completedSourceApplyState(rootDir, previous)),
      ),
    ).toMatchObject({ complete: false, previousCommit: previous, recovery: "none" });
  });

  test("matching HEAD without a completion record is an unrecorded apply", () => {
    expect(assessSourceApplyEvidence(rootDir, target, target, null)).toMatchObject({
      complete: false,
      previousCommit: target,
      recovery: "unrecorded",
    });
    expect(assessSourceApplyEvidence(rootDir, previous, target, null)).toMatchObject({
      complete: false,
      previousCommit: previous,
      recovery: "none",
    });
  });

  test.each(["applying", "rolling-back"] as const)(
    "%s retains the last completed commit and forces recovery",
    (phase) => {
      const state = activeSourceApplyState(rootDir, phase, target, previous);
      expect(
        assessSourceApplyEvidence(rootDir, target, target, serializeUpdateApplyState(state)),
      ).toMatchObject({
        complete: false,
        previousCommit: previous,
        recovery: "unfinished",
      });
    },
  );

  test("invalid and foreign records prove nothing and safely reapply from HEAD", () => {
    for (const state of [
      "not json",
      '{"version":1,"method":"source","rootDir":"/opt/omnesis","phase":"complete","commit":"short"}',
      raw(completedSourceApplyState("/another/checkout", target)),
    ]) {
      expect(assessSourceApplyEvidence(rootDir, target, target, state)).toMatchObject({
        complete: false,
        previousCommit: target,
        recovery: "mismatch",
      });
    }
    expect(
      parseSourceApplyState(serializeUpdateApplyState(completedSourceApplyState(rootDir, target))),
    ).toEqual(completedSourceApplyState(rootDir, target));
  });
});

describe("apply plans", () => {
  test("a source rollback brings the checkout to the ref it was on", () => {
    const target = "1122334455667788990011223344556677889900";
    const previous = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
    const plan = sourceApplyPlan("/opt/omnesis", "v9.9.2", target, previous);
    expect(plan.apply.map(formatCommandSpec)).toEqual([
      "git checkout --detach v9.9.2",
      "npm ci",
      "npm run build",
    ]);
    // The same sequence, at the old ref: node_modules and dist were left at
    // the target by the failed attempt, so both have to be rebuilt.
    expect(plan.rollback.map(formatCommandSpec)).toEqual([
      `git checkout --detach ${previous}`,
      "npm ci",
      "npm run build",
    ]);
    expect(plan.rollback.every((spec) => spec.cwd === "/opt/omnesis")).toBe(true);
    expect(plan.previous).toBe(previous);
    expect(plan.applyState).toEqual({
      applying: activeSourceApplyState("/opt/omnesis", "applying", target, previous),
      complete: completedSourceApplyState("/opt/omnesis", target),
      rollingBack: activeSourceApplyState("/opt/omnesis", "rolling-back", target, previous),
      rolledBack: completedSourceApplyState("/opt/omnesis", previous),
      completeAt: "apply",
    });
  });

  test("a package rollback reinstalls the version that was running", () => {
    const plan = npmGlobalApplyPlan("0.3.0", "0.2.0");
    expect(plan.apply.map(formatCommandSpec)).toEqual(["npm install -g omnesis@0.3.0"]);
    expect(plan.rollback.map(formatCommandSpec)).toEqual(["npm install -g omnesis@0.2.0"]);
  });

  test("a package rollback keeps the registry it installed from", () => {
    const plan = npmGlobalApplyPlan("0.3.0", "0.2.0", "https://registry.example.com");
    expect(plan.rollback[0].args).toContain("--registry");
  });

  test("a container install pulls the tag it recorded, both ways", () => {
    const plan = dockerApplyPlan("/cfg/docker-compose.yml", "/cfg", "0.4.2", "0.4.1");
    // The command is the same in both directions: what differs is the tag the
    // flow records before running it.
    expect(plan.apply.map(formatCommandSpec)).toEqual([
      "docker compose -f /cfg/docker-compose.yml pull",
    ]);
    expect(plan.rollback.map(formatCommandSpec)).toEqual([
      "docker compose -f /cfg/docker-compose.yml pull",
    ]);
    expect(plan.target).toBe("0.4.2");
    expect(plan.previous).toBe("0.4.1");
    // Recorded before the tag moves; complete only once the whole plan, the
    // gateway's health included, has passed.
    expect(plan.applyState).toEqual({
      applying: activeDockerApplyState("/cfg", "applying", "0.4.2", "0.4.1"),
      complete: completedDockerApplyState("/cfg", "0.4.2"),
      rollingBack: activeDockerApplyState("/cfg", "rolling-back", "0.4.2", "0.4.1"),
      rolledBack: completedDockerApplyState("/cfg", "0.4.1"),
      completeAt: "end",
    });
  });

  describe("container apply evidence", () => {
    const complete = serializeUpdateApplyState(completedDockerApplyState("/cfg", "0.4.2"));
    const applying = serializeUpdateApplyState(
      activeDockerApplyState("/cfg", "applying", "0.4.2", "0.4.1"),
    );

    test("the record round-trips, and anything else proves nothing", () => {
      expect(parseUpdateApplyState(complete)).toEqual(completedDockerApplyState("/cfg", "0.4.2"));
      expect(parseUpdateApplyState(applying)).toEqual(
        activeDockerApplyState("/cfg", "applying", "0.4.2", "0.4.1"),
      );
      expect(parseSourceApplyState(complete)).toBeNull();
      expect(
        parseUpdateApplyState(
          JSON.stringify({
            version: 1,
            method: "docker",
            projectDir: "/cfg",
            phase: "complete",
            tag: "bad tag",
          }),
        ),
      ).toBeNull();
      expect(
        parseUpdateApplyState(
          JSON.stringify({ version: 1, method: "docker", phase: "complete", tag: "0.4.2" }),
        ),
      ).toBeNull();
    });

    test("a complete record for the tag on file is proof; the served version can still contradict it", () => {
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", complete, null)).toEqual({
        complete: true,
        previousTag: "0.4.2",
        recovery: "none",
        attested: false,
      });
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", complete, "0.4.2").complete).toBe(
        true,
      );
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", complete, "0.4.1")).toEqual({
        complete: false,
        previousTag: "0.4.1",
        recovery: "mismatch",
        attested: false,
      });
      // Moving on from a completed tag: the baseline is that tag.
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.3", complete, null)).toEqual({
        complete: false,
        previousTag: "0.4.2",
        recovery: "none",
        attested: false,
      });
      // The tag moved without the record (an installer re-run): the gateway
      // decides, and a match is attested rather than reapplied.
      expect(assessDockerApplyEvidence("/cfg", "0.4.3", "0.4.3", complete, "0.4.3")).toEqual({
        complete: true,
        previousTag: "0.4.3",
        recovery: "none",
        attested: true,
      });
      expect(assessDockerApplyEvidence("/cfg", "0.4.3", "0.4.3", complete, "0.4.2")).toEqual({
        complete: false,
        previousTag: "0.4.2",
        recovery: "mismatch",
        attested: false,
      });
    });

    test("an active record is an unfinished apply whose baseline is the last served tag", () => {
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", applying, "0.4.1")).toEqual({
        complete: false,
        previousTag: "0.4.1",
        recovery: "unfinished",
        attested: false,
      });
      expect(
        assessDockerApplyEvidence(
          "/cfg",
          "0.4.2",
          "0.4.2",
          serializeUpdateApplyState(
            activeDockerApplyState("/cfg", "rolling-back", "0.4.2", "0.4.1"),
          ),
          null,
        ).recovery,
      ).toBe("unfinished");
    });

    test("with no record, the tag on file is intent: the gateway's answer decides", () => {
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", null, "0.4.2")).toEqual({
        complete: true,
        previousTag: "0.4.2",
        recovery: "none",
        attested: true,
      });
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", null, "0.4.1")).toEqual({
        complete: false,
        previousTag: "0.4.1",
        recovery: "unrecorded",
        attested: false,
      });
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", null, null)).toEqual({
        complete: false,
        previousTag: "0.4.2",
        recovery: "unrecorded",
        attested: false,
      });
      // A record for another project, or unparsable text, is not this one's.
      expect(
        assessDockerApplyEvidence(
          "/cfg",
          "0.4.2",
          "0.4.2",
          serializeUpdateApplyState(completedDockerApplyState("/other", "0.4.2")),
          null,
        ).recovery,
      ).toBe("mismatch");
      expect(assessDockerApplyEvidence("/cfg", "0.4.2", "0.4.2", "{not json", null).recovery).toBe(
        "mismatch",
      );
      // An ordinary move forward needs no proof about the old tag.
      expect(assessDockerApplyEvidence("/cfg", "0.4.1", "0.4.2", null, null)).toEqual({
        complete: false,
        previousTag: "0.4.1",
        recovery: "none",
        attested: false,
      });
    });
  });

  test("every apply plan names what it moves to and what it moves back to", () => {
    expect(
      sourceApplyPlan(
        "/opt/omnesis",
        "v9.9.2",
        "1122334455667788990011223344556677889900",
        "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
      ),
    ).toMatchObject({
      target: "v9.9.2",
      previous: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
    });
    expect(npmGlobalApplyPlan("0.3.0", "0.2.0")).toMatchObject({
      target: "0.3.0",
      previous: "0.2.0",
    });
  });

  // Recreating the container is what makes it run the newly pulled image —
  // and, on the way back, the image the rolled-back tag names.
  test("a container is restarted by being recreated, not by docker restart", () => {
    expect(formatCommandSpec(dockerRestartSpec("/cfg/docker-compose.yml", "gateway"))).toBe(
      "docker compose -f /cfg/docker-compose.yml up -d --no-deps gateway",
    );
    expect(formatCommandSpec(dockerComposeSpec("/cfg/docker-compose.yml", ["pull"]))).toBe(
      "docker compose -f /cfg/docker-compose.yml pull",
    );
  });

  test("the previous ref is read before the checkout moves", () => {
    expect(formatCommandSpec(sourceHeadSpec("/opt/omnesis"))).toBe("git rev-parse HEAD");
  });

  test("the harness steps name the harness's own commands", () => {
    expect(formatCommandSpec(harnessRefreshSpec("openclaw", "/usr/local/bin/omnesis"))).toBe(
      "/usr/local/bin/omnesis connect openclaw --refresh",
    );
    expect(formatCommandSpec(harnessRestartSpec("hermes"))).toBe("hermes gateway restart");
  });
});

// ── Version comparison + update assessment ───────────────────────────────

describe("compareSemver", () => {
  test("orders by numeric major.minor.patch core", () => {
    expect(compareSemver("0.3.0", "0.2.0")).toBe(1);
    expect(compareSemver("0.2.0", "0.3.0")).toBe(-1);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1); // numeric, not lexical
  });

  test("tolerates a leading v, whitespace, and a pre-release suffix", () => {
    expect(compareSemver("v0.2.0\n", "0.2.0")).toBe(0);
    expect(compareSemver("0.3.0-beta.1", "0.2.0")).toBe(1);
    expect(compareSemver("0.2.0-beta.1", "0.2.0")).toBe(0); // core ignores the tag
  });
});

describe("assessUpdate", () => {
  test("upgrade recommends a backup and does not require force", () => {
    const a = assessUpdate("0.2.0", "0.3.0");
    expect(a.direction).toBe("upgrade");
    expect(a.requiresForce).toBe(false);
    expect(a.notes.join(" ")).toMatch(/back up/i);
  });

  test("downgrade requires force and explains the source reset", () => {
    const a = assessUpdate("0.3.0", "0.2.0");
    expect(a.direction).toBe("downgrade");
    expect(a.requiresForce).toBe(true);
    expect(a.notes.join(" ")).toMatch(/resets? any source|resync/i);
  });

  test("same version is a no-op with no notes", () => {
    const a = assessUpdate("0.2.0", "v0.2.0");
    expect(a.direction).toBe("same");
    expect(a.requiresForce).toBe(false);
    expect(a.notes).toEqual([]);
  });
});

describe("source update commands against a replaced repository history (real git)", () => {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "omnesis-test",
    GIT_AUTHOR_EMAIL: "release@example.com",
    GIT_COMMITTER_NAME: "omnesis-test",
    GIT_COMMITTER_EMAIL: "release@example.com",
  };
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  const run = (spec: { command: string; args: string[]; cwd?: string }) =>
    spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: gitEnv, encoding: "utf8" });
  const release = (repo: string, version: string) => {
    mkdirSync(join(repo, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(repo, "packages", "cli", "package.json"),
      `${JSON.stringify({ version })}\n`,
    );
    git(repo, "add", "packages/cli/package.json");
    git(repo, "commit", "-q", "-m", version);
    git(repo, "tag", `v${version}`);
  };

  const replaceWithRoot = (origin: string, version: string) => {
    git(origin, "checkout", "-q", "--orphan", "replaced");
    git(origin, "rm", "-r", "-q", "--cached", ".");
    for (const tag of git(origin, "tag", "--list").stdout.split("\n").filter(Boolean)) {
      git(origin, "tag", "-d", tag);
    }
    // A squashed root never reproduces an old commit: its tree differs.
    writeFileSync(join(origin, "SQUASHED"), "history squashed\n");
    git(origin, "add", "SQUASHED");
    release(origin, version);
    git(origin, "branch", "-M", "main");
  };

  test("an edge checkout's fetch moves origin/main to the new root", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-replaced-edge-"));
    try {
      const origin = join(dir, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      release(origin, "0.5.10");
      const checkout = join(dir, "checkout");
      expect(
        git(dir, "clone", "-q", "--branch", "main", "--single-branch", origin, checkout).status,
      ).toBe(0);
      const installed = git(checkout, "rev-parse", "HEAD").stdout.trim();
      replaceWithRoot(origin, "0.5.11");

      // Without forcing, git refuses to move origin/main to an unrelated commit.
      expect(git(checkout, "fetch", "origin", "main:refs/remotes/origin/main").status).not.toBe(0);
      expect(run(sourceFetchSpec(checkout, true, "origin/main")).status).toBe(0);
      expect(git(checkout, "rev-parse", "origin/main").stdout.trim()).toBe(
        git(origin, "rev-parse", "main").stdout.trim(),
      );
      expect(run(sourceAncestrySpec(checkout, "origin/main", installed)).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release tag that already exists locally at another commit is never overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-tag-clobber-"));
    try {
      const origin = join(dir, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      release(origin, "0.5.10");
      const checkout = join(dir, "checkout");
      expect(
        git(dir, "clone", "-q", "--branch", "v0.5.10", "--single-branch", origin, checkout).status,
      ).toBe(0);
      const local = git(checkout, "rev-parse", "v0.5.10").stdout.trim();
      replaceWithRoot(origin, "0.5.10");

      expect(run(sourceFetchSpec(checkout, false, "v0.5.10")).status).not.toBe(0);
      expect(git(checkout, "rev-parse", "v0.5.10").stdout.trim()).toBe(local);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a checkout cloned from a tag fetches, compares, and reads the new root's release", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-replaced-history-"));
    try {
      const origin = join(dir, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      release(origin, "0.4.7");
      release(origin, "0.5.10");
      const checkout = join(dir, "checkout");
      // The installer's fresh stable clone: it configures origin to fetch this one tag.
      expect(
        git(dir, "clone", "-q", "--branch", "v0.4.7", "--single-branch", origin, checkout).status,
      ).toBe(0);
      expect(git(checkout, "config", "--get", "remote.origin.fetch").stdout.trim()).toBe(
        "+refs/tags/v0.4.7:refs/tags/v0.4.7",
      );
      const installed = git(checkout, "rev-parse", "HEAD").stdout.trim();

      // The repository's history is replaced by one new root with a newer release.
      replaceWithRoot(origin, "0.5.11");

      // A plain fetch now fails on the configured tag; the update's fetch does not.
      expect(git(checkout, "fetch", "origin", "--tags").status).not.toBe(0);
      expect(run(sourceFetchSpec(checkout, false, "v0.5.11")).status).toBe(0);
      expect(run(sourceAncestrySpec(checkout, "v0.5.11", installed)).status).toBe(1);
      const mergeBase = run(sourceMergeBaseSpec(checkout, "v0.5.11", installed));
      expect(mergeBase.status).toBe(1);
      expect(mergeBase.stdout).toBe("");
      expect(JSON.parse(run(sourceTargetVersionSpec(checkout, "v0.5.11")).stdout)).toEqual({
        version: "0.5.11",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
