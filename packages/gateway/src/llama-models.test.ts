// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const AMX_INFO = "CPU : SSE3 = 1 | AVX512 = 1 | AMX_INT8 = 1 | REPACK = 1 | ";
const PLAIN_INFO = "CPU : SSE3 = 1 | AVX2 = 1 | AVX512 = 1 | REPACK = 1 | ";

const llama = vi.hoisted(() => ({
  systemInfo: "",
  loadModel: vi.fn(),
}));

vi.mock("./llama-instance.js", () => ({
  getLlamaInstance: () => Promise.resolve(llama),
}));

const warn = vi.hoisted(() => vi.fn());
vi.mock("@omnesis/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omnesis/core")>();
  return {
    ...core,
    createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

function fakeModel() {
  return { dispose: vi.fn(async () => {}) };
}

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function freshModule() {
  vi.resetModules();
  return import("./llama-models.js");
}

beforeEach(() => {
  llama.loadModel.mockReset();
  llama.loadModel.mockImplementation(async () => fakeModel());
  warn.mockReset();
});

afterEach(() => onPlatform(realPlatform));

describe("modelFreeIsUnsafe", () => {
  test("only Windows with llama.cpp's AMX CPU backend cannot free a model", async () => {
    const { modelFreeIsUnsafe } = await freshModule();
    expect(modelFreeIsUnsafe("win32", AMX_INFO)).toBe(true);
    expect(modelFreeIsUnsafe("win32", PLAIN_INFO)).toBe(false);
    expect(modelFreeIsUnsafe("win32", "CPU : AMX_INT8 = 0 | ")).toBe(false);
    expect(modelFreeIsUnsafe("linux", AMX_INFO)).toBe(false);
    expect(modelFreeIsUnsafe("darwin", AMX_INFO)).toBe(false);
  });
});

describe("loading and releasing local models", () => {
  test.each([
    ["linux", AMX_INFO],
    ["darwin", PLAIN_INFO],
    ["win32", PLAIN_INFO],
  ] as const)("frees a released model on %s without AMX trouble", async (platform, info) => {
    onPlatform(platform);
    llama.systemInfo = info;
    const models = await freshModule();
    const model = await models.loadLlamaModel({ modelPath: "/models/a.gguf" });
    await models.releaseLlamaModel(model);
    expect(model.dispose).toHaveBeenCalledOnce();
    expect(models.holdsUnfreeableLlamaModels()).toBe(false);
    await models.loadLlamaModel({ modelPath: "/models/a.gguf" });
    expect(llama.loadModel).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps a released model on Windows with AMX and hands it back to the next equal load", async () => {
    onPlatform("win32");
    llama.systemInfo = AMX_INFO;
    const models = await freshModule();
    const progress = vi.fn();
    const first = await models.loadLlamaModel({
      modelPath: "/models/a.gguf",
      onLoadProgress: progress,
    });
    expect(models.holdsUnfreeableLlamaModels()).toBe(true);
    await models.releaseLlamaModel(first);
    expect(first.dispose).not.toHaveBeenCalled();

    // A progress callback does not change the model; other options do.
    const again = await models.loadLlamaModel({ modelPath: "/models/a.gguf" });
    expect(again).toBe(first);
    expect(llama.loadModel).toHaveBeenCalledTimes(1);
    const other = await models.loadLlamaModel({ modelPath: "/models/a.gguf", useMmap: false });
    expect(other).not.toBe(first);
    const second = await models.loadLlamaModel({ modelPath: "/models/b.gguf" });
    expect(second).not.toBe(first);
    expect(llama.loadModel).toHaveBeenCalledTimes(3);

    // A model is handed to one holder at a time.
    await models.releaseLlamaModel(again);
    await models.releaseLlamaModel(second);
    const third = await models.loadLlamaModel({ modelPath: "/models/a.gguf" });
    expect(third).toBe(first);
    const fourth = await models.loadLlamaModel({ modelPath: "/models/a.gguf" });
    expect(fourth).not.toBe(first);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("AMX");
  });
});
