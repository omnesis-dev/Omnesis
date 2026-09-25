// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drives the real installer's `--collector` role against fakes: a local git
 * remote carrying a release tag, an `npm` that writes a recording CLI shim
 * instead of installing anything, and a pseudo-terminal for the prompts the
 * role reads from `/dev/tty`.
 *
 * The seam is the shim: a source install always runs the CLI through
 * `<checkout>/node_modules/.bin/tsx`, so a recorder written there sees every
 * command the installer issues, with its arguments. It also stands in for the
 * collector daemon: registering the service writes the pairing record a real
 * collector writes once the gateway has accepted it, which is what the
 * installer waits on.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  callStartingWith,
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  installer,
  runInstaller as runInstallerRaw,
  runInstallerOnTty as runInstallerOnTtyRaw,
} from "./installer-harness.mjs";

/** A gateway on some other machine, and the certificate it serves. */
const GATEWAY_URL = "https://gateway.example.com:7600";
const GATEWAY_FP = "a".repeat(64);
const PAIRING_CODE = "K7QX2M9ZB4";
/** What the fake collector daemon reports its device is called. */
const DEVICE_NAME = "field-station";

/**
 * The recording CLI shim. Invoked as `<shim> <entry.ts> <cli args...>` through
 * the wrapper the installer writes, so the first argument is dropped.
 *
 * `service install` doubles as the collector daemon: it writes the pairing
 * record the daemon writes once the gateway accepts its token, unless the test
 * asked for a collector that never gets there.
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
  pair)
    if [ -t 0 ]; then printf 'pair stdin is a tty\n' >> "$OMNESIS_TEST_CALLS"; fi
    if [ -n "\${OMNESIS_TEST_PAIR_FAIL:-}" ]; then
      # The value is the exit status, so a test can drive the CLI's real
      # EXIT_GATEWAY_DOWN (64) and not only a generic refusal. "1" keeps its
      # existing meaning: a code the gateway saw and rejected.
      if [ "\${OMNESIS_TEST_PAIR_FAIL}" = 64 ]; then
        echo "Cannot reach the gateway. Check that it is running, and that its port is reachable from here." >&2
        exit 64
      fi
      echo "Invalid or expired pairing code." >&2
      exit 1
    fi
    mkdir -p "$HOME/.config/omnesis"
    printf 'fake-device-token\\n' > "$HOME/.config/omnesis/collector-token"
    ;;
  service)
    if [ "$2" = install ] && [ -n "\${OMNESIS_TEST_COLLECTOR_ONLINE:-}" ]; then
      mkdir -p "$HOME/.config/omnesis"
      printf '{"state":"paired","deviceName":"${DEVICE_NAME}","gatewayUrl":"%s","tokenFingerprint":"0123456789abcdef","lastAuthenticatedAt":1,"unauthorizedAt":null,"repairCommand":null}\\n' \\
        "$OMNESIS_TEST_COLLECTOR_ONLINE" > "$HOME/.config/omnesis/collector-pairing-state.json"
    fi
    ;;
  *) : ;;
esac
exit 0
`;

/**
 * The default for this suite: a collector that reaches the gateway it was
 * pointed at. Tests that want the other outcomes override the variable.
 */
const runInstaller = (name, args, extraEnv = {}) =>
  runInstallerRaw(name, args, { OMNESIS_TEST_COLLECTOR_ONLINE: GATEWAY_URL, ...extraEnv });
const runInstallerOnTty = (name, args, answers, extraEnv = {}) =>
  runInstallerOnTtyRaw(name, args, answers, {
    OMNESIS_TEST_COLLECTOR_ONLINE: GATEWAY_URL,
    ...extraEnv,
  });

/** Write a `devices discover --json` answer for the shim to serve. */
function discoveryAnswer(name, body) {
  const path = fixturePath(`discover-${name}.json`);
  writeFileSync(path, `${JSON.stringify(body)}\n`);
  return path;
}

beforeEach(() => {
  createFixture({ name: "collector", versions: ["0.10.0"], cliShim: CLI_SHIM });
});

afterEach(destroyFixture);

/** The flag set every collector test shares: no keyring, no code prompt. */
const CODED = ["--collector", "--no-keyring", "--code", PAIRING_CODE];

