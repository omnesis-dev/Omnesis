// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayFetch: vi.fn(),
  gatewayJson: vi.fn(),
  isJSON: false,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  gatewayFetch: mocks.gatewayFetch,
  gatewayJson: mocks.gatewayJson,
  get isJSON() {
    return mocks.isJSON;
  },
}));

import { backupAction, backupStartedLine, formatBackupProgress, runBackup } from "./backup.js";

beforeEach(() => {
  mocks.gatewayFetch.mockReset();
  mocks.gatewayJson.mockReset();
  mocks.isJSON = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("backupStartedLine", () => {
  test("a backup without the search index says why nothing is lost", () => {
    const line = backupStartedLine(false);
    expect(line).toContain("without the search index (index.db)");
    expect(line).toContain("rebuilds it from the documents");
    expect(line).not.toContain("skipped");
  });

  test("a full backup just starts", () => {
    expect(backupStartedLine(true)).toBe("Backup started…");
  });
});

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

  test("the file list lines its sizes up past the longest name", async () => {
    mocks.gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ backupId: "backup-3" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const files = [
      { name: "omnesis.db.enc", bytes: 3_300_000 },
      { name: "keyring/storage-encryption-required.enc", bytes: 403 },
    ];
    mocks.gatewayJson.mockResolvedValue({
      running: false,
      lastResult: {
        backupId: "backup-3",
        ok: true,
        startedAt: "2030-01-01T00:00:00.000Z",
        finishedAt: "2030-01-01T00:00:01.000Z",
        path: "/tmp/example-backup",
        totalBytes: 3_300_403,
        files,
      },
    });

    await runBackup({ includeIndex: true });

    const lines = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => files.some((f) => line.includes(f.name)));
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
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

  describe("summary, as the update's pre-update backup reports", () => {
    const files = [
      { name: "omnesis.db.enc", bytes: 3_300_000, durationMs: 9 },
      { name: "token.enc", bytes: 557, durationMs: 1 },
    ];
    function serve(): void {
      mocks.gatewayFetch.mockResolvedValue(
        new Response(JSON.stringify({ backupId: "backup-4" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
      mocks.gatewayJson
        .mockResolvedValueOnce({
          running: true,
          current: {
            backupId: "backup-4",
            startedAt: "2030-01-01T00:00:00.000Z",
            path: "/tmp/example-backup",
            includeIndex: false,
            currentFile: "omnesis.db",
            files: [],
          },
        })
        .mockResolvedValueOnce({
          running: false,
          lastResult: {
            backupId: "backup-4",
            ok: true,
            startedAt: "2030-01-01T00:00:00.000Z",
            finishedAt: "2030-01-01T00:00:01.000Z",
            path: "/tmp/example-backup",
            totalBytes: 3_300_557,
            files,
          },
        });
    }
    function printed(): string[] {
      return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    }

    test("with no terminal it prints one human line, not the JSON report or progress", async () => {
      mocks.isJSON = true;
      const tty = process.stdout.isTTY;
      process.stdout.isTTY = false;
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        serve();
        await runBackup({ includeIndex: false, purpose: "pre-update", summary: true });
      } finally {
        process.stdout.isTTY = tty;
      }

      const lines = printed();
      expect(lines.some((line) => line.trimStart().startsWith("{"))).toBe(false);
      expect(lines.filter((line) => line.includes("omnesis.db.enc"))).toEqual([]);
      expect(
        lines.filter((line) =>
          line.includes(
            "Backed up the gateway's databases: 2 files, 3.1 MB, in /tmp/example-backup",
          ),
        ),
      ).toHaveLength(1);
      expect(write).not.toHaveBeenCalled();
    });

    test("on a terminal it still shows live progress before the line", async () => {
      const tty = process.stdout.isTTY;
      process.stdout.isTTY = true;
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        serve();
        await runBackup({ includeIndex: false, purpose: "pre-update", summary: true });
      } finally {
        process.stdout.isTTY = tty;
      }

      expect(write).toHaveBeenCalledWith(expect.stringContaining("backing up omnesis.db"));
      expect(
        printed().filter((line) => line.includes("Backed up the gateway's databases")),
      ).toHaveLength(1);
    });

    test("a plain backup with no terminal keeps its JSON report", async () => {
      mocks.isJSON = true;
      serve();
      await runBackup({ includeIndex: true });
      expect(printed().some((line) => line.startsWith('{"backupId":"backup-4"'))).toBe(true);
    });
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

describe("backupAction", () => {
  test("no words creates a backup, and --list lists them", () => {
    expect(backupAction(false, [])).toBe("create");
    expect(backupAction(true, [])).toBe("list");
  });

  test("`omnesis backup list` lists instead of starting a backup", () => {
    expect(backupAction(false, ["list"])).toBe("list");
  });

  test("any other word is refused, never ignored", () => {
    for (const words of [["lsit"], ["before", "cleanup"], ["list", "extra"]]) {
      expect(() => backupAction(false, words)).toThrow(/takes no arguments/);
    }
    expect(() => backupAction(false, ["now"])).toThrow(/omnesis backup list/);
  });
});
