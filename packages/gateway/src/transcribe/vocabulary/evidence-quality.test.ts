// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { ordinaryEvidenceQuality } from "./evidence-quality.js";

test("unknown legacy and entirely unmarked evidence retain ordinary confidence", () => {
  expect(ordinaryEvidenceQuality(0, 0)).toBe(1);
  expect(ordinaryEvidenceQuality(1, 1)).toBe(1);
  expect(ordinaryEvidenceQuality(200, 200)).toBe(1);
});

test("repeated automation never manufactures independent unmarked corroboration", () => {
  expect(ordinaryEvidenceQuality(2, 0)).toBe(0.15);
  expect(ordinaryEvidenceQuality(10000, 0)).toBe(0.15);
  expect(ordinaryEvidenceQuality(10000, 1)).toBe(0.15);
  expect(ordinaryEvidenceQuality(10002, 2)).toBe(1);
});

test("configured zero excludes only evidence carrying known automation", () => {
  expect(ordinaryEvidenceQuality(2, 0, 0)).toBe(0);
  expect(ordinaryEvidenceQuality(3, 1, 0)).toBe(0);
  expect(ordinaryEvidenceQuality(3, 2, 0)).toBe(1);
  expect(ordinaryEvidenceQuality(0, 0, 0)).toBe(1);
  expect(ordinaryEvidenceQuality(2, 2, 0)).toBe(1);
});

test("confidence is configurable without discarding machine-origin entities", () => {
  expect(ordinaryEvidenceQuality(200, 0, 0.05)).toBe(0.05);
  expect(ordinaryEvidenceQuality(200, 0, 1)).toBe(1);
});
