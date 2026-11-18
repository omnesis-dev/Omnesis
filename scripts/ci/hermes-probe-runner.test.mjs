// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { hermesGatewayProbeInvocation, runHermesInvocation } from "../test-hermes.mjs";

test("the gateway probe selects native Python and the real protocol fixture", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const invocation = hermesGatewayProbeInvocation(platform);
    expect(invocation.command).toBe(platform === "win32" ? "python" : "python3");
    expect(invocation.args[0]).toBe("-B");
    expect(invocation.args[1]).toBe(
      fileURLToPath(
        new URL("../../packages/agent-integration/test/hermes_gateway_probe.py", import.meta.url),
      ),
    );
    expect(existsSync(invocation.args[1])).toBe(true);
    expect(invocation.args).toHaveLength(2);
  }
});

test("the actual Node gateway-probe entry refuses extra execution arguments", () => {
  const script = fileURLToPath(new URL("../test-hermes.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [script, "--gateway-probe", "invented-other-entry.py"],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("The gateway probe takes no additional arguments");
});

test("native Python completion keeps application nonzero distinct from cleanup uncertainty", async () => {
  const invocation = { command: "python.exe", args: ["-B", "invented-probe.py"] };
  let options;
  expect(
    await runHermesInvocation(invocation, {}, "win32", async (command, args, opts) => {
      expect(command).toBe(invocation.command);
      expect(args).toEqual(invocation.args);
      options = opts;
      return { exitCode: 7 };
    }),
  ).toBe(7);
  expect(options).not.toHaveProperty("completion");
  expect(options).not.toHaveProperty("timeoutMs");
  expect(
    await runHermesInvocation(invocation, {}, "win32", async () => ({
      exitCode: null,
      failure: "timeout",
    })),
  ).toBe(1);
  for (const cleanupFailure of [undefined, new Error("invented cleanup detail")]) {
    const error = await runHermesInvocation(invocation, {}, "win32", async () => ({
      exitCode: 0,
      cleanupFailure,
    })).then(
      () => undefined,
      (error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(Object.hasOwn(error, "cleanupFailure")).toBe(true);
    expect(error.cleanupFailure).toBe(cleanupFailure);
  }
});
