// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assessSourceApplyEvidence, sourceManagedSpec, type CommandSpec } from "./detect.js";
import {
  adoptSourceCheckout,
  isOfficialSourceAdoptionOrigin,
  nodeSourceAdoptionFs,
  parseSourceAdoptionRemoteRefs,
  type SourceAdoptionDeps,
  type SourceAdoptionFs,
  type SourceAdoptionRunOutcome,
} from "./source-adoption.js";

const ROOT = "/srv/omnesis fixture;$safe";
const GIT_DIR = join(ROOT, ".git");
const GIT_CONFIG = join(GIT_DIR, "config");
const HEAD = "1".repeat(40);
const MAIN = "2".repeat(40);
const TAG_OBJECT = "3".repeat(40);
const OFFICIAL = "https://github.com/omnesis-dev/Omnesis.git";
const GITHUB_SSH_AUTHORITY = ["git", "github.com"].join("@");
const GITHUB_USERINFO_AUTHORITY = ["user", "github.com"].join("@");

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeFs(
  options: {
    rootKind?: "directory" | "file" | "symlink" | "other" | null;
    gitKind?: "directory" | "file" | "symlink" | "other" | null;
    configKind?: "directory" | "file" | "symlink" | "other" | null;
    present?: string[];
  } = {},
): SourceAdoptionFs {
  const present = new Set(options.present ?? []);
  const identity = (kind: "directory" | "file" | "symlink" | "other" | null, inode: string) =>
    kind === null ? null : { kind, device: "7", inode };
  return {
    identity: (path) => {
      if (path === ROOT) {
        return identity("rootKind" in options ? (options.rootKind ?? null) : "directory", "11");
      }
      if (path === GIT_DIR) {
        return identity("gitKind" in options ? (options.gitKind ?? null) : "directory", "12");
      }
      if (path === GIT_CONFIG) {
        return identity("configKind" in options ? (options.configKind ?? null) : "file", "13");
      }
      return null;
    },
    exists: (path) => present.has(path),
  };
}

interface FakeState {
  marker: string[];
  calls: CommandSpec[];
  counts: Map<string, number>;
}

type Override = (
  args: string[],
  occurrence: number,
  state: FakeState,
) => SourceAdoptionRunOutcome | Error | undefined;

function commandKey(args: string[]): string {
  return args.join("\0");
}

