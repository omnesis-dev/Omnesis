// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { reportSetupFailures } from "./setup-failure-report.js";

function recorder() {
  return { error: vi.fn<(message: string) => void>(), debug: vi.fn<(message: string) => void>() };
}

describe("reportSetupFailures", () => {
  it("names a declared source's failure at ERROR", () => {
    const log = recorder();
    reportSetupFailures(
      [{ key: "gmail:maya@example.com", error: "fixture is malformed" }],
      new Set(["gmail:maya@example.com"]),
      "default",
      log,
    );
    expect(log.error).toHaveBeenCalledWith(
      "Universe source gmail:maya@example.com did not instantiate: fixture is malformed",
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("keeps an undeclared source's failure out of ERROR", () => {
    const log = recorder();
    reportSetupFailures(
      [{ key: "apple-notes:maya@example.com", error: "missing fixture apple-notes/notes.json" }],
      new Set(["gmail:maya@example.com"]),
      "focused",
      log,
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "Undeclared source apple-notes:maya@example.com did not instantiate in universe 'focused': missing fixture apple-notes/notes.json",
    );
  });

  it("separates both kinds in one report", () => {
    const log = recorder();
    reportSetupFailures(
      [
        { key: "notion:u-1", error: "no fixture" },
        { key: "gmail:maya@example.com", error: "boom" },
      ],
      new Map([["gmail:maya@example.com", []]]),
      "default",
      log,
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toContain("gmail:maya@example.com");
    expect(log.debug).toHaveBeenCalledTimes(1);
  });
});
