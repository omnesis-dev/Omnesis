// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fileSystem from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});
const native = vi.hoisted(() => ({ roots: vi.fn(), inspect: vi.fn() }));
vi.mock("@omnesis/core", () => ({
  ensurePrivateDirs: native.roots,
  inspectWindowsPrivatePaths: native.inspect,
}));
import {
  prepareCodexPrivateState,
  bindCodexPoolAuthOwner,
  codexPoolAuthOwner,
} from "./codex-private-state.js";
import type { Dir } from "node:fs";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "codex-private-state-")));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(fileSystem.opendir).mockReset();
  native.roots.mockImplementation(async (paths: readonly string[]) => {
    for (const path of paths) await mkdir(path, { recursive: true });
  });
  native.inspect.mockImplementation((paths: readonly unknown[]) =>
    Promise.resolve(paths.map(() => ({ private: true, fixed: false }))),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("secures roots before bounded preorder inspection and preserves existing bytes", async () => {
  const home = join(root, "home"),
    workspace = join(root, "workspace");
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "auth.json"), "invented retained authentication");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) =>
      writeFile(join(home, "sessions", `${index}.jsonl`), "invented retained session"),
    ),
  );
  await prepareCodexPrivateState([home, workspace]);
  expect(native.roots).toHaveBeenCalledWith([home, workspace]);
  expect(native.roots.mock.invocationCallOrder[0]).toBeLessThan(
    native.inspect.mock.invocationCallOrder[0]!,
  );
  const batches = native.inspect.mock.calls.map(([paths, options]) => {
    const batch = paths as Array<{ path: string; kind: string }>;
    expect(batch.every((entry) => entry.kind === batch[0]!.kind)).toBe(true);
    expect(options).toEqual({ repair: true, protect: batch[0]!.kind === "directory" });
    return batch;
  });
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.every((paths) => paths.length <= 512)).toBe(true);
  const paths = batches.flat();
  expect(paths.findIndex((entry) => entry.path === home)).toBeLessThan(
    paths.findIndex((entry) => entry.path === join(home, "auth.json")),
  );
  expect(paths.findIndex((entry) => entry.path === join(home, "sessions"))).toBeLessThan(
    paths.findIndex((entry) => entry.path.endsWith("0.jsonl")),
  );
  expect(await readFile(join(home, "auth.json"), "utf8")).toBe("invented retained authentication");
});
it("only the pool's exact auth reference is permitted, with native inspection of its owner file", async () => {
  const home = join(root, "member"),
    owner = join(root, "owner");
  await mkdir(home);
  await mkdir(owner);
  const target = join(owner, "auth.json");
  await writeFile(target, "invented shared login");
  await symlink(target, join(home, "auth.json"));
  await prepareCodexPrivateState([home], { home, target });
  expect(native.inspect.mock.calls.flatMap(([paths]) => paths)).toContainEqual({
    path: target,
    kind: "file",
  });
  await expect(prepareCodexPrivateState([home])).rejects.toThrow("untrusted symbolic link");
  await expect(
    prepareCodexPrivateState([home], { home, target: join(owner, "other.json") }),
  ).rejects.toThrow("untrusted symbolic link");
  await symlink(owner, join(home, "unrelated"), process.platform === "win32" ? "junction" : "dir");
  await expect(prepareCodexPrivateState([home], { home, target })).rejects.toThrow(
    "untrusted symbolic link",
  );
  expect(await readFile(target, "utf8")).toBe("invented shared login");
});
it.each(["unsafe", "incomplete", "failure"])(
  "refuses startup after %s native evidence",
  async (scenario) => {
    native.inspect.mockImplementation((paths: readonly unknown[]) =>
      scenario === "failure"
        ? Promise.reject(new Error("inspection unavailable"))
        : Promise.resolve(
            scenario === "incomplete"
              ? []
              : paths.map(() => ({ private: false, fixed: false, error: "EPRIVATE" })),
          ),
    );
    await expect(prepareCodexPrivateState([join(root, "home")])).rejects.toThrow(
      scenario === "failure" ? "inspection unavailable" : "could not be verified",
    );
  },
);
it("binds an auth owner only through the trusted pool registry, without runtime configuration fields", () => {
  const runtime = {};
  expect(codexPoolAuthOwner(runtime)).toBeUndefined();
  bindCodexPoolAuthOwner(runtime, root);
  expect(codexPoolAuthOwner(runtime)).toEqual({ home: root, path: join(root, "auth.json") });
  expect(codexPoolAuthOwner({ sharedAuthPath: join(root, "untrusted.json") })).toBeUndefined();
});

it("rejects aliased roots before creating or changing anything beneath their targets", async () => {
  const target = join(root, "unrelated"),
    alias = join(root, "alias");
  await mkdir(target);
  await writeFile(join(target, "preserved.json"), "invented unrelated bytes");
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(prepareCodexPrivateState([join(alias, "new-runtime")])).rejects.toThrow(
    "untrusted directory alias",
  );
  expect(native.roots).not.toHaveBeenCalled();
  expect(await readFile(join(target, "preserved.json"), "utf8")).toBe("invented unrelated bytes");
});

it("bounds a single oversized directory and closes its iterator without scanning partial state", async () => {
  let closed = false;
  const entries = (function* () {
    try {
      for (let index = 0; index < 50_001; index++) yield { name: `${index}.jsonl` };
    } finally {
      closed = true;
    }
  })();
  vi.mocked(fileSystem.opendir).mockResolvedValue(entries as unknown as Dir);
  await expect(prepareCodexPrivateState([join(root, "home")])).rejects.toThrow(
    "bounded inspection limit",
  );
  expect(closed).toBe(true);
  expect(native.inspect).not.toHaveBeenCalled();
});

it("fails closed and closes the directory iterator when enumeration fails", async () => {
  let closed = false;
  const entries = (function* () {
    try {
      yield { name: "invented.jsonl" };
      throw new Error("directory enumeration unavailable");
    } finally {
      closed = true;
    }
  })();
  vi.mocked(fileSystem.opendir).mockResolvedValue(entries as unknown as Dir);
  await expect(prepareCodexPrivateState([join(root, "home")])).rejects.toThrow(
    "directory enumeration unavailable",
  );
  expect(closed).toBe(true);
  expect(native.inspect).not.toHaveBeenCalled();
});
