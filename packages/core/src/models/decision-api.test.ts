// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { decisionUrlPlaceholders, isWorkersAiModelId } from "./decision-api.js";

describe("decisionUrlPlaceholders", () => {
  it("lists every placeholder left in a URL", () => {
    expect(
      decisionUrlPlaceholders("https://{resource}.example.com/accounts/{account}/run"),
    ).toEqual(["resource", "account"]);
    expect(decisionUrlPlaceholders("http://127.0.0.1:11435/v1/systemone")).toEqual([]);
  });
});

describe("isWorkersAiModelId", () => {
  it("accepts Workers AI model paths and refuses anything that could leave them", () => {
    expect(isWorkersAiModelId("@cf/cloudflare/clef-flash")).toBe(true);
    expect(isWorkersAiModelId("clef")).toBe(true);
    expect(isWorkersAiModelId("../../user/tokens")).toBe(false);
    expect(isWorkersAiModelId("@cf//clef")).toBe(false);
    expect(isWorkersAiModelId("clef?x=1")).toBe(false);
  });
});
