// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveHelperBinary } from "./helper-binary.js";

let dir: string;
let program: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-helper-bin-"));
  program = join(dir, "omnesis-tailnet");
  writeFileSync(program, "#!/bin/sh\n");
  chmodSync(program, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveHelperBinary", () => {
  test("uses the configured program when it is an executable absolute path", () => {
    expect(resolveHelperBinary({ OMNESIS_TAILSCALE_HELPER: program }, "/nowhere")).toEqual({
      path: program,
    });
  });

  test("refuses relative, missing and non-file configured paths, never falling back", () => {
    expect(resolveHelperBinary({ OMNESIS_TAILSCALE_HELPER: "omnesis-tailnet" }, program)).toEqual({
      path: null,
      reason: "OMNESIS_TAILSCALE_HELPER must be an absolute path.",
    });
    for (const invalid of [join(dir, "absent"), dir]) {
      expect(resolveHelperBinary({ OMNESIS_TAILSCALE_HELPER: invalid }, program)).toMatchObject({
        path: null,
        reason: expect.stringContaining("missing or not executable"),
      });
    }
  });

  test.skipIf(process.platform === "win32")(
    "refuses a program without POSIX execute permission",
    () => {
      chmodSync(program, 0o644);
      expect(resolveHelperBinary({ OMNESIS_TAILSCALE_HELPER: program }, program)).toMatchObject({
        path: null,
        reason: expect.stringContaining("missing or not executable"),
      });
    },
  );

  test("otherwise uses the copy built in the source tree, or says how to get one", () => {
    expect(resolveHelperBinary({}, program)).toEqual({ path: program });
    expect(resolveHelperBinary({}, join(dir, "absent"))).toMatchObject({
      path: null,
      reason: expect.stringContaining("npm run tailnet-helper:build"),
    });
    expect(resolveHelperBinary({}, dir)).toMatchObject({ path: null });
  });
});
