// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * scripts/hardened-gateway.sh without root: its option checks, which run before
 * anything touches the host, and its helpers, sourced with
 * OMNESIS_HARDENED_SOURCE_ONLY=1 against temporary directories and a local git
 * repository. What needs root and systemd (fetching as root, the throwaway
 * build account, the unit, switching and rolling back) runs for real in
 * scripts/docker-e2e/systemd.
 */

import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "hardened-gateway.sh");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// The script runs only on Linux, and these helpers use GNU tools (`mv -T`,
// `stat -c`, `readlink -e`) and /proc, which macOS does not have.
const LINUX = process.platform === "linux";

let scratch;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-hardened-sh-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args) {
  const res = spawnSync("sh", [script, ...args], { encoding: "utf8" });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

/** Source the script's functions and run a body against them. */
function sourced(body) {
  const res = spawnSync("sh", ["-c", `. "$SCRIPT"\n${body}`], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: script, OMNESIS_HARDENED_SOURCE_ONLY: "1" },
  });
  return { status: res.status, stdout: res.stdout, output: `${res.stdout}${res.stderr}` };
}

test("website/hardened-gateway.sh mirrors scripts/hardened-gateway.sh exactly", () => {
  const mirror = readFileSync(join(repoRoot, "website", "hardened-gateway.sh"), "utf8");
  expect(mirror).toBe(readFileSync(script, "utf8"));
});

test("both scripts are executable in the tree", () => {
  for (const file of ["hardened-gateway.sh", "hardened-gateway-exec.sh"]) {
    expect(lstatSync(join(repoRoot, "scripts", file)).mode & 0o111).not.toBe(0);
  }
});

describe("hardened-gateway.sh options", () => {
  test("help names every command", () => {
    const res = run(["help"]);
    expect(res.status).toBe(0);
    for (const command of ["install", "update", "rollback", "status", "cli", "uninstall"]) {
      expect(res.output).toContain(command);
    }
  });

  test.each([
    [["install", "--version", "0.4"], "Invalid --version '0.4'"],
    [["install", "--version", "0.4.9", "--ref", "main"], "pass one"],
    [["install", "--ref", "-x"], "Invalid --ref '-x'"],
    [["install", "--ref", "main..v1"], "Invalid --ref"],
    [["install", "--ref", "main;reboot"], "Invalid --ref"],
    [["install", "--port", "0"], "expected 1-65535"],
    [["install", "--port", "https"], "expected a number"],
    [["install", "--keyring-passphrase-file", "keyring.pass"], "must be an absolute path"],
    [
      ["install", "--no-keyring", "--keyring-passphrase-file", "/etc/pass"],
      "contradict each other",
    ],
    [["install", "--repo-url", "ssh://example.com/omnesis.git"], "https://"],
    [["install", "--version"], "--version needs a value"],
    [["install", "--sideways"], "Unknown option: --sideways"],
    [["reinstall"], "Unknown command: reinstall"],
  ])("%j is refused before anything else happens", (args, message) => {
    const res = run(args);
    expect(res.status).not.toBe(0);
    expect(res.output).toContain(message);
  });

  test.skipIf(IS_ROOT)("a valid install asks for root before it fetches anything", () => {
    const res = run(["install", "--version", "0.4.9"]);
    expect(res.status).not.toBe(0);
    expect(res.output).toContain("run it as root");
    expect(res.output).not.toContain("Fetching");
  });
});

