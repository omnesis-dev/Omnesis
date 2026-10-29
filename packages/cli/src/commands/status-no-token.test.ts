// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_AUTH } from "@omnesis/cli-shared";
import { missingTokenMessage } from "../utils.js";

const GATEWAY = "https://gateway.example.com:7600";

describe("a command that needs the gateway's admin token, where there is none", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-no-token-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("on a machine paired as a collector, sends the operator to the gateway host or portal", () => {
    writeFileSync(join(configDir, "collector-token"), "fictional-collector-token\n", {
      mode: 0o600,
    });
    const message = missingTokenMessage(configDir, `${GATEWAY}/`);
    expect(message).toContain("as a collector");
    expect(message).toContain("Run this command on the gateway host");
    expect(message).toContain(`${GATEWAY}/portal/`);
    expect(message).not.toContain("Start the gateway first");
  });

  it("anywhere else, still says to start the gateway", () => {
    expect(missingTokenMessage(configDir, GATEWAY)).toContain("Start the gateway first");
  });

  describe("omnesis status", () => {
    const execFileAsync = promisify(execFile);
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

    async function status(): Promise<{ code: number; stderr: string }> {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_GATEWAY_URL: GATEWAY,
      };
      delete env.OMNESIS_TOKEN;
      try {
        const { stderr } = await execFileAsync("npx", ["tsx", entry, "status"], { env });
        return { code: 0, stderr };
      } catch (err) {
        const e = err as { code?: number; stderr?: string };
        return { code: e.code ?? 1, stderr: e.stderr ?? "" };
      }
    }

    it("fails with the message alone on a collector-only host, not a stack trace", async () => {
      writeFileSync(join(configDir, "collector-token"), "fictional-collector-token\n", {
        mode: 0o600,
      });
      const { code, stderr } = await status();
      expect(code).toBe(EXIT_AUTH);
      expect(stderr).toContain("as a collector");
      expect(stderr).not.toMatch(/^\s+at /mu);
    }, 60_000);
  });
});
