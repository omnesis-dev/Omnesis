// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

const operations = vi.hoisted(() => ({
  exec: vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>(),
  readToken: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  kill: vi.fn(async () => {}),
  spawn: vi.fn<() => unknown>(() => {
    throw new Error("unexpected gateway admission");
  }),
}));
vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  execWindowsJob: operations.exec,
  readSecretTextFile: operations.readToken,
}));
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  return {
    ...(await original<typeof import("node:child_process")>()),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: operations.exec }),
  };
});
vi.mock("./subprocess-reaper.js", () => ({
  killSubprocessGroup: operations.kill,
  registerSubprocessGroup: vi.fn(async () => {}),
}));
vi.mock("./e2e-owned-process.js", () => ({
  spawnE2ESubprocess: operations.spawn,
  e2eApplicationStatus: vi.fn(() => ({ exitCode: null, signalCode: null })),
  e2eApplicationPid: vi.fn(),
  e2eProcessOutput: vi.fn(() => ({})),
  requestE2EProcessShutdown: vi.fn(),
}));
const fixtures: MultiCollectorHarness[] = [];
function fixture() {
  const harness = new MultiCollectorHarness();
  fixtures.push(harness);
  const gateway = { invented: true };
  Reflect.set(harness, "gatewayProcess", gateway);
  return { harness, gateway, root: dirname(harness.getDbPath()) };
}
function marker(nested = false) {
  const error = Object.assign(new Error("invented CLI cleanup uncertainty"), {
    cleanupFailure: undefined,
    code: "EIO",
  });
  return nested ? new Error("invented CLI wrapper", { cause: error }) : error;
}
afterEach(async () => {
  await Promise.allSettled(fixtures.map((harness) => harness.destroy()));
  // No real native child exists at these mocked boundaries, including
  // cases intentionally retaining a synthetic ownership receipt.
  for (const harness of fixtures.splice(0))
    rmSync(dirname(harness.getDbPath()), { recursive: true, force: true });
  vi.clearAllMocks();
  operations.exec.mockReset();
  operations.kill.mockReset();
  operations.kill.mockResolvedValue(undefined);
  operations.readToken.mockReset();
  operations.spawn.mockReset().mockImplementation(() => {
    throw new Error("unexpected gateway admission");
  });
  vi.unstubAllGlobals();
});

test("Gateway readiness authenticates with a decoded token and the daemon's secret backend", async () => {
  const harness = new MultiCollectorHarness({ extraGatewayEnv: { OMNESIS_SECRET_STORE: "file" } });
  fixtures.push(harness);
  writeFileSync(join(harness.gatewayConfigDir, "token"), "invented encrypted envelope");
  operations.spawn.mockReturnValue({ invented: true });
  operations.readToken.mockResolvedValue("fixture-token\n");
  const transport = vi.fn(
    async (url: string, options?: RequestInit) =>
      new Response(null, {
        status:
          url.endsWith("/health") ||
          (options?.headers as Record<string, string> | undefined)?.Authorization ===
            "Bearer fixture-token"
            ? 200
            : 401,
      }),
  );
  vi.stubGlobal("fetch", transport);
  await harness.start();
  expect(harness.bootstrapToken).toBe("fixture-token");
  expect(operations.readToken).toHaveBeenCalledWith(join(harness.gatewayConfigDir, "token"), {
    configDir: harness.gatewayConfigDir,
    backend: "file",
  });
  expect(transport).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "bootstrap read uncertainty retains the fixture after independent Gateway join (nested=%s)",
  async (nested) => {
    const { harness, gateway, root } = fixture();
    const failure = marker(nested);
    operations.spawn.mockReturnValue(gateway);
    operations.readToken.mockRejectedValue(failure);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(harness.start()).rejects.toBe(failure);
    await expect(harness.start()).rejects.toBe(failure);
    await expect(harness.destroy()).rejects.toBe(failure);
    expect(operations.kill).toHaveBeenCalledWith(gateway, {});
    expect(existsSync(root)).toBe(true);
  },
);

test("a bootstrap read completing beyond the shared budget cannot publish readiness", async () => {
  const { harness, gateway } = fixture();
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  operations.spawn.mockReturnValue(gateway);
  operations.readToken.mockImplementation(async () => {
    now += 90_001;
    return "fixture-token";
  });
  const transport = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", transport);
  await expect(harness.start()).rejects.toThrow("shared boot budget");
  expect(transport).toHaveBeenCalledOnce();
  expect(harness.bootstrapToken).toBe("");
});

test.each([false, true])(
  "CLI uncertainty survives Gateway join and blocks later admission (nested=%s)",
  async (nested) => {
    const { harness, gateway, root } = fixture();
    const failure = marker(nested);
    operations.exec.mockRejectedValue(failure);
    await expect(harness.runCli(["status", "--json"])).rejects.toBe(failure);
    await expect(harness.runCli(["status"])).rejects.toBe(failure);
    await expect(harness.start()).rejects.toBe(failure);
    await expect(harness.restartGateway()).rejects.toBe(failure);
    expect(operations.exec).toHaveBeenCalledOnce();
    expect(operations.spawn).not.toHaveBeenCalled();
    await expect(harness.destroy()).rejects.toBe(failure);
    await expect(harness.destroy()).rejects.toBe(failure);
    expect(operations.kill).toHaveBeenCalledWith(gateway, {});
    expect(existsSync(root)).toBe(true);
  },
);

test("destroy starts Gateway cleanup independently while joining an accepted CLI", async () => {
  const { harness, gateway, root } = fixture();
  const failure = marker();
  let reject!: (reason: unknown) => void;
  const gate = new Promise<never>((_resolve, no) => (reject = no));
  operations.exec.mockReturnValue(gate);
  const running = harness.runCli(["status"]);
  void running.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(operations.exec).toHaveBeenCalledOnce());
    closing = harness.destroy();
    void closing.catch(() => {});
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(operations.kill).toHaveBeenCalledWith(gateway, {}));
    expect(settled).toBe(false);
    expect(existsSync(root)).toBe(true);
    reject(failure);
    await expect(running).rejects.toBe(failure);
    await expect(closing).rejects.toBe(failure);
    expect(existsSync(root)).toBe(true);
  } finally {
    reject(failure);
    await Promise.allSettled([running, closing]);
  }
});

