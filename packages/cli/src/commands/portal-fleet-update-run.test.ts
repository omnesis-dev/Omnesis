// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
  readPortalFleetUpdateOperation,
  writePortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
} from "@omnesis/core/portal-fleet-update";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createPortalFleetUpdateOutputCapture,
  portalFleetUpdateRunCommand,
  runPortalFleetUpdateOperation,
  type PortalFleetUpdateRunDeps,
} from "./portal-fleet-update-run.js";

const ID = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
const STARTED = "2026-09-16T12:00:00.000Z";

function operation(
  overrides: Partial<PortalFleetUpdateOperation> = {},
): PortalFleetUpdateOperation {
  return {
    id: ID,
    currentVersion: "1.2.2",
    targetVersion: "1.2.3",
    releaseCheckedAt: "2026-09-16T11:59:00.000Z",
    state: "queued",
    startedAt: STARTED,
    updatedAt: STARTED,
    ...overrides,
  };
}

function deps(runChild: PortalFleetUpdateRunDeps["runChild"]): PortalFleetUpdateRunDeps {
  const times = [new Date("2026-09-16T12:00:01.000Z"), new Date("2026-09-16T12:01:00.000Z")];
  return {
    now: () => times.shift()!,
    runChild,
    cliEntry: "/opt/omnesis/cli.js",
    execPath: "/usr/bin/node",
    execArgv: ["--enable-source-maps"],
    env: { PATH: "/usr/bin", OMNESIS_CONFIG_DIR: "/wrong/config" },
  };
}