function fakeDeps(
  options: {
    fs?: SourceAdoptionFs;
    marker?: string[];
    override?: Override;
  } = {},
): { deps: SourceAdoptionDeps; state: FakeState; logs: string[] } {
  const state: FakeState = {
    marker: [...(options.marker ?? [])],
    calls: [],
    counts: new Map(),
  };
  const logs: string[] = [];
  const deps: SourceAdoptionDeps = {
    fs: options.fs ?? fakeFs(),
    log: (message) => logs.push(message),
    nonce: () => "test-nonce",
    run: (spec) =>
      Promise.resolve().then(() => {
        state.calls.push(spec);
        expect(spec.command).toBe("git");
        expect(spec.cwd).toBe(ROOT);
        expect(spec.args.slice(0, 3)).toEqual([
          `--git-dir=${GIT_DIR}`,
          `--work-tree=${ROOT}`,
          "--no-replace-objects",
        ]);
        const args = spec.args.slice(3);
        const key = commandKey(args);
        const occurrence = (state.counts.get(key) ?? 0) + 1;
        state.counts.set(key, occurrence);
        const overridden = options.override?.(args, occurrence, state);
        if (overridden instanceof Error) throw overridden;
        if (overridden) return overridden;

        const joined = args.join(" ");
        if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: `${ROOT}\n` };
        if (joined === "rev-parse --is-bare-repository") return { code: 0, stdout: "false\n" };
        if (joined === "rev-parse --absolute-git-dir") {
          return { code: 0, stdout: `${GIT_DIR}\n` };
        }
        if (joined === "rev-parse --git-common-dir") return { code: 0, stdout: ".git\n" };
        if (joined === "config --local --bool core.sparseCheckout") {
          return { code: 1, stdout: "" };
        }
        if (joined === "config --worktree --bool core.sparseCheckout") {
          return { code: 1, stdout: "" };
        }
        if (joined === "for-each-ref --format=%(refname) refs/replace") {
          return { code: 0, stdout: "" };
        }
        if (joined === "status --porcelain=v1 --untracked-files=all --ignore-submodules=none") {
          return { code: 0, stdout: "" };
        }
        if (joined === "symbolic-ref --quiet HEAD") return { code: 1, stdout: "" };
        if (joined === "rev-parse --verify HEAD") return { code: 0, stdout: `${HEAD}\n` };
        if (joined === "config --local --no-includes --get-all remote.origin.url") {
          return { code: 0, stdout: `${OFFICIAL}\n` };
        }
        if (joined === "remote get-url --all origin") return { code: 0, stdout: `${OFFICIAL}\n` };
        if (joined === "config --local --no-includes --get-all omnesis.install") {
          return state.marker.length > 0
            ? { code: 0, stdout: `${state.marker.join("\n")}\n` }
            : { code: 1, stdout: "" };
        }
        if (joined === "ls-remote origin refs/heads/main refs/tags/v*") {
          return {
            code: 0,
            stdout:
              `${MAIN}\trefs/heads/main\n` +
              `${TAG_OBJECT}\trefs/tags/v1.2.3\n` +
              `${HEAD}\trefs/tags/v1.2.3^{}\n`,
          };
        }
        if (joined === `show ${HEAD}:packages/cli/package.json`) {
          return { code: 0, stdout: '{"version":"1.2.3"}\n' };
        }
        if (joined === `fetch --no-tags --no-write-fetch-head origin ${MAIN}`) {
          return { code: 0, stdout: "" };
        }
        if (joined === `merge-base --is-ancestor ${HEAD} ${MAIN}`) {
          return { code: 0, stdout: "" };
        }
        if (args.slice(0, 5).join(" ") === "config --local --no-includes --add omnesis.install") {
          state.marker.push(args[5]!);
          return { code: 0, stdout: "" };
        }
        if (args.slice(0, 4).join(" ") === "config --local --no-includes --replace-all") {
          const next = args[5]!;
          const pattern = args[6]!;
          const index = state.marker.findIndex((value) => pattern === `^${value}$`);
          if (index === -1) return { code: 5, stdout: "" };
          state.marker[index] = next;
          return { code: 0, stdout: "" };
        }
        if (
          args.slice(0, 5).join(" ") === "config --local --no-includes --unset-all omnesis.install"
        ) {
          const pattern = args[5]!;
          const matched = state.marker.some((value) => pattern === `^${value}$`);
          state.marker = state.marker.filter((value) => pattern !== `^${value}$`);
          return { code: matched ? 0 : 5, stdout: "" };
        }
        throw new Error(`Unexpected command: ${joined}`);
      }),
  };
  return { deps, state, logs };
}

function subcommands(state: FakeState): string[] {
  return state.calls.map((call) => call.args.slice(3).join(" "));
}

describe("source adoption remote parsing", () => {
  test("peels annotated tags and accepts lightweight stable tags", () => {
    const lightweight = "4".repeat(40);
    const parsed = parseSourceAdoptionRemoteRefs(
      `${MAIN}\trefs/heads/main\n` +
        `${TAG_OBJECT}\trefs/tags/v1.2.3\n` +
        `${HEAD}\trefs/tags/v1.2.3^{}\n` +
        `${lightweight}\trefs/tags/v2.0.0\n`,
    );
    expect(parsed.main).toBe(MAIN);
    expect([...parsed.stableTags]).toEqual([
      [HEAD, ["v1.2.3"]],
      [lightweight, ["v2.0.0"]],
    ]);
  });

  test("ignores prerelease and lookalike tag names", () => {
    const parsed = parseSourceAdoptionRemoteRefs(
      `${HEAD}\trefs/tags/v1.2.3-beta.1\n` +
        `${HEAD}\trefs/tags/v01.2.3\n` +
        `${HEAD}\trefs/tags/v1.2.3-local\n`,
    );
    expect([...parsed.stableTags]).toEqual([]);
  });

  test.each([
    "malformed",
    `${HEAD}\trefs/heads/main\n${MAIN}\trefs/heads/main`,
    `${HEAD}\trefs/tags/v1.2.3^{}`,
  ])("rejects malformed or ambiguous output: %s", (output) => {
    expect(() => parseSourceAdoptionRemoteRefs(output)).toThrow();
  });
});

