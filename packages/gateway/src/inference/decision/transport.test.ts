// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { decisionAuthHeaders, errorDetail } from "./transport.js";

describe("errorDetail", () => {
  it("reads the message out of the error bodies providers send", () => {
    expect(
      errorDetail(
        JSON.stringify({
          error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
        }),
      ),
    ).toBe("API key not valid.");
    expect(errorDetail('{"error":"invalid key"}')).toBe("invalid key");
    expect(errorDetail('{"message":"Model is warming up"}')).toBe("Model is warming up");
  });

  it("keeps a body with no message as it was sent", () => {
    expect(errorDetail("upstream unavailable")).toBe("upstream unavailable");
    expect(errorDetail('{"error":{"code":5007}}')).toBe('{"error":{"code":5007}}');
    expect(errorDetail("")).toBe("");
  });
});

describe("decisionAuthHeaders", () => {
  it("puts the key in the header each provider reads, and sends none without a key", () => {
    expect(decisionAuthHeaders("bearer", "k")).toEqual({ authorization: "Bearer k" });
    expect(decisionAuthHeaders("api-key", "k")).toEqual({ "api-key": "k" });
    expect(decisionAuthHeaders("x-api-key", "k")).toEqual({ "x-api-key": "k" });
    expect(decisionAuthHeaders("x-goog-api-key", "k")).toEqual({ "x-goog-api-key": "k" });
    expect(decisionAuthHeaders("x-goog-api-key", undefined)).toEqual({});
  });
});
