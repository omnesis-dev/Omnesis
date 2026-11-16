// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { TailnetGateway, type TailnetMachine, type TailnetTools } from "./tailnet-harness.js";
import { runCliOn, stopTailnetCommands } from "./tailnet-command-processes.js";
import { tailnetMachineEnv } from "./tailnet-machine-env.js";
import type { TestPki } from "./fixture-pki.js";

const roots: string[] = [];
const machines: TailnetMachine[] = [];
afterEach(async () => {
  // The PKI producer in these tests never creates a process. Real CLI roots
  // still require independent cohort closure before any fixture is removed.
  await stopTailnetCommands(machines);
  machines.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gatewayWithLeafFailure(error: unknown): TailnetGateway {
  const pki: TestPki = { caCert: "", caCertFile: "", leaf: () => Promise.reject(error) };
  const tools: TailnetTools = {
    helper: "unused-fixture-helper",
    headscale: "",
    tailscale: "",
    tailscaled: "",
    derper: "",
  };
  const gateway = new TailnetGateway({ pki, tools, controlUrl: "http://127.0.0.1:32145" });
  roots.push(gateway.dir);
  return gateway;
}

test.each([undefined, new Error("invented unconfirmed PKI receipt")])(
  "startup cleanup uncertainty retains every gateway input (%s)",
  async (failure) => {
    const error = Object.assign(new Error("invented PKI ownership uncertainty"), {
      cleanupFailure: failure,
    });
    const gateway = gatewayWithLeafFailure(error);
    const input = join(gateway.dir, "pending-input");
    writeFileSync(input, "fictional fixture input");
    await expect(gateway.start()).rejects.toBe(error);
    await expect(gateway.remove()).rejects.toHaveProperty("cleanupFailure", failure);
    expect(existsSync(input)).toBe(true);
  },
);

test("a closed producer's ordinary startup refusal still permits input cleanup", async () => {
  const error = new Error("invented closed PKI refusal");
  const gateway = gatewayWithLeafFailure(error);
  await expect(gateway.start()).rejects.toBe(error);
  await gateway.remove();
  expect(existsSync(gateway.dir)).toBe(false);
});

test.each([
  { args: ["--version"], success: true },
  { args: ["--fixture-invalid-option"], success: false },
])(
  "real CLI completion keeps its actual result after cohort closure: $args",
  async ({ args, success }) => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-tailnet cli literal-"));
    roots.push(dir);
    const machine: TailnetMachine = {
      name: "fixture-cli-peer",
      dir,
      socket: "unused-fixture-socket",
      binDir: dir,
      proxyUrl: "http://127.0.0.1:32145",
      env: (ca) => tailnetMachineEnv(dir, "http://127.0.0.1:32145", ca),
    };
    machines.push(machine);
    const result = await runCliOn(machine, "", args);
    if (success) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/u);
    } else {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("--fixture-invalid-option");
    }
    await stopTailnetCommands([machine]);
    expect(existsSync(dir)).toBe(true);
  },
  30_000,
);
