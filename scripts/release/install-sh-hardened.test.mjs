// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * install.sh's dedicated gateway account: `--hardened`, `--no-hardened`, and
 * the question a terminal install on a systemd host is asked.
 *
 * The dedicated gateway runs from a release root fetches and owns, so the
 * installer's part is to have the CLI print the one root command that installs
 * it, and to say how to administer it. The CLI is the harness's recording shim,
 * so what the installer asks the CLI to do is read from `run.calls`; nothing is
 * installed as a system unit and no sudo is ever run. The harness plants a
 * `systemctl` that answers like a host without systemd; `installSystemd` makes
 * it answer like one. The installer also looks for `/run/systemd/system`, which
 * no fake can supply, so the runs that need a systemd host skip themselves on a
 * machine without one.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  installSystemd,
  runInstaller,
  runInstallerOnTty,
} from "./installer-harness.mjs";

const LINUX = process.platform === "linux";
const SYSTEMD_HOST = LINUX && existsSync("/run/systemd/system");

/**
 * The recording CLI shim. `pair` saves a token and `service install` writes the
 * record a collector daemon writes once the gateway accepts it, so the
 * collector role can run to completion on the same home as a hardened gateway.
 */
const CLI_SHIM = `#!/bin/sh
shift 2>/dev/null || true
printf '%s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
case "$1" in
  --version) echo "0.10.0" ;;
  keyring)
    case "$2" in
      status) echo '{"store":{"available":false,"secure":false,"detail":"no usable keyring"}}' ;;
      *) : ;;
    esac
    ;;
  pair)
    mkdir -p "$HOME/.config/omnesis"
    printf 'fake-device-token\\n' > "$HOME/.config/omnesis/collector-token"
    ;;
  service)
    if [ "$2" = install ] && [ "$3" = gateway ] && [ "$4" = --hardened ]; then
      echo "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --version 0.10.0"
    fi
    if [ "$2" = install ] && [ "$3" = collector ] && [ -n "\${OMNESIS_TEST_COLLECTOR_ONLINE:-}" ]; then
      mkdir -p "$HOME/.config/omnesis"
      printf '{"state":"paired","deviceName":"studio-collector","gatewayUrl":"%s","tokenFingerprint":"0123456789abcdef","lastAuthenticatedAt":1,"unauthorizedAt":null,"repairCommand":null}\\n' \\
        "$OMNESIS_TEST_COLLECTOR_ONLINE" > "$HOME/.config/omnesis/collector-pairing-state.json"
    fi
    ;;
  *) : ;;
esac
exit 0
`;

/** Answers every other question, so a terminal run asks only about the account. */
const QUIET = ["--no-tls", "--no-model", "--no-keyring"];
const QUESTION = "Which account should run the gateway?";

/** Plant a file under the home a run of this name will use, before it runs. */
function plant(name, relativePath, content = "") {
  const path = fixturePath(`home-${name}`, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  createFixture({ name: "hardened", versions: ["0.9.0", "0.10.0"], cliShim: CLI_SHIM });
});

afterEach(destroyFixture);