describe("hardened-gateway.sh helpers", () => {
  test("refs are held to the characters refs use", () => {
    const res = sourced(`
      for ref in v0.4.9 main feat/root-copy 0123456789abcdef0123456789abcdef01234567 '' -x a..b 'a b' 'a;b' '$(id)'; do
        if valid_ref "$ref"; then echo "ok:$ref"; else echo "no:$ref"; fi
      done
    `);
    expect(res.stdout.trim().split("\n")).toEqual([
      "ok:v0.4.9",
      "ok:main",
      "ok:feat/root-copy",
      "ok:0123456789abcdef0123456789abcdef01234567",
      "no:",
      "no:-x",
      "no:a..b",
      "no:a b",
      "no:a;b",
      "no:$(id)",
    ]);
  });

  test("an older release is told apart by its version number", () => {
    const res = sourced(`
      for pair in "0.4.8 0.4.9" "0.4.10 0.4.9" "0.4.9 0.4.9" "0.3.12 0.4.0" "1.0.0 0.9.9" "0.4.9-beta.1 0.4.9" "main 0.4.9"; do
        set -- $pair
        if version_older "$1" "$2"; then echo "older:$1<$2"; else echo "not:$1<$2"; fi
      done
    `);
    expect(res.stdout.trim().split("\n")).toEqual([
      "older:0.4.8<0.4.9",
      "not:0.4.10<0.4.9",
      "not:0.4.9<0.4.9",
      "older:0.3.12<0.4.0",
      "not:1.0.0<0.9.9",
      "not:0.4.9-beta.1<0.4.9",
      "not:main<0.4.9",
    ]);
  });

  test("versions sort by number, not by text", () => {
    const res = sourced(`printf 'v0.10.0\\nv0.9.1\\nv0.4.12\\nv1.0.0\\nv0.4.9\\n' | sort_versions`);
    expect(res.stdout.trim().split("\n")).toEqual([
      "v0.4.9",
      "v0.4.12",
      "v0.9.1",
      "v0.10.0",
      "v1.0.0",
    ]);
  });

  test("the newest stable release is read from the repository, and a fetch lands on it", () => {
    const origin = join(scratch, "origin");
    mkdirSync(origin);
    const git = (...args) =>
      execFileSync("git", ["-C", origin, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "maya@example.com",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "maya@example.com",
        },
      });
    git("init", "-q");
    for (const tag of ["v0.4.8", "v0.4.10", "v0.5.0-rc.1"]) {
      writeFileSync(join(origin, "release.txt"), `${tag}\n`);
      git("add", "release.txt");
      git("-c", "commit.gpgsign=false", "commit", "-q", "-m", tag);
      git("-c", "tag.gpgsign=false", "tag", tag);
    }
    const checkout = join(scratch, "checkout");
    const res = sourced(`
      REPO_URL="file://${origin}"
      REF="$(newest_stable_tag "$REPO_URL")"
      echo "ref:$REF"
      fetch_checkout "${checkout}"
      cat "${checkout}/release.txt"
    `);
    expect(res.status, res.output).toBe(0);
    expect(res.stdout).toContain("ref:v0.4.10");
    expect(readFileSync(join(checkout, "release.txt"), "utf8")).toBe("v0.4.10\n");
    expect(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(
      git("rev-parse", "v0.4.10"),
    );
  });

  test.skipIf(!LINUX)(
    "a path another account can change is named, and a root-owned one passes",
    () => {
      const open = join(scratch, "open-dir");
      mkdirSync(open);
      chmodSync(open, 0o777);
      const res = sourced(`
      if root_controlled /usr/bin/env; then echo "env:yes"; else echo "env:no:$UNSAFE_PATH"; fi
      if root_controlled "${open}"; then echo "open:yes"; else echo "open:no:$UNSAFE_PATH"; fi
    `);
      expect(res.status, res.output).toBe(0);
      expect(res.stdout).toContain(`open:no:${open}`);
      // /usr/bin is root's on every host this suite runs on.
      expect(res.stdout).toContain("env:yes");
    },
  );

  test("an earlier dedicated gateway's unit gives up its port and passphrase path", () => {
    const unit = join(scratch, "legacy.service");
    writeFileSync(
      unit,
      [
        "[Service]",
        "ExecStart=/home/maya/.local/bin/omnesis gateway serve",
        "LoadCredential=omnesis-keyring-passphrase:/home/maya/.config/omnesis/hardened-gateway.pass",
        'Environment="OMNESIS_GATEWAY_PORT=8443"',
        "",
      ].join("\n"),
    );
    const res = sourced(`
      UNIT_PATH="${unit}"
      read_legacy_unit
      echo "pass:$LEGACY_PASS"
      echo "port:$CONF_PORT"
    `);
    expect(res.status, res.output).toBe(0);
    expect(res.stdout).toContain("pass:/home/maya/.config/omnesis/hardened-gateway.pass");
    expect(res.stdout).toContain("port:8443");
  });

  test("the install record round-trips", () => {
    const etc = join(scratch, "etc");
    const res = sourced(`
      ETC_DIR="${etc}"
      INSTALL_ENV="${etc}/install.env"
      CONF_REPO_URL=https://github.com/omnesis-dev/Omnesis CONF_PORT=8443 CONF_KEYRING=passphrase
      write_install_env
      CONF_REPO_URL= CONF_PORT= CONF_KEYRING=
      read_install_env
      echo "$CONF_REPO_URL $CONF_PORT $CONF_KEYRING"
    `);
    expect(res.status, res.output).toBe(0);
    expect(res.stdout.trim()).toBe("https://github.com/omnesis-dev/Omnesis 8443 passphrase");
  });

  test.skipIf(!LINUX)(
    "switching moves current and previous, and pruning keeps just those two",
    () => {
      const root = join(scratch, "opt");
      const releases = join(root, "releases");
      for (const name of ["v0.4.8-aaaaaaaaaaaa", "v0.4.9-bbbbbbbbbbbb", "v0.4.10-cccccccccccc"]) {
        mkdirSync(join(releases, name), { recursive: true });
      }
      symlinkSync(join(releases, "v0.4.8-aaaaaaaaaaaa"), join(root, "current"));
      const res = sourced(`
      RELEASE_ROOT="${root}" RELEASES="${releases}" CURRENT="${root}/current" PREVIOUS="${root}/previous"
      switch_current "${releases}/v0.4.9-bbbbbbbbbbbb"
      switch_current "${releases}/v0.4.10-cccccccccccc"
      prune_releases
    `);
      expect(res.status, res.output).toBe(0);
      expect(readlinkSync(join(root, "current"))).toBe(join(releases, "v0.4.10-cccccccccccc"));
      expect(readlinkSync(join(root, "previous"))).toBe(join(releases, "v0.4.9-bbbbbbbbbbbb"));
      expect(existsSync(join(releases, "v0.4.8-aaaaaaaaaaaa"))).toBe(false);
      expect(existsSync(join(root, ".current-new"))).toBe(false);
    },
  );

  test.skipIf(!LINUX)(
    "a missing or dangling link names no release, so a first switch keeps no previous",
    () => {
      const root = join(scratch, "first-switch");
      const releases = join(root, "releases");
      mkdirSync(join(releases, "v0.4.9-bbbbbbbbbbbb"), { recursive: true });
      symlinkSync(join(releases, "gone"), join(root, "dangling"));
      // The last line is what a failed first update does: it puts back the
      // `previous` it read before switching.
      const res = sourced(`
      RELEASE_ROOT="${root}" RELEASES="${releases}" CURRENT="${root}/current" PREVIOUS="${root}/previous"
      printf 'missing=[%s] dangling=[%s]\\n' "$(link_target "$PREVIOUS")" "$(link_target "${root}/dangling")"
      update_previous="$(link_target "$PREVIOUS")"
      switch_current "${releases}/v0.4.9-bbbbbbbbbbbb"
      set_previous "$update_previous"
    `);
      expect(res.status, res.output).toBe(0);
      expect(res.stdout).toContain("missing=[] dangling=[]");
      expect(readlinkSync(join(root, "current"))).toBe(join(releases, "v0.4.9-bbbbbbbbbbbb"));
      expect(() => lstatSync(join(root, "previous"))).toThrow();
    },
  );
});