describe("source adoption origin policy", () => {
  test.each([
    "https://github.com/omnesis-dev/Omnesis",
    "https://github.com/omnesis-dev/Omnesis.git",
    `${GITHUB_SSH_AUTHORITY}:omnesis-dev/Omnesis`,
    `${GITHUB_SSH_AUTHORITY}:omnesis-dev/Omnesis.git`,
    `ssh://${GITHUB_SSH_AUTHORITY}/omnesis-dev/Omnesis`,
    `ssh://${GITHUB_SSH_AUTHORITY}/omnesis-dev/Omnesis.git`,
  ])("accepts the exact official form %s", (origin) => {
    expect(isOfficialSourceAdoptionOrigin(origin)).toBe(true);
  });

  test.each([
    "https://github.com/example/Omnesis.git",
    "https://github.com/omnesis-dev/Omnesis-fork.git",
    `https://${GITHUB_USERINFO_AUTHORITY}/omnesis-dev/Omnesis.git`,
    "https://github.com/omnesis-dev/omnesis.git",
    "https://github.com/omnesis-dev/Omnesis.git?ref=main",
    "file:///srv/Omnesis",
    "ext::sh -c exploit",
    "/srv/Omnesis",
  ])("rejects unsafe or non-official form %s", (origin) => {
    expect(isOfficialSourceAdoptionOrigin(origin)).toBe(false);
  });
});

