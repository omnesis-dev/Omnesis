// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { NO_THINKING, withTemperature } from "./anthropic-messages.js";

const request = {
  model: "example-model",
  max_tokens: 16,
  thinking: NO_THINKING,
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("withTemperature", () => {
  it("adds the sampling temperature to the request body", () => {
    expect(withTemperature(request, 0.3)).toEqual({ ...request, temperature: 0.3 });
  });

  it("keeps a zero temperature", () => {
    expect(withTemperature(request, 0)).toMatchObject({ temperature: 0 });
  });

  it("returns the request untouched when there is no temperature", () => {
    expect(withTemperature(request, undefined)).toBe(request);
  });
});
