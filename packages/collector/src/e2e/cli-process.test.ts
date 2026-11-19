// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { execCliWithDiagnostics } from "./cli-process.js";

describe("CLI subprocess diagnostics", () => {
  it("returns successful output", async () => {
    await expect(
      execCliWithDiagnostics(process.execPath, ["-e", "process.stdout.write('ready')"], {}),
    ).resolves.toEqual({ stdout: "ready", stderr: "" });
  });

  it("distinguishes command exit from deadline termination without exposing output", async () => {
    const failure = await execCliWithDiagnostics(
      process.execPath,
      ["-e", "process.stderr.write('fictional-secret'); process.exit(42)"],
      {},
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /code=42, signal=none, killed=false, stdoutBytes=0, stderrBytes=16/,
    );
    expect((failure as Error).message).not.toContain("fictional-secret");
    expect(failure).not.toHaveProperty("cause");
    await expect(
      execCliWithDiagnostics(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 100,
      }),
    ).rejects.toThrow(/signal=SIGTERM, killed=true/);
  });
});