describe("adoptSourceCheckout", () => {
  test("writes only the local marker after an annotated remote-tag proof", async () => {
    const { deps, state, logs } = fakeDeps();
    await adoptSourceCheckout(ROOT, deps);
    expect(state.marker).toEqual(["managed"]);
    expect(logs.at(-1)).toMatch(/first managed update will rebuild/u);
    expect(subcommands(state)).not.toContain(
      expect.stringMatching(/npm|build|launcher|update-state/u),
    );
    expect(subcommands(state)).not.toContain(expect.stringMatching(/fetch/u));
    expect(subcommands(state)).toContain(
      "config --local --no-includes --add omnesis.install adopting:test-nonce",
    );
    expect(subcommands(state)).toContain(
      "config --local --no-includes --replace-all omnesis.install managed-pending:test-nonce ^adopting:test-nonce$",
    );
    expect(subcommands(state)).toContain(
      "config --local --no-includes --replace-all omnesis.install managed ^managed-pending:test-nonce$",
    );
  });

  test.each([
    ["missing", 1, ""],
    ["invalid", 0, "not-json"],
    ["mismatched", 0, '{"version":"9.9.9"}\n'],
  ])("refuses a %s release manifest", async (_label, code, stdout) => {
    const { deps, state } = fakeDeps({
      override: (args) => (args[0] === "show" ? { code, stdout } : undefined),
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/release/u);
    expect(state.marker).toEqual([]);
  });

  test("accepts a release when one of several live tags matches its manifest", async () => {
    const { deps, state } = fakeDeps({
      override: (args) => {
        if (args[0] === "ls-remote") {
          return {
            code: 0,
            stdout: `${HEAD}\trefs/tags/v1.2.3\n` + `${HEAD}\trefs/tags/v2.0.0\n`,
          };
        }
        if (args[0] === "show") return { code: 0, stdout: '{"version":"2.0.0"}\n' };
        return undefined;
      },
    });
    await adoptSourceCheckout(ROOT, deps);
    expect(state.marker).toEqual(["managed"]);
  });

  test("accepts an untagged commit only after fetching the freshly advertised main hash", async () => {
    const { deps, state } = fakeDeps({
      override: (args) =>
        args[0] === "ls-remote" ? { code: 0, stdout: `${MAIN}\trefs/heads/main\n` } : undefined,
    });
    await adoptSourceCheckout(ROOT, deps);
    expect(subcommands(state)).toContain(`fetch --no-tags --no-write-fetch-head origin ${MAIN}`);
    expect(subcommands(state)).toContain(`merge-base --is-ancestor ${HEAD} ${MAIN}`);
    expect(subcommands(state)).not.toContain(expect.stringContaining("origin/main"));
  });

  test("revalidates an already-managed checkout without duplicating its marker", async () => {
    const { deps, state, logs } = fakeDeps({ marker: ["managed"] });
    await adoptSourceCheckout(ROOT, deps);
    expect(state.marker).toEqual(["managed"]);
    expect(subcommands(state)).not.toContain(
      "config --local --no-includes --add omnesis.install adopting:test-nonce",
    );
    expect(logs).toEqual(["This source checkout is already managed; verification passed."]);
  });

  test.each([
    ["missing root", fakeFs({ rootKind: null }), /root is not a real directory/u],
    ["linked worktree", fakeFs({ gitKind: "file" }), /linked worktrees and submodules/u],
    ["symlinked git dir", fakeFs({ gitKind: "symlink" }), /must be a real directory/u],
    ["symlinked config", fakeFs({ configKind: "symlink" }), /config must be a real file/u],
    [
      "active bisect",
      fakeFs({ present: [join(GIT_DIR, "BISECT_START")] }),
      /Git operation is in progress/u,
    ],
    ["grafts", fakeFs({ present: [join(GIT_DIR, "info", "grafts")] }), /local Git grafts/u],
    [
      "sparse metadata",
      fakeFs({ present: [join(GIT_DIR, "info", "sparse-checkout")] }),
      /sparse checkouts/u,
    ],
  ] as const)("refuses a %s layout", async (_label, fs, pattern) => {
    const { deps, state } = fakeDeps({ fs });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(pattern);
    expect(state.marker).toEqual([]);
  });

  test.each([" M package.json\n", "A  staged.txt\n", "?? new.txt\n", " m packages/example\n"])(
    "refuses dirty porcelain output %j",
    async (stdout) => {
      const { deps, state } = fakeDeps({
        override: (args) => (args[0] === "status" ? { code: 0, stdout } : undefined),
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/working tree is not clean/u);
      expect(state.marker).toEqual([]);
    },
  );

  test.each([
    ["attached branch", (args: string[]) => args[0] === "symbolic-ref", 0, /local branch/u],
    ["symbolic-ref failure", (args: string[]) => args[0] === "symbolic-ref", 2, /detached/u],
    ["status failure", (args: string[]) => args[0] === "status", 2, /working tree/u],
  ] as const)("refuses or fails on %s", async (_label, matches, code, pattern) => {
    const { deps, state } = fakeDeps({
      override: (args) => (matches(args) ? { code, stdout: "" } : undefined),
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(pattern);
    expect(state.marker).toEqual([]);
  });

  test("refuses sparse config and replacement refs", async () => {
    for (const mode of ["sparse", "replace"] as const) {
      const { deps, state } = fakeDeps({
        override: (args) => {
          if (mode === "sparse" && args.join(" ") === "config --local --bool core.sparseCheckout") {
            return { code: 0, stdout: "true\n" };
          }
          if (mode === "replace" && args[0] === "for-each-ref") {
            return { code: 0, stdout: "refs/replace/abc\n" };
          }
          return undefined;
        },
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(
        mode === "sparse" ? /sparse checkouts/u : /replacement refs/u,
      );
      expect(state.marker).toEqual([]);
    }
  });

  test.each([
    ["wrong origin", `${"https://github.com/example/Omnesis.git"}\n`, /not the official/u],
    ["multiple origins", `${OFFICIAL}\n${OFFICIAL}\n`, /exactly one/u],
  ])("refuses %s", async (_label, stdout, pattern) => {
    const { deps, state } = fakeDeps({
      override: (args) =>
        args.join(" ") === "config --local --no-includes --get-all remote.origin.url"
          ? { code: 0, stdout }
          : undefined,
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(pattern);
    expect(state.marker).toEqual([]);
  });

  test.each([[["foreign"]], [["managed", "managed"]], [["managed", "foreign"]]])(
    "refuses a noncanonical pre-existing marker %j",
    async (marker) => {
      const { deps, state } = fakeDeps({ marker });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/ownership marker/u);
      expect(state.marker).toEqual(marker);
    },
  );

  test("does not trust a local tag or cached origin/main when the live query fails", async () => {
    const { deps, state } = fakeDeps({
      override: (args) => (args[0] === "ls-remote" ? { code: 1, stdout: "" } : undefined),
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/could not be queried/u);
    expect(subcommands(state)).not.toContain(expect.stringContaining("origin/main"));
    expect(subcommands(state)).not.toContain(expect.stringMatching(/describe|tag --points-at/u));
    expect(state.marker).toEqual([]);
  });

  test("refuses a divergent commit and an ancestry inspection error", async () => {
    for (const code of [1, 2]) {
      const { deps, state } = fakeDeps({
        override: (args) => {
          if (args[0] === "ls-remote") return { code: 0, stdout: `${MAIN}\trefs/heads/main\n` };
          if (args[0] === "merge-base") return { code, stdout: "" };
          return undefined;
        },
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(
        code === 1 ? /neither a live stable release/u : /could not prove HEAD/u,
      );
      expect(state.marker).toEqual([]);
    }
  });

  test("refuses a failed fresh-main fetch instead of falling back to a stale ref", async () => {
    const { deps, state } = fakeDeps({
      override: (args) => {
        if (args[0] === "ls-remote") return { code: 0, stdout: `${MAIN}\trefs/heads/main\n` };
        if (args[0] === "fetch") return { code: 1, stdout: "" };
        return undefined;
      },
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/cached origin\/main/u);
    expect(state.marker).toEqual([]);
  });

  test.each(["head", "status", "origin"] as const)(
    "refuses %s drift after the remote proof",
    async (field) => {
      const { deps, state } = fakeDeps({
        override: (args, occurrence) => {
          if (occurrence !== 2) return undefined;
          if (field === "head" && args.join(" ") === "rev-parse --verify HEAD") {
            return { code: 0, stdout: `${"9".repeat(40)}\n` };
          }
          if (field === "status" && args[0] === "status") {
            return { code: 0, stdout: "?? changed.txt\n" };
          }
          if (field === "origin" && args[0] === "remote") {
            return { code: 0, stdout: `${GITHUB_SSH_AUTHORITY}:omnesis-dev/Omnesis.git\n` };
          }
          return undefined;
        },
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(
        field === "status" ? /working tree is not clean/u : /checkout changed/u,
      );
      expect(state.marker).toEqual([]);
    },
  );

  test.each([
    ["claim write", "add", 0, "adopting:test-nonce"],
    ["claim readback", "marker", 3, "adopting:test-nonce"],
    ["pending write", "first-replace", 0, "adopting:test-nonce"],
    ["pending readback", "marker", 4, "managed-pending:test-nonce"],
    ["managed write", "second-replace", 0, "managed-pending:test-nonce"],
  ] as const)(
    "cleans up its exact marker after a failed %s",
    async (_label, mode, occurrence, value) => {
      const { deps, state } = fakeDeps({
        override: (args, seen, fake) => {
          if (
            mode === "add" &&
            args.slice(0, 5).join(" ") === "config --local --no-includes --add omnesis.install"
          ) {
            fake.marker.push(value);
            return { code: 2, stdout: "" };
          }
          if (
            mode === "marker" &&
            args.join(" ") === "config --local --no-includes --get-all omnesis.install" &&
            seen === occurrence
          ) {
            return { code: 0, stdout: `${value}\n${value}\n` };
          }
          if (
            mode === "first-replace" &&
            args[3] === "--replace-all" &&
            args[5] === "managed-pending:test-nonce"
          ) {
            return { code: 2, stdout: "" };
          }
          if (mode === "second-replace" && args[3] === "--replace-all" && args[5] === "managed") {
            return { code: 2, stdout: "" };
          }
          return undefined;
        },
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/ownership (?:claim|marker)/u);
      expect(state.marker).toEqual([]);
      expect(subcommands(state)).toContain(
        `config --local --no-includes --unset-all omnesis.install ^${value}$`,
      );
    },
  );

  test.each([
    ["claim", "--add", "adopting:test-nonce"],
    ["pending", "--replace-all", "adopting:test-nonce"],
    ["managed", "managed", "managed-pending:test-nonce"],
  ] as const)(
    "cleans up its exact marker when the %s command throws",
    async (_stage, mode, value) => {
      const { deps, state } = fakeDeps({
        override: (args) => {
          if (mode === "--add" && args[3] === "--add") return new Error("spawn failed");
          if (
            mode === "--replace-all" &&
            args[3] === "--replace-all" &&
            args[5] === "managed-pending:test-nonce"
          ) {
            return new Error("spawn failed");
          }
          if (mode === "managed" && args[3] === "--replace-all" && args[5] === "managed") {
            return new Error("spawn failed");
          }
          return undefined;
        },
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/ownership marker/u);
      expect(state.marker).toEqual([]);
      expect(subcommands(state)).toContain(
        `config --local --no-includes --unset-all omnesis.install ^${value}$`,
      );
    },
  );

  test.each([
    ["claim", 3],
    ["pending", 4],
  ] as const)(
    "removes only its marker when the checkout changes after %s",
    async (_stage, occurrence) => {
      const { deps, state } = fakeDeps({
        override: (args, seen) =>
          args[0] === "status" && seen === occurrence
            ? { code: 0, stdout: "?? raced.txt\n" }
            : undefined,
      });
      await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/ownership (?:claim|marker)/u);
      expect(state.marker).toEqual([]);
    },
  );

  test("leaves canonical markers untouched when final readback is ambiguous", async () => {
    const { deps, state } = fakeDeps({
      override: (args, occurrence, fake) => {
        if (
          args.join(" ") === "config --local --no-includes --get-all omnesis.install" &&
          occurrence === 5
        ) {
          fake.marker.push("managed");
          return { code: 0, stdout: "managed\nmanaged\n" };
        }
        return undefined;
      },
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/left in place/u);
    expect(state.marker).toEqual(["managed", "managed"]);
    expect(subcommands(state)).not.toContain(
      "config --local --no-includes --unset-all omnesis.install ^managed$",
    );
  });

  test("preserves a concurrent adopter's marker when rejecting a duplicate claim", async () => {
    const other = "adopting:other-nonce";
    const { deps, state } = fakeDeps({
      override: (args, occurrence, fake) => {
        if (
          args.join(" ") === "config --local --no-includes --get-all omnesis.install" &&
          occurrence === 3
        ) {
          fake.marker.push(other);
          return { code: 0, stdout: `${fake.marker.join("\n")}\n` };
        }
        return undefined;
      },
    });
    await expect(adoptSourceCheckout(ROOT, deps)).rejects.toThrow(/ownership claim/u);
    expect(state.marker).toEqual([other]);
  });

  test("keeps metacharacters in cwd and argv without invoking a shell", async () => {
    const { deps, state } = fakeDeps();
    await adoptSourceCheckout(ROOT, deps);
    expect(state.calls.every((call) => call.command === "git" && call.cwd === ROOT)).toBe(true);
    expect(state.calls.every((call) => call.args.includes(`--work-tree=${ROOT}`))).toBe(true);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function realRepository(): { root: string; head: string; tagObject: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-source-adoption-")));
  temporaryRoots.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["config", "user.email", "maya.reeves@example.com"]);
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md", "packages/cli/package.json"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  git(root, ["tag", "-a", "v1.2.3", "-m", "release"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const tagObject = git(root, ["rev-parse", "v1.2.3"]);
  git(root, ["checkout", "--quiet", "--detach", head]);
  git(root, ["remote", "add", "origin", OFFICIAL]);
  return { root, head, tagObject };
}

function realRunner(remoteOutput: string): SourceAdoptionDeps["run"] {
  return (spec) =>
    Promise.resolve().then(() => {
      const args = spec.args.slice(3);
      if (args[0] === "ls-remote") return { code: 0, stdout: remoteOutput };
      const result = spawnSync(spec.command, spec.args, {
        cwd: spec.cwd,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout };
    });
}

describe("source adoption with real Git repositories", () => {
  test("peels a real annotated tag and writes the repository-local marker", async () => {
    const { root, head, tagObject } = realRepository();
    const main = git(root, ["rev-parse", "HEAD"]);
    const globalConfig = join(root, ".git", "global-config");
    writeFileSync(globalConfig, "[omnesis]\n\tinstall = managed\n");
    const includedRoot = mkdtempSync(join(tmpdir(), "omnesis-source-adoption-include-"));
    temporaryRoots.push(includedRoot);
    const includedConfig = join(includedRoot, "config");
    writeFileSync(includedConfig, "[omnesis]\n\tinstall = managed\n");
    git(root, ["config", "--local", "include.path", includedConfig]);
    const managedSpec = sourceManagedSpec(root);
    const before = spawnSync(managedSpec.command, managedSpec.args, {
      cwd: managedSpec.cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    expect(before.status).toBe(1);

    await adoptSourceCheckout(root, {
      run: realRunner(
        `${main}\trefs/heads/main\n` +
          `${tagObject}\trefs/tags/v1.2.3\n` +
          `${head}\trefs/tags/v1.2.3^{}\n`,
      ),
      log: () => {},
    });
    expect(git(root, ["config", "--local", "--no-includes", "--get-all", "omnesis.install"])).toBe(
      "managed",
    );
    expect(assessSourceApplyEvidence(root, head, head, null)).toMatchObject({
      complete: false,
      recovery: "unrecorded",
    });
  });

  test("refuses a real linked worktree before running Git", async () => {
    const { root, head } = realRepository();
    const linked = join(root, "linked");
    mkdirSync(linked);
    rmSync(linked, { recursive: true });
    git(root, ["worktree", "add", "--quiet", "--detach", linked, head]);
    const run = (): Promise<SourceAdoptionRunOutcome> =>
      Promise.reject(new Error("Git must not run for a linked worktree"));
    await expect(
      adoptSourceCheckout(linked, { run, fs: nodeSourceAdoptionFs, log: () => {} }),
    ).rejects.toThrow(/linked worktrees and submodules/u);
  });

  test("refuses a symlinked real Git config without changing its external target", async () => {
    const { root } = realRepository();
    const external = mkdtempSync(join(tmpdir(), "omnesis-source-adoption-config-"));
    temporaryRoots.push(external);
    const config = join(root, ".git", "config");
    const target = join(external, "config");
    renameSync(config, target);
    symlinkSync(target, config);
    const before = readFileSync(target);
    const run = (): Promise<SourceAdoptionRunOutcome> =>
      Promise.reject(new Error("Git must not run with a symlinked local config"));

    await expect(
      adoptSourceCheckout(root, { run, fs: nodeSourceAdoptionFs, log: () => {} }),
    ).rejects.toThrow(/config must be a real file/u);
    expect(readFileSync(target)).toEqual(before);
  });
});
