// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { execE2EBufferedCommand, namedPosixTimeout } from "./e2e-buffered-command.js";

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

test.runIf(process.platform !== "win32")(
  "a POSIX command stopped at its limit names itself, its limit and how long it ran",
  async () => {
    const failure = await execE2EBufferedCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)", "--", "--token=invented-secret"],
      { cwd: process.cwd(), env: process.env, timeout: 200, maxBuffer: 8192 },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ETIMEDOUT", killed: true, stdout: "", stderr: "" });
    expect((failure as Error).message).toMatch(
      /^Command timed out after \d+\.\d s \(limit 0\.2 s\): node -e … … --token=…$/u,
    );
    expect((failure as Error).message).not.toContain("invented-secret");
  },
);

test("only a command Node stopped at its limit becomes a named timeout", () => {
  const killedAtLimit = Object.assign(new Error("Command failed"), { killed: true, code: null });
  const overflow = Object.assign(new Error("stdout maxBuffer length exceeded"), {
    killed: true,
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
  const exited = Object.assign(new Error("Command failed"), { killed: false, code: 1 });
  expect(namedPosixTimeout(killedAtLimit, "invented", [], 100, 100)).toMatchObject({
    code: "ETIMEDOUT",
    message: "Command timed out after 0.1 s (limit 0.1 s): invented",
  });
  expect(namedPosixTimeout(killedAtLimit, "invented", [], 100, 50)).toBe(killedAtLimit);
  expect(namedPosixTimeout(overflow, "invented", [], 100, 150)).toBe(overflow);
  expect(namedPosixTimeout(exited, "invented", [], 100, 150)).toBe(exited);
});
