// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  execFile: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
import { publicGatewayCommit } from "./commit.js";

describe("public upstream commit disclosure", () => {
  const local = "a".repeat(40);
  const publicTip = "b".repeat(40);
  beforeEach(() => {
    mocks.mkdtemp.mockResolvedValue("/tmp/isolated-public-refs");
    mocks.rm.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(new Error("no artifact"));
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      const stdout =
        args[0] === "rev-parse"
          ? `${local}\n`
          : args[0] === "ls-remote"
            ? `${publicTip}\trefs/heads/main\n`
            : "";
      callback(null, { stdout, stderr: "" });
    });
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("never transmits an unknown local hash to verify public ancestry", async () => {
    expect(await publicGatewayCommit(new AbortController().signal)).toBe(local);
    const networkCalls = mocks.execFile.mock.calls.filter((call) => call[1][0] === "ls-remote");
    expect(networkCalls).toHaveLength(1);
    expect(networkCalls[0]?.[1]).toEqual([
      "ls-remote",
      "https://github.com/omnesis-dev/Omnesis.git",
      "refs/heads/main",
      "refs/tags/*",
    ]);
    expect(JSON.stringify(networkCalls)).not.toContain(local);
    expect(mocks.execFile.mock.calls.at(-1)?.[1]).toEqual([
      "merge-base",
      "--is-ancestor",
      local,
      publicTip,
    ]);
  });

  it("isolates the remote verifier from Git URL rewrites, private repositories and grafts", async () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "url.file:///private/.insteadOf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/omnesis-dev/Omnesis.git");
    vi.stubEnv("GIT_DIR", "/private/.git");
    try {
      expect(await publicGatewayCommit(new AbortController().signal)).toBe(local);
      const remote = mocks.execFile.mock.calls.find((call) => call[1][0] === "ls-remote")!;
      expect(remote[2].cwd).toBe("/tmp/isolated-public-refs");
      expect(remote[2].env).not.toHaveProperty("GIT_DIR");
      expect(remote[2].env).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(remote[2].env).not.toHaveProperty("GIT_CONFIG_KEY_0");
      expect(remote[2].env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      });
      expect(remote[2].env.GIT_CONFIG_GLOBAL).toBe(remote[2].env.GIT_CONFIG_SYSTEM);
      expect(remote[2].env.GIT_GRAFT_FILE).toBe(remote[2].env.GIT_CONFIG_SYSTEM);
      expect(mocks.rm).toHaveBeenCalledWith("/tmp/isolated-public-refs", {
        recursive: true,
        force: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("recognizes a public release tag in a shallow source installation", async () => {
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "merge-base") callback(new Error("main object absent"));
      else
        callback(null, {
          stdout:
            args[0] === "rev-parse"
              ? local
              : args[0] === "ls-remote"
                ? `${publicTip}\trefs/heads/main\n${"c".repeat(40)}\trefs/tags/v0.1.0\n${local}\trefs/tags/v0.1.0^{}\n`
                : "",
          stderr: "",
        });
    });
    expect(await publicGatewayCommit(new AbortController().signal)).toBe(local);
    expect(mocks.execFile.mock.calls.some((call) => call[1][0] === "merge-base")).toBe(false);
  });

  it("reports custom for private fork history", async () => {
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "merge-base") callback(new Error("not reachable"));
      else
        callback(null, {
          stdout:
            args[0] === "rev-parse"
              ? local
              : args[0] === "ls-remote"
                ? `${publicTip}\trefs/heads/main\n`
                : "",
          stderr: "",
        });
    });
    expect(await publicGatewayCommit(new AbortController().signal)).toBe("custom");
  });

  it("does no external lookup for modified source and tolerates an unavailable verifier", async () => {
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "ls-remote") callback(new Error("offline"));
      else callback(null, { stdout: args[0] === "rev-parse" ? local : "", stderr: "" });
    });
    expect(await publicGatewayCommit(new AbortController().signal)).toBe("custom");
    mocks.execFile.mockClear();
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      callback(null, { stdout: args[0] === "rev-parse" ? local : " M private.ts", stderr: "" });
    });
    expect(await publicGatewayCommit(new AbortController().signal)).toBe("custom");
    expect(mocks.execFile.mock.calls.some((call) => call[1][0] === "ls-remote")).toBe(false);
  });

  it.each([local, "custom"])(
    "uses a packaged public proof (%s) without enclosing-repo inference",
    async (gitCommit) => {
      mocks.readFile.mockResolvedValue(JSON.stringify({ gitCommit }));
      expect(await publicGatewayCommit(new AbortController().signal)).toBe(gitCommit);
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
});
