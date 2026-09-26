// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drives the real installer's `--openclaw` and `--hermes` roles against fakes:
 * a local git remote carrying a release tag, an `npm` that writes a recording
 * CLI shim instead of installing anything, a fake harness planted (or
 * deliberately not planted) under the run's own HOME, and a pseudo-terminal
 * for the prompts the roles read from `/dev/tty`.
 *
 * The seam is the shim: a source install always runs the CLI through
 * `<checkout>/node_modules/.bin/tsx`, so a recorder written there sees every
 * command the installer issues, with its arguments. It also stands in for
 * `omnesis connect`, whose `--print-home` answer is what the installer uses to
 * decide between a fresh pairing and a refresh.
 *
 * No real harness is ever contacted, and no real `omnesis connect` ever runs —
 * a connect against a live gateway would pair a device and spend a code. What
 * a run against a real OpenClaw or Hermes does is out of reach here; it is
 * covered by hand.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  callStartingWith,
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  installer,
  prepareHome,
  runInstaller,
  runInstallerOnTty,
  writeExecutable,
} from "./installer-harness.mjs";

/** A gateway on some other machine, and the certificate it serves. */
const GATEWAY_URL = "https://gateway.example.com:7600";
const GATEWAY_FP = "a".repeat(64);
const PAIRING_CODE = "K7QX2M9ZB4";

/**
 * The recording CLI shim. Invoked as `<shim> <entry.ts> <cli args...>` through
 * the wrapper the installer writes, so the first argument is dropped.
 *
 * `connect <harness> --print-home` answers on stdout the way the real command
 * does; every other `connect` is recorded and succeeds, unless the test asked
 * for one that fails.
 */
const CLI_SHIM = `#!/bin/sh
shift 2>/dev/null || true
printf '%s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
case "$1" in
  --version) echo "0.10.0" ;;
  keyring)
    case "$2" in
      status)
        if [ "\${OMNESIS_TEST_KEYRING:-locked}" = ready ]; then
          echo '{"store":{"available":true,"secure":true}}'
        else
          echo '{"store":{"available":false,"secure":false,"detail":"no usable keyring"}}'
        fi
        ;;
      *) : ;;
    esac
    ;;
  devices)
    if [ "$2" = discover ]; then
      if [ -n "\${OMNESIS_TEST_DISCOVER:-}" ]; then cat "$OMNESIS_TEST_DISCOVER"; else echo '{"found":false}'; fi
    fi
    ;;
  connect)
    if [ "$2" = --help ]; then
      # What the real command's help lists. A CLI that predates the harness
      # restart has no --no-restart among them until \`update\` has run.
      echo "--gateway-url --code --trust-fingerprint --dir --print-home --skill-only --refresh"
      if [ -z "\${OMNESIS_TEST_CONNECT_PREDATES_RESTART:-}" ] || [ -e "$OMNESIS_TEST_CALLS.updated" ]; then
        echo "--restart --no-restart --yes"
      fi
      exit 0
    fi
    case "$3" in
      --print-home)
        if [ -n "\${OMNESIS_TEST_PRINT_HOME_FAIL:-}" ]; then exit 1; fi
        case "$2" in
          openclaw)
            if [ -n "\${OPENCLAW_STATE_DIR:-}" ]; then printf '%s\\n' "$OPENCLAW_STATE_DIR"
            elif [ -d "$HOME/.openclaw" ]; then printf '%s\\n' "$HOME/.openclaw"
            elif [ -d "$HOME/.clawdbot" ]; then printf '%s\\n' "$HOME/.clawdbot"
            else printf '%s\\n' "$HOME/.openclaw"; fi
            ;;
          hermes)   printf '%s\\n' "\${HERMES_HOME:-$HOME/.hermes}" ;;
        esac
        ;;
      *)
        if [ -t 0 ]; then printf 'connect stdin is a tty\n' >> "$OMNESIS_TEST_CALLS"; fi
        if [ -n "\${OMNESIS_TEST_CONNECT_FAIL:-}" ]; then
          echo "Gateway health check failed." >&2
          exit 1
        fi
        ;;
    esac
    ;;
  update)
    if [ -z "\${OMNESIS_TEST_UPDATE_KEEPS_OLD_CLI:-}" ]; then : > "$OMNESIS_TEST_CALLS.updated"; fi
    ;;
  *) : ;;
esac
exit 0
`;

