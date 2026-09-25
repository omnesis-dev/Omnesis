// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The package channel of `install.sh`, driven against a fake npm so the
 * method-resolution rules are asserted without a registry: `--method package`
 * installs the published CLI, `--method auto` prefers it when the registry
 * actually serves the requested dist-tag, and falls back to a source checkout
 * when it does not.
 *
 * The registry round-trip against a real Verdaccio lives in
 * `.github/workflows/install-smoke.yml`; this file covers the decision.
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = join(repoRoot, "scripts", "install.sh");
const HAS_PTY = process.platform === "linux";
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const pathWithoutCodex = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => {
    if (entry.length === 0) return false;
    try {
      accessSync(join(entry, "codex"), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  })
  .join(delimiter);

/**
 * Stands in for npm. `view` answers whether the registry serves the package,
 * `prefix -g` names a writable prefix, and `install -g` drops an `omnesis`
 * binary there and records the exact spec it was asked for. `ci` is the source
 * path's build step.
 */
const FAKE_NPM = `#!/bin/sh
FAKE_EFFECTIVE_PREFIX="\${NPM_CONFIG_PREFIX:-$FAKE_NPM_PREFIX}"
case "$1" in
  view)
    mkdir -p "$FAKE_EFFECTIVE_PREFIX"
    printf '%s\\n' "$2" > "$FAKE_EFFECTIVE_PREFIX/viewed-spec"
    printf '%s\\n' "$*" > "$FAKE_EFFECTIVE_PREFIX/viewed-argv"
    if [ "$FAKE_NPM_HAS_PACKAGE" = 1 ]; then
      case "$2" in
        *"@latest"|*"@beta") echo 0.10.0 ;;
        *@*) printf '%s\\n' "\${2##*@}" ;;
      esac
      exit 0
    fi
    echo "npm error 404 no such package" >&2; exit 1 ;;
  prefix) printf '%s\\n' "$FAKE_EFFECTIVE_PREFIX"; exit 0 ;;
  install)
    if [ "$2" = "-g" ]; then
      if [ "\${FAKE_NPM_FAIL_INSTALL:-0}" = 1 ]; then exit 42; fi
      mkdir -p "$FAKE_EFFECTIVE_PREFIX/bin"
      mkdir -p "$FAKE_EFFECTIVE_PREFIX/lib/node_modules/omnesis/dist"
      printf '%s\\n' "$3" > "$FAKE_EFFECTIVE_PREFIX/installed-spec"
      printf '%s\\n' "$*" > "$FAKE_EFFECTIVE_PREFIX/installed-argv"
      case "$3" in
        *"@latest"|*"@beta") installed_version=0.10.0 ;;
        *@*) installed_version="\${3##*@}" ;;
      esac
      cat > "$FAKE_EFFECTIVE_PREFIX/lib/node_modules/omnesis/dist/index.js" <<EOF
#!/bin/sh
printf '%s\\n' "\\\${NPM_CONFIG_PREFIX:-}" > "$FAKE_EFFECTIVE_PREFIX/package-prefix-seen"
printf '%s\\n' "\\$*" > "$FAKE_EFFECTIVE_PREFIX/package-argv-seen"
printf '%s\\n' "\\$*" >> "$FAKE_EFFECTIVE_PREFIX/package-argv-log"
if [ "\\\${1:-}" = --version ]; then printf '%s\\n' "$installed_version"; fi
if [ "\\\${1:-}" = service ] && [ "\\\${2:-}" = restart ] && [ "\\\${3:-}" = "\\\${FAKE_SERVICE_RESTART_FAIL:-}" ]; then exit 45; fi
if [ "\\\${1:-}" = service ] && [ "\\\${2:-}" = status ]; then
  status_file="$FAKE_EFFECTIVE_PREFIX/package-status-count"
  status_count=0
  if [ -f "\\$status_file" ]; then status_count=\\$(cat "\\$status_file"); fi
  status_count=\\$((status_count + 1))
  printf '%s\\n' "\\$status_count" > "\\$status_file"
  status_state="\\\${FAKE_SERVICE_STATE:-running}"
  if [ -n "\\\${FAKE_SERVICE_FAIL_AFTER_STATUS:-}" ] && [ "\\$status_count" -gt "\\$FAKE_SERVICE_FAIL_AFTER_STATUS" ]; then status_state=failed; fi
  printf '%s\\n' "{\\"items\\":[{\\"component\\":\\"\\\${3:-}\\",\\"state\\":\\"\\$status_state\\"}]}"
fi
if [ "\\\${1:-}" = config ] && [ "\\\${2:-}" = get ]; then
  if [ -n "\\\${FAKE_AGENT_ASSIGNMENT:-}" ]; then
    printf '{"inference":{"assignments":{"agent":"%s"}}}' "\\$FAKE_AGENT_ASSIGNMENT"
  else
    printf '%s' '{}'
  fi
fi
if [ "\\\${1:-}" = codex ] && [ "\\\${2:-}" = refresh ]; then
  printf '%s' '{"type":"codex","configured":true,"status":"ok","loggedIn":true,"models":["gpt-5.6-luna"]}'
fi
if [ "\\\${1:-}" = codex ] && [ "\\\${3:-}" = --help ]; then
  case "\\\${2:-}" in
    login) printf '%s\\n' '  --wait    Wait for device login and verify the live model catalog' ;;
    setup-agent) printf '%s\\n' 'USAGE setup-agent [OPTIONS] <MODEL>' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "\\\${1:-}" = codex ] && [ "\\\${2:-}" = setup-agent ]; then
  printf '%s\\n' "\\\${3:-}" > "$FAKE_EFFECTIVE_PREFIX/codex-setup-model"
fi
exit 0
EOF
      chmod +x "$FAKE_EFFECTIVE_PREFIX/lib/node_modules/omnesis/dist/index.js"
      rm -f "$FAKE_EFFECTIVE_PREFIX/bin/omnesis"
      ln -s "$FAKE_EFFECTIVE_PREFIX/lib/node_modules/omnesis/dist/index.js" "$FAKE_EFFECTIVE_PREFIX/bin/omnesis"
    fi
    exit 0 ;;
  ci)
    mkdir -p node_modules/.bin
    printf '#!/bin/sh\\necho source-version\\n' > node_modules/.bin/tsx
    chmod +x node_modules/.bin/tsx
    exit 0 ;;
esac
exit 0
`;

let fixture;

function git(...args) {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
}

function install(
  args,
  name,
  {
    hasPackage = true,
    clientOnly = true,
    failPackageInstall = false,
    failGit = false,
    failHealth = false,
    healthVersion = "0.10.0",
    failServiceRestart = "",
    serviceState = "running",
    serviceFailAfterStatus = "",
    prefixAtLocal = false,
    prefixOverride = null,
    preexistingLocalPackageVersion = null,
    preexistingLocalPackageRootSymlink = false,
    preexistingLocalNodeModulesSymlink = false,
    prefixBinSymlink = false,
    prefixModulesSymlink = false,
    prefixPackageRootSymlink = false,
    ttyAnswers = null,
    codexInstalled = false,
    agentAssignment = "",
  } = {},
) {
  const home = join(fixture, `home-${name}`);
  const prefix =
    prefixOverride ?? (prefixAtLocal ? join(home, ".local") : join(fixture, `prefix-${name}`));
  const source = join(fixture, `checkout-${name}`);
  mkdirSync(prefix, { recursive: true });
  if (prefixBinSymlink) {
    const outsideBin = join(fixture, `outside-bin-${name}`);
    mkdirSync(outsideBin);
    symlinkSync(outsideBin, join(prefix, "bin"));
  } else {
    mkdirSync(join(prefix, "bin"), { recursive: true });
  }
  if (prefixModulesSymlink) {
    const outsideModules = join(fixture, `outside-fresh-modules-${name}`);
    mkdirSync(join(prefix, "lib"), { recursive: true });
    mkdirSync(outsideModules);
    symlinkSync(outsideModules, join(prefix, "lib", "node_modules"));
  }
  if (prefixPackageRootSymlink) {
    const outsidePackage = join(fixture, `outside-fresh-package-${name}`);
    mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
    mkdirSync(outsidePackage);
    symlinkSync(outsidePackage, join(prefix, "lib", "node_modules", "omnesis"));
  }
  mkdirSync(home, { recursive: true });
  if (codexInstalled) {
    writeFileSync(join(fixture, "fake-bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  if (preexistingLocalPackageVersion !== null) {
    const modulesRoot = preexistingLocalNodeModulesSymlink
      ? join(fixture, `outside-modules-${name}`)
      : join(prefix, "lib", "node_modules");
    if (preexistingLocalNodeModulesSymlink) {
      mkdirSync(join(prefix, "lib"), { recursive: true });
      symlinkSync(modulesRoot, join(prefix, "lib", "node_modules"));
    }
    const packageRoot = preexistingLocalPackageRootSymlink
      ? join(fixture, `outside-package-${name}`)
      : join(modulesRoot, "omnesis");
    if (preexistingLocalPackageRootSymlink) {
      mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
      symlinkSync(packageRoot, join(prefix, "lib", "node_modules", "omnesis"));
    }
    const target = join(packageRoot, "dist", "index.js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `#!/bin/sh\nif [ "\${1:-}" = --version ]; then printf '%s\\n' '${preexistingLocalPackageVersion}'; fi\n`,
      { mode: 0o755 },
    );
    symlinkSync(target, join(prefix, "bin", "omnesis"));
  }
  const argv = [
    installer,
    ...(clientOnly ? ["--client-only"] : ["--no-tls", "--no-model"]),
    "--no-keyring",
    "--source-dir",
    source,
    ...args,
  ];
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${join(fixture, "fake-bin")}:${pathWithoutCodex}`,
    OMNESIS_REPO_URL: fixture,
    OMNESIS_KEYRING_PASSPHRASE_FILE: "",
    FAKE_NPM_PREFIX: prefix,
    FAKE_NPM_HAS_PACKAGE: hasPackage ? "1" : "0",
    FAKE_NPM_FAIL_INSTALL: failPackageInstall ? "1" : "0",
    FAKE_GIT_FAIL: failGit ? "1" : "0",
    FAKE_GIT_CALLED_FILE: join(home, "git-called"),
    FAKE_HEALTH_FAIL: failHealth ? "1" : "0",
    FAKE_HEALTH_VERSION: healthVersion,
    FAKE_SERVICE_RESTART_FAIL: failServiceRestart,
    FAKE_SERVICE_STATE: serviceState,
    FAKE_SERVICE_FAIL_AFTER_STATUS: serviceFailAfterStatus,
    FAKE_AGENT_ASSIGNMENT: agentAssignment,
    FAKE_CURL_LOG: join(home, "curl-argv-log"),
    OMNESIS_GATEWAY_WAIT_SECONDS: "1",
  };
  const result =
    ttyAnswers === null
      ? spawnSync("sh", argv, {
          env,
          encoding: "utf8",
          detached: true,
        })
      : spawnSync(
          "script",
          [
            "-qec",
            ["sh", ...argv].map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "),
            "/dev/null",
          ],
          {
            env,
            input: ttyAnswers.map((answer) => `${answer}\n`).join(""),
            encoding: "utf8",
          },
        );
  const fallbackPrefix = join(home, ".npm-global");
  const installedPrefix = existsSync(join(fallbackPrefix, "bin", "omnesis"))
    ? fallbackPrefix
    : prefix;
  return {
    ...result,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    prefix: installedPrefix,
    source,
  };
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").trim() : null);

function sourceThenPackage(name, packageArgs = ["--replace-source-wrapper"]) {
  const source = install(["--method", "source"], name, { clientOnly: false });
  expect(source.status, source.stderr).toBe(0);
  const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
  const sourceLauncher = readFileSync(wrapper, "utf8");
  const packaged = install(["--method", "package", ...packageArgs], name, {
    clientOnly: false,
  });
  return { source, packaged, wrapper, sourceLauncher };
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "omnesis-package-installer-"));
  git("init", "-b", "main");
  git("config", "user.name", "omnesis-test");
  git("config", "user.email", "release@example.com");
  mkdirSync(join(fixture, "packages", "cli"), { recursive: true });
  writeFileSync(join(fixture, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(fixture, "packages/cli/package.json"),
    `${JSON.stringify({ version: "0.10.0" })}\n`,
  );
  git("add", ".");
  git("commit", "-m", "0.10.0");
  git("tag", "v0.10.0");

  const fakeBin = join(fixture, "fake-bin");
  mkdirSync(fakeBin);
  symlinkSync(process.execPath, join(fakeBin, "node"));
  writeFileSync(join(fakeBin, "npm"), FAKE_NPM);
  chmodSync(join(fakeBin, "npm"), 0o755);
  writeFileSync(
    join(fakeBin, "git"),
    `#!/bin/sh\nif [ "\${FAKE_GIT_FAIL:-0}" = 1 ]; then : > "$FAKE_GIT_CALLED_FILE"; exit 99; fi\nexec '${realGit.replaceAll("'", `'\\''`)}' "$@"\n`,
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  writeFileSync(
    join(fakeBin, "curl"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_CURL_LOG"\n[ "${FAKE_HEALTH_FAIL:-0}" != 1 ] || exit 1\nprintf \'{"version":"%s"}\\n\' "${FAKE_HEALTH_VERSION:-0.10.0}"\n',
  );
  chmodSync(join(fakeBin, "curl"), 0o755);
  writeFileSync(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "sleep"), 0o755);
  // A host systemd does not supervise, so a terminal run is never offered the
  // dedicated gateway account whatever machine runs this suite.
  writeFileSync(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fakeBin, "systemctl"), 0o755);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe("install.sh package channel", () => {
  test("--method package installs the CLI from the registry and makes no checkout", () => {
    const result = install(["--method", "package"], "package");
    expect(result.status).toBe(0);
    expect(read(join(result.prefix, "installed-spec"))).toBe("omnesis@latest");
    expect(existsSync(join(result.source, ".git"))).toBe(false);
    const wrapper = join(fixture, "home-package", ".local", "bin", "omnesis");
    expect(readFileSync(wrapper, "utf8")).toContain(
      `exec '${join(result.prefix, "bin", "omnesis")}'`,
    );
  });

  test("--method package never requires git", () => {
    const result = install(["--method", "package"], "package-no-git", { failGit: true });
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(fixture, "home-package-no-git", "git-called"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("a native package install can enable the Codex agent", () => {
    const result = install(["--method", "package"], "package-codex", {
      clientOnly: false,
      ttyAnswers: ["y"],
      codexInstalled: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(read(join(result.prefix, "codex-setup-model"))).toBe("gpt-5.6-luna");
    expect(read(join(result.prefix, "package-argv-log"))).toContain(
      "codex setup-agent gpt-5.6-luna",
    );
  });

  test.skipIf(!HAS_PTY)("a package install preserves an existing agent assignment", () => {
    const result = install(["--method", "package"], "package-codex-assigned", {
      clientOnly: false,
      ttyAnswers: [],
      codexInstalled: true,
      agentAssignment: "local/fictional-agent-model",
    });

    expect(result.status, result.output).toBe(0);
    expect(read(join(result.prefix, "package-argv-log"))).not.toContain("codex refresh");
    expect(existsSync(join(result.prefix, "codex-setup-model"))).toBe(false);
  });

  test("package reruns restart both services from the installed build", () => {
    const name = "package-rerun";
    const first = install(["--method", "package"], name, { clientOnly: false });
    expect(first.status, first.output).toBe(0);
    const second = install(["--method", "package"], name, { clientOnly: false });
    expect(second.status, second.output).toBe(0);
    const invocations = read(join(second.prefix, "package-argv-log"));
    expect(invocations.match(/service restart gateway/gu)).toHaveLength(2);
    expect(invocations.match(/service restart collector/gu)).toHaveLength(2);
    expect(second.output).toContain("Gateway is healthy");
  });

  test("a package rerun keeps the verified launcher prefix when npm defaults change", () => {
    const name = "package-prefix-change";
    const firstPrefix = join(fixture, "package-prefix-a");
    const secondPrefix = join(fixture, "package-prefix-b");
    const first = install(["--method", "package"], name, {
      prefixOverride: firstPrefix,
    });
    expect(first.status, first.output).toBe(0);
    const second = install(["--method", "package", "--version", "0.9.0"], name, {
      prefixOverride: secondPrefix,
    });
    expect(second.status, second.output).toBe(0);
    expect(read(join(firstPrefix, "installed-spec")), second.output).toBe("omnesis@0.9.0");
    expect(existsSync(join(secondPrefix, "installed-spec"))).toBe(false);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    expect(spawnSync(wrapper, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.9.0");
  });

  test("a package rerun probes the saved gateway port and bind address", () => {
    const name = "package-listener";
    const first = install(["--method", "package", "--port", "17600"], name, {
      clientOnly: false,
    });
    expect(first.status, first.output).toBe(0);
    writeFileSync(
      join(fixture, `home-${name}`, ".config", "omnesis", ".env"),
      "OMNESIS_GATEWAY_PORT=17600\nOMNESIS_GATEWAY_PORT=17601\n" +
        "OMNESIS_BIND=192.0.2.10\nOMNESIS_BIND=192.0.2.11\n",
    );
    const second = install(["--method", "package"], name, { clientOnly: false });
    expect(second.status, second.output).toBe(0);
    expect(read(join(fixture, `home-${name}`, "curl-argv-log"))).toContain(
      "https://192.0.2.10:17600/health",
    );
  });

  test("exact-version health cannot mask a gateway that leaves supervision", () => {
    const name = "package-post-health-status";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.output).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      serviceFailAfterStatus: "2",
    });
    const packageLog = read(join(packaged.prefix, "package-argv-log"));
    expect(
      read(join(packaged.prefix, "package-status-count")),
      `${packaged.output}\n${packageLog}`,
    ).toBe("3");
    expect(packaged.status).not.toBe(0);
    expect(packaged.output).toContain("stopped being supervised after its health response");
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(read(join(packaged.prefix, "package-argv-log"))).not.toContain(
      "service restart collector",
    );
  });

  test("a package rerun does not accept a stale gateway version as healthy", () => {
    const name = "package-rerun-stale";
    const first = install(["--method", "package"], name, { clientOnly: false });
    expect(first.status, first.output).toBe(0);
    const stale = install(["--method", "package", "--version", "0.9.0"], name, {
      clientOnly: false,
      healthVersion: "0.10.0",
    });
    expect(stale.output).toContain("Gateway did not answer /health");
    expect(stale.output).not.toContain("Gateway is healthy");
    // A gateway answering as another version is up, not starting: the installer
    // says which build answered and stops, instead of sitting through the whole
    // startup window waiting for a version that is not coming.
    expect(stale.output).toContain("it is serving an older build");
    expect(stale.output).not.toContain("still starting");
  });

  test("--channel beta tracks the beta dist-tag", () => {
    const result = install(["--method", "package", "--channel", "beta"], "beta");
    expect(read(join(result.prefix, "installed-spec"))).toBe("omnesis@beta");
  });

  test("--version pins the exact published version", () => {
    const result = install(["--method", "package", "--version", "0.9.0"], "pinned");
    expect(read(join(result.prefix, "installed-spec"))).toBe("omnesis@0.9.0");
  });

  test("--registry is shared by package lookup and install", () => {
    const registry = "https://registry.example.org/omnesis/";
    const result = install(["--method", "auto", "--registry", registry], "registry");
    expect(result.status).toBe(0);
    expect(read(join(result.prefix, "viewed-argv"))).toBe(
      `view omnesis@latest version --fetch-retries 0 --fetch-timeout 10000 --registry ${registry}`,
    );
    expect(read(join(result.prefix, "installed-argv"))).toBe(
      `install -g omnesis@latest --registry ${registry}`,
    );
  });

  test("--method auto installs the package when the registry serves it", () => {
    const result = install(["--method", "auto"], "auto-hit");
    expect(result.status).toBe(0);
    expect(read(join(result.prefix, "viewed-spec"))).toBe("omnesis@latest");
    expect(read(join(result.prefix, "installed-spec"))).toBe("omnesis@latest");
    expect(existsSync(join(result.source, ".git"))).toBe(false);
  });

  test("--method auto falls back to a source checkout when the registry has nothing", () => {
    const result = install(["--method", "auto"], "auto-miss", { hasPackage: false });
    expect(result.status).toBe(0);
    expect(read(join(result.prefix, "installed-spec"))).toBeNull();
    expect(
      execFileSync("git", ["describe", "--tags", "--exact-match"], {
        cwd: result.source,
        encoding: "utf8",
      }).trim(),
    ).toBe("v0.10.0");
  });

  test("--method auto never resolves to a package for an edge install", () => {
    const result = install(["--method", "auto", "--edge"], "auto-edge");
    expect(result.status).toBe(0);
    expect(read(join(result.prefix, "installed-spec"))).toBeNull();
    expect(existsSync(join(result.source, ".git"))).toBe(true);
  });

  test("an unknown channel is refused", () => {
    const result = install(["--method", "package", "--channel", "nightly"], "bad-channel");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown --channel");
  });

  test("a malformed --version is refused before anything is installed", () => {
    const result = install(["--method", "package", "--version", "1.2"], "bad-version");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid --version");
    expect(read(join(result.prefix, "installed-spec"))).toBeNull();
  });

  // A dist-tag and a registry name a published package. Honoring them on a
  // source install is impossible, and ignoring them would install something
  // other than what was asked for.
  test("--channel and --registry are refused on a source install", () => {
    const channel = install(["--method", "source", "--channel", "beta"], "source-channel");
    expect(channel.status).toBe(1);
    expect(channel.stderr).toContain("needs --method package");

    const registry = install(
      ["--method", "source", "--registry", "http://localhost:4873"],
      "source-registry",
    );
    expect(registry.status).toBe(1);
    expect(registry.stderr).toContain("needs --method package");
  });

  test("--method auto refuses to fall back to source when beta was asked for", () => {
    const result = install(["--method", "auto", "--channel", "beta"], "auto-beta", {
      hasPackage: false,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a source install has no beta channel");
    expect(existsSync(join(result.source, ".git"))).toBe(false);
  });
});

describe("install.sh package launcher transition", () => {
  test("a symlinked package root cannot claim the reserved launcher path", () => {
    const name = "symlinked-package-root";
    const result = install(["--method", "package"], name, {
      prefixAtLocal: true,
      preexistingLocalPackageVersion: "0.10.0",
      preexistingLocalPackageRootSymlink: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("contains a symlink or non-directory package path");
  });

  test("a symlinked modules directory cannot claim the reserved launcher path", () => {
    const name = "symlinked-modules-root";
    const result = install(["--method", "package"], name, {
      prefixAtLocal: true,
      preexistingLocalPackageVersion: "0.10.0",
      preexistingLocalNodeModulesSymlink: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("contains a symlink or non-directory package path");
  });

  test.each([
    ["bin", { prefixBinSymlink: true }],
    ["node_modules", { prefixModulesSymlink: true }],
    ["package root", { prefixPackageRootSymlink: true }],
  ])("refuses a fresh package prefix with a symlinked %s directory", (_label, options) => {
    const result = install(["--method", "package"], `fresh-symlink-${_label}`, options);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("contains a symlink or non-directory package path");
    expect(existsSync(join(result.prefix, "installed-spec"))).toBe(false);
  });

  test("an explicit non-interactive opt-in replaces an authentic source launcher", () => {
    const { packaged, wrapper, sourceLauncher, source } = sourceThenPackage("replace");

    expect(packaged.status, packaged.stderr).toBe(0);
    const packageLauncher = readFileSync(wrapper, "utf8");
    expect(packageLauncher).not.toBe(sourceLauncher);
    expect(packageLauncher).toContain(`NPM_CONFIG_PREFIX='${packaged.prefix}'`);
    expect(packageLauncher).toContain(`exec '${join(packaged.prefix, "bin", "omnesis")}' "$@"`);
    expect(packaged.output).toContain("Replaced the source launcher");
    expect(existsSync(join(source.source, ".git"))).toBe(true);

    const invoked = spawnSync(wrapper, ["update", "--yes"], {
      env: { ...process.env, NPM_CONFIG_PREFIX: "" },
      encoding: "utf8",
    });
    expect(invoked.status).toBe(0);
    expect(read(join(packaged.prefix, "package-prefix-seen"))).toBe(packaged.prefix);
    expect(read(join(packaged.prefix, "package-argv-seen"))).toBe("update --yes");
  });

  test.skipIf(!HAS_PTY)("an interactive install offers and accepts launcher replacement", () => {
    const name = "interactive";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package"], name, {
      clientOnly: false,
      ttyAnswers: ["y"],
    });
    expect(packaged.status, packaged.stderr).toBe(0);
    expect(packaged.output).toContain("Replace");
    expect(packaged.output).toContain("[y/N]");
    expect(readFileSync(wrapper, "utf8")).not.toBe(sourceLauncher);
  });

  test("a non-interactive package install retains the source launcher by default", () => {
    const { packaged, wrapper, sourceLauncher } = sourceThenPackage("retain", []);

    expect(packaged.status, packaged.stderr).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("non-interactive run did not authorize replacing it");
    expect(packaged.output).toContain("--replace-source-wrapper");
  });

  test("replacement discovers a custom source root from durable installer state", () => {
    const name = "custom-source-state";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const unrelated = join(fixture, "unrelated-source-argument");

    const packaged = install(
      ["--method", "package", "--replace-source-wrapper", "--source-dir", unrelated],
      name,
      { clientOnly: false },
    );
    expect(packaged.status, packaged.output).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain(`NPM_CONFIG_PREFIX='${packaged.prefix}'`);
  });

  test("replacement explicitly restarts package-backed gateway and collector services", () => {
    const { packaged } = sourceThenPackage("service-restart-proof");

    expect(packaged.status, packaged.stderr).toBe(0);
    const invocations = read(join(packaged.prefix, "package-argv-log"));
    expect(invocations).toContain("service restart gateway");
    expect(invocations).toContain("service restart collector");
  });

  test("restart success does not count when the package service stops immediately", () => {
    const name = "service-stops";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      serviceState: "failed",
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("did not remain running");
  });

  test("an explicitly requested replacement fails when the package gateway cannot restart", () => {
    const name = "restart-failure";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      failServiceRestart: "gateway",
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("package-backed service was not verified");
  });

  test("an explicitly requested replacement fails when the package gateway is unhealthy", () => {
    const name = "health-failure";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      failHealth: true,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("package-backed service was not verified");
  });

  test("an explicitly requested replacement rejects a stale gateway version", () => {
    const name = "stale-health-version";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      healthVersion: "0.9.0",
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("package-backed service was not verified");
  });

  test("an arbitrary executable at the launcher path is never overwritten", () => {
    const name = "arbitrary";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const arbitrary = "#!/bin/sh\necho operator-owned\n";
    writeFileSync(wrapper, arbitrary);
    chmodSync(wrapper, 0o755);

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(arbitrary);
    expect(packaged.output).toContain("not the exact installer-owned launcher");
  });

  test("a symlink at the launcher path and its target are never overwritten", () => {
    const name = "symlink";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const target = join(fixture, "operator-owned-command");
    const targetBody = "#!/bin/sh\necho operator-owned\n";
    writeFileSync(target, targetBody);
    chmodSync(target, 0o755);
    rmSync(wrapper);
    symlinkSync(target, wrapper);

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(targetBody);
    expect(readFileSync(wrapper, "utf8")).toBe(targetBody);
    expect(packaged.output).toContain("not the exact installer-owned launcher");
  });

  test("a source state naming another root prevents replacement", () => {
    const name = "wrong-root";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");
    const statePath = join(fixture, `home-${name}`, ".config", "omnesis", "update-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, `${JSON.stringify({ ...state, rootDir: join(fixture, "other") })}\n`);

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("not the exact installer-owned launcher");
  });

  test("a failed package install leaves the authentic source launcher intact", () => {
    const name = "failed-package";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      failPackageInstall: true,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
  });

  test("an npm prefix at ~/.local falls back before touching the source launcher", () => {
    const name = "colliding-prefix";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      prefixAtLocal: true,
    });
    expect(packaged.status, packaged.output).toBe(0);
    expect(packaged.prefix).toBe(join(fixture, `home-${name}`, ".npm-global"));
    expect(readFileSync(wrapper, "utf8")).toContain(`NPM_CONFIG_PREFIX='${packaged.prefix}'`);
    expect(packaged.output).toContain("shares the reserved source-launcher path");
  });

  test("a first package install preserves ~/.local as a no-clobber front door", () => {
    const name = "first-colliding-prefix";
    const result = install(["--method", "package"], name, { prefixAtLocal: true });
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    expect(result.status, result.output).toBe(0);
    expect(result.prefix).toBe(join(fixture, `home-${name}`, ".npm-global"));
    expect(readFileSync(wrapper, "utf8")).toContain(`NPM_CONFIG_PREFIX='${result.prefix}'`);
  });

  test("an existing npm-owned ~/.local binary updates in its configured prefix", () => {
    const name = "existing-local-package";
    const result = install(["--method", "package"], name, {
      prefixAtLocal: true,
      preexistingLocalPackageVersion: "0.9.0",
    });
    const prefix = join(fixture, `home-${name}`, ".local");
    const wrapper = join(prefix, "bin", "omnesis");
    expect(result.status, result.output).toBe(0);
    expect(result.prefix).toBe(prefix);
    expect(read(join(prefix, "installed-spec"))).toBe("omnesis@latest");
    expect(execFileSync(wrapper, ["--version"], { encoding: "utf8" }).trim()).toBe("0.10.0");
    expect(result.output).not.toContain("reserved source-launcher path");
  });

  test("a colliding prefix and failed install preserve an arbitrary launcher", () => {
    const name = "colliding-prefix-failure";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const arbitrary = "#!/bin/sh\necho operator-owned\n";
    writeFileSync(wrapper, arbitrary, { mode: 0o755 });

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name, {
      clientOnly: false,
      failPackageInstall: true,
      prefixAtLocal: true,
    });
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(arbitrary);
  });

  test("client-only cannot replace a launcher that may still anchor source services", () => {
    const name = "client-only";
    const source = install(["--method", "source"], name, { clientOnly: false });
    expect(source.status, source.stderr).toBe(0);
    const wrapper = join(fixture, `home-${name}`, ".local", "bin", "omnesis");
    const sourceLauncher = readFileSync(wrapper, "utf8");

    const packaged = install(["--method", "package", "--replace-source-wrapper"], name);
    expect(packaged.status).not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toBe(sourceLauncher);
    expect(packaged.output).toContain("did not verify a replacement service");
    expect(packaged.output).toContain("migrate-to-package");
    expect(packaged.output).toContain("--replace-source-wrapper was requested");
  });
});
