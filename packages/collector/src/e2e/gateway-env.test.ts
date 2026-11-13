// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { e2eGatewayEnv, e2eTsxCommand } from "./gateway-env.js";

describe("e2eGatewayEnv", () => {
  test("uses small pools for synthetic gateway processes", () => {
    const env = e2eGatewayEnv({});

    expect(env).toMatchObject({
      OMNESIS_IO_CONCURRENCY: "2",
      OMNESIS_CPU_CONCURRENCY: "2",
      OMNESIS_SEARCH_WORKER_CONCURRENCY: "1",
      OMNESIS_USEARCH_BACKFILL_THREADS: "1",
    });
  });

  test("preserves explicit overrides without mutating the caller", () => {
    const base = {
      OMNESIS_CPU_CONCURRENCY: "4",
      OMNESIS_SEARCH_WORKER_CONCURRENCY: "3",
      KEEP_ME: "yes",
    };

    const env = e2eGatewayEnv(base);

    expect(env.OMNESIS_CPU_CONCURRENCY).toBe("4");
    expect(env.OMNESIS_SEARCH_WORKER_CONCURRENCY).toBe("3");
    expect(env.KEEP_ME).toBe("yes");
    expect(base).not.toHaveProperty("OMNESIS_IO_CONCURRENCY");
  });

  test("does not pass ambient feature gates into a spawned gateway", () => {
    const base = {
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_EXPERIMENTAL: "1",
      KEEP_ME: "yes",
    };

    const env = e2eGatewayEnv(base);

    expect(env).not.toHaveProperty("OMNESIS_SYNTHETIC");
    expect(env).not.toHaveProperty("OMNESIS_EXPERIMENTAL");
    expect(env.KEEP_ME).toBe("yes");
    expect(base).toEqual({
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_EXPERIMENTAL: "1",
      KEEP_ME: "yes",
    });
  });

  test("always suppresses the gateway's external release lookup", () => {
    expect(e2eGatewayEnv({ OMNESIS_E2E_DISABLE_RELEASE_CHECK: "0" })).toMatchObject({
      OMNESIS_E2E_DISABLE_RELEASE_CHECK: "1",
    });
  });

  test("always suppresses the gateway's hosted icon fetches", () => {
    expect(e2eGatewayEnv({ OMNESIS_E2E_DISABLE_ICON_FETCH: "0" })).toMatchObject({
      OMNESIS_E2E_DISABLE_ICON_FETCH: "1",
    });
  });

  test("keeps a spawned gateway off the public CT provider unless a harness opts in", () => {
    expect(e2eGatewayEnv({})).toMatchObject({
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
    });
    expect(e2eGatewayEnv({ OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1" })).toMatchObject({
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
    });
  });

  test("launches tsx through Node without an npx wrapper", () => {
    const command = e2eTsxCommand("packages/gateway/src/index.ts");

    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe("--import");
    expect(command.args[1]).toMatch(/^file:/);
    expect(command.args[2]).toBe("packages/gateway/src/index.ts");
  });
});

test("a source entry executes in the exact spawned process without a wrapper child", async () => {
  const root = mkdtempSync(join(tmpdir(), "gateway source # "));
  try {
    const entry = join(root, "entry.ts");
    writeFileSync(entry, "const pid: number = process.pid; process.stdout.write(String(pid));");
    const command = e2eTsxCommand(entry);
    const child = spawn(command.command, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code, stderr).toBe(0);
    expect(Number(stdout)).toBe(child.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