describe("install.sh --collector: the happy path", () => {
  test.skipIf(!HAS_PTY)("--no-prompt isolates the pairing CLI from terminal input", () => {
    const run = runInstallerOnTty(
      "no-prompt-stdin",
      [
        ...CODED,
        "--no-prompt",
        "--gateway-url",
        GATEWAY_URL,
        "--trust-fingerprint",
        `sha256:${GATEWAY_FP}`,
      ],
      [],
    );
    expect(run.status, run.output).toBe(0);
    expect(run.calls).not.toContain("pair stdin is a tty");
    expect(callStartingWith(run.calls, "pair ")).toContain(`pair ${PAIRING_CODE}`);
  });

  test("pairs, registers the collector unit, and reports the device online", () => {
    const run = runInstaller("happy", [
      ...CODED,
      "--gateway-url",
      GATEWAY_URL,
      "--trust-fingerprint",
      `sha256:${GATEWAY_FP}`,
    ]);

    expect(run.status).toBe(0);
    // The exact vector: the code, the gateway it was told to trust and how to
    // verify it, and the file the daemon will authenticate from.
    expect(callStartingWith(run.calls, "pair ")).toBe(
      `pair ${PAIRING_CODE} --gateway-url ${GATEWAY_URL} ` +
        `--trust-fingerprint sha256:${GATEWAY_FP} ` +
        `--save ${join(run.configDir, "collector-token")}`,
    );
    // The unit carries the gateway URL, because a daemon starts with a minimal
    // environment and would otherwise browse for a gateway on every start.
    expect(callStartingWith(run.calls, "service install")).toBe(
      `service install collector --env OMNESIS_GATEWAY_URL=${GATEWAY_URL} --exec ${run.wrapper}`,
    );
    // No local gateway on this machine: exactly one unit, and no model.
    expect(run.calls.filter((call) => call.startsWith("service install"))).toHaveLength(1);
    expect(run.calls.some((call) => call.startsWith("model install"))).toBe(false);
    expect(run.output).toContain(`Collector ${DEVICE_NAME} is online.`);
    expect(run.output).toContain(`omnesis sources add --device '${DEVICE_NAME}'`);
    // Only the gateway host mints pairing codes, so no phone step here.
    expect(run.output).not.toContain("Pair a phone");
    expect(run.output).not.toContain("Connect your browser");
  });

  test("a run without a fingerprint pairs without pinning one", () => {
    const run = runInstaller("nofp", [...CODED, "--gateway-url", GATEWAY_URL]);
    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "pair ")).toBe(
      `pair ${PAIRING_CODE} --gateway-url ${GATEWAY_URL} ` +
        `--save ${join(run.configDir, "collector-token")}`,
    );
  });

  test("a trailing slash on the gateway URL never reaches the CLI", () => {
    const run = runInstaller("slash", [...CODED, "--gateway-url", `${GATEWAY_URL}/`]);
    expect(run.status).toBe(0);
    expect(callStartingWith(run.calls, "pair ")).toContain(`--gateway-url ${GATEWAY_URL} `);
  });

  test("a keyring-backed collector mints its own storage keys before pairing", () => {
    const run = runInstaller(
      "storage-keys",
      ["--collector", "--code", PAIRING_CODE, "--gateway-url", GATEWAY_URL],
      { OMNESIS_TEST_KEYRING: "ready" },
    );
    expect(run.status).toBe(0);
    const init = run.calls.indexOf("keyring init");
    const storageInit = run.calls.indexOf("keyring storage-init --host collector");
    const pair = run.calls.findIndex((call) => call.startsWith("pair "));
    expect(init).toBeGreaterThanOrEqual(0);
    // The collector's keys, not the gateway's, minted after the root key and
    // before the daemon can sync anything.
    expect(storageInit).toBeGreaterThan(init);
    expect(storageInit).toBeLessThan(pair);
    expect(run.output).toContain("Storage:  encrypted at rest (this collector's own keys)");
  });

  test("--no-keyring prepares no storage keys and says the stores are plaintext", () => {
    const run = runInstaller("plaintext", [...CODED, "--gateway-url", GATEWAY_URL]);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("keyring storage-init"))).toBe(false);
    expect(run.output).toContain("Storage:  plaintext (no keyring)");
  });

  test("the collector unit carries the passphrase wiring this run armed", () => {
    const passFile = fixturePath("keyring.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "passphrase",
      [
        "--collector",
        "--code",
        PAIRING_CODE,
        "--gateway-url",
        GATEWAY_URL,
        "--keyring-passphrase-file",
        passFile,
      ],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(0);
    const install = callStartingWith(run.calls, "service install");
    expect(install).toContain("service install collector");
    expect(install).toContain("--secret-store passphrase");
    expect(install).toContain(passFile);
    // The storage keys are sealed by the same passphrase backend.
    expect(run.calls).toContain("keyring storage-init --host collector --backend passphrase");
    expect(run.output).toContain("Storage:  encrypted at rest (this collector's own keys)");
  });
});

