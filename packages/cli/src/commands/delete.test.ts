// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs, type ArgsDef } from "citty";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gw: vi.fn(),
    withSpinner: (_label: string, operation: () => unknown) => operation(),
  };
});

import { gw, EXIT_USER_ERROR } from "../utils.js";
import { deleteCommand } from "./delete.js";

async function argsDef(): Promise<ArgsDef> {
  const def = deleteCommand.args;
  return (typeof def === "function" ? await def() : def!) as ArgsDef;
}

function run(args: Record<string, unknown>): Promise<void> {
  return (deleteCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
    args,
  });
}

afterEach(() => {
  vi.mocked(gw).mockReset();
  vi.restoreAllMocks();
});

describe("delete — arg parsing", () => {
  it("deletes for good by default and accepts --copy for a copy-only delete", async () => {
    const def = await argsDef();
    expect(parseArgs(["a3f2c1b8"], def)).toMatchObject({ id: "a3f2c1b8" });
    expect(parseArgs(["a3f2c1b8"], def).copy).toBeFalsy();
    expect(parseArgs(["a3f2c1b8", "--copy", "--yes"], def)).toMatchObject({
      id: "a3f2c1b8",
      copy: true,
      yes: true,
    });
  });
});

describe("delete — request", () => {
  it("asks the gateway to keep the copy recapturable only with --copy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    (gw as Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: 1 }) });

    await run({ id: "a3f2c1b8", yes: true });
    expect(gw).toHaveBeenLastCalledWith("/documents/a3f2c1b8", { method: "DELETE" });

    await run({ id: "a3f2c1b8", yes: true, copy: true });
    expect(gw).toHaveBeenLastCalledWith("/documents/a3f2c1b8?tombstone=0", { method: "DELETE" });
  });

  it("refuses to delete without --yes when it cannot ask", async () => {
    // Vitest runs without a TTY, so the command must not block on a prompt.
    await expect(run({ id: "a3f2c1b8" })).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(gw).not.toHaveBeenCalled();
  });
});
