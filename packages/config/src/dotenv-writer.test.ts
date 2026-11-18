// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({ create: vi.fn(), secure: vi.fn(), atomic: vi.fn() }));
vi.mock("@omnesis/platform/windows-private-file", () => ({
  createWindowsPrivateFileSync: native.create,
  secureWindowsPrivatePathSync: native.secure,
  writeWindowsPrivateFileAtomicSync: native.atomic,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { scaffoldDotEnv, upsertDotEnv } from "./dotenv-writer.js";

let directory: string;
const original = "OMNESIS_FAKE_KNOB=retained\n";
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(readFileSync).mockReset().mockImplementation(actual.readFileSync);
  for (const mock of Object.values(native)) mock.mockReset();
  directory = mkdtempSync(join(tmpdir(), "dotenv-write-refusal-"));
  writeFileSync(join(directory, ".env"), original);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the persistence operation to refuse");
}

describe("dotenv scaffolding ownership", () => {
  for (const stage of ["directory", "file"] as const)
    for (const wrapped of [false, true])
      test.each([undefined, new Error("Invented native join refusal")])(
        "retains native cleanup uncertainty from " +
          stage +
          (wrapped ? " through a cause" : "") +
          " (%j)",
        (cleanupFailure) => {
          const marker = Object.assign(new Error("Invented native configuration operation"), {
            cleanupFailure,
          });
          const failure = wrapped ? new Error("Configuration wrapper", { cause: marker }) : marker;
          (stage === "directory" ? native.secure : native.create).mockImplementation(() => {
            throw failure;
          });
          expect(thrownBy(() => onPlatform("win32", () => scaffoldDotEnv(directory)))).toBe(
            failure,
          );
          if (stage === "directory") expect(native.create).not.toHaveBeenCalled();
          expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
        },
      );

  test("an ordinary existing file remains a harmless scaffold refusal", () => {
    native.create.mockImplementation(() => {
      throw Object.assign(new Error("Existing configuration"), { code: "EEXIST" });
    });
    expect(onPlatform("win32", () => scaffoldDotEnv(directory))).toBe(false);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
  });
});

describe("dotenv updates preserve unreadable configuration", () => {
  for (const platform of ["win32", "linux"] as const)
    test.each(["EACCES", "EIO"])(
      "refuses unreadable existing input on " + platform + " (%s)",
      (code) => {
        const failure = Object.assign(new Error("Invented configuration read refusal"), { code });
        vi.mocked(readFileSync).mockImplementationOnce(() => {
          throw failure;
        });
        expect(
          thrownBy(() =>
            onPlatform(platform, () =>
              upsertDotEnv(directory, { OMNESIS_FAKE_KNOB: "replacement" }),
            ),
          ),
        ).toBe(failure);
        expect(native.secure).not.toHaveBeenCalled();
        expect(native.atomic).not.toHaveBeenCalled();
        expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
      },
    );

  test("a missing-file code cannot hide an explicit unjoined operation", () => {
    const failure = Object.assign(new Error("Invented unjoined configuration read"), {
      code: "ENOENT",
      cleanupFailure: undefined,
    });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(thrownBy(() => upsertDotEnv(directory, { OMNESIS_FAKE_KNOB: "replacement" }))).toBe(
      failure,
    );
    expect(native.atomic).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
  });

  test("a proven absent file still creates private Windows configuration", () => {
    rmSync(join(directory, ".env"));
    native.atomic.mockImplementation((path: string, bytes: Uint8Array) =>
      writeFileSync(path, bytes),
    );
    expect(
      onPlatform("win32", () => upsertDotEnv(directory, { OMNESIS_FAKE_KNOB: "created" })).changed,
    ).toEqual(["OMNESIS_FAKE_KNOB"]);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe("OMNESIS_FAKE_KNOB=created\n");
  });
});