describe("install.sh --collector: finding the gateway", () => {
  test.skipIf(!HAS_PTY)("a discovered gateway is confirmed before anything is paired", () => {
    const run = runInstallerOnTty(
      "discover-yes",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE],
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
    expect(run.output).toContain(`sha256:${GATEWAY_FP}`);
    // The advertised fingerprint becomes the pin: verifying what answered is
    // strictly better than trusting it on sight.
    expect(callStartingWith(run.calls, "pair ")).toBe(
      `pair ${PAIRING_CODE} --gateway-url ${GATEWAY_URL} ` +
        `--trust-fingerprint sha256:${GATEWAY_FP} ` +
        `--save ${join(run.configDir, "collector-token")}`,
    );
  });

  test.skipIf(!HAS_PTY)("a fingerprint the operator brought outranks the advertised one", () => {
    const typed = "b".repeat(64);
    const run = runInstallerOnTty(
      "discover-pin",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE, "--trust-fingerprint", typed],
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
    expect(callStartingWith(run.calls, "pair ")).toContain(`--trust-fingerprint ${typed}`);
  });

  test.skipIf(!HAS_PTY)("declining the discovered gateway pairs nothing", () => {
    const run = runInstallerOnTty(
      "discover-no",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE],
      ["n"],
      {
        OMNESIS_TEST_DISCOVER: discoveryAnswer("hit", {
          found: true,
          url: GATEWAY_URL,
          name: "gateway-host",
          fingerprint: `sha256:${GATEWAY_FP}`,
        }),
      },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("Stopped without pairing");
    expect(run.output).toContain("--gateway-url <url>");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("a gateway advertising no fingerprint is paired without a pin", () => {
    const run = runInstallerOnTty(
      "discover-nofp",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE],
      ["y"],
      {
        OMNESIS_TEST_DISCOVER: discoveryAnswer("nofp", {
          found: true,
          url: GATEWAY_URL,
          name: "gateway-host",
        }),
      },
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("(none advertised)");
    expect(callStartingWith(run.calls, "pair ")).toBe(
      `pair ${PAIRING_CODE} --gateway-url ${GATEWAY_URL} ` +
        `--save ${join(run.configDir, "collector-token")}`,
    );
  });

  test("a record that answers without a URL is nothing at all", () => {
    const run = runInstaller(
      "discover-nourl",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE],
      { OMNESIS_TEST_DISCOVER: discoveryAnswer("nourl", { found: true, name: "gateway-host" }) },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("No gateway answered on this LAN");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });

  test("nothing on the LAN is an honest refusal, not a guess", () => {
    const run = runInstaller("discover-miss", [
      "--collector",
      "--no-keyring",
      "--code",
      PAIRING_CODE,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No gateway answered on this LAN");
    expect(run.output).toContain("--gateway-url https://<gateway-host>:7600");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });

  test("a hit with no terminal to confirm it on refuses and names the flag", () => {
    const run = runInstaller(
      "discover-notty",
      ["--collector", "--no-keyring", "--code", PAIRING_CODE],
      {
        OMNESIS_TEST_DISCOVER: discoveryAnswer("hit", {
          found: true,
          url: GATEWAY_URL,
          name: "gateway-host",
          fingerprint: `sha256:${GATEWAY_FP}`,
        }),
      },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain(`--gateway-url ${GATEWAY_URL}`);
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });
});

describe("install.sh --collector: the pairing code", () => {
  test.skipIf(!HAS_PTY)("is asked for on the terminal when no --code was given", () => {
    const run = runInstallerOnTty(
      "code-prompt",
      ["--collector", "--no-keyring", "--gateway-url", GATEWAY_URL],
      [PAIRING_CODE],
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("omnesis devices pair --kind collector");
    expect(callStartingWith(run.calls, "pair ")).toContain(`pair ${PAIRING_CODE} `);
  });

  test.skipIf(!HAS_PTY)("an empty answer stops rather than pairing with nothing", () => {
    const run = runInstallerOnTty(
      "code-empty",
      ["--collector", "--no-keyring", "--gateway-url", GATEWAY_URL],
      [""],
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("No pairing code entered");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });

  test("no terminal and no --code is a refusal that names --code", () => {
    const run = runInstaller("code-notty", [
      "--collector",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No terminal to ask for the pairing code");
    expect(run.output).toContain("--code <code>");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
  });

  test("a refused code stops before anything is registered", () => {
    const run = runInstaller("code-bad", [...CODED, "--gateway-url", GATEWAY_URL], {
      OMNESIS_TEST_PAIR_FAIL: "1",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("Pairing failed");
    expect(run.output).toContain("omnesis devices pair --kind collector");
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
  });

  test("an unreachable gateway is not blamed on the pairing code", () => {
    const run = runInstaller("code-gateway-down", [...CODED, "--gateway-url", GATEWAY_URL], {
      OMNESIS_TEST_PAIR_FAIL: "64",
    });
    expect(run.status).toBe(1);
    // The redeem never reached the gateway, so the code was not consumed.
    // Advising a fresh one sends the operator round in a circle, re-minting
    // codes while the port stays shut.
    expect(run.output).toContain("could not be reached");
    expect(run.output).toContain("your code was not used");
    expect(run.output).not.toContain("single-use and short-lived");
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
  });
});

describe("install.sh --collector: degrading honestly", () => {
  test("--no-service pairs and hands back the command to run the daemon", () => {
    const run = runInstaller("noservice", [...CODED, "--gateway-url", GATEWAY_URL, "--no-service"]);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(true);
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
    expect(run.output).toContain(`OMNESIS_GATEWAY_URL=${GATEWAY_URL} omnesis collector run`);
    expect(run.output).not.toContain("is online.");
  });

  test("a headless collector with no keyring is offered the flag it can accept", () => {
    // A collector host holds a device token worth sealing, and headless is
    // where no OS keyring exists — so the remedy names the passphrase file
    // rather than the client-install wording, which refuses that flag.
    const run = runInstaller(
      "keyring-remedy",
      ["--collector", "--code", PAIRING_CODE, "--gateway-url", GATEWAY_URL],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("--keyring-passphrase-file <abs-path>");
    expect(run.output).toContain("--no-keyring");
    expect(run.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });

  test("a pairing record an earlier install left is not this run's evidence", () => {
    // Re-pairing the same machine to the same gateway is the repair flow; the
    // record from last time would otherwise satisfy the wait on its first poll.
    const home = fixturePath("home-stale-same");
    mkdirSync(join(home, ".config", "omnesis"), { recursive: true });
    writeFileSync(
      join(home, ".config", "omnesis", "collector-pairing-state.json"),
      `${JSON.stringify({
        state: "paired",
        deviceName: "an-earlier-install",
        gatewayUrl: GATEWAY_URL,
        tokenFingerprint: "0123456789abcdef",
        lastAuthenticatedAt: 1,
        unauthorizedAt: null,
        repairCommand: null,
      })}\n`,
    );
    const run = runInstaller("stale-same", [...CODED, "--gateway-url", GATEWAY_URL], {
      OMNESIS_TEST_COLLECTOR_ONLINE: "",
      OMNESIS_COLLECTOR_WAIT_SECONDS: "1",
    });
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("an-earlier-install");
    expect(run.output).not.toContain("is online.");
  });

  test("a collector the gateway never accepts is not announced as online", () => {
    const run = runInstaller("offline", [...CODED, "--gateway-url", GATEWAY_URL], {
      OMNESIS_TEST_COLLECTOR_ONLINE: "",
      OMNESIS_COLLECTOR_WAIT_SECONDS: "1",
    });
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("is online.");
    expect(run.output).toContain("omnesis service logs collector");
  });

  test("a pairing record about a different gateway is not this run's evidence", () => {
    const run = runInstaller("stale", [...CODED, "--gateway-url", GATEWAY_URL], {
      OMNESIS_TEST_COLLECTOR_ONLINE: "https://an-older-gateway.example.org:7600",
      OMNESIS_COLLECTOR_WAIT_SECONDS: "1",
    });
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("is online.");
  });
});

describe("install.sh --collector: refused combinations", () => {
  const refusal = (name, args, needle, extraEnv = {}) => {
    const run = runInstaller(name, args, extraEnv);
    expect(run.status).toBe(1);
    expect(run.output).toContain(needle);
    expect(run.calls).toEqual([]);
  };

  test("--collector is a role of its own, not a modifier on --client-only", () => {
    refusal(
      "with-client-only",
      ["--collector", "--client-only"],
      "--client-only cannot be combined",
    );
  });

  test("--port and --mkcert configure a local gateway this machine will not run", () => {
    refusal(
      "with-port",
      ["--collector", "--port", "8443"],
      "--port sets the port of a LOCAL gateway",
    );
    refusal("with-mkcert", ["--collector", "--mkcert"], "--mkcert provisions a certificate");
  });

  test("--embedder names a model a collector never downloads", () => {
    refusal(
      "with-embedder",
      ["--collector", "--embedder", "nomic-embed-text-v1.5.Q8_0"],
      "cannot be combined with --no-model, --client-only, --collector, --openclaw or --hermes",
    );
  });

  test("the collector flags mean nothing without the role", () => {
    refusal("url-alone", ["--gateway-url", GATEWAY_URL], "--gateway-url is only meaningful");
    refusal(
      "fp-alone",
      ["--trust-fingerprint", `sha256:${GATEWAY_FP}`],
      "--trust-fingerprint is only meaningful",
    );
    refusal("code-alone", ["--code", PAIRING_CODE], "--code is only meaningful");
  });

  test("the collector's own wait and discovery knobs must be numbers", () => {
    // Left unvalidated, a typo here surfaces as "No gateway answered on this
    // LAN" — a wrong diagnosis of a mistyped environment variable.
    refusal(
      "bad-wait",
      [...CODED, "--gateway-url", GATEWAY_URL],
      "OMNESIS_COLLECTOR_WAIT_SECONDS must be a positive whole number",
      { OMNESIS_COLLECTOR_WAIT_SECONDS: "soon" },
    );
    refusal(
      "bad-discover",
      [...CODED, "--gateway-url", GATEWAY_URL],
      "OMNESIS_DISCOVER_MS must be a positive whole number",
      { OMNESIS_DISCOVER_MS: "0" },
    );
  });

  test("--client-only still refuses the flags it always refused", () => {
    refusal(
      "client-port",
      ["--client-only", "--port", "8443"],
      "--port cannot be used with --client-only",
    );
    refusal(
      "client-mkcert",
      ["--client-only", "--mkcert"],
      "--mkcert cannot be used with --client-only",
    );
  });
});

describe("install.sh --collector: the script itself", () => {
  test("stays POSIX sh and keeps main() on the last line", () => {
    const script = readFileSync(installer, "utf8");
    expect(spawnSync("sh", ["-n", installer]).status).toBe(0);
    expect(script.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });

  test("--help prints the whole header block and no code", () => {
    // The help text is a line range over this file's own header, so it drifts
    // silently the moment a flag is documented above it.
    const help = spawnSync("sh", [installer, "--help"], { encoding: "utf8" }).stdout ?? "";
    expect(help).toContain("--collector");
    expect(help).toContain("--gateway-url <url>");
    expect(help).toContain("--trust-fingerprint sha256:");
    expect(help).toContain("--code <code>");
    expect(help.trimEnd().endsWith("# download executes nothing.")).toBe(true);
    expect(help).not.toContain("set -eu");
  });
});
