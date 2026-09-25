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
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(output).toBe("connected\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
