// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { connectedComponents } from "./clusters.js";

describe("connectedComponents", () => {
  it("merges chained pairs into one cluster", () => {
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["d", "e"],
    ];
    const clusters = connectedComponents(edges);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual(["a", "b", "c"]);
    expect(clusters[1]).toEqual(["d", "e"]);
  });

  it("sorts clusters by size desc", () => {
    const edges: Array<[string, string]> = [
      ["x1", "x2"],
      ["x2", "x3"],
      ["x3", "x4"],
      ["y1", "y2"],
    ];
    const clusters = connectedComponents(edges);
    expect(clusters[0].length).toBe(4);
    expect(clusters[1].length).toBe(2);
  });

  it("empty input yields empty result", () => {
    expect(connectedComponents([])).toEqual([]);
  });
});
