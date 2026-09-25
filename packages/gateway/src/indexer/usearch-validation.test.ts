// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
  load: vi.fn(),
  view: vi.fn(),
  search: vi.fn(),
  dimensions: vi.fn(),
  size: vi.fn(),
}));

vi.mock("usearch", () => ({
  default: {
    Index: class {
      load = native.load;
      view = native.view;
      search = native.search;
      dimensions = native.dimensions;
      size = native.size;
    },
    MetricKind: { Cos: "cos" },
    ScalarKind: { F32: "f32" },
  },
}));

import { validateUsearchFile } from "./usearch-index.js";

describe("usearch validation before allocating a writable index", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.dimensions.mockReturnValue(32);
    native.size.mockReturnValue(1);
  });

  test("an invalid mapped file never reaches the allocating loader", () => {
    native.view.mockImplementation(() => {
      throw new Error("vectors matrix exceeds file size");
    });
    expect(() => validateUsearchFile("invalid.usearch", 32)).toThrow(
      "vectors matrix exceeds file size",
    );
    expect(native.load).not.toHaveBeenCalled();
    expect(native.search).not.toHaveBeenCalled();
  });

  test("a wrong dimension is rejected before a probe or allocating load", () => {
    native.dimensions.mockReturnValue(64);
    expect(() => validateUsearchFile("wrongdim.usearch", 32)).toThrow(
      "dimension 64 != expected 32",
    );
    expect(native.load).not.toHaveBeenCalled();
    expect(native.search).not.toHaveBeenCalled();
  });

  test("a broken search graph never reaches the allocating loader", () => {
    native.search.mockImplementation(() => {
      throw new Error("invalid graph");
    });
    expect(() => validateUsearchFile("graph.usearch", 32)).toThrow("invalid graph");
    expect(native.load).not.toHaveBeenCalled();
  });

  test("a healthy nonempty file exercises both reader and writer paths", () => {
    validateUsearchFile("healthy.usearch", 32);
    expect(native.view).toHaveBeenCalledWith("healthy.usearch");
    expect(native.search).toHaveBeenCalledWith(new Float32Array(32), 1, 0);
    expect(native.load).toHaveBeenCalledWith("healthy.usearch");
    expect(native.search.mock.invocationCallOrder[0]).toBeLessThan(
      native.load.mock.invocationCallOrder[0],
    );
  });

  test("an empty index still exercises the writer without an empty graph probe", () => {
    native.size.mockReturnValue(0);
    validateUsearchFile("empty.usearch", 32);
    expect(native.view).toHaveBeenCalledWith("empty.usearch");
    expect(native.load).toHaveBeenCalledWith("empty.usearch");
    expect(native.search).not.toHaveBeenCalled();
  });

  test("a load-only failure is still rejected after a successful reader probe", () => {
    native.load.mockImplementation(() => {
      throw new Error("invalid writable graph");
    });
    expect(() => validateUsearchFile("load-error.usearch", 32)).toThrow("invalid writable graph");
    expect(native.search).toHaveBeenCalledOnce();
  });
});
