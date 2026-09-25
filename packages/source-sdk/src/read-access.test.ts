// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { close, closeSync, constants, fstat, open } from "node:fs";
import { opendir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listReadAccessDirectory, probeFileReadAccess } from "./read-access.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  open: vi.fn(),
  fstat: vi.fn(),
  closeSync: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ opendir: vi.fn() }));

describe("fresh read access", () => {
  const path = "/private/example/source.db";
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(open).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      (callback as (error: null, fd: number) => void)(null, 42);
    });
    vi.mocked(fstat).mockImplementation((_fd, callback) => {
      (callback as (error: null, stat: { isFile: () => boolean }) => void)(null, {
        isFile: () => true,
      });
    });
  });

  it("opens afresh, checks file type and closes without reading content", async () => {
    for (let i = 0; i < 2; i++) {
      expect(await probeFileReadAccess(path, { signal: new AbortController().signal })).toEqual({
        status: "readable",
      });
    }
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK,
      expect.any(Function),
    );
    expect(closeSync).toHaveBeenCalledTimes(2);
    expect(closeSync).toHaveBeenCalledWith(42);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "ENOENT", "EIO"])(
    "categorizes %s without exposing errors",
    async (code) => {
      vi.mocked(open).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1);
        (callback as (error: Error) => void)(Object.assign(new Error(`refused ${path}`), { code }));
      });
      expect(await probeFileReadAccess(path, { signal: new AbortController().signal })).toEqual({
        status: code === "EACCES" || code === "EPERM" ? "denied" : "unavailable",
      });
    },
  );

  it("does not report directories as readable files", async () => {
    vi.mocked(fstat).mockImplementation((_fd, callback) => {
      (callback as (error: null, stat: { isFile: () => boolean }) => void)(null, {
        isFile: () => false,
      });
    });
    expect(await probeFileReadAccess(path, { signal: new AbortController().signal })).toEqual({
      status: "unavailable",
    });
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("retains ownership after abort until a late file handle closes, without further work", async () => {
    const controller = new AbortController();
    let finish!: (error: null, fd: number) => void;
    vi.mocked(open).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      finish = callback as typeof finish;
    });
    const pending = probeFileReadAccess(path, { signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled);
    controller.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.mocked(closeSync).mockImplementation(() => {
      expect(settled).not.toHaveBeenCalled();
    });
    finish(null, 42);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(closeSync).toHaveBeenCalledOnce();
    expect(fstat).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("does no work after pre-abort", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await probeFileReadAccess(path, { signal: controller.signal })).toEqual({
      status: "unavailable",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("closes late directory handles after cancellation without listing", async () => {
    const controller = new AbortController();
    let finish!: (value: never) => void;
    vi.mocked(opendir).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = listReadAccessDirectory(path, { signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled);
    controller.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const directory = { close: vi.fn(), read: vi.fn() };
    finish(directory as never);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(directory.close).toHaveBeenCalledOnce();
    expect(directory.read).not.toHaveBeenCalled();
  });

  it("closes a handle when metadata inspection fails", async () => {
    vi.mocked(fstat).mockImplementation((_fd, callback) => {
      (callback as (error: Error) => void)(new Error(path));
    });
    expect(await probeFileReadAccess(path, { signal: new AbortController().signal })).toEqual({
      status: "unavailable",
    });
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("waits for pending metadata after abort, then closes synchronously before settlement", async () => {
    let finish!: (error: null, stat: { isFile: () => boolean }) => void;
    vi.mocked(fstat).mockImplementation((_fd, callback) => {
      finish = callback as typeof finish;
    });
    const controller = new AbortController();
    const pending = probeFileReadAccess(path, { signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled);
    await vi.waitFor(() => expect(fstat).toHaveBeenCalledOnce());
    controller.abort();
    expect(settled).not.toHaveBeenCalled();
    expect(closeSync).not.toHaveBeenCalled();
    finish(null, { isFile: () => true });
    expect(await pending).toEqual({ status: "unavailable" });
    expect(closeSync).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("bounds directory discovery and closes at overflow", async () => {
    const directory = { read: vi.fn().mockResolvedValue({ name: "entry" }), close: vi.fn() };
    vi.mocked(opendir).mockResolvedValue(directory as never);
    expect(await listReadAccessDirectory(path, { signal: new AbortController().signal })).toEqual({
      status: "unavailable",
    });
    expect(directory.read).toHaveBeenCalledTimes(257);
    expect(directory.close).toHaveBeenCalledOnce();
  });

  it("directory access tests listing, including an empty directory", async () => {
    const directory = { read: vi.fn().mockResolvedValue(null), close: vi.fn() };
    vi.mocked(opendir).mockResolvedValue(directory as never);
    expect(await listReadAccessDirectory(path, { signal: new AbortController().signal })).toEqual({
      status: "readable",
      entries: [],
    });
    expect(directory.read).toHaveBeenCalledOnce();
    expect(directory.close).toHaveBeenCalledOnce();
  });

  it("closes a directory after a denied read and does not leak its path", async () => {
    const directory = {
      read: vi.fn().mockRejectedValue(Object.assign(new Error(path), { code: "EPERM" })),
      close: vi.fn(),
    };
    vi.mocked(opendir).mockResolvedValue(directory as never);
    expect(await listReadAccessDirectory(path, { signal: new AbortController().signal })).toEqual({
      status: "denied",
    });
    expect(directory.close).toHaveBeenCalledOnce();
  });
});
