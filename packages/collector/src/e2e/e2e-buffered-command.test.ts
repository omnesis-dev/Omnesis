// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { execE2EBufferedCommand } from "./e2e-buffered-command.js";

test.each(["win32", "linux", "darwin"] as const)(
  "%s buffered commands preserve literal argv, isolation and existing bounds",
  async (platform) => {
    const result = { stdout: "invented UTF-8 output 雪", stderr: "invented diagnostic" };
    const windows = vi.fn(async () => result),
      posix = vi.fn(async () => result);
    const args = ["space value", "quote'\"", "$&;", "雪"];
    const options = {
      cwd: "invented-root",
      env: { INVENTED_VALUE: "literal $&" },
      timeout: 1234,
      maxBuffer: 8192,
    };
    expect(
      await execE2EBufferedCommand("invented-command", args, options, { platform, windows, posix }),
    ).toBe(result);
    expect(platform === "win32" ? windows : posix).toHaveBeenCalledExactlyOnceWith(
      "invented-command",
      args,
      options,
    );
    expect(platform === "win32" ? posix : windows).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "buffered ownership receipts are never projected into an ordinary result (nested=%s)",
  async (nested) => {
    const marker = Object.assign(new Error("invented buffered cleanup uncertainty"), {
      cleanupFailure: undefined,
    });
    const failure = nested ? new Error("invented buffered wrapper", { cause: marker }) : marker;
    const windows = vi.fn(async () => {
      throw failure;
    });
    await expect(
      execE2EBufferedCommand(
        "invented",
        [],
        { cwd: "invented-root", env: {}, timeout: 1234, maxBuffer: 8192 },
        { platform: "win32", windows },
      ),
    ).rejects.toBe(failure);
  },
);

test.runIf(process.platform === "win32")(
  "real Windows buffered capture preserves Node's literal arguments and joins",
  async () => {
    const args = ["space value", "quote'\"", "$&;", "雪"];
    const result = await execE2EBufferedCommand(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
        maxBuffer: 8192,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe("");
  },
  35_000,
);
