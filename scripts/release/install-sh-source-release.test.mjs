// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = join(repoRoot, "scripts", "install.sh");
let fixture;

function git(...args) {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
}

function commitVersion(version, message) {
  mkdirSync(join(fixture, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(fixture, "packages", "cli", "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  git("add", ".");
  git("commit", "-m", message);
}

function install(args, name, extraEnv = {}, source = join(fixture, `checkout-${name}`)) {
  const home = join(fixture, `home-${name}`);
  mkdirSync(home, { recursive: true });
  execFileSync(
    "sh",
    [installer, "--client-only", "--no-keyring", "--source-dir", source, ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
        OMNESIS_REPO_URL: fixture,
        OMNESIS_KEYRING_PASSPHRASE_FILE: "",
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
  return source;
}

// Replace the fixture repository's whole history with one new root commit at
// `version`, the way a squash into a new repository does: every old tag and
// commit is gone from what origin advertises.
function replaceHistory(version) {
  git("checkout", "--orphan", "replaced-root");
  git("rm", "-r", "--cached", "-q", ".");
  mkdirSync(join(fixture, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(fixture, "packages", "cli", "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  git("add", ".gitignore", "packages/cli/package.json");
  git("commit", "-m", `Squashed history at ${version}`);
  git("branch", "-M", "main");
  for (const tag of git("tag", "--list").split("\n").filter(Boolean)) git("tag", "-d", tag);
  git("tag", `v${version}`);
}

function releaseOnMain(version) {
  writeFileSync(
    join(fixture, "packages", "cli", "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  git("add", "packages/cli/package.json");
  git("commit", "-m", version);
  git("tag", `v${version}`);
}

// Re-run the installer on an existing checkout and return the whole result, so
// a test can read the warnings it printed.
function rerun(args, name) {
  return spawnSync(
    "sh",
    [
      installer,
      "--client-only",
      "--no-keyring",
      "--source-dir",
      join(fixture, `checkout-${name}`),
      ...args,
    ],
    {
      env: {
        ...process.env,
        HOME: join(fixture, `home-${name}`),
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
        OMNESIS_REPO_URL: fixture,
        OMNESIS_KEYRING_PASSPHRASE_FILE: "",
      },
      encoding: "utf8",
    },
  );
}

function installedState(name) {
  const path = join(fixture, `home-${name}`, ".config", "omnesis", "update-state.json");
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

function fakeLinuxHost() {
  const uname = join(fixture, "fake-bin", "uname");
  writeFileSync(
    uname,
    "#!/bin/sh\ncase \"$1\" in\n  -s) printf 'Linux\\n' ;;\n  -m) printf 'x86_64\\n' ;;\n  *) exit 64 ;;\nesac\n",
  );
  chmodSync(uname, 0o755);
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-source-installer-")));
  git("init", "-b", "main");
  git("config", "user.name", "omnesis-test");
  git("config", "user.email", "release@example.com");
  writeFileSync(join(fixture, ".gitignore"), "node_modules/\n");
  commitVersion("0.9.0", "0.9.0");
  git("tag", "v0.9.0");
  commitVersion("0.10.0", "0.10.0");
  git("tag", "v0.10.0");
  git("tag", "v0.11.0-beta.1");
  commitVersion("0.11.0", "edge");

  const fakeBin = join(fixture, "fake-bin");
  mkdirSync(fakeBin);
  const npm = join(fakeBin, "npm");
  writeFileSync(
    npm,
    '#!/bin/sh\nif [ "$1" = ci ]; then rm -rf node_modules; [ "${FAIL_NPM_CI:-0}" != 1 ] || exit 42; mkdir -p node_modules/.bin; printf \'#!/bin/sh\\necho test-version\\n\' > node_modules/.bin/tsx; chmod +x node_modules/.bin/tsx; fi\n',
  );
  chmodSync(npm, 0o755);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe("install.sh source releases", () => {
  test("refuses a glibc host that cannot load the supported native bindings", () => {
    fakeLinuxHost();
    const getconf = join(fixture, "fake-bin", "getconf");
    writeFileSync(getconf, "#!/bin/sh\nprintf 'glibc 2.34\\n'\n");
    chmodSync(getconf, 0o755);

    expect(() => install([], "old-glibc")).toThrow(/glibc 2\.34 is too old/);
    expect(() => statSync(join(fixture, "checkout-old-glibc"))).toThrow();
  });

  test("accepts the glibc boundary and a known musl host, but refuses an unknown libc", () => {
    fakeLinuxHost();
    const getconf = join(fixture, "fake-bin", "getconf");
    const ldd = join(fixture, "fake-bin", "ldd");
    writeFileSync(getconf, "#!/bin/sh\nprintf 'glibc 2.35\\n'\n");
    chmodSync(getconf, 0o755);
    install([], "glibc-boundary");
    expect(statSync(join(fixture, "checkout-glibc-boundary")).isDirectory()).toBe(true);

    writeFileSync(getconf, "#!/bin/sh\nexit 1\n");
    writeFileSync(ldd, "#!/bin/sh\nprintf 'musl libc 1.2.5\\n'\n");
    chmodSync(ldd, 0o755);
    install([], "musl");
    expect(statSync(join(fixture, "checkout-musl")).isDirectory()).toBe(true);

    writeFileSync(ldd, "#!/bin/sh\nprintf 'unknown libc\\n'\n");
    expect(() => install([], "unknown-libc")).toThrow(/Could not determine the host libc/);
    expect(() => statSync(join(fixture, "checkout-unknown-libc"))).toThrow();

    writeFileSync(getconf, "#!/bin/sh\nprintf 'glibc 3\\n'\n");
    expect(() => install([], "malformed-glibc")).toThrow(/Could not read the host glibc version/);
    expect(() => statSync(join(fixture, "checkout-malformed-glibc"))).toThrow();
  });

  test("canonicalizes a source destination reached through a symlinked parent", () => {
    const physicalParent = join(fixture, "physical-destinations");
    const aliasedParent = join(fixture, "destination-alias");
    mkdirSync(physicalParent);
    symlinkSync(physicalParent, aliasedParent, "dir");
    const aliasedSource = join(aliasedParent, "checkout");

    install([], "aliased", {}, aliasedSource);

    const canonicalSource = realpathSync(aliasedSource);
    expect(installedState("aliased").value.rootDir).toBe(canonicalSource);
    const wrapper = join(fixture, "home-aliased", ".local", "bin", "omnesis");
    const launcher = readFileSync(wrapper, "utf8");
    expect(launcher).toContain(canonicalSource);
    expect(launcher).not.toContain(aliasedSource);
    expect(
      execFileSync(wrapper, ["--version"], {
        env: {
          ...process.env,
          HOME: join(fixture, "home-aliased"),
          PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
        },
        encoding: "utf8",
      }).trim(),
    ).toBe("test-version");
  });

  test("defaults to the newest strict stable tag using numeric SemVer order", () => {
    const source = install([], "stable");
    expect(
      execFileSync("git", ["describe", "--tags", "--exact-match"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).toBe("v0.10.0");
    expect(
      execFileSync("git", ["config", "--get", "omnesis.install"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).toBe("managed");
    const state = installedState("stable");
    expect(state.value).toEqual({
      version: 1,
      method: "source",
      rootDir: source,
      phase: "complete",
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    });
    expect(statSync(state.path).mode & 0o777).toBe(0o600);
  });

  test("supports an exact stable version and an explicit edge checkout", () => {
    const exact = install(["--version", "0.9.0"], "exact");
    expect(readFileSync(join(exact, "packages", "cli", "package.json"), "utf8")).toContain(
      '"0.9.0"',
    );
    const edge = install(["--edge"], "edge");
    expect(readFileSync(join(edge, "packages", "cli", "package.json"), "utf8")).toContain(
      '"0.11.0"',
    );
    expect(installedState("exact").value.commit).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: exact, encoding: "utf8" }).trim(),
    );
    expect(installedState("edge").value.commit).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: edge, encoding: "utf8" }).trim(),
    );
  });

  test("installs and updates to exact commits fetched from origin", () => {
    const first = git("rev-parse", "v0.9.0^{commit}");
    const latest = git("rev-parse", "main^{commit}");
    const source = install(["--commit", first], "commit");

    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    ).toBe(first);
    install(["--commit", latest], "commit");
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    ).toBe(latest);
    expect(installedState("commit").value.commit).toBe(latest);
  });

  test("refuses malformed, conflicting, and non-source commit selectors", () => {
    expect(() => install(["--commit", "abc"], "bad-commit")).toThrow(/Invalid --commit/u);
    expect(() =>
      install(["--commit", `${"a".repeat(40)}\n${"b".repeat(40)}`], "multiline-commit"),
    ).toThrow(/Invalid --commit/u);
    expect(() => install(["--commit", "a".repeat(40), "--edge"], "conflicting-commit")).toThrow(
      /cannot be used with --edge/u,
    );

    const result = spawnSync(
      "/bin/sh",
      [installer, "--method", "package", "--commit", "a".repeat(40)],
      { env: { HOME: join(fixture, "unused"), PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source-only");
  });

  test("refuses dirty and backwards existing checkouts unless explicitly forced", () => {
    const source = install(["--edge"], "existing");
    writeFileSync(join(source, "local-change"), "dirty\n");
    expect(() => install([], "existing")).toThrow(/local changes/u);
    rmSync(join(source, "local-change"));
    expect(() => install([], "existing")).toThrow(/not a forward update/u);
    install(["--force"], "existing");
    expect(
      execFileSync("git", ["describe", "--tags", "--exact-match"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).toBe("v0.10.0");
  });

  test("moves forward across a replaced repository history to a newer release", () => {
    const source = install([], "replaced");
    const installed = installedState("replaced").value.commit;
    replaceHistory("0.12.0");
    const newRoot = git("rev-parse", "v0.12.0");

    const crossed = rerun([], "replaced");
    expect(crossed.status, crossed.stderr).toBe(0);
    expect(crossed.stderr).toContain("the repository's history was replaced");
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    ).toBe(newRoot);
    expect(installedState("replaced").value).toMatchObject({ phase: "complete", commit: newRoot });
    expect(
      spawnSync("git", ["merge-base", newRoot, installed], { cwd: source }).status,
      "the new root shares no history with the old install",
    ).toBe(1);

    // The next release on the new history is an ordinary forward update.
    releaseOnMain("0.13.0");
    const next = rerun([], "replaced");
    expect(next.status, next.stderr).toBe(0);
    expect(next.stderr).not.toContain("history was replaced");
    expect(installedState("replaced").value.commit).toBe(git("rev-parse", "v0.13.0"));
  });

  test("an edge install follows main across a replaced repository history", () => {
    install(["--edge"], "replaced-edge");
    replaceHistory("0.12.0");
    const crossed = rerun(["--edge"], "replaced-edge");
    expect(crossed.status, crossed.stderr).toBe(0);
    expect(crossed.stderr).toContain("the repository's history was replaced");
    expect(installedState("replaced-edge").value.commit).toBe(git("rev-parse", "main"));
  });

  test("moves forward to a newer release that lacks an installed exact commit", () => {
    const mainTip = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "unmerged", "v0.10.0");
    writeFileSync(join(fixture, "unmerged.txt"), "an unmerged change\n");
    git("add", "unmerged.txt");
    git("commit", "-m", "unmerged change");
    const unmerged = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    expect(git("rev-parse", "HEAD")).toBe(mainTip);
    install(["--commit", unmerged], "unmerged");
    git("tag", "v0.11.0", mainTip);

    const moved = rerun([], "unmerged");
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stderr).toContain(
      "is newer than the installed build (0.10.0) but does not contain all of it",
    );
    expect(moved.stderr).not.toContain("history was replaced");
    expect(installedState("unmerged").value.commit).toBe(mainTip);
  });

  test("refuses a replaced repository history whose release is not newer unless forced", () => {
    const source = install([], "replaced-older");
    replaceHistory("0.9.5");
    expect(() => install([], "replaced-older")).toThrow(/not a forward update/u);
    install(["--force"], "replaced-older");
    expect(
      execFileSync("git", ["describe", "--tags", "--exact-match"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).toBe("v0.9.5");
  });

  test("an interrupted same-target rebuild stays recoverable through the stable wrapper", () => {
    const source = install([], "recovery");
    const completedCommit = installedState("recovery").value.commit;
    const wrapper = join(fixture, "home-recovery", ".local", "bin", "omnesis");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec "${source}/node_modules/.bin/tsx" "${source}/packages/cli/src/index.ts" "$@"\n`,
    );

    expect(() => install([], "recovery", { FAIL_NPM_CI: "1" })).toThrow();
    expect(installedState("recovery").value).toEqual({
      version: 1,
      method: "source",
      rootDir: source,
      phase: "applying",
      targetCommit: completedCommit,
      lastCompletedCommit: completedCommit,
    });
    expect(() => readFileSync(join(source, "node_modules", ".bin", "tsx"))).toThrow();
    expect(readFileSync(wrapper, "utf8")).toContain("A source update did not finish");
    writeFileSync(join(source, "packages", "cli", "package.json"), "interrupted checkout\n");

    const daemon = spawnSync(wrapper, ["gateway", "serve"], {
      env: {
        ...process.env,
        HOME: join(fixture, "home-recovery"),
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
    expect(daemon.status).toBe(1);
    expect(daemon.stderr).toContain("Run 'omnesis update'");
    expect(daemon.stderr).toContain(
      "If its build was killed for lack of memory, first stop the collector and gateway",
    );
    expect(() => readFileSync(join(source, "node_modules", ".bin", "tsx"))).toThrow();

    const dirtyRecovery = spawnSync(wrapper, ["update"], {
      env: {
        ...process.env,
        HOME: join(fixture, "home-recovery"),
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
    expect(dirtyRecovery.status).toBe(1);
    expect(dirtyRecovery.stderr).toContain("local changes after the interrupted update");
    expect(readFileSync(join(source, "packages", "cli", "package.json"), "utf8")).toBe(
      "interrupted checkout\n",
    );
    expect(() => readFileSync(join(source, "node_modules", ".bin", "tsx"))).toThrow();

    execFileSync("git", ["checkout", "--", "packages/cli/package.json"], { cwd: source });
    expect(
      execFileSync(wrapper, ["update"], {
        env: {
          ...process.env,
          HOME: join(fixture, "home-recovery"),
          PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
        },
        encoding: "utf8",
      }).trim(),
    ).toBe("test-version");
    expect(readFileSync(join(source, "node_modules", ".bin", "tsx"), "utf8")).toContain(
      "test-version",
    );
    expect(readFileSync(join(source, "packages", "cli", "package.json"), "utf8")).toContain(
      '"0.10.0"',
    );
  });

  test("a failed atomic launcher replacement preserves the previous wrapper", () => {
    install([], "launcher-atomic");
    const binDir = join(fixture, "home-launcher-atomic", ".local", "bin");
    const wrapper = join(binDir, "omnesis");
    const previous = readFileSync(wrapper, "utf8");
    const fakeNode = join(fixture, "fake-bin", "node");
    writeFileSync(
      fakeNode,
      '#!/bin/sh\ncase "$*" in *"/.omnesis."*) [ "${FAIL_LAUNCHER_COMMIT:-0}" != 1 ] || exit 42 ;; esac\nexec "$REAL_NODE" "$@"\n',
    );
    chmodSync(fakeNode, 0o755);

    expect(() =>
      install([], "launcher-atomic", {
        FAIL_LAUNCHER_COMMIT: "1",
        REAL_NODE: process.execPath,
      }),
    ).toThrow(/atomically install/u);
    rmSync(fakeNode);

    expect(readFileSync(wrapper, "utf8")).toBe(previous);
    expect(readdirSync(binDir).filter((entry) => entry.startsWith(".omnesis."))).toEqual([]);
  });

  test("a complete marker whose commit differs from HEAD requires recovery", () => {
    const source = install([], "head-mismatch");
    const completedCommit = installedState("head-mismatch").value.commit;
    execFileSync("git", ["checkout", "--detach", "v0.9.0"], { cwd: source });
    const wrapper = join(fixture, "home-head-mismatch", ".local", "bin", "omnesis");

    const daemon = spawnSync(wrapper, ["gateway", "serve"], {
      env: {
        ...process.env,
        HOME: join(fixture, "home-head-mismatch"),
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
    expect(daemon.status).toBe(1);
    expect(daemon.stderr).toContain("Run 'omnesis update'");

    execFileSync(wrapper, ["update"], {
      env: {
        ...process.env,
        HOME: join(fixture, "home-head-mismatch"),
        PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
      },
    });
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    ).toBe(completedCommit);
  });

  test("the installed wrapper preserves shell metacharacters in local paths", () => {
    const name = "special-'\"$(false)`false`$USER";
    const source = install([], name);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");

    expect(
      execFileSync(wrapper, ["--version"], {
        env: {
          ...process.env,
          HOME: join(fixture, `home-${name}`),
          PATH: `${join(fixture, "fake-bin")}:${process.env.PATH}`,
        },
        encoding: "utf8",
      }).trim(),
    ).toBe("test-version");
    expect(installedState(name).value.rootDir).toBe(source);
  });

  test("rejects mismatched tag metadata before npm runs", () => {
    git("tag", "v0.12.0");
    expect(() => install(["--version", "0.12.0"], "mismatch")).toThrow(
      /contains CLI version 0\.11\.0/u,
    );
    expect(() =>
      readFileSync(join(fixture, "checkout-mismatch", "node_modules", ".bin", "tsx")),
    ).toThrow();
  });

  test("refuses an edge package install: there is no dist-tag for a branch", () => {
    const result = spawnSync("/bin/sh", [installer, "--method", "package", "--edge"], {
      env: { HOME: join(fixture, "unused"), PATH: "/nonexistent" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source-only");
  });
});
