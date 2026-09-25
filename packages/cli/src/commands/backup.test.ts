// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayFetch: vi.fn(),
  gatewayJson: vi.fn(),
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  gatewayFetch: mocks.gatewayFetch,
  gatewayJson: mocks.gatewayJson,
  isJSON: false,
}));

import { formatBackupProgress, runBackup } from "./backup.js";

beforeEach(() => {
  mocks.gatewayFetch.mockReset();
  mocks.gatewayJson.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("runBackup", () => {
  test("sends the structured purpose and accepts an estimated size", async () => {
    mocks.gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ backupId: "backup-1", estimatedTotalBytes: 4096 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    mocks.gatewayJson.mockResolvedValue({
      running: false,
      lastResult: {
        backupId: "backup-1",
        ok: true,
        startedAt: "2030-01-01T00:00:00.000Z",
        finishedAt: "2030-01-01T00:00:01.000Z",
        path: "/tmp/example-backup",
        totalBytes: 1024,
        files: [],
      },
    });

    await runBackup({
      includeIndex: false,
      note: "pre-update 1.0.0 to v1.1.0",
      purpose: "pre-update",
    });

    expect(mocks.gatewayFetch).toHaveBeenCalledWith("/admin/backup", {
      method: "POST",
      body: JSON.stringify({
        includeIndex: false,
        note: "pre-update 1.0.0 to v1.1.0",
        purpose: "pre-update",
      }),
    });
  });

  test("leaves purpose absent for an ordinary operator backup", async () => {
    mocks.gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ backupId: "backup-2" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    mocks.gatewayJson.mockResolvedValue({
      running: false,
      lastResult: {
        backupId: "backup-2",
        ok: true,
        startedAt: "2030-01-01T00:00:00.000Z",
        finishedAt: "2030-01-01T00:00:01.000Z",
        path: "/tmp/example-backup",
        totalBytes: 1024,
        files: [],
      },
    });

    await runBackup({ includeIndex: true, note: "operator snapshot" });

    const init = mocks.gatewayFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ note: "operator snapshot" });
  });

  test("threads the gateway estimate into live progress with elapsed time", async () => {
    mocks.gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ backupId: "backup-3", estimatedTotalBytes: 4096 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    mocks.gatewayJson
      .mockResolvedValueOnce({
        running: true,
        current: {
          backupId: "backup-3",
          startedAt: "2030-01-01T00:00:00.000Z",
          path: "/tmp/example-backup",
          includeIndex: false,
          currentFile: "omnesis.db",
          files: [{ name: "config", bytes: 1024, durationMs: 5 }],
        },
      })
      .mockResolvedValueOnce({
        running: false,
        lastResult: {
          backupId: "backup-3",
          ok: true,
          startedAt: "2030-01-01T00:00:00.000Z",
          finishedAt: "2030-01-01T00:00:08.000Z",
          path: "/tmp/example-backup",
          totalBytes: 1024,
          files: [],
        },
      });
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(8_000);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runBackup({ includeIndex: false, purpose: "pre-update" });

    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        "1 file done · 1.0 KB written · at most ~4.0 KB · backing up omnesis.db… [7s]",
      ),
    );
  });
});

describe("formatBackupProgress", () => {
  const current = {
    currentFile: "omnesis.db",
    files: [{ name: "config", bytes: 1024, durationMs: 5 }],
  };

  test("labels the gateway estimate as an upper bound alongside elapsed time", () => {
    const line = formatBackupProgress(current, 7, 4096);
    expect(line).toContain(
      "1 file done · 1.0 KB written · at most ~4.0 KB · backing up omnesis.db… [7s]",
    );
    expect(line).not.toContain("estimated total");
  });

  test("counts the bytes of the file in flight and names them separately", () => {
    const line = formatBackupProgress({ ...current, currentFileBytes: 2048 }, 40, 8192);
    expect(line).toBe(
      "\r  1 file done · 3.0 KB written · at most ~8.0 KB · backing up omnesis.db (2.0 KB so far)… [40s]",
    );
  });

  test("shows zero bytes so far for a snapshot that has only just been created", () => {
    const line = formatBackupProgress(
      { currentFile: "omnesis.db", currentFileBytes: 0, files: [] },
      1,
    );
    expect(line).toContain("0 files done · 0 B written · backing up omnesis.db (0 B so far)… [1s]");
  });

  test("ignores in-flight bytes once no file is in flight", () => {
    const line = formatBackupProgress({ files: current.files, currentFileBytes: 2048 }, 9);
    expect(line).toContain("1 file done · 1.0 KB written · finishing… [9s]");
  });

  test("gracefully renders progress from an older gateway without an estimate or in-flight bytes", () => {
    const line = formatBackupProgress(current, 7);
    expect(line).toContain("1 file done · 1.0 KB written · backing up omnesis.db… [7s]");
    expect(line).not.toContain("at most");
    expect(line).not.toContain("so far");
  });
});