describe("portal fleet update runner", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-fleet-run-"));
    writePortalFleetUpdateOperation(configDir, operation());
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("runs only the recorded target through the current CLI entry", async () => {
    const runChild = vi.fn<PortalFleetUpdateRunDeps["runChild"]>().mockResolvedValue({
      code: 0,
      signal: null,
      output: "Gateway healthy. Fleet updated.\n",
    });

    const result = await runPortalFleetUpdateOperation(
      { operationId: ID, configDir },
      deps(runChild),
    );

    expect(runChild).toHaveBeenCalledWith({
      command: "/usr/bin/node",
      args: [
        "--enable-source-maps",
        "/opt/omnesis/cli.js",
        "update",
        "--yes",
        "--fleet",
        "--target-version=1.2.3",
      ],
      env: { PATH: "/usr/bin", OMNESIS_CONFIG_DIR: configDir },
    });
    expect(result).toMatchObject({
      id: ID,
      targetVersion: "1.2.3",
      state: "succeeded",
      completedAt: "2026-09-16T12:01:00.000Z",
    });
    expect(readPortalFleetUpdateOperation(configDir)).toEqual(result);
  });

  test("records a failed exit and bounds its output", async () => {
    const secret = "omn_secret_value";
    const output = `old diagnostics ${secret} https://user:pass@example.org token=visible\n${"x".repeat(PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES + 100)}\nGateway health failed. Rolled back to 1.2.2.`;
    const runDeps = deps(async () => ({ code: 17, signal: null, output }));
    runDeps.env.OMNESIS_TOKEN = secret;
    const result = await runPortalFleetUpdateOperation({ operationId: ID, configDir }, runDeps);

    expect(result.state).toBe("failed");
    expect(result.detail).toBe("Fleet update exited with code 17.");
    expect(Buffer.byteLength(result.output!, "utf8")).toBeLessThanOrEqual(
      PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
    );
    expect(result.output).not.toContain("old diagnostics");
    expect(result.output).toContain("Rolled back to 1.2.2");
  });

  test("redacts credential-shaped diagnostics before persisting them", async () => {
    const secret = "omn_secret_value";
    const runDeps = deps(async () => ({
      code: 1,
      signal: null,
      output: `credential ${secret}\nhttps://user:pass@example.org/path\ntoken=visible`,
    }));
    runDeps.env.OMNESIS_TOKEN = secret;

    const result = await runPortalFleetUpdateOperation({ operationId: ID, configDir }, runDeps);
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("user:pass");
    expect(result.output).not.toContain("token=visible");
    expect(result.output).toContain("https://***@example.org/path");
  });

  test("redacts a secret before tail truncation can retain only its suffix", async () => {
    const secret = "portal-boundary-secret-value";
    const trailing = "x".repeat(PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES - 8);
    const runDeps = deps(async () => ({
      code: 1,
      signal: null,
      output: `${secret}${trailing}`,
    }));
    runDeps.env.OMNESIS_TOKEN = secret;

    const result = await runPortalFleetUpdateOperation({ operationId: ID, configDir }, runDeps);
    expect(result.output).not.toContain(secret.slice(-8));
    expect(result.output).toContain("***");
  });

  test("redacts secrets split across streamed child-output chunks", () => {
    const secret = "split stream secret value";
    const capture = createPortalFleetUpdateOutputCapture({ OMNESIS_TOKEN: secret });
    capture.write(`${"prefix ".repeat(100)}${secret.slice(0, 12)}`);
    capture.write(`${secret.slice(12)} after`);

    const output = capture.end();
    expect(output).not.toContain(secret);
    expect(output).toContain("*** after");
  });

  test("redacts short and key-named secrets across stream boundaries", () => {
    const capture = createPortalFleetUpdateOutputCapture({ API_KEY: "abc", PASSWORD: "xy" });
    capture.write(`${"prefix ".repeat(100)}a`);
    capture.write("bc and x");
    capture.write("y after");

    const output = capture.end();
    expect(output).not.toContain("abc");
    expect(output).not.toContain("xy");
    expect(output).toContain("*** and *** after");
  });

  test("allows only one runner to own a queued operation", async () => {
    let finishFirst!: () => void;
    const firstChild = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstRunChild = vi.fn<PortalFleetUpdateRunDeps["runChild"]>(async () => {
      await firstChild;
      return { code: 0, signal: null, output: "updated" };
    });
    const secondRunChild = vi.fn<PortalFleetUpdateRunDeps["runChild"]>();

    const first = runPortalFleetUpdateOperation(
      { operationId: ID, configDir },
      deps(firstRunChild),
    );
    await vi.waitFor(() => {
      expect(readPortalFleetUpdateOperation(configDir)?.state).toBe("running");
    });
    await expect(
      runPortalFleetUpdateOperation({ operationId: ID, configDir }, deps(secondRunChild)),
    ).rejects.toThrow(/portal fleet update runner/u);
    expect(secondRunChild).not.toHaveBeenCalled();

    finishFirst();
    await expect(first).resolves.toMatchObject({ state: "succeeded" });
    expect(firstRunChild).toHaveBeenCalledOnce();
  });

  test("records spawn failures and returns normally so a service manager does not retry", async () => {
    const result = await runPortalFleetUpdateOperation(
      { operationId: ID, configDir },
      deps(async () => {
        throw new Error("launcher unavailable");
      }),
    );

    expect(result).toMatchObject({ state: "failed", detail: "launcher unavailable" });
    expect(readPortalFleetUpdateOperation(configDir)).toEqual(result);
  });

  test("is idempotent for a matching terminal operation", async () => {
    const terminal = operation({
      state: "succeeded",
      updatedAt: "2026-09-16T12:01:00.000Z",
      completedAt: "2026-09-16T12:01:00.000Z",
    });
    writePortalFleetUpdateOperation(configDir, terminal);
    const runChild = vi.fn<PortalFleetUpdateRunDeps["runChild"]>();

    await expect(
      runPortalFleetUpdateOperation({ operationId: ID, configDir }, deps(runChild)),
    ).resolves.toEqual(terminal);
    expect(runChild).not.toHaveBeenCalled();
  });

  test("refuses a mismatched id, an in-flight replay, and a relative config path", async () => {
    const runChild = vi.fn<PortalFleetUpdateRunDeps["runChild"]>();
    await expect(
      runPortalFleetUpdateOperation(
        { operationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", configDir },
        deps(runChild),
      ),
    ).rejects.toThrow(/does not match/u);

    writePortalFleetUpdateOperation(configDir, operation({ state: "running" }));
    await expect(
      runPortalFleetUpdateOperation({ operationId: ID, configDir }, deps(runChild)),
    ).rejects.toThrow(/expected queued/u);
    await expect(
      runPortalFleetUpdateOperation({ operationId: ID, configDir: "relative" }, deps(runChild)),
    ).rejects.toThrow(/not absolute/u);
    expect(runChild).not.toHaveBeenCalled();
  });

  test("is hidden from operator-facing help metadata", () => {
    const meta = portalFleetUpdateRunCommand.meta as { hidden?: boolean } | undefined;
    expect(meta?.hidden).toBe(true);
  });
});
