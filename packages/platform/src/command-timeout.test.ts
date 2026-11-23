// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { commandTimeoutError, describeCommandForDiagnostics } from "./command-timeout.js";

describe("describeCommandForDiagnostics", () => {
  it("names a Windows npm launcher's script and keeps its subcommands and flags", () => {
    expect(
      describeCommandForDiagnostics("C:\\Tools\\nodejs\\node.exe", [
        "D:\\work\\node_modules\\invented-cli\\cli.mjs",
        "plugins",
        "inspect",
        "invented-plugin",
        "--runtime",
        "--json",
      ]),
    ).toBe("node.exe cli.mjs plugins inspect invented-plugin --runtime --json");
  });

  it("elides values that could carry a secret or a machine detail", () => {
    const description = describeCommandForDiagnostics("/usr/bin/invented", [
      "--code",
      "A1B2C3D4E5",
      "--token=invented-secret-value",
      "https://invented.example.com:7600/path?token=abc",
      "--dir",
      "/home/invented-user/harness",
      "-EncodedCommand",
      "JABhAGIAYwAvAGQAZQBmAA==",
      "/ab+cd/ef",
      "npm-pack:C:\\Users\\invented\\archive.tgz",
      "17600",
    ]);
    expect(description).toBe("invented --code … --token=… … --dir … -EncodedCommand … … … …");
    for (const secret of ["A1B2C3D4E5", "invented-secret-value", "example.com", "invented-user"])
      expect(description).not.toContain(secret);
  });

  it("stops after a bounded number of arguments", () => {
    const args = Array.from({ length: 20 }, () => "word");
    expect(describeCommandForDiagnostics("invented", args).split(" ")).toHaveLength(14);
  });
});

describe("commandTimeoutError", () => {
  it("names the command, its limit and how long it ran, and keeps the timeout code", () => {
    const error = commandTimeoutError("invented", ["plugins", "list"], 30_000, 30_012.4);
    expect(error.message).toBe(
      "Command timed out after 30.0 s (limit 30.0 s): invented plugins list",
    );
    expect(error).toMatchObject({ code: "ETIMEDOUT", killed: true });
  });

  it("says when the command never started", () => {
    expect(commandTimeoutError("invented", [], 100, 140, "starting").message).toBe(
      "Command timed out before it started after 0.1 s (limit 0.1 s): invented",
    );
  });
});
