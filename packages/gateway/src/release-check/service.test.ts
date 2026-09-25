// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { ReleaseCheckService } from "./service.js";

const SIGNAL = new AbortController().signal;

function service(
  lookup: NonNullable<ConstructorParameters<typeof ReleaseCheckService>[0]["lookup"]>,
  enabled = true,
) {
  return new ReleaseCheckService({
    configDir: "/state",
    argv1Path: "/entry",
    currentVersion: "1.2.3",
    enabled,
    installMethod: { method: "source", rootDir: "/repo" },
    lookup,
    now: () => Date.parse("2026-09-07T12:00:00.000Z"),
  });
}

describe("ReleaseCheckService", () => {
  test("publishes only a successful stable answer", async () => {
    const checker = service(vi.fn(() => Promise.resolve("1.3.0")));
    expect(await checker.check(SIGNAL)).toBe(true);
    expect(checker.snapshot()).toEqual({
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      installMethod: "source",
      checkedAt: "2026-09-07T12:00:00.000Z",
      updateAvailable: true,
    });
  });

  test("a first failure is silent and a later failure preserves the last answer", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("1.2.3")
      .mockRejectedValueOnce(new Error("offline again"));
    const checker = service(lookup);

    expect(await checker.check(SIGNAL)).toBe(false);
    expect(checker.snapshot()).toBeNull();
    expect(await checker.check(SIGNAL)).toBe(true);
    const successful = checker.snapshot();
    expect(await checker.check(SIGNAL)).toBe(false);
    expect(checker.snapshot()).toEqual(successful);
  });

  test("the off switch performs no lookup, clears state, and requires a fresh success", async () => {
    const lookup = vi.fn(() => Promise.resolve("1.3.0"));
    const checker = service(lookup, false);
    expect(await checker.check(SIGNAL)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();

    checker.setEnabled(true);
    expect(checker.snapshot()).toBeNull();
    expect(await checker.check(SIGNAL)).toBe(true);
    checker.setEnabled(false);
    expect(checker.snapshot()).toBeNull();
    expect(await checker.check(SIGNAL)).toBe(false);
    expect(lookup).toHaveBeenCalledOnce();
  });

  test("a result cannot publish after the check is disabled in flight", async () => {
    let resolve!: (value: string) => void;
    const checker = service(
      vi.fn(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = checker.check(SIGNAL);
    checker.setEnabled(false);
    resolve("1.3.0");
    expect(await pending).toBe(false);
    expect(checker.snapshot()).toBeNull();
  });
});