describe("hardened-gateway.sh guards around what root runs", () => {
  test.skipIf(!LINUX)("the hand-over takes only this script's own fetch directory", () => {
    const root = join(scratch, "guard-root");
    mkdirSync(join(root, ".fetch-42"), { recursive: true });
    const res = sourced(`
      RELEASE_ROOT="${root}"
      for path in /home/maya/checkout "${root}/.fetch-abc" "${root}/.fetch-12/../x" "${root}/.fetch-42"; do
        ( require_fetched_checkout "$path" ) 2>&1 | head -n 1
      done
    `);
    const lines = res.stdout.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(
      Array(3).fill(
        "error: --from-checkout takes only the directory this script fetched a release into.",
      ),
    );
    // The right shape, but not a directory root made and closed.
    expect(lines[3]).toContain("is not a directory root fetched a release into");
  });

  test.skipIf(IS_ROOT || !LINUX)(
    "a passphrase is copied only from a plain file, never through a link, a pipe or an oversized file",
    () => {
      const dir = join(scratch, "pass");
      mkdirSync(dir);
      writeFileSync(join(dir, "plain"), "a-fictional-passphrase\n");
      symlinkSync(join(dir, "plain"), join(dir, "link"));
      writeFileSync(join(dir, "huge"), "x".repeat(5000));
      execFileSync("mkfifo", [join(dir, "pipe")]);
      const res = sourced(`
        NODE_BIN="$(command -v node)"
        for name in plain link huge pipe; do
          if ( copy_passphrase "${dir}/$name" "${dir}/out-$name" ) >/dev/null 2>&1; then
            echo "copied:$name"
          else
            echo "refused:$name"
          fi
        done
        stat -c '%a' "${dir}/out-plain.tmp"
      `);
      expect(res.stdout.trim().split("\n")).toEqual([
        "copied:plain",
        "refused:link",
        "refused:huge",
        "refused:pipe",
        "600",
      ]);
      expect(readFileSync(join(dir, "out-plain.tmp"), "utf8")).toBe("a-fictional-passphrase\n");
    },
  );

  test("root's environment is reset before anything runs, keeping what the script reads", () => {
    const res = spawnSync(
      "sh",
      [
        "-c",
        `. "$SCRIPT"\nsanitize_environment\nprintf '%s|%s|%s|%s|%s|%s|%s\\n' "$PATH" "$HOME" "\${GIT_DIR:-unset}" "\${NODE_OPTIONS:-unset}" "\${OMNESIS_GIT_TOKEN:-unset}" "\${https_proxy:-unset}" "$GIT_CONFIG_GLOBAL"`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCRIPT: script,
          OMNESIS_HARDENED_SOURCE_ONLY: "1",
          HOME: "/home/maya",
          GIT_DIR: "/home/maya/elsewhere",
          NODE_OPTIONS: "--require /home/maya/preload.js",
          OMNESIS_GIT_TOKEN: "fictional-token",
          https_proxy: "http://proxy.example.com:3128",
        },
      },
    );
    expect(res.stdout.trim()).toBe(
      [
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/root",
        "unset",
        "unset",
        "fictional-token",
        "http://proxy.example.com:3128",
        "/dev/null",
      ].join("|"),
    );
  });
});
