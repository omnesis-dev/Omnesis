// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("install.sh NodeSource setup hardening", () => {
  const installScript = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");

  test("does not execute a fixed /tmp NodeSource script as root", () => {
    expect(installScript).not.toContain("/tmp/nodesource_setup.sh");
    expect(installScript).not.toContain("$SUDO -E bash");
  });

  test("downloads NodeSource setup into a private verified temp directory", () => {
    expect(installScript).toContain('mktemp -d "$TMP_PARENT/omnesis-nodesource.XXXXXX"');
    expect(installScript).toContain('chmod 700 "$NODESOURCE_TMP_DIR"');
    expect(installScript).toContain("stat -c '%u:%a'");
    expect(installScript).toContain('chmod 600 "$NODESOURCE_SETUP"');
    expect(installScript).toContain(
      'run_privileged env DEBIAN_FRONTEND=noninteractive bash "$NODESOURCE_SETUP"',
    );
  });

  test("bounds the fixed HTTPS fetch and validates its raw script shape before sudo", () => {
    expect(installScript).toContain('--connect-timeout "$NETWORK_TIMEOUT_SECONDS"');
    expect(installScript).toContain('--speed-limit 1 --speed-time "$NETWORK_TIMEOUT_SECONDS"');
    expect(installScript).toContain("--retry 3 --retry-delay 1 --retry-connrefused");
    expect(installScript).toContain("--proto '=https' --tlsv1.2");
    expect(installScript).toContain('od -An -tx1 -N2 "$NODESOURCE_SETUP"');
    expect(installScript).toContain('[ "$NODESOURCE_MAGIC" = 2321 ]');
    expect(installScript.indexOf("NODESOURCE_MAGIC=")).toBeLessThan(
      installScript.indexOf(
        'run_privileged env DEBIAN_FRONTEND=noninteractive bash "$NODESOURCE_SETUP"',
      ),
    );
  });

  test("passes noninteractive apt behavior through the privilege boundary", () => {
    expect(installScript).toContain(
      'run_privileged env DEBIAN_FRONTEND=noninteractive apt-get "$@"',
    );
    expect(installScript).toContain('"$SUDO" -n "$@"');
    expect(installScript).not.toContain("NEEDRESTART_MODE=a");
  });
});

describe("the entry package name", () => {
  // The installer installs one npm package and the updater looks for the
  // same one; the two literals live in different languages, so nothing but
  // this keeps a rename from producing an installer that fetches a package
  // the updater never finds.
  test("is one literal across the installer, the updater and the package manifest", () => {
    const installScript = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
    const releaseCheck = readFileSync(
      join(repoRoot, "packages", "core", "src", "release-check.ts"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    );
    const shell = /^CLI_PKG="([^"]+)"$/mu.exec(installScript)?.[1];
    const typescript = /^export const CLI_PACKAGE = "([^"]+)";$/mu.exec(releaseCheck)?.[1];
    expect(shell).toBeDefined();
    expect(typescript).toBeDefined();
    expect(shell).toBe(typescript);
    expect(manifest.name).toBe(typescript);
  });
});
