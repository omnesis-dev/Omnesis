// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("./runtime.js", () => ({ runRelayCommand: mocks.run }));
vi.mock("@omnesis/core", () => ({
  createLogger: () => ({ info: mocks.info, error: mocks.error }),
}));

const argv = process.argv;
const priorCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = priorCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

test("default daemon command reports readiness and owns both shutdown signals", async () => {
  process.argv = ["node", "main"];
  const close = vi.fn(async () => {});
  mocks.run.mockResolvedValue({ url: "http://127.0.0.1:1234", dataPort: 5678, close });
  const handlers = new Map<string | symbol, (...args: unknown[]) => void>();
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    handlers.set(event, listener);
    return process;
  });
  await import("./main.js");
  expect(mocks.run).toHaveBeenCalledWith("serve", process.env);
  expect(mocks.info).toHaveBeenCalledWith("Listening on http://127.0.0.1:1234");
  expect(mocks.info).toHaveBeenCalledWith("TLS passthrough port 5678");
  handlers.get("SIGINT")!();
  handlers.get("SIGTERM")!();
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
});

test("login reports credential persistence without logging credentials", async () => {
  process.argv = ["node", "main", "login"];
  mocks.run.mockResolvedValue(undefined);
  await import("./main.js");
  expect(mocks.run).toHaveBeenCalledWith("login", process.env);
  expect(mocks.info).toHaveBeenCalledWith("Cloud relay command complete");
});

test("startup errors set a failure status and never log credential parser payloads", async () => {
  process.argv = ["node", "main", "serve"];
  mocks.run.mockRejectedValue(new Error("fictional-sensitive-value"));
  await import("./main.js");
  expect(process.exitCode).toBe(1);
  expect(mocks.error).toHaveBeenCalledWith(
    "Cloud relay command failed; check configuration and credentials",
  );
});

test("shutdown failures are contained and set a failure status", async () => {
  mocks.run.mockResolvedValue({
    url: "http://127.0.0.1:1234",
    close: async () => {
      throw new Error("failed");
    },
  });
  let signal!: () => void;
  vi.spyOn(process, "once").mockImplementation((_event, listener) => {
    signal = listener as () => void;
    return process;
  });
  await import("./main.js");
  signal();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.error).toHaveBeenCalledWith("Cloud relay shutdown failed");
  expect(process.exitCode).toBe(1);
});

test("offline prepare-owner keeps stdout public JSON free of generic success messages", async () => {
  process.argv = ["node", "main", "prepare-owner"];
  mocks.run.mockResolvedValue(undefined);
  await import("./main.js");
  expect(mocks.run).toHaveBeenCalledWith("prepare-owner", process.env);
  expect(mocks.info).not.toHaveBeenCalled();
});
