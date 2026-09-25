// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The rig every `install-sh-*.test.mjs` that RUNS the installer shares.
 *
 * `scripts/install.sh` is driven for real; only the world around it is faked —
 * a local git remote carrying release tags (reached through `OMNESIS_REPO_URL`),
 * an `npm` that plants a recording CLI shim instead of installing anything,
 * and a `curl` whose exit code the test decides. The seam is the shim: a source
 * install always runs the CLI through `<checkout>/node_modules/.bin/tsx`, so a
 * recorder written there sees every command the installer issues, with its
 * arguments.
 *
 * Two run modes:
 *   - `runInstaller` gives the script no controlling terminal (`detached`), so
 *     it exercises what a systemd unit or a container build sees.
 *   - `runInstallerOnTty` runs it under `script(1)` and feeds the prompts.
 *
 * Each suite calls `createFixture` in `beforeEach` and `destroyFixture` in
 * `afterEach`, then plants whatever else it needs under `fixturePath()`.
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
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const installer = join(repoRoot, "scripts", "install.sh");
const HOST_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

/**
 * `script(1)` supplies the pseudo-terminal the prompt tests answer on. Its
 * flags differ on macOS, so those assertions run on Linux — where they are a
 * hard requirement, not a convenience: a missing `script` there would silently
 * take the whole prompt suite out of CI, so it fails loudly instead.
 */
export const HAS_PTY = process.platform === "linux";
if (HAS_PTY && spawnSync("script", ["-qec", "true", "/dev/null"]).status !== 0) {
  throw new Error("script(1) is required to drive the installer's prompts on Linux.");
}

/** The temp directory holding the current fixture, or "" between tests. */
let fixture = "";

/** Where the current fixture lives; suites plant their own files under it. */
export function fixturePath(...parts) {
  return join(fixture, ...parts);
}

