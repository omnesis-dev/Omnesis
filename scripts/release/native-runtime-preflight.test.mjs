// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { assertNativeRuntimeSupported } from "../native-runtime-preflight.mjs";

describe("native runtime preflight", () => {
  test("rejects glibc below the native binding floor", () => {
    expect(() => assertNativeRuntimeSupported({ platform: "linux", glibcVersion: "2.34" })).toThrow(
      /glibc 2\.34 is too old/,
    );
  });

  test("accepts the boundary, newer glibc, macOS, and musl", () => {
    expect(() =>
      assertNativeRuntimeSupported({ platform: "linux", glibcVersion: "2.35" }),
    ).not.toThrow();
    expect(() =>
      assertNativeRuntimeSupported({ platform: "linux", glibcVersion: "3.0" }),
    ).not.toThrow();
    expect(() =>
      assertNativeRuntimeSupported({ platform: "darwin", glibcVersion: undefined }),
    ).not.toThrow();
    expect(() =>
      assertNativeRuntimeSupported({ platform: "linux", glibcVersion: undefined }),
    ).not.toThrow();
  });

  test("rejects a malformed glibc report", () => {
    expect(() => assertNativeRuntimeSupported({ platform: "linux", glibcVersion: "2." })).toThrow(
      /Could not read the host glibc version/,
    );
  });
});
