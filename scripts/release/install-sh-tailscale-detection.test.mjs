// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const cliFunctions = installer.slice(
  installer.indexOf("tailscale_cli() {"),
  installer.indexOf("provision_tls() {"),
);

describe("install.sh Tailscale CLI detection", () => {
  test("finds a connected macOS app when the PATH CLI is disconnected", () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-tailscale-detection-"));
    try {
      const bin = join(home, "bin");
      const app = join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale");
      mkdirSync(bin);
      mkdirSync(dirname(app), { recursive: true });
      writeFileSync(
        join(bin, "tailscale"),
        '#!/bin/sh\nprintf \'{"BackendState":"NeedsLogin"}\\n\'\n',
      );
      writeFileSync(
        app,
        '#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1\n[ "$1" = status ] || exit 1\nif [ "$2" = --json ]; then printf \'{"BackendState":"Running"}\\n\'; else printf "connected\\n"; fi\n',
      );
      chmodSync(join(bin, "tailscale"), 0o755);
      chmodSync(app, 0o755);
      const output = execFileSync(
        "sh",
        ["-c", `${cliFunctions}\nPLATFORM=darwin\nfind_tailscale_cli && tailscale_cli status`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            // Where /Applications and Homebrew are looked for: never the
            // machine's own Tailscale.
            OMNESIS_TEST_TAILSCALE_ROOT: join(home, "root"),
          },
        },
      );
      expect(output).toBe("connected\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("finds Homebrew's CLI by absolute path when PATH does not reach it", () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-tailscale-detection-"));
    try {
      // PATH as a launchd job's: node's bin dir and the system's, no Homebrew bin.
      const brew = join(home, "opt/homebrew/bin");
      mkdirSync(brew, { recursive: true });
      writeFileSync(
        join(brew, "tailscale"),
        '#!/bin/sh\n[ "$1" = status ] || exit 1\nif [ "$2" = --json ]; then printf \'{"BackendState":"Running"}\\n\'; else printf "brew\\n"; fi\n',
      );
      chmodSync(join(brew, "tailscale"), 0o755);
      const detect = `${cliFunctions}\nPLATFORM=darwin\nfind_tailscale_cli && tailscale_cli status`;
      const output = execFileSync("sh", ["-c", detect], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          // Homebrew's prefixes, and /Applications, are looked for under here.
          OMNESIS_TEST_TAILSCALE_ROOT: home,
        },
      });
      expect(output).toBe("brew\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
