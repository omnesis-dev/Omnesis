// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
const root = join(tmpdir(), "invented-managed-runtime");
async function configured() {
  const node = await import("./node-command.js");
  const context = {
    root,
    launcher: join(root, "runtime-exec"),
    preload: join(root, "packages/core/dist/managed-runtime-bootstrap.js"),
  };
  node.installManagedRuntimeLauncher(context);
  return { node, context };
}

test("ordinary headless/source invocation ignores arbitrary launcher environment hints", async () => {
  vi.stubEnv("OMNESIS_NODE_WRAPPER", "/invented/untrusted-wrapper");
  const node = await import("./node-command.js");
  expect(node.managedNodeInvocation(["--version"])).toEqual({
    command: process.execPath,
    args: ["--version"],
  });
  expect(node.managedRuntimePreload()).toEqual([]);
  expect(await node.resolveNpmInvocation(["install"], { platform: "darwin" })).toEqual({
    command: "npm",
    args: ["install"],
  });
});
test("compiled workers retain the fixed pure preload and sibling processes use the native adapter", async () => {
  const { context } = await configured();
  const { resolveSubprocessEntry, resolveWorkerEntry } = await import("./worker-entry.js");
  const caller = pathToFileURL(join(root, "packages/gateway/dist/runtime.js")).href;
  expect(resolveSubprocessEntry("./child.ts", caller)).toEqual({
    command: context.launcher,
    args: ["--node", join(root, "packages/gateway/dist/child.js")],
  });
  expect(resolveWorkerEntry("./worker.ts", caller, "./tsx-register.mjs").execArgv).toEqual([
    "--use-system-ca",
    "--import",
    pathToFileURL(context.preload).href,
  ]);
});
test("npm and npx cannot fall back to a host-installed runtime when managed", async () => {
  const { node, context } = await configured();
  for (const command of ["npm", "npx"]) {
    expect(
      await node.resolveNpmInvocation(["--version"], {
        command,
        env: { PATH: "/invented/host/bin" },
      }),
    ).toEqual({
      command: context.launcher,
      args: ["--node", join(root, "lib/node_modules/npm/bin", `${command}-cli.js`), "--version"],
    });
  }
});
test("owned native binaries and external interpreters retain the same epoch lease", async () => {
  const { node, context } = await configured();
  expect(
    node.nodeCommandInvocation(join(root, "packages/tailnet-helper/dist/bin/omnesis-tailnet"), [
      "--fixture",
    ]),
  ).toEqual({
    command: context.launcher,
    args: ["--exec", "packages/tailnet-helper/dist/bin/omnesis-tailnet", "--fixture"],
  });
  expect(node.nodeCommandInvocation(join(root, "..", "outside-program"), ["--fixture"])).toEqual({
    command: context.launcher,
    args: ["--external", join(root, "..", "outside-program"), "--fixture"],
  });
  expect(node.nodeCommandInvocation("./helper", ["fixture"])).toEqual({
    command: context.launcher,
    args: ["--external", "./helper", "fixture"],
  });
  expect(node.nodeCommandInvocation(context.launcher, ["--node", "entry.js"])).toEqual({
    command: context.launcher,
    args: ["--node", "entry.js"],
  });
  expect(node.nodeCommandInvocation("/usr/bin/security", ["fixture"])).toEqual({
    command: context.launcher,
    args: ["--external", "/usr/bin/security", "fixture"],
  });
});
test("the selected code identity cannot be changed or redirected to an arbitrary executable", async () => {
  const { node, context } = await configured();
  expect(() =>
    node.installManagedRuntimeLauncher({ ...context, launcher: "/invented/external" }),
  ).toThrow("Invalid");
  const other = join(root, "other");
  expect(() =>
    node.installManagedRuntimeLauncher({
      root: other,
      launcher: join(other, "runtime-exec"),
      preload: join(other, "packages/core/dist/managed-runtime-bootstrap.js"),
    }),
  ).toThrow("cannot change");
});

test("fork and Worker defaults lose only the exact daemon-owner preload query", async () => {
  const node = await import("./node-command.js");
  const ordinary = "file:///example/runtime/bootstrap.js",
    owner = ordinary + "?background-owner=fixture";
  expect(
    node.managedBackgroundExecArgv(
      ["--use-system-ca", "--import", owner, "--import=another-preload", "--title", owner],
      owner,
      ordinary,
    ),
  ).toEqual([
    "--use-system-ca",
    "--import",
    ordinary,
    "--import=another-preload",
    "--title",
    owner,
  ]);
  expect(node.managedBackgroundExecArgv(["--import=" + owner], owner, ordinary)).toEqual([
    "--import=" + ordinary,
  ]);
});
