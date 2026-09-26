// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installScript = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");

describe("install.sh client-only mode", () => {
  test("turns off every local server responsibility", () => {
    expect(installScript).toContain(
      "--client-only) CLIENT_ONLY=1; CLIENT_ONLY_FLAG=1; WANT_SERVICE=0; WANT_MODEL=0; WANT_TLS=0; shift ;;",
    );
  });

  test("returns after client keyring setup and before gateway provisioning", () => {
    // Anchored on the branch itself, not merely on the flag: the flag is read
    // in several helpers and validated in main() before this point, and only
    // this branch decides what a client install skips.
    const mainStart = installScript.indexOf("main() {");
    expect(mainStart).toBeGreaterThan(0);
    const clientBranch = installScript.indexOf('if [ "$CLIENT_ONLY" = 1 ]; then\n', mainStart);
    const tlsCall = installScript.indexOf("  provision_tls", clientBranch);
    expect(clientBranch).toBeGreaterThan(0);
    expect(installScript.slice(clientBranch, tlsCall)).toContain("setup_keyring_init");
    expect(installScript.slice(clientBranch, tlsCall)).toContain("print_client_banner");
    expect(installScript.slice(clientBranch, tlsCall)).toContain("return 0");
    expect(installScript.slice(clientBranch, tlsCall)).not.toContain("start_services");
    expect(installScript.slice(clientBranch, tlsCall)).not.toContain("install_model");
  });

  test("uses the ordinary config directory now that no local MCP profile exists", () => {
    expect(installScript).not.toContain("omnesis-mcp");
  });

  test("does not describe the client as a stopped server installation", () => {
    expect(installScript).toContain("Omnesis client is installed.");
    expect(installScript).toContain("will not run a gateway, collector, or embedding model");
  });

  test("rejects server-only and headless-secret flags", () => {
    expect(installScript).toContain("--port cannot be used with --client-only.");
    expect(installScript).toContain("--mkcert cannot be used with --client-only.");
    expect(installScript).toContain("--keyring-passphrase-file cannot be used with --client-only.");
  });
});