export function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function git(...args) {
  // A global commit.gpgsign or core.hooksPath would otherwise decide whether
  // this fixture can be built at all.
  return execFileSync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/**
 * Commit `packages/cli/package.json` at `version` and tag it. The installer
 * refuses a tag whose CLI manifest disagrees with the tag name, so the two
 * always move together.
 */
export function tagRelease(version) {
  mkdirSync(join(fixture, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(fixture, "packages", "cli", "package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  git("add", ".");
  git("commit", "-m", version);
  git("tag", `v${version}`);
}

/**
 * Build a fixture: a git remote with the given release tags, and a fake-bin
 * holding `npm`, `curl`, `tailscale` and `systemctl`. `cliShim` is the recorder planted as
 * `node_modules/.bin/tsx` by the fake `npm ci`; a suite passes its own, since
 * what the shim has to answer differs per role.
 */
export function createFixture({ name, versions, cliShim }) {
  fixture = mkdtempSync(join(tmpdir(), `omnesis-installer-${name}-`));
  git("init", "-b", "main");
  git("config", "user.name", "omnesis-test");
  git("config", "user.email", "release@example.com");
  writeFileSync(join(fixture, ".gitignore"), "node_modules/\n");
  for (const version of versions) tagRelease(version);

  const fakeBin = join(fixture, "fake-bin");
  mkdirSync(fakeBin);
  // The machine's real `sudo` must never be reachable from a test: a run that
  // asks for it would prompt the developer for a password, or worse, succeed.
  // This one refuses the way a machine without sudo rights does; a suite that
  // means to exercise a privileged step plants `installFakeSudo()` over it.
  writeExecutable(
    join(fakeBin, "sudo"),
    `#!/bin/sh
printf 'sudo refused %s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
echo "sudo: a password is required" >&2
exit 1
`,
  );
  writeFileSync(join(fixture, "cli-shim.sh"), cliShim);
  chmodSync(join(fixture, "cli-shim.sh"), 0o755);
  // `npm ci` plants the recording shim where the wrapper will look for tsx.
  // OMNESIS_TEST_NPM_CI_FAILURES=<n> makes the first n `npm ci` runs fail the
  // way a dropped download or a busy install-script binary does, with exit
  // status OMNESIS_TEST_NPM_CI_EXIT (1 by default; 137 is the kernel's kill).
  // OMNESIS_TEST_NPM_BUILD_EXIT makes `npm run build` exit with that status.
  // OMNESIS_TEST_NPM_BUILD_FAILURES=<n> fails the first n builds the way an
  // interrupted earlier run does: a tree npm ci accepted, missing the
  // declaration files its packages ship.
  writeExecutable(
    join(fakeBin, "npm"),
    `#!/bin/sh
if [ "$1" = ci ]; then
  printf 'npm ci\\n' >> "$OMNESIS_TEST_CALLS"
  if [ -n "\${OMNESIS_TEST_RECORD_NETWORK_ENV:-}" ]; then
    printf 'network env git-limit=%s git-time=%s npm-retries=%s npm-timeout=%s\\n' \
      "\${GIT_HTTP_LOW_SPEED_LIMIT:-}" "\${GIT_HTTP_LOW_SPEED_TIME:-}" \
      "\${NPM_CONFIG_FETCH_RETRIES:-}" "\${NPM_CONFIG_FETCH_TIMEOUT:-}" >> "$OMNESIS_TEST_CALLS"
  fi
  count_file="$OMNESIS_TEST_CALLS.npm-ci-count"
  count=$(cat "$count_file" 2>/dev/null || echo 0)
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -le "\${OMNESIS_TEST_NPM_CI_FAILURES:-0}" ]; then
    # A real npm ci that dies part-way (an install script killed by the
    # kernel, or one that crashes mid-write) leaves a partial tree behind,
    # and that tree is what a second npm ci does not fully replace. The
    # marker stands in for it: a test can then tell a retry that cleared the
    # tree from one that re-entered it.
    mkdir -p node_modules
    printf 'partial\\n' > node_modules/.omnesis-partial-tree
    echo "npm error code ECONNRESET" >&2
    exit "\${OMNESIS_TEST_NPM_CI_EXIT:-1}"
  fi
  mkdir -p node_modules/.bin
  cp "${join(fixture, "cli-shim.sh")}" node_modules/.bin/tsx
  chmod +x node_modules/.bin/tsx
fi
if [ "$1" = run ] && [ "$2" = build ]; then
  printf 'build NODE_OPTIONS=%s\\n' "\${NODE_OPTIONS:-}" >> "$OMNESIS_TEST_CALLS"
  [ -z "\${OMNESIS_TEST_NPM_BUILD_EXIT:-}" ] || exit "$OMNESIS_TEST_NPM_BUILD_EXIT"
  build_count_file="$OMNESIS_TEST_CALLS.npm-build-count"
  build_count=$(cat "$build_count_file" 2>/dev/null || echo 0)
  build_count=$((build_count + 1))
  printf '%s' "$build_count" > "$build_count_file"
  if [ "$build_count" -le "\${OMNESIS_TEST_NPM_BUILD_FAILURES:-0}" ]; then
    # What an interrupted earlier run leaves: npm ci was content with the tree,
    # and the build fails on a package missing the files its tarball ships.
    echo "error TS7016: Could not find a declaration file for module 'usearch'." >&2
    exit 2
  fi
fi
exit 0
`,
  );
  // No gateway is ever started here, so `curl` decides whether /health answers.
  // OMNESIS_TEST_HEALTH_BODY is what a successful /health answers, for runs that check the version.
  // OMNESIS_TEST_CURL_FAIL_TIMES makes the first n calls fail the way a gateway
  // that has not finished starting does, before the answer below.
  writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
count_file="$OMNESIS_TEST_CALLS.curl-count"
count=$(cat "$count_file" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [ "$count" -le "\${OMNESIS_TEST_CURL_FAIL_TIMES:-0}" ]; then
  exit "\${OMNESIS_TEST_CURL_FAIL_EXIT:-7}"
fi
[ -z "\${OMNESIS_TEST_HEALTH_BODY:-}" ] || printf '%s' "$OMNESIS_TEST_HEALTH_BODY"
exit "\${OMNESIS_TEST_CURL_EXIT:-0}"
`,
  );
  // `sync` records what the installer asked the filesystem to flush. The real
  // one has nothing observable to do against these fakes, and the installer
  // calls it for every file a power cut used to leave empty.
  writeExecutable(
    join(fakeBin, "sync"),
    `#!/bin/sh
printf 'sync %s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
exit 0
`,
  );
  installAbsentTailscale();
  installAbsentSystemd();
  installResolvingNames();
  return fixture;
}

/**
 * A `getent` that resolves every name, so which address an install records never
 * depends on whether the machine running the suite resolves `.local` names.
 * Planted by default.
 */
export function installResolvingNames() {
  writeExecutable(
    join(fixture, "fake-bin", "getent"),
    `#!/bin/sh
[ "$1" = hosts ] || exit 2
printf '192.0.2.250\\t%s\\n' "$2"
`,
  );
}

/** A `getent` like a stock Linux server's: no `.local` name resolves, others do. */
export function installUnresolvableLocalNames() {
  writeExecutable(
    join(fixture, "fake-bin", "getent"),
    `#!/bin/sh
[ "$1" = hosts ] || exit 2
case "$2" in *.local) exit 2 ;; esac
printf '192.0.2.250\\t%s\\n' "$2"
`,
  );
}

export function destroyFixture() {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = "";
}

/**
 * A `systemctl` that answers like a host systemd does not supervise, so a
 * run's offer of a dedicated gateway account never depends on the machine the
 * test happens to run on. Planted by default.
 */
export function installAbsentSystemd() {
  writeExecutable(join(fixture, "fake-bin", "systemctl"), "#!/bin/sh\nexit 1\n");
}

/**
 * A `systemctl` that answers like a systemd host, optionally one with a
 * dedicated-account gateway unit installed. The installer also looks
 * for `/run/systemd/system`, which no fake on PATH can supply, so a suite
 * relying on this skips itself on a machine without one.
 */
export function installSystemd({ dedicatedGateway = false } = {}) {
  const unitListing = dedicatedGateway
    ? 'if [ "$1" = --system ] && [ "$2" = list-unit-files ]; then echo "omnesis-gateway.service enabled enabled"; fi\n'
    : "";
  writeExecutable(
    join(fixture, "fake-bin", "systemctl"),
    `#!/bin/sh\n[ "$1" = --version ] && echo "systemd 255 (fake)"\n${unitListing}exit 0\n`,
  );
}

/**
 * A fake `tailscale` that reports the given MagicDNS name and mints certs.
 *
 * `certPem`, when given, is what `tailscale cert` writes — a run that means to
 * exercise what the installer does with the provisioned certificate needs a
 * real one there rather than an empty file.
 */
export function installFakeTailscale(dnsName, certPem = "") {
  const certSource = join(fixture, "fake-tailscale-cert.pem");
  writeFileSync(certSource, certPem);
  writeExecutable(
    join(fixture, "fake-bin", "tailscale"),
    `#!/bin/sh
case "$1" in
  status)
    if [ "$2" = "--json" ]; then printf '{"BackendState":"Running","Self":{"DNSName":"${dnsName}."}}\\n'; fi
    exit 0 ;;
  cert)
    # --cert-file <p> --key-file <p> <name>
    cat "${certSource}" > "$3"; : > "$5"; exit 0 ;;
esac
exit 1
`,
  );
}

/**
 * A `sudo` that runs what it is given and records the command, for the one step
 * the installer takes with privilege: granting this account the Tailscale
 * operator permission. Planted over the refusing default by suites that mean to
 * let that step succeed.
 */
export function installFakeSudo() {
  writeExecutable(
    join(fixture, "fake-bin", "sudo"),
    `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
[ "$1" = -n ] && shift
exec "$@"
`,
  );
}

/**
 * A `tailscale` that refuses to mint for an account that is not the operator —
 * the real client's wording — and mints once `set --operator` has been run.
 * `reason` replaces that refusal with a different failure, for the arm where
 * the permission is not what is missing.
 */
export function installDenyingTailscale(dnsName, certPem = "", { reason = "" } = {}) {
  const certSource = join(fixture, "fake-tailscale-cert.pem");
  writeFileSync(certSource, certPem);
  const operatorFlag = join(fixture, "fake-tailscale-operator");
  writeExecutable(
    join(fixture, "fake-bin", "tailscale"),
    `#!/bin/sh
case "$1" in
  status)
    if [ "$2" = "--json" ]; then printf '{"BackendState":"Running","Self":{"DNSName":"${dnsName}."}}\\n'; fi
    exit 0 ;;
  set)
    case "$2" in
      --operator=*) printf 'tailscale %s\\n' "$*" >> "$OMNESIS_TEST_CALLS"; printf '%s' "\${2#--operator=}" > "${operatorFlag}"; exit 0 ;;
    esac
    exit 1 ;;
  cert)
    ${
      reason
        ? `echo ${JSON.stringify(reason)} >&2; exit 1 ;;`
        : `if [ -s "${operatorFlag}" ]; then
      # --cert-file <p> --key-file <p> <name>
      cat "${certSource}" > "$3"; : > "$5"; exit 0
    fi
    echo "Access denied: cert access denied" >&2
    echo "" >&2
    echo "Use 'sudo tailscale cert --cert-file $3 --key-file $5 $6'." >&2
    exit 1 ;;`
    }
esac
exit 1
`,
  );
  return { operatorFlag };
}

/**
 * A fake `tailscale` that reports no tailnet. Always planted, so the machine's
 * real tailscale can never be reached from a test — minting a certificate is
 * an effect on the host, not on the fixture.
 */
export function installAbsentTailscale() {
  writeExecutable(join(fixture, "fake-bin", "tailscale"), "#!/bin/sh\nexit 1\n");
}

/**
 * A fake mkcert that records the leaf certificate argv and installs a real
 * fixture certificate, so installer tests can inspect both the requested SANs
 * and the certificate-driven address picker without touching a host trust
 * store.
 */
export function installFakeMkcert(name, subjectAltName) {
  const { fingerprint, pem } = mintCert(`mkcert-${name}`, subjectAltName);
  const certSource = join(fixture, `mkcert-${name}-source.pem`);
  const argsPath = join(fixture, `mkcert-${name}-args.txt`);
  writeFileSync(certSource, pem);
  writeExecutable(
    join(fixture, "fake-bin", "mkcert"),
    `#!/bin/sh
if [ "$1" = -install ]; then exit 0; fi
printf '%s\\n' "$@" > '${argsPath.replaceAll("'", "'\\''")}'
cp '${certSource.replaceAll("'", "'\\''")}' "$2"
: > "$4"
`,
  );
  return { argsPath, fingerprint };
}

/**
 * `openssl verify` is what the installer uses to decide whether a certificate
 * the operator supplied chains to a root this host trusts, and the tests stand
 * in for a public chain by naming their fixture certificate in `SSL_CERT_FILE`.
 * macOS ships LibreSSL as /usr/bin/openssl, which ignores that variable
 * entirely, so those runs need a real OpenSSL: Homebrew's is put on PATH when
 * it is installed. With only LibreSSL the affected tests skip, rather than
 * failing for the host's toolchain and reading as a product bug.
 */
function realOpensslDir() {
  for (const dir of ["/opt/homebrew/opt/openssl@3/bin", "/usr/local/opt/openssl@3/bin"]) {
    try {
      if (
        /^OpenSSL /u.test(execFileSync(join(dir, "openssl"), ["version"], { encoding: "utf8" }))
      ) {
        return dir;
      }
    } catch {
      /* not installed here */
    }
  }
  try {
    if (/^OpenSSL /u.test(execFileSync("openssl", ["version"], { encoding: "utf8" }))) return "";
  } catch {
    /* no openssl at all */
  }
  return null;
}

const REAL_OPENSSL_DIR = realOpensslDir();

/** Can a run verify a certificate chain the way a Linux host does? */
export const HAS_REAL_OPENSSL = REAL_OPENSSL_DIR !== null;

/**
 * Every executable the installer looks for on PATH and would act on if it found
 * a real one: the CLI it may already have installed, agent harnesses the
 * `--openclaw` / `--hermes` roles probe, and Codex (which controls an optional
 * setup offer).
 */
const SHADOWED_ON_PATH = ["omnesis", "openclaw", "hermes", "codex"];

/**
 * PATH for one installer run: the fakes first, then the developer's own PATH
 * minus every directory holding one of those. A real `omnesis` there would read
 * the developer's catalog and dial their gateway; a real harness would decide
 * the outcome of a preflight the test means to control. Either way the run
 * would depend on the machine it happens to execute on.
 */
function scrubbedPath() {
  const dirs = (process.env.PATH ?? "").split(":").filter((dir) => {
    if (!dir) return false;
    const shadowed = SHADOWED_ON_PATH.some((name) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    return !shadowed;
  });
  // Preserve the exact Node and Git selected for the test process. A shadowed
  // command can share their package-manager bin, while a lower-priority PATH
  // entry may contain an older tool. Existing links make repeated runs in one
  // fixture idempotent.
  const preservedToolsDir = join(fixture, "host-tools");
  mkdirSync(preservedToolsDir, { recursive: true });
  for (const [tool, source] of [
    ["git", HOST_GIT],
    ["node", process.execPath],
  ]) {
    const target = join(preservedToolsDir, tool);
    if (!existsSync(target)) symlinkSync(source, target);
  }
  // A real OpenSSL, where the host has one, goes ahead of the system LibreSSL.
  return [
    join(fixture, "fake-bin"),
    ...(REAL_OPENSSL_DIR ? [REAL_OPENSSL_DIR] : []),
    preservedToolsDir,
    ...dirs,
  ].join(":");
}

/**
 * Every variable a run must not inherit from the machine it executes on: the
 * installer's own configuration, the harness home overrides it and the CLI
 * both honor, and NODE_OPTIONS, which the installer reads when it builds.
 */
const SCRUBBED_ENV_PREFIXES = ["OMNESIS_", "OPENCLAW_", "HERMES_"];

/** Environment for one installer run, scrubbed of the developer's own config. */
function installerEnv(home, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    // The fake bin shadows tailscale, systemctl, curl, and npm; git and node stay real.
    PATH: scrubbedPath(),
    SHELL: "/bin/zsh",
    OMNESIS_REPO_URL: fixture,
    OMNESIS_TEST_CALLS: join(home, "cli-calls.log"),
    ...extra,
  };
}

/**
 * The home directory one run installs into. Created rather than cleared, so a
 * suite can plant state (a certificate, a stale pairing record) under the same
 * run name beforehand.
 */
export function prepareHome(name, { umask } = {}) {
  const home = join(fixture, `home-${name}`);
  const existed = existsSync(home);
  mkdirSync(home, { recursive: true });
  // A home made here takes the run's umask, not the test process's; one a suite
  // planted beforehand keeps whatever modes the suite gave it.
  if (!existed && umask !== undefined) chmodSync(home, 0o777 & ~umask);
  writeFileSync(join(home, "cli-calls.log"), "");
  return home;
}

function resultOf(home, proc) {
  const calls = readFileSync(join(home, "cli-calls.log"), "utf8").split("\n").filter(Boolean);
  return {
    status: proc.status,
    output: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    home,
    calls,
    configDir: join(home, ".config", "omnesis"),
    wrapper: join(home, ".local", "bin", "omnesis"),
    envFile: () => {
      const path = join(home, ".config", "omnesis", ".env");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
  };
}

/**
 * The command line one run executes. Every run gets its own checkout path, so
 * suites never share one — except a `--docker` run, which installs no checkout
 * at all and refuses the flag that would name one.
 */
function installerArgv(name, args) {
  if (args.includes("--docker")) return [installer, ...args];
  return [installer, "--source-dir", join(fixture, `checkout-${name}`), ...args];
}

/**
 * The shell command line for one run. `umask` runs the installer under that
 * mask instead of the one the test runner inherited, for a suite whose
 * outcome depends on the modes of what the installer creates.
 */
function shellArgv(name, args, umask) {
  if (umask === undefined) return installerArgv(name, args);
  return [
    "-c",
    `umask ${umask.toString(8).padStart(3, "0")} && exec sh "$@"`,
    "sh",
    ...installerArgv(name, args),
  ];
}

/** Run the installer with no controlling terminal, the way a unit would. */
export function runInstaller(name, args, extraEnv = {}, { umask } = {}) {
  const home = prepareHome(name, { umask });
  const proc = spawnSync("sh", shellArgv(name, args, umask), {
    env: installerEnv(home, extraEnv),
    encoding: "utf8",
    detached: true,
    timeout: 120_000,
  });
  return resultOf(home, proc);
}

/** Run the installer on a pseudo-terminal, feeding `answers` to its prompts. */
export function runInstallerOnTty(name, args, answers, extraEnv = {}, { umask } = {}) {
  const home = prepareHome(name, { umask });
  const command = ["sh", ...shellArgv(name, args, umask)]
    .map((word) => `'${word.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  const proc = spawnSync("script", ["-qec", command, "/dev/null"], {
    env: installerEnv(home, extraEnv),
    encoding: "utf8",
    input: answers.map((a) => `${a}\n`).join(""),
    timeout: 60_000,
  });
  return resultOf(home, proc);
}

/** The recorded call starting with `prefix`. Fails the test when there is none. */
export function callStartingWith(calls, prefix) {
  const line = calls.find((c) => c.startsWith(prefix));
  expect(line, `no recorded CLI call starting with "${prefix}"`).toBeDefined();
  return line;
}

/**
 * A throwaway self-signed certificate, with the fingerprint the installer will
 * compute from it. `openssl` is probed rather than assumed: without it the
 * certificate tests would silently stop covering anything.
 */
export function mintCert(name, subjectAltName = "DNS:localhost, DNS:omnesis.local") {
  if (spawnSync("openssl", ["version"]).status !== 0) {
    throw new Error("openssl is required to mint the installer suite's fixture certificates.");
  }
  const cnf = join(fixture, `${name}.cnf`);
  writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3_ext",
      "",
      "[dn]",
      "CN = fictional-installer-gateway",
      "",
      "[v3_ext]",
      "basicConstraints = critical, CA:FALSE",
      `subjectAltName = ${subjectAltName}`,
      "",
    ].join("\n"),
  );
  const certPath = join(fixture, `${name}-cert.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      join(fixture, `${name}.key`),
      "-out",
      certPath,
      "-days",
      "3",
      "-nodes",
      "-config",
      cnf,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const pem = readFileSync(certPath, "utf8");
  const der = Buffer.from(
    pem
      .match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)[1]
      .replace(/\s+/g, ""),
    "base64",
  );
  return { fingerprint: createHash("sha256").update(der).digest("hex"), pem };
}

/** Plant a certificate where a booted gateway would have written its own. */
export function plantGatewayCert(runName, subjectAltName = "DNS:localhost, DNS:omnesis.local") {
  const tlsDir = join(fixture, `home-${runName}`, ".config", "omnesis", "tls");
  mkdirSync(tlsDir, { recursive: true });
  const { fingerprint, pem } = mintCert(`gateway-${runName}`, subjectAltName);
  writeFileSync(join(tlsDir, "cert.pem"), pem);
  return fingerprint;
}
