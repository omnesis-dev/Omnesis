// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  fstatSync: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
const scope = {
  configDir: "/example/library",
  instance: `desktop-${"a".repeat(16)}`,
  secretService: `dev.omnesis.desktop.${"b".repeat(64)}`,
};
const epoch = "c".repeat(64);
const root = join("/example/runtime", epoch);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
async function fixture(owner: unknown = undefined, retirement = false) {
  const node = await import("./node-command.js");
  const context = {
    root,
    launcher: join(root, "runtime-exec"),
    preload: join(root, "packages/core/dist/managed-runtime-bootstrap.js"),
    ...(owner === undefined
      ? {}
      : retirement
        ? { backgroundRetirement: owner }
        : { backgroundOwner: owner }),
  };
  node.installManagedRuntimeLauncher(context);
  return { node, context, background: await import("./managed-background.js") };
}
function owner() {
  return {
    format: 1 as const,
    scope: { format: 1 as const, ...scope },
    epoch,
    nonce: "00000000-0000-4000-8000-000000000001",
    helperPid: process.ppid,
    daemonPid: process.pid,
    pipe: { device: "1", inode: "2" },
  };
}
function fifo() {
  vi.mocked(fs.fstatSync).mockReturnValue({ isFIFO: () => true, dev: 1n, ino: 2n } as never);
}
test("headless/source ignores forged native hints and cannot assert background ownership", async () => {
  vi.stubEnv("OMNESIS_DESKTOP_BACKGROUND_OWNER", JSON.stringify(owner()));
  const background = await import("./managed-background.js");
  expect(
    background.managedDesktopBackgroundStartInvocation(
      scope,
      undefined,
      "file:///example/source.ts",
    ),
  ).toBeNull();
  expect(() => background.verifyManagedDesktopBackgroundOwner(scope)).toThrow(
    "verified native owner",
  );
  expect(child.spawnSync).not.toHaveBeenCalled();
});
test("fixed native client binds current epoch/scope and exact restore tuple without environment commands", async () => {
  const { background, context, node } = await fixture();
  const activation = {
    operationId: "00000000-0000-4000-8000-000000000002",
    attemptId: "00000000-0000-4000-8000-000000000003",
    epoch,
  };
  const call = background.managedDesktopBackgroundStartInvocation(
    scope,
    activation,
    import.meta.url,
  )!;
  expect(call.command).toBe(context.launcher);
  expect(call.args[0]).toBe("--background-start");
  expect(JSON.parse(Buffer.from(call.args[1], "base64url").toString())).toEqual({
    version: 1,
    scope: { format: 1, ...scope },
    epoch,
    activation,
  });
  expect(() =>
    background.managedDesktopBackgroundStartInvocation(
      scope,
      { ...activation, epoch: null },
      import.meta.url,
    ),
  ).toThrow();
  vi.spyOn(node, "managedRuntimeLauncherContext").mockReturnValue({
    ...context,
    data: {} as never,
  });
  expect(() =>
    background.managedDesktopBackgroundStartInvocation(scope, undefined, import.meta.url),
  ).toThrow();
});
test("publicly registered owner metadata is not authority without actual native verification", async () => {
  fifo();
  const hint = owner();
  const { background } = await fixture(hint);
  vi.mocked(child.spawnSync).mockReturnValue({ status: 78, signal: null } as never);
  expect(() => background.verifyManagedDesktopBackgroundOwner(scope)).toThrow(
    "verified native owner",
  );
  expect(child.spawnSync).toHaveBeenCalledOnce();
  vi.mocked(child.spawnSync).mockReturnValue({ status: 0, signal: null } as never);
  expect(background.verifyManagedDesktopBackgroundOwner(scope)).toEqual(hint);
  expect(child.spawnSync).toHaveBeenLastCalledWith(
    join(root, "runtime-exec"),
    ["--verify-background-owner", Buffer.from(JSON.stringify(hint)).toString("base64url")],
    expect.objectContaining({ stdio: [0, "ignore", "ignore"], timeout: 10000 }),
  );
});
test.each(["parent", "daemon", "pipe", "scope", "extra"])(
  "forged %s owner fails before native verification",
  async (kind) => {
    fifo();
    const hint: Record<string, unknown> = owner();
    if (kind === "parent") hint.helperPid = process.ppid + 100;
    if (kind === "daemon") hint.daemonPid = process.pid + 100;
    if (kind === "pipe") hint.pipe = { device: "1", inode: "3" };
    if (kind === "scope")
      hint.scope = { format: 1, ...scope, instance: `desktop-${"d".repeat(16)}` };
    if (kind === "extra") hint.executable = "/example/arbitrary";
    const { background } = await fixture(hint);
    expect(() => background.verifyManagedDesktopBackgroundOwner(scope)).toThrow();
    expect(child.spawnSync).not.toHaveBeenCalled();
  },
);
test("owner metadata does not spread to workers and null-device stdin cannot authenticate", async () => {
  const { node, background } = await fixture(owner());
  expect(node.managedRuntimePreload().join(" ")).not.toContain("background-owner");
  vi.mocked(fs.fstatSync).mockReturnValue({ isFIFO: () => false, dev: 1n, ino: 2n } as never);
  expect(() => background.verifyManagedDesktopBackgroundOwner(scope)).toThrow();
  expect(child.spawnSync).not.toHaveBeenCalled();
});

