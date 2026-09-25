// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import { resolveServiceExec, serviceBinaryName, type ExecResolveDeps } from "./exec-resolver.js";

function deps(overrides: Partial<ExecResolveDeps> = {}): ExecResolveDeps {
  return {
    env: {},
    argv1: undefined,
    execPath: "/opt/node/bin/node",
    which: () => Promise.resolve(null),
    realpath: (p) => p,
    exists: () => false,
    ...overrides,
  };
}

describe("serviceBinaryName", () => {
  it("gateway and collector resolve through the omnesis binary", () => {
    expect(serviceBinaryName("gateway")).toBe("omnesis");
    expect(serviceBinaryName("collector")).toBe("omnesis");
  });
});

describe("resolveServiceExec", () => {
  it("--exec flag wins over everything", async () => {
    const exec = await resolveServiceExec(
      "gateway",
      "/custom/omnesis",
      deps({
        env: { OMNESIS_SERVICE_EXEC: "/env/omnesis" },
        which: () => Promise.resolve("/path/omnesis"),
      }),
    );
    expect(exec).toEqual(["/custom/omnesis", "gateway", "serve"]);
  });

  it("resolves a relative --exec against the cwd", async () => {
    const exec = await resolveServiceExec("gateway", "bin/omnesis", deps());
    expect(exec[0]).toBe(`${process.cwd()}/bin/omnesis`);
  });

  it("$OMNESIS_SERVICE_EXEC wins over which", async () => {
    const exec = await resolveServiceExec(
      "collector",
      undefined,
      deps({
        env: { OMNESIS_SERVICE_EXEC: "/env/omnesis" },
        which: () => Promise.resolve("/path/omnesis"),
      }),
    );
    expect(exec).toEqual(["/env/omnesis", "collector", "run"]);
  });

  it("falls back to which omnesis for gateway/collector", async () => {
    const asked: string[] = [];
    const exec = await resolveServiceExec(
      "gateway",
      undefined,
      deps({
        which: (name) => {
          asked.push(name);
          return Promise.resolve("/usr/local/bin/omnesis");
        },
      }),
    );
    expect(asked).toEqual(["omnesis"]);
    expect(exec).toEqual(["/usr/local/bin/omnesis", "gateway", "serve"]);
  });

  it("falls back to [node, realpath(argv1)] when running a compiled .js entry", async () => {
    const exec = await resolveServiceExec(
      "gateway",
      undefined,
      deps({
        argv1: "/install/node_modules/.bin/omnesis-shim.js",
        realpath: () => "/install/node_modules/omnesis/dist/index.js",
      }),
    );
    expect(exec).toEqual([
      "/opt/node/bin/node",
      "/install/node_modules/omnesis/dist/index.js",
      "gateway",
      "serve",
    ]);
  });

  it("execs the checkout's tsx runner when running a .ts source entry", async () => {
    const exec = await resolveServiceExec(
      "collector",
      undefined,
      deps({
        argv1: "/repo/packages/cli/src/index.ts",
        exists: (p) => p === "/repo/node_modules/.bin/tsx",
      }),
    );
    expect(exec).toEqual([
      "/repo/node_modules/.bin/tsx",
      "/repo/packages/cli/src/index.ts",
      "collector",
      "run",
    ]);
  });

  it("resolves the .ts entry through realpath before deriving the runner", async () => {
    const exec = await resolveServiceExec(
      "gateway",
      undefined,
      deps({
        argv1: "/link/index.ts",
        realpath: () => "/repo/packages/cli/src/index.ts",
        exists: (p) => p === "/repo/node_modules/.bin/tsx",
      }),
    );
    expect(exec[0]).toBe("/repo/node_modules/.bin/tsx");
    expect(exec[1]).toBe("/repo/packages/cli/src/index.ts");
  });

  it("errors when a .ts entry has no tsx runner above it", async () => {
    await expect(
      resolveServiceExec("gateway", undefined, deps({ argv1: "/repo/packages/cli/src/index.ts" })),
    ).rejects.toThrow(CliError);
  });

  it("errors with a --exec hint when nothing resolves", async () => {
    await expect(resolveServiceExec("gateway", undefined, deps())).rejects.toThrow(
      /omnesis is not on PATH.*--exec/,
    );
  });
});
