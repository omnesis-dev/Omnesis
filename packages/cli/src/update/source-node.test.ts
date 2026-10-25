// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { assertSourceNodeVersion, assertSourceTargetNode } from "./source-node.js";
import type { CommandRunner } from "../commands/update.js";

const manifest = { engines: { node: ">=24.16.0 <25 || >=26.1.0" } };

describe("source Node requirements", () => {
  it.each([
    ["24.15.0", false],
    ["24.16.0", true],
    ["24.22.0", true],
    ["25.0.0", false],
    ["26.0.0", false],
    ["26.1.0", true],
    ["26.1.0-rc.1", false],
    ["garbage", false],
  ])("checks Node %s against the target requirement", (version, supported) => {
    const check = () => assertSourceNodeVersion(manifest, version as string);
    if (supported) expect(check).not.toThrow();
    else expect(check).toThrow(/ensure node.*rerun omnesis update/);
  });

  it("keeps older source targets compatible with their own declared runtime", () => {
    expect(() =>
      assertSourceNodeVersion({ engines: { node: ">=24.0.0" } }, "24.15.0"),
    ).not.toThrow();
  });

  it.each([
    {},
    { engines: {} },
    { engines: { node: " " } },
    null,
    { engines: null },
    { engines: { node: 24 } },
    { engines: { node: "invalid" } },
  ])("refuses malformed target requirements: %j", (target) => {
    expect(() => assertSourceNodeVersion(target, "24.22.0")).toThrow("invalid Node requirements");
  });

  it("reads the immutable root manifest and the child Node version without running target code", async () => {
    const run = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(manifest) })
      .mockResolvedValueOnce({ code: 0, stdout: "24.15.0\n" });
    await expect(assertSourceTargetNode(run, "/checkout", "a".repeat(40))).rejects.toThrow(
      "24.15.0",
    );
    expect(run.mock.calls.map(([spec]) => spec)).toEqual([
      {
        command: "git",
        args: ["show", "--no-textconv", `${"a".repeat(40)}:package.json`],
        cwd: "/checkout",
      },
      { command: "node", args: ["-p", "process.versions.node"], cwd: "/checkout" },
    ]);
  });

  it.each([
    { code: 1, stdout: "" },
    { code: 0, stdout: "not json" },
  ])("refuses an unreadable target before probing Node", async (result) => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result);
    await expect(assertSourceTargetNode(run, "/checkout", "a".repeat(40))).rejects.toThrow(
      "Could not read",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