test("captured owner metadata cannot be mutated through the public context read seam", async () => {
  const hint = owner();
  const { node } = await fixture(hint);
  const exposed = node.managedRuntimeLauncherContext()!;
  (exposed.backgroundOwner as typeof hint).scope.configDir = "/example/changed";
  expect(node.managedRuntimeLauncherContext()?.backgroundOwner).toEqual(hint);
});

test("a compiled macOS entry cannot select source fallback by omitting its preload", async () => {
  const background = await import("./managed-background.js");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(() =>
      background.managedDesktopBackgroundStartInvocation(
        scope,
        undefined,
        "file:///example/dist/background-start.js",
      ),
    ).toThrow();
    expect(
      background.managedDesktopBackgroundStartInvocation(
        scope,
        undefined,
        "file:///example/src/background-start.ts",
      ),
    ).toBeNull();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("retirement and daemon provenance cannot authorize each other's fixed entry", async () => {
  fifo();
  const hint = owner();
  const { background, node } = await fixture(hint, true);
  vi.mocked(child.spawnSync).mockReturnValue({ status: 0, signal: null } as never);
  expect(() => background.verifyManagedDesktopBackgroundOwner(scope)).toThrow();
  expect(child.spawnSync).not.toHaveBeenCalled();
  expect(background.verifyManagedDesktopBackgroundRetirement(scope)).toEqual(hint);
  expect(child.spawnSync).toHaveBeenLastCalledWith(
    join(root, "runtime-exec"),
    ["--verify-background-retirement", Buffer.from(JSON.stringify(hint)).toString("base64url")],
    expect.objectContaining({ stdio: [0, "ignore", "ignore"], timeout: 10000 }),
  );
  expect(node.managedRuntimePreload().join(" ")).not.toContain("background-retirement");
  expect(() =>
    background.managedDesktopBackgroundStartInvocation(scope, undefined, import.meta.url),
  ).toThrow();
  const exposed = node.managedRuntimeLauncherContext()!;
  (exposed.backgroundRetirement as typeof hint).scope.configDir = "/example/changed";
  expect(node.managedRuntimeLauncherContext()?.backgroundRetirement).toEqual(hint);
});

test("daemon-only registration and forged environment cannot retire a library", async () => {
  fifo();
  vi.stubEnv("OMNESIS_DESKTOP_BACKGROUND_RETIREMENT", JSON.stringify(owner()));
  const { background } = await fixture(owner());
  expect(() => background.verifyManagedDesktopBackgroundRetirement(scope)).toThrow();
  expect(child.spawnSync).not.toHaveBeenCalled();
});

test("public retirement metadata still requires successful native code-chain verification", async () => {
  fifo();
  const { background } = await fixture(owner(), true);
  vi.mocked(child.spawnSync).mockReturnValue({ status: 78, signal: null } as never);
  expect(() => background.verifyManagedDesktopBackgroundRetirement(scope)).toThrow();
});

test("retirement metadata cannot mix with DATA or daemon provenance", async () => {
  const node = await import("./node-command.js");
  const context = {
    root,
    launcher: join(root, "runtime-exec"),
    preload: join(root, "packages/core/dist/managed-runtime-bootstrap.js"),
    backgroundRetirement: owner(),
  };
  expect(() =>
    node.installManagedRuntimeLauncher({ ...context, backgroundOwner: owner() }),
  ).toThrow();
  expect(() => node.installManagedRuntimeLauncher({ ...context, data: {} as never })).toThrow();
});
