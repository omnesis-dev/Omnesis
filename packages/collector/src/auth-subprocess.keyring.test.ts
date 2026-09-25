// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The auth subprocess must say so when it cannot reach the install root key.
 *
 * `keyringUnavailableNotice` is unit-tested next to the other emitters; what
 * this covers is the wiring the script does around it, which is where the
 * original defect lived: `primeSecretFileKeyCache` answers `false` rather than
 * throwing, and the script used to discard that answer entirely. Only running
 * the real script proves the answer is still read.
 *
 * The child is driven with a descriptor id that does not exist, so it emits the
 * notice, reports the unknown descriptor, and exits — no provider, no network,
 * no auth flow.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveSubprocessEntry, secureMarkerPath } from "@omnesis/core";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config dir that requires secret-file encryption but holds no root key. */
function configDirRequiringEncryption(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-auth-keyring-"));
  dirs.push(dir);
  // The marker's presence is the "encryption is in use" signal. Its path comes
  // from the same helper the reader uses, so a rename cannot leave this fixture
  // quietly writing a file nothing looks for.
  const marker = secureMarkerPath("secret-files", dir);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "omnesis.secret-files.required.v1\n");
  return dir;
}

function runSubprocess(configDir: string): Promise<{ stderr: string; code: number | null }> {
  const entry = resolveSubprocessEntry("./auth-subprocess.ts", import.meta.url);
  const child = spawn(entry.command, [...entry.args, "no-such-source"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: import.meta.dirname,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      OMNESIS_CONFIG_DIR: configDir,
      // Name a backend with no passphrase anywhere: the root key cannot be
      // unsealed, which is exactly the state the notice exists to report.
      OMNESIS_SECRET_STORE: "passphrase",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stderr, code }));
  });
}

describe("auth subprocess keyring diagnostics", () => {
  test(
    "names the unreachable root key on stderr before the flow fails",
    { timeout: 60_000 },
    async () => {
      const { stderr } = await runSubprocess(configDirRequiringEncryption());
      expect(stderr).toContain("install root key unavailable");
      expect(stderr).toContain("passphrase");
    },
  );

  test("stays quiet on an install that encrypts nothing", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-auth-plain-"));
    dirs.push(dir);
    const { stderr } = await runSubprocess(dir);
    expect(stderr).not.toContain("install root key unavailable");
  });
});