test("Gateway cleanup errors cannot replace a prior CLI ownership receipt", async () => {
  const { harness, root } = fixture();
  const failure = marker();
  const gatewayFailure = new Error("invented ordinary Gateway cleanup failure");
  operations.exec.mockRejectedValue(failure);
  operations.kill.mockRejectedValue(gatewayFailure);
  await harness.runCli(["status"]).catch(() => {});
  const error = await harness.destroy().catch((error) => error);
  expect(error).toMatchObject({ cleanupFailure: undefined, cause: failure });
  expect(error.errors).toContain(gatewayFailure);
  expect(existsSync(root)).toBe(true);
});

test.each([7, "ENOENT"])(
  "ordinary joined CLI failure %s keeps status and retry behavior",
  async (code) => {
    const { harness, root } = fixture();
    operations.exec
      .mockRejectedValueOnce(
        Object.assign(new Error("invented joined CLI failure"), {
          code,
          stdout: "invented partial output",
          stderr: "invented diagnostic",
        }),
      )
      .mockResolvedValue({ stdout: "invented success", stderr: "" });
    const result = await harness.runCli(["status"]);
    expect(result).toEqual({
      stdout: "invented partial output",
      stderr: "invented diagnostic",
      exitCode: typeof code === "number" ? code : Number(code),
    });
    await expect(harness.runCli(["status"])).resolves.toEqual({
      stdout: "invented success",
      stderr: "",
      exitCode: 0,
    });
    await harness.destroy();
    expect(existsSync(root)).toBe(false);
  },
);

test("CLI capture retains isolation, timeout and output bounds", async () => {
  const { harness } = fixture();
  operations.exec.mockResolvedValue({ stdout: "invented output", stderr: "invented stderr" });
  await expect(
    harness.runCli(["status", "--json"], {
      token: "invented-token",
      timeoutMs: 1234,
      extraEnv: {
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_EXTRA_CA_CERTS: "invented.pem",
        OMNESIS_INSECURE_TLS: "1",
      },
    }),
  ).resolves.toEqual({ stdout: "invented output", stderr: "invented stderr", exitCode: 0 });
  const options = operations.exec.mock.calls[0]![2] as {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  };
  expect(options).toMatchObject({
    timeout: 1234,
    maxBuffer: 8 * 1024 * 1024,
    env: { OMNESIS_CONFIG_DIR: harness.gatewayConfigDir, OMNESIS_TOKEN: "invented-token" },
  });
  expect(options.env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
  expect(options.env).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
  expect(options.env).not.toHaveProperty("OMNESIS_INSECURE_TLS");
});
