// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { tasklistHasImage, windowsIsProcessRunning } from "./windows-process-probe.js";
import type { execWindowsJob } from "@omnesis/core";

const processTable =
  '"ExampleApp.exe","72","Console","1","13,024 K"\r\n"ExampleAppHelper.exe","73","Services","0","2,048 K"\r\n"源 app.exe","74","Console","1","1,024 K"\r\n';

describe("Windows feed process lookup", () => {
  test("matches complete image names with an optional exe suffix and Windows casing", () => {
    for (const name of ["ExampleApp", "exampleapp.EXE", "源 app.exe"])
      expect(tasklistHasImage(processTable, name)).toBe(true);
    for (const name of [
      "Example",
      "ExampleAppHelp",
      "ExampleApp.exe.exe",
      "ExampleApp*",
      "*",
      "missing",
    ])
      expect(tasklistHasImage(processTable, name)).toBe(false);
  });

  test("honors embedded commas and doubled quotes without reading another column as an image", () => {
    const table =
      '"invented,app.exe","72","Console","1","13,024 K"\n"other.exe","73","ExampleApp.exe","0","2,048 K"\n"double""quote.exe","74","Console","1","1,024 K"';
    expect(tasklistHasImage(table, "invented,app")).toBe(true);
    expect(tasklistHasImage(table, 'double"quote')).toBe(true);
    expect(tasklistHasImage(table, "ExampleApp")).toBe(false);
  });

  test.each([
    "",
    "INFO: invented unreadable table",
    '"ExampleApp.exe","broken"',
    processTable + '"unterminated',
    processTable.replace("ExampleApp", "\uFFFD"),
  ])("rejects malformed process output instead of declaring absence (%j)", (table) => {
    expect(() => tasklistHasImage(table, "missing")).toThrow();
  });

  test("uses trusted System32 with literal arguments and the original deadline", async () => {
    const run = vi
      .fn<typeof execWindowsJob>()
      .mockResolvedValue({ stdout: processTable, stderr: "" });
    const env = { SYSTEMROOT: "C:\\Windows", PATH: "C:\\untrusted tools" };
    expect(await windowsIsProcessRunning("ExampleApp", 2000, { env, run })).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "C:\\Windows\\System32\\tasklist.exe",
      ["/FO", "CSV", "/NH"],
      { timeout: 2000, maxBuffer: 2 * 1024 * 1024, env },
    );
  });

  test("propagates owned process failures for the caller's unknown reading", async () => {
    const failure = Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" });
    const run = vi.fn<typeof execWindowsJob>().mockRejectedValue(failure);
    await expect(
      windowsIsProcessRunning("ExampleApp", 2000, { env: { SystemRoot: "C:\\Windows" }, run }),
    ).rejects.toBe(failure);
  });

  test.each([{}, { SystemRoot: "relative" }])(
    "refuses a missing or unanchored system directory",
    async (env) => {
      const run = vi.fn<typeof execWindowsJob>();
      await expect(windowsIsProcessRunning("ExampleApp", 2000, { env, run })).rejects.toThrow(
        "system directory",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );
});
