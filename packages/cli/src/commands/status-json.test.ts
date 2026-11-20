// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runCommand } from "citty";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveToken } from "@omnesis/core";
import { buildCliFx, gatewayJson, withSpinner, EXIT_AUTH, EXIT_USER_ERROR } from "../utils.js";
import { statusCommand } from "./status.js";
import { renderStatus } from "./status-render.js";

vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  resolveToken: vi.fn(),
}));
vi.mock("../utils.js", async (original) => ({
  ...(await original<typeof import("../utils.js")>()),
  gatewayJson: vi.fn(),
  buildCliFx: vi.fn(),
  withSpinner: vi.fn(async (_label: string, operation: () => Promise<unknown>) => operation()),
  missingTokenMessage: vi.fn(() => "Invented admin token is missing"),
}));
vi.mock("./status-render.js", () => ({ renderStatus: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveToken).mockReturnValue("invented-admin-token");
  vi.mocked(gatewayJson).mockImplementation(async (path) => {
    const responses: Record<string, unknown> = {
      "/admin/sources": {
        items: [{ id: "invented:fixture", type: "invented", accountId: "fixture", config: {} }],
      },
      "/admin/sync/status": { items: [{ sourceId: "invented:fixture", state: "idle" }] },
      "/status": { dbSizeBytes: 4096, diskUsage: { totalBytes: 8192 } },
      "/index/stats": null,
      "/analytics/catalog": { tables: [] },
      "/admin/source-descriptors": { items: [{ id: "invented", unitName: "items" }] },
      "/admin/process-vitals?window=60": null,
      "/health": { version: "1.2.3" },
      "/admin/devices": { items: [] },
      "/documents/stats": { stats: {} },
    };
    if (!(path in responses)) throw new Error("Unexpected gateway request");
    return responses[path] as never;
  });
});
afterEach(() => vi.restoreAllMocks());

test("--json prints one complete status object without terminal rendering or FX requests", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runCommand(statusCommand, { rawArgs: ["--json"] });
  expect(output).toHaveBeenCalledTimes(1);
  const serialized = String(output.mock.calls[0]![0]);
  const data = JSON.parse(serialized);
  expect(data).toMatchObject({
    dbSizeBytes: 4096,
    diskUsageBytes: 8192,
    gatewayVersion: "1.2.3",
    statuses: [{ sourceId: "invented:fixture", state: "idle", unitName: "items" }],
  });
  expect(Number.isFinite(Date.parse(data.timestamp))).toBe(true);
  expect(serialized).toMatch(/\n$/);
  expect(serialized).not.toContain("\u001b");
  expect(renderStatus).not.toHaveBeenCalled();
  expect(buildCliFx).not.toHaveBeenCalled();
  expect(withSpinner).not.toHaveBeenCalled();
});

test("human status retains the spinner, FX and renderer path", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runCommand(statusCommand, { rawArgs: [] });
  expect(withSpinner).toHaveBeenCalledTimes(1);
  expect(buildCliFx).toHaveBeenCalledTimes(1);
  expect(renderStatus).toHaveBeenCalledWith(
    expect.objectContaining({ gatewayVersion: "1.2.3" }),
    undefined,
  );
  expect(output).not.toHaveBeenCalled();
});

test("--json preserves the missing-token error without writing a JSON success", async () => {
  vi.mocked(resolveToken).mockReturnValue(null);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(runCommand(statusCommand, { rawArgs: ["--json"] })).rejects.toMatchObject({
    exitCode: EXIT_AUTH,
  });
  expect(output).not.toHaveBeenCalled();
  expect(gatewayJson).not.toHaveBeenCalled();
});

test("--json keeps the existing partial-outage defaults machine readable", async () => {
  vi.mocked(gatewayJson).mockRejectedValue(new TypeError("fetch failed"));
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runCommand(statusCommand, { rawArgs: ["--json"] });
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
    statuses: [],
    dbSizeBytes: null,
    indexStats: null,
    gatewayVersion: null,
  });
});

test("--watch --json is refused before gateway calls or terminal side effects", async () => {
  // An unfixed command must fail locally rather than opening a real watch socket.
  vi.mocked(resolveToken).mockReturnValue(null);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(runCommand(statusCommand, { rawArgs: ["--watch", "--json"] })).rejects.toMatchObject(
    {
      exitCode: EXIT_USER_ERROR,
      message: "--json cannot be combined with --watch",
    },
  );
  expect(gatewayJson).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(withSpinner).not.toHaveBeenCalled();
});
