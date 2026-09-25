// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isAutoSubmittedGenerated } from "./mail-markup.js";

describe("isAutoSubmittedGenerated", () => {
  test("absent or explicit 'no' means human, whatever the casing or trailing CFWS", () => {
    expect(isAutoSubmittedGenerated(undefined)).toBe(false);
    expect(isAutoSubmittedGenerated("")).toBe(false);
    expect(isAutoSubmittedGenerated("no")).toBe(false);
    expect(isAutoSubmittedGenerated("No")).toBe(false);
    expect(isAutoSubmittedGenerated("no (sent by a human)")).toBe(false);
  });

  test("generated values match on the first token, parameters and comments ignored", () => {
    expect(isAutoSubmittedGenerated("auto-generated")).toBe(true);
    expect(isAutoSubmittedGenerated("Auto-Replied")).toBe(true);
    expect(isAutoSubmittedGenerated("auto-replied; owner=list@example.com")).toBe(true);
    expect(isAutoSubmittedGenerated("auto-generated (vacation)")).toBe(true);
  });
});