beforeEach(() => {
  createFixture({ name: "harness", versions: ["0.10.0"], cliShim: CLI_SHIM });
});

afterEach(destroyFixture);

/**
 * Create the harness's home under the HOME this run will use, before the run
 * starts. `prepareHome` creates rather than clears, so planting here survives.
 */
function plantHarnessHome(name, directory, files = {}) {
  const home = join(prepareHome(name), directory);
  mkdirSync(home, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(home, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return home;
}

/**
 * A Hermes home holding one of the executables its plugin loader looks for:
 * the venv install by default, or the checkout beside it.
 */
function plantHermes(name, { at = "venv", files = {} } = {}) {
  const home = plantHarnessHome(name, ".hermes", files);
  const binary =
    at === "venv"
      ? join(home, "hermes-agent", "venv", "bin", "hermes")
      : join(home, "hermes-agent", "hermes");
  mkdirSync(join(binary, ".."), { recursive: true });
  writeExecutable(binary, "#!/bin/sh\nexit 0\n");
  return home;
}

/** Write a `devices discover --json` answer for the shim to serve. */
function discoveryAnswer(name, body) {
  const path = fixturePath(`discover-${name}.json`);
  writeFileSync(path, `${JSON.stringify(body)}\n`);
  return path;
}

/** The flags every connecting run shares: no keyring, no code prompt. */
const CODED = ["--no-keyring", "--code", PAIRING_CODE, "--gateway-url", GATEWAY_URL];

describe("install.sh --openclaw / --hermes: the happy path", () => {
  test.each([
    ["openclaw", ".openclaw", "OpenClaw"],
    ["hermes", ".hermes", "Hermes"],
  ])("--dry-run reports the %s integration by its display name", (harness, directory, label) => {
    plantHarnessHome(`dry-${harness}`, directory);
    if (harness === "hermes") plantHermes(`dry-${harness}`);
    const run = runInstaller(`dry-${harness}`, [
      `--${harness}`,
      "--dry-run",
      "--gateway-url",
      GATEWAY_URL,
      "--code",
      PAIRING_CODE,
    ]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(`Role:      ${label} integration for another gateway`);
    expect(run.calls).toEqual([]);
  });

  test.skipIf(!HAS_PTY)("--no-prompt isolates the harness CLI from terminal input", () => {
    plantHarnessHome("no-prompt-stdin", ".openclaw");
    const run = runInstallerOnTty("no-prompt-stdin", ["--openclaw", "--no-prompt", ...CODED], []);
    expect(run.status, run.output).toBe(0);
    expect(run.calls).not.toContain("connect stdin is a tty");
  });

  test("connects OpenClaw with the gateway, code and pin it was given", () => {
    plantHarnessHome("openclaw", ".openclaw");
    const run = runInstaller("openclaw", [
      "--openclaw",
      ...CODED,
      "--trust-fingerprint",
      `sha256:${GATEWAY_FP}`,
    ]);

    expect(run.status).toBe(0);
    // With nobody to ask, connect is told to restart OpenClaw: the plugin it
    // installs loads no other way.
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toBe(
      `connect openclaw --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} ` +
        `--trust-fingerprint sha256:${GATEWAY_FP} --yes`,
    );
    // A harness machine runs no local gateway, no collector, and no model.
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("model install"))).toBe(false);
    expect(run.output).toContain("OpenClaw is connected to Omnesis.");
    expect(run.output).toContain("whether it reports the Omnesis skill ready");
    expect(run.output).not.toContain("Restart the OpenClaw gateway");
    // The wait is announced, so ten silent minutes read as expected rather
    // than as a hang worth Ctrl-C'ing.
    expect(run.output).toContain("up to ten minutes");
  });

  test("connects Hermes and leaves its restart to connect", () => {
    plantHermes("hermes");
    const run = runInstaller("hermes", ["--hermes", ...CODED]);

    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "connect hermes --gateway-url")).toBe(
      `connect hermes --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} --yes`,
    );
    expect(run.output).toContain("Hermes is connected to Omnesis.");
    expect(run.output).toContain("Hermes restarted with its plugin");
    expect(run.output).not.toContain("Restart the Hermes gateway");
  });

  test("an OpenClaw home under OPENCLAW_STATE_DIR is found where the CLI looks", () => {
    // The preflight has to agree with `connect` about the overrides, or a
    // perfectly good installation is refused for being somewhere standard.
    const stateDir = fixturePath("openclaw-state");
    mkdirSync(stateDir, { recursive: true });
    const run = runInstaller("openclaw-statedir", ["--openclaw", ...CODED], {
      OPENCLAW_STATE_DIR: stateDir,
    });
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(true);
  });

  test("an OpenClaw that predates the rename is found in its legacy directory", () => {
    plantHarnessHome("openclaw-legacy", ".clawdbot");
    const run = runInstaller("openclaw-legacy", ["--openclaw", ...CODED]);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(true);
  });

  test("a Hermes whose executable is the checkout beside the venv is installed too", () => {
    plantHermes("hermes-checkout", { at: "checkout" });
    const run = runInstaller("hermes-checkout", ["--hermes", ...CODED]);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("connect hermes --gateway-url"))).toBe(true);
  });

  test("a Hermes whose executable is only on PATH is installed too", () => {
    // The plugin loader's last resort, and the one a system-wide install uses.
    plantHarnessHome("hermes-path", ".hermes");
    writeExecutable(fixturePath("fake-bin", "hermes"), "#!/bin/sh\nexit 0\n");
    const run = runInstaller("hermes-path", ["--hermes", ...CODED]);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("connect hermes --gateway-url"))).toBe(true);
  });

  test("an OpenClaw under a named profile is found where the CLI looks", () => {
    // `OPENCLAW_PROFILE` moves the home whether or not the directory exists,
    // so the installer has to follow it rather than fall back to the default.
    const run = runInstaller("openclaw-profile", ["--openclaw", ...CODED], {
      OPENCLAW_PROFILE: "fictional",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(join(run.home, ".openclaw-fictional"));
  });
});