describe("install.sh --hardened", () => {
  test.skipIf(!SYSTEMD_HOST)(
    "has the CLI print the root command, says how to administer it, and registers nothing for this account",
    () => {
      installSystemd();
      writeFileSync(fixturePath("fake-bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const run = runInstaller("printed", ["--hardened"]);
      expect(run.status, run.output).toBe(0);
      expect(run.calls).toContain("service install gateway --hardened");
      expect(run.output).toContain(
        "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --version 0.10.0",
      );
      // The passphrase belongs to root now: nothing is written under this account.
      expect(existsSync(join(run.configDir, "hardened-gateway.pass"))).toBe(false);
      expect(run.output).toContain("readable by root alone");
      // Root administers it through the admin command, never this account's CLI.
      expect(run.output).toContain(
        "sudo omnesis-gateway-admin cli keyring export-recovery --backend passphrase",
      );
      expect(run.output).toContain("sudo omnesis-gateway-admin cli devices pair --kind collector");
      expect(run.output).not.toContain("sudo env");
      expect(run.output).not.toMatch(/sudo [^\n]*\.local\/bin\/omnesis/);
      // No keyring is set up under this account for a gateway that is not its own.
      expect(run.calls.some((call) => call.startsWith("keyring"))).toBe(false);
      // No user units, no model or certificate for an account the gateway is not.
      expect(run.calls.some((call) => call.startsWith("service install --exec"))).toBe(false);
      expect(run.calls.some((call) => call.startsWith("model install"))).toBe(false);
      expect(run.output).not.toContain(["Set up the agent with Codex", "Luna"].join(" "));
      expect(run.calls.some((call) => call.startsWith("codex "))).toBe(false);
      expect(run.envFile()).not.toContain("OMNESIS_TLS_CERT");
      expect(run.output).toContain("the dedicated gateway waits for the root command above");
      expect(run.output).toContain("where only root can change it");
      expect(run.output).toContain(
        "--collector --gateway-url https://localhost:7600 --trust-fingerprint sha256:<fingerprint> --code <code>",
      );
      expect(run.output).not.toContain(QUESTION);
    },
  );

  test.skipIf(!SYSTEMD_HOST)(
    "this account's collector then joins the dedicated gateway through the collector role, as itself",
    () => {
      installSystemd();
      const gateway = runInstaller("same-host", ["--hardened"]);
      expect(gateway.status, gateway.output).toBe(0);

      const fingerprint = `sha256:${"b".repeat(64)}`;
      const collector = runInstaller(
        "same-host",
        [
          "--collector",
          "--no-keyring",
          "--gateway-url",
          "https://localhost:7600",
          "--trust-fingerprint",
          fingerprint,
          "--code",
          "K7QX2M9ZB4",
        ],
        {
          OMNESIS_TEST_COLLECTOR_ONLINE: "https://localhost:7600",
          OMNESIS_COLLECTOR_WAIT_SECONDS: "5",
        },
      );
      expect(collector.status, collector.output).toBe(0);
      expect(collector.calls).toContain(
        `pair K7QX2M9ZB4 --gateway-url https://localhost:7600 --trust-fingerprint ${fingerprint} --save ${join(collector.configDir, "collector-token")}`,
      );
      expect(collector.calls.some((call) => call.startsWith("service install collector"))).toBe(
        true,
      );
      expect(collector.calls.some((call) => call.includes("--hardened"))).toBe(false);
      expect(collector.output).toContain("Collector studio-collector is online.");
    },
  );

  test.skipIf(!SYSTEMD_HOST)(
    "a named passphrase file and --no-keyring reach the printed command",
    () => {
      installSystemd();
      const named = fixturePath("operator.pass");
      writeFileSync(named, "a-fictional-passphrase\n", { mode: 0o600 });
      const withFile = runInstaller("named-pass", [
        "--hardened",
        "--keyring-passphrase-file",
        named,
      ]);
      expect(withFile.status, withFile.output).toBe(0);
      expect(withFile.calls).toContain(
        `service install gateway --hardened --keyring-passphrase-file ${named}`,
      );

      const without = runInstaller("no-keyring", ["--hardened", "--no-keyring"]);
      expect(without.status, without.output).toBe(0);
      expect(without.calls).toContain("service install gateway --hardened --no-keyring");
      expect(without.output).toContain("It runs without encryption at rest (--no-keyring).");
      expect(without.output).not.toContain("keyring export-recovery");
    },
  );

  test.skipIf(!SYSTEMD_HOST)("a --port reaches the printed command and the pairing line", () => {
    installSystemd();
    const run = runInstaller("port", ["--hardened", "--no-keyring", "--port", "8443"]);
    expect(run.status, run.output).toBe(0);
    expect(run.calls).toContain(
      "service install gateway --hardened --env OMNESIS_GATEWAY_PORT=8443 --no-keyring",
    );
    expect(run.output).toContain(
      "--gateway-url https://localhost:8443 --trust-fingerprint sha256:<fingerprint> --code <code>",
    );
  });

  test.skipIf(!SYSTEMD_HOST)(
    "is not refused where home directories are closed to other accounts, since the gateway runs nothing from them",
    () => {
      installSystemd();
      plant("closed-home", ".profile");
      chmodSync(fixturePath("home-closed-home"), 0o750);
      const run = runInstaller("closed-home", ["--hardened"]);
      expect(run.status, run.output).toBe(0);
      expect(run.calls).toContain("service install gateway --hardened");
      expect(run.output).not.toContain("which other accounts cannot enter");
    },
  );

  test.skipIf(!LINUX)(
    "is refused on a host systemd does not supervise, before anything is installed",
    () => {
      const run = runInstaller("no-systemd", ["--hardened"]);
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("needs systemd supervising this host");
      expect(run.calls).toEqual([]);
    },
  );

  test.skipIf(!SYSTEMD_HOST)(
    "is refused while this account's gateway service is registered, and says what each choice means",
    () => {
      installSystemd();
      plant("registered", ".config/systemd/user/omnesis-gateway.service", "[Unit]\n");
      const run = runInstaller("registered", ["--hardened"]);
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("A gateway service of this account is registered");
      expect(run.output).toContain("nothing is moved, devices pair again and sources sync again");
      expect(run.output).toContain("omnesis service uninstall gateway");
      expect(run.calls).toEqual([]);
    },
  );

  test.skipIf(!SYSTEMD_HOST)(
    "an installed dedicated gateway refuses a gateway under this account, and --hardened prints the command that moves it",
    () => {
      installSystemd({ dedicatedGateway: true });
      const beside = runInstaller("dedicated-present", QUIET);
      expect(beside.status).not.toBe(0);
      expect(beside.output).toContain("A dedicated-account gateway is installed on this host");
      expect(beside.output).toContain("sudo omnesis-gateway-admin uninstall");
      expect(beside.calls).toEqual([]);

      const moved = runInstaller("dedicated-move", ["--hardened"]);
      expect(moved.status, moved.output).toBe(0);
      expect(moved.output).toContain("moves it to this release and keeps its state");
      expect(moved.calls).toContain("service install gateway --hardened");
    },
  );

  test.skipIf(!SYSTEMD_HOST)("leaves an earlier gateway's data where it is, and says so", () => {
    installSystemd();
    plant("earlier", ".config/omnesis/omnesis.db");
    const run = runInstaller("earlier", ["--hardened"]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("holds an earlier gateway's data");
    expect(run.output).toContain("does not read it; it stays where it is");
  });

  test.each([
    [["--hardened", "--no-hardened"], "answer the same question two ways"],
    [["--hardened", "--docker"], "different boundaries, not two spellings of one"],
    [["--hardened", "--client-only"], "--client-only installs none"],
    [
      [
        "--hardened",
        "--collector",
        "--gateway-url",
        "https://gateway.example.test:7600",
        "--code",
        "ABC123DEF4",
      ],
      "a collector stays under the account whose data it reads",
    ],
    [["--hardened", "--no-service"], "--no-service registers none"],
    [["--hardened", "--mkcert"], "which the dedicated gateway account cannot read"],
    [
      ["--hardened", "--keyring-passphrase-file", "keyring.pass"],
      "must be an absolute path under --hardened",
    ],
  ])("%j is refused with its reason, before anything is installed", (args, reason) => {
    const run = runInstaller(`refused-${args.length}-${reason.length}`, args);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(reason);
    expect(run.calls).toEqual([]);
  });

  test("the help names both flags", () => {
    const run = runInstaller("help", ["--help"]);
    expect(run.status).toBe(0);
    expect(run.output).toContain("--hardened");
    expect(run.output).toContain("--no-hardened");
  });
});

describe("install.sh gateway account question", () => {
  test.skipIf(!HAS_PTY || !SYSTEMD_HOST)(
    "a terminal install on a systemd host is asked, and answering 2 prints the root command",
    () => {
      installSystemd();
      const run = runInstallerOnTty("offer-dedicated", QUIET, ["2"]);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(QUESTION);
      expect(run.output).toContain("It does not protect");
      expect(run.output).toContain("only root can change");
      expect(run.calls).toContain("service install gateway --hardened --no-keyring");
    },
  );

  test.skipIf(!HAS_PTY || !SYSTEMD_HOST)(
    "the default answer keeps the gateway under this account",
    () => {
      installSystemd();
      const run = runInstallerOnTty("offer-default", QUIET, [""]);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(QUESTION);
      expect(run.calls).toContain(`service install --exec ${run.wrapper}`);
      expect(run.calls.some((call) => call.includes("--hardened"))).toBe(false);
    },
  );

  test.skipIf(!HAS_PTY || !SYSTEMD_HOST)(
    "is not skipped on a host whose home directories are closed to other accounts",
    () => {
      installSystemd();
      plant("offer-closed", ".profile");
      chmodSync(fixturePath("home-offer-closed"), 0o750);
      const run = runInstallerOnTty("offer-closed", QUIET, [""]);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(QUESTION);
    },
  );

  test.skipIf(!HAS_PTY)(
    "is not asked without systemd, with --no-hardened, or where this account already has a gateway",
    () => {
      const noSystemd = runInstallerOnTty("offer-no-systemd", QUIET, []);
      expect(noSystemd.status, noSystemd.output).toBe(0);
      expect(noSystemd.output).not.toContain(QUESTION);

      installSystemd();
      const declined = runInstallerOnTty("offer-declined", [...QUIET, "--no-hardened"], []);
      expect(declined.status, declined.output).toBe(0);
      expect(declined.output).not.toContain(QUESTION);

      plant("offer-existing", ".config/omnesis/omnesis.db");
      const existing = runInstallerOnTty("offer-existing", QUIET, []);
      expect(existing.status, existing.output).toBe(0);
      expect(existing.output).not.toContain(QUESTION);

      plant("offer-docker", ".config/omnesis/install-method", "docker\n");
      const docker = runInstallerOnTty("offer-docker", QUIET, []);
      expect(docker.output).not.toContain(QUESTION);
    },
  );
});