describe("install.sh --openclaw / --hermes: refusing the wrong machine", () => {
  test("no OpenClaw at all is refused before anything is installed", () => {
    const run = runInstaller("no-openclaw", ["--openclaw", ...CODED]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No OpenClaw on this machine");
    expect(run.output).toContain("no `openclaw` on PATH");
    expect(run.output).toContain(join(run.home, ".openclaw"));
    expect(run.output).toContain("this installer never installs it");
    // Nothing ran: not the CLI install, and above all not a pairing code.
    expect(run.calls).toEqual([]);
    expect(run.output).not.toContain("No terminal to ask for the pairing code");
  });

  test("no Hermes at all is refused, naming the directory looked for", () => {
    const run = runInstaller("no-hermes", ["--hermes", ...CODED]);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/no Hermes on this machine/i);
    expect(run.output).toContain(join(run.home, ".hermes"));
    expect(run.calls).toEqual([]);
  });

  test("a Hermes home without its executable names all three candidates", () => {
    // The plugin loader tries the venv, then a checkout beside it, then PATH.
    // A home with none of them is a half-finished install, not an absent one.
    plantHarnessHome("hermes-novenv", ".hermes");
    const run = runInstaller("hermes-novenv", ["--hermes", ...CODED]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("its executable is not");
    expect(run.output).toContain(
      join(run.home, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
    );
    expect(run.output).toContain(join(run.home, ".hermes", "hermes-agent", "hermes"));
    expect(run.output).toContain("`hermes` on PATH");
    expect(run.calls).toEqual([]);
  });

  test("HERMES_HOME moves what the refusal looks for", () => {
    const elsewhere = fixturePath("hermes-elsewhere");
    const run = runInstaller("hermes-env", ["--hermes", ...CODED], { HERMES_HOME: elsewhere });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      new RegExp(`no Hermes on this machine: no ${elsewhere.replaceAll("/", "\\/")}`, "i"),
    );
    expect(run.calls).toEqual([]);
  });

  test("a binary with no home is refused before the code prompt, not by connect after it", () => {
    // `openclaw` on PATH gets past the machine check, but `connect` refuses a
    // home that is not there — and it refuses it after the code is spent. The
    // installer resolves the home first so that refusal lands here instead.
    writeExecutable(fixturePath("fake-bin", "openclaw"), "#!/bin/sh\nexit 0\n");
    const run = runInstaller("openclaw-nohome", [
      "--openclaw",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("OpenClaw is not installed at");
    expect(run.output).toContain(join(run.home, ".openclaw"));
    expect(run.output).not.toContain("No terminal to ask for the pairing code");
    expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(false);
  });

  test("the refusal comes before the code prompt, not after it", () => {
    // The ordering is the whole point: a single-use code spent on the wrong
    // machine cannot be spent again on the right one.
    const run = runInstaller("no-openclaw-prompt", ["--openclaw", "--no-keyring"]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No OpenClaw on this machine");
    expect(run.output).not.toContain("No terminal to ask for the pairing code");
    expect(run.calls).toEqual([]);
  });
});

describe("install.sh --openclaw / --hermes: the pairing code", () => {
  test.skipIf(!HAS_PTY)("is asked for on the terminal, as an agent device", () => {
    plantHarnessHome("code-prompt", ".openclaw");
    const run = runInstallerOnTty(
      "code-prompt",
      ["--openclaw", "--no-keyring", "--gateway-url", GATEWAY_URL],
      [PAIRING_CODE],
    );
    expect(run.status).toBe(0);
    // The kind matters: a collector code is not redeemable as an agent.
    expect(run.output).toContain("omnesis devices pair --kind agent");
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toContain(
      `--code ${PAIRING_CODE}`,
    );
  });

  test("no terminal and no --code is a refusal that names --code", () => {
    plantHarnessHome("code-notty", ".openclaw");
    const run = runInstaller("code-notty", [
      "--openclaw",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No terminal to ask for the pairing code");
    expect(run.output).toContain("omnesis devices pair --kind agent");
    expect(run.output).toContain("--code <code>");
    expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(false);
  });
});

describe("install.sh --openclaw / --hermes: finding the gateway", () => {
  test.skipIf(!HAS_PTY)("a discovered gateway is confirmed, and its fingerprint pins", () => {
    plantHarnessHome("discover-yes", ".openclaw");
    const run = runInstallerOnTty(
      "discover-yes",
      ["--openclaw", "--no-keyring", "--code", PAIRING_CODE],
      ["y"],
      {
        OMNESIS_TEST_DISCOVER: discoveryAnswer("hit", {
          found: true,
          url: GATEWAY_URL,
          name: "gateway-host",
          fingerprint: `sha256:${GATEWAY_FP}`,
        }),
      },
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain(`Found gateway-host at ${GATEWAY_URL}`);
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toBe(
      `connect openclaw --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} ` +
        `--trust-fingerprint sha256:${GATEWAY_FP}`,
    );
  });
});

describe("install.sh --openclaw / --hermes: a second run", () => {
  test("an installation that is already connected is refreshed, not re-paired", () => {
    plantHarnessHome("refresh", ".openclaw", {
      "omnesis/integration.json": '{"gatewayUrl":"https://gateway.example.com:7600"}\n',
    });
    const run = runInstaller("refresh", ["--openclaw", "--no-keyring"]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("already connected — refreshing");
    expect(callStartingWith(run.calls, "connect openclaw --refresh")).toBe(
      "connect openclaw --refresh --yes",
    );
    expect(run.output).toContain("OpenClaw is refreshed.");
    // A refresh reuses the recorded gateway, so nothing asks for a code.
    expect(run.output).not.toContain("Pairing code");
  });

  test("a refresh still carries a pin the operator brought", () => {
    plantHermes("refresh-pin", { files: { "omnesis/integration.json": "{}\n" } });
    const run = runInstaller("refresh-pin", [
      "--hermes",
      "--no-keyring",
      "--trust-fingerprint",
      `sha256:${GATEWAY_FP}`,
    ]);
    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "connect hermes --refresh")).toBe(
      `connect hermes --refresh --trust-fingerprint sha256:${GATEWAY_FP} --yes`,
    );
  });

  test("a resume says the code it was handed is not the one it will use", () => {
    plantHarnessHome("resume-code", ".openclaw", {
      "omnesis/connect-redemption.json": '{"version":1}\n',
    });
    const run = runInstaller("resume-code", ["--openclaw", "--no-keyring", "--code", PAIRING_CODE]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("is not used: the pending connect carries its own");
    expect(run.calls).toContain("connect openclaw --yes");
  });

  test("a resume says the gateway it was handed is not the one it will dial", () => {
    plantHarnessHome("resume-url", ".openclaw", {
      "omnesis/connect-recovery.json": '{"version":1}\n',
    });
    const run = runInstaller("resume-url", [
      "--openclaw",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
    ]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("is not used: the pending connect names its own");
    expect(run.calls).toContain("connect openclaw --yes");
  });

  test.skipIf(!HAS_PTY)("a code on its own means pair, not refresh", () => {
    // A fresh code and a stale integration file is the repair case: refreshing
    // would keep the old pairing and leave the code the operator minted unspent.
    plantHarnessHome("repair-code", ".openclaw", { "omnesis/integration.json": "{}\n" });
    const run = runInstallerOnTty(
      "repair-code",
      ["--openclaw", "--no-keyring", "--code", PAIRING_CODE],
      ["y"],
      {
        OMNESIS_TEST_DISCOVER: discoveryAnswer("repair", {
          found: true,
          url: GATEWAY_URL,
          name: "gateway-host",
        }),
      },
    );
    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toBe(
      `connect openclaw --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE}`,
    );
    expect(run.calls.some((call) => call.startsWith("connect openclaw --refresh"))).toBe(false);
  });

  test("a named gateway means pair, not refresh, even with an integration there", () => {
    // `connect --refresh` refuses to be told a gateway, so a run that names one
    // is asking for a fresh pairing against it.
    plantHarnessHome("repair", ".openclaw", { "omnesis/integration.json": "{}\n" });
    const run = runInstaller("repair", ["--openclaw", ...CODED]);
    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toBe(
      `connect openclaw --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} --yes`,
    );
  });

  test("an unfinished connect is resumed with the code it already holds", () => {
    // The journal carries the code that connect already minted. Asking for a
    // second one would spend it to finish work the first one paid for.
    plantHarnessHome("resume", ".openclaw", {
      "omnesis/connect-redemption.json": '{"version":1}\n',
    });
    const run = runInstaller("resume", ["--openclaw", "--no-keyring"]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("has an unfinished connect — resuming it");
    expect(callStartingWith(run.calls, "connect openclaw")).toBe("connect openclaw --print-home");
    expect(run.calls).toContain("connect openclaw --yes");
    expect(run.output).not.toContain("Pairing code");
  });

  test("a redeemed-but-unfinished connect resumes too, rather than refreshing", () => {
    // A recovery marker beside an integration file means the credentials
    // landed but the local install did not; `--refresh` would discard it.
    plantHarnessHome("resume-recovery", ".openclaw", {
      "omnesis/connect-recovery.json": '{"version":1}\n',
      "omnesis/integration.json": "{}\n",
    });
    const run = runInstaller("resume-recovery", ["--openclaw", "--no-keyring"]);
    expect(run.status).toBe(0);
    expect(run.calls).toContain("connect openclaw --yes");
    expect(run.calls.some((call) => call.startsWith("connect openclaw --refresh"))).toBe(false);
  });

  test("a CLI that cannot say where the harness lives stops before pairing", () => {
    plantHarnessHome("nohome", ".openclaw");
    const run = runInstaller("nohome", ["--openclaw", ...CODED], {
      OMNESIS_TEST_PRINT_HOME_FAIL: "1",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("could not say where OpenClaw lives");
    expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(false);
  });

  test("a failed connect names the resume that needs no fresh code", () => {
    plantHarnessHome("connect-fail", ".openclaw");
    const run = runInstaller("connect-fail", ["--openclaw", ...CODED], {
      OMNESIS_TEST_CONNECT_FAIL: "1",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("Connecting OpenClaw failed");
    expect(run.output).toContain("omnesis connect openclaw");
    expect(run.output).not.toContain("is connected to Omnesis");
  });
});

describe("install.sh --openclaw / --hermes: a machine that already runs Omnesis", () => {
  /** Register the user services `omnesis service install` would have written. */
  function registerServices(home, names) {
    for (const name of names) {
      for (const path of [
        join(home, ".config", "systemd", "user", `omnesis-${name}.service`),
        join(home, "Library", "LaunchAgents", `dev.omnesis.${name}.plist`),
      ]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
    }
  }

  /**
   * A collector machine this installer set up: a recorded checkout, the
   * launcher at ~/.local/bin/omnesis, and a registered collector service.
   */
  function collectorMachine(name) {
    const first = runInstaller(name, ["--client-only", "--no-keyring"]);
    expect(first.status, first.output).toBe(0);
    registerServices(first.home, ["collector"]);
    return first;
  }

  /** Every file under `root` with its bytes, so a run that changes one is caught. */
  function snapshotTree(root) {
    if (!existsSync(root)) return {};
    const files = {};
    const visit = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) visit(path);
        else files[path] = readFileSync(path, "utf8");
      }
    };
    visit(root);
    return files;
  }

  const checkoutHead = (name) =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixturePath(`checkout-${name}`),
      encoding: "utf8",
    }).trim();

  /** Calls that would rebuild, reinstall or re-seal what the machine runs. */
  const reinstalls = (run) =>
    run.calls.filter((call) => /^(npm ci|build |keyring |service install)/u.test(call));

  test("connects with the CLI already there and leaves the install untouched", () => {
    const first = collectorMachine("existing");
    plantHarnessHome("existing", ".openclaw");
    const before = {
      head: checkoutHead("existing"),
      wrapper: readFileSync(first.wrapper, "utf8"),
      config: snapshotTree(first.configDir),
      units: snapshotTree(join(first.home, ".config", "systemd")),
    };

    const run = runInstaller("existing", ["--openclaw", ...CODED]);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("This machine already runs Omnesis (the checkout at");
    expect(run.output).toContain("and its collector service)");
    expect(reinstalls(run)).toEqual([]);
    expect(callStartingWith(run.calls, "connect openclaw --gateway-url")).toBe(
      `connect openclaw --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} --yes`,
    );
    expect(checkoutHead("existing")).toBe(before.head);
    expect(readFileSync(first.wrapper, "utf8")).toBe(before.wrapper);
    expect(snapshotTree(first.configDir)).toEqual(before.config);
    expect(snapshotTree(join(first.home, ".config", "systemd"))).toEqual(before.units);
    expect(run.output).toContain("OpenClaw is connected to Omnesis.");
  });

  test("an install this installer did not record is found by its registered service", () => {
    // A service with an `omnesis` of its own and no recorded checkout — a
    // package install, or one set up by hand. Nothing is cloned beside it.
    const home = prepareHome("services-only");
    registerServices(home, ["gateway", "collector"]);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeExecutable(
      join(home, ".local", "bin", "omnesis"),
      `#!/bin/sh\nexec "${fixturePath("cli-shim.sh")}" entry "$@"\n`,
    );
    plantHermes("services-only");

    const run = runInstaller("services-only", ["--hermes", ...CODED]);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("already runs Omnesis (its gateway and collector services)");
    expect(reinstalls(run)).toEqual([]);
    expect(existsSync(fixturePath("checkout-services-only"))).toBe(false);
    expect(run.calls).toContain(
      `connect hermes --gateway-url ${GATEWAY_URL} --code ${PAIRING_CODE} --yes`,
    );
  });

  test("a registered service with no omnesis to connect with is refused, not reinstalled over", () => {
    const home = prepareHome("no-cli");
    registerServices(home, ["collector"]);
    plantHarnessHome("no-cli", ".openclaw");

    const run = runInstaller("no-cli", ["--openclaw", ...CODED]);

    expect(run.status).toBe(1);
    expect(run.output).toContain("no omnesis command was found");
    expect(run.output).toContain("re-run this installer without --openclaw");
    expect(existsSync(fixturePath("checkout-no-cli"))).toBe(false);
    expect(run.calls).toEqual([]);
  });

  test("a dry run names the install it will use and changes nothing", () => {
    collectorMachine("existing-dry");
    plantHarnessHome("existing-dry", ".openclaw");
    const run = runInstaller("existing-dry", ["--openclaw", "--dry-run", ...CODED]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("using this machine's existing Omnesis");
    expect(run.output).toContain("Delivery:  none; the CLI already installed here");
    expect(run.calls).toEqual([]);
  });

  test("a CLI that predates this connect is not updated unasked; the run says to update", () => {
    const first = collectorMachine("existing-old");
    plantHarnessHome("existing-old", ".openclaw");
    const head = checkoutHead("existing-old");

    const run = runInstaller("existing-old", ["--openclaw", ...CODED], {
      OMNESIS_TEST_CONNECT_PREDATES_RESTART: "1",
    });

    expect(run.status).toBe(1);
    expect(run.output).toContain("predates the connect this role runs");
    expect(run.output).toContain("omnesis update");
    expect(run.calls.filter((call) => /^(update|connect openclaw --)/u.test(call))).toEqual([]);
    expect(reinstalls(run)).toEqual([]);
    expect(checkoutHead("existing-old")).toBe(head);
    expect(existsSync(first.wrapper)).toBe(true);
  });

  test.skipIf(!HAS_PTY)(
    "on a terminal, an old CLI is brought up to date by the machine's own updater first",
    () => {
      collectorMachine("existing-update");
      plantHarnessHome("existing-update", ".openclaw");

      const run = runInstallerOnTty("existing-update", ["--openclaw", ...CODED], ["y"], {
        OMNESIS_TEST_CONNECT_PREDATES_RESTART: "1",
      });

      expect(run.status, run.output).toBe(0);
      expect(run.calls.filter((call) => call.startsWith("update "))).toEqual(["update --yes"]);
      expect(reinstalls(run)).toEqual([]);
      const updateAt = run.calls.indexOf("update --yes");
      const connectAt = run.calls.findIndex((call) =>
        call.startsWith("connect openclaw --gateway-url"),
      );
      expect(updateAt).toBeGreaterThanOrEqual(0);
      expect(connectAt).toBeGreaterThan(updateAt);
    },
  );

  test.skipIf(!HAS_PTY)("declining that update changes nothing and connects nothing", () => {
    collectorMachine("existing-decline");
    plantHarnessHome("existing-decline", ".openclaw");

    const run = runInstallerOnTty("existing-decline", ["--openclaw", ...CODED], ["n"], {
      OMNESIS_TEST_CONNECT_PREDATES_RESTART: "1",
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("Nothing was changed.");
    expect(run.calls.filter((call) => /^(update|connect openclaw --)/u.test(call))).toEqual([]);
  });

  test("a fresh machine still gets the CLI installed before the connect", () => {
    plantHarnessHome("fresh", ".openclaw");
    const run = runInstaller("fresh", ["--openclaw", ...CODED]);
    expect(run.status, run.output).toBe(0);
    expect(run.calls).toContain("npm ci");
    expect(existsSync(run.wrapper)).toBe(true);
    expect(run.output).not.toContain("already runs Omnesis");
    // The connect comes after the install that provides it.
    expect(run.calls.indexOf("npm ci")).toBeLessThan(
      run.calls.findIndex((call) => call.startsWith("connect openclaw --gateway-url")),
    );
  });
});

describe("install.sh --openclaw / --hermes: refused combinations", () => {
  const refusal = (name, args, needle, extraEnv = {}) => {
    // Both harnesses are planted so that a refusal here can only be about the
    // flags: a run that passed them would still have a machine to install on.
    plantHarnessHome(name, ".openclaw");
    plantHermes(name);
    const run = runInstaller(name, args, extraEnv);
    expect(run.status).toBe(1);
    expect(run.output).toContain(needle);
    expect(run.calls).toEqual([]);
  };

  test("two harnesses are two roles, not a shorthand for both", () => {
    refusal(
      "both-harnesses",
      ["--openclaw", "--hermes"],
      "--openclaw and --hermes name two different harnesses",
    );
  });

  test("a harness role and the collector role are two roles for one machine", () => {
    refusal(
      "with-collector",
      ["--openclaw", "--collector"],
      "--collector and --openclaw are two roles for one machine",
    );
  });

  test("a harness role already installs the CLI --client-only installs", () => {
    refusal(
      "with-client-only",
      ["--hermes", "--client-only"],
      "--hermes already installs the CLI without local gateway services",
    );
  });

  test("--port and --mkcert configure a local gateway this machine will not run", () => {
    refusal("with-port", ["--openclaw", "--port", "8443"], "--openclaw pairs with one elsewhere");
    refusal("with-mkcert", ["--openclaw", "--mkcert"], "--mkcert provisions a certificate");
  });

  test("--embedder names a model a harness machine never downloads", () => {
    refusal(
      "with-embedder",
      ["--openclaw", "--embedder", "nomic-embed-text-v1.5.Q8_0"],
      "--collector, --openclaw or --hermes",
    );
  });

  test("--no-service has no daemon to skip on a machine that registers none", () => {
    refusal("with-no-service", ["--openclaw", "--no-service"], "--openclaw registers none");
  });

  test("--keyring-passphrase-file seals nothing this role writes here", () => {
    const passFile = fixturePath("keyring.pass");
    writeFileSync(passFile, "test-passphrase\n");
    refusal(
      "with-passphrase",
      ["--openclaw", "--keyring-passphrase-file", passFile],
      "--keyring-passphrase-file cannot be used with --openclaw",
    );
  });

  test.each(["locked", "ready"])(
    "a harness host never touches the keyring, whether one is usable (%s) or not",
    (keyring) => {
      // It keeps no Omnesis secret to seal. A keyring armed here would seal
      // whatever else of Omnesis this account holds, and one that is not
      // usable must not stop a connect that needs none.
      plantHarnessHome(`keyring-${keyring}`, ".openclaw");
      const run = runInstaller(
        `keyring-${keyring}`,
        ["--openclaw", "--code", PAIRING_CODE, "--gateway-url", GATEWAY_URL],
        { OMNESIS_TEST_KEYRING: keyring },
      );
      expect(run.status, run.output).toBe(0);
      expect(run.calls.filter((call) => call.startsWith("keyring"))).toEqual([]);
      expect(run.output).not.toContain("no usable OS keyring");
      expect(run.calls.some((call) => call.startsWith("connect openclaw --gateway-url"))).toBe(
        true,
      );
    },
  );
});

describe("install.sh --openclaw / --hermes: the script itself", () => {
  test("--help documents both harness roles", () => {
    // The help text is a line range over the script's own header, so it drifts
    // silently the moment a flag is documented outside it. The range's own
    // boundaries are the collector suite's; this only asks that these two
    // roles fall inside it.
    const help = spawnSync("sh", [installer, "--help"], { encoding: "utf8" }).stdout ?? "";
    expect(help).toContain("--openclaw");
    expect(help).toContain("--hermes");
  });
});
