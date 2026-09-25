// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { institutionIcon, plaidIcon } from "./icons.js";

describe("institutionIcon", () => {
  test("brands the instance with the bank's own mark and colour", () => {
    const icon = institutionIcon({ institution_logo: "aGVsbG8=", institution_color: "#0055AA" });
    expect(icon?.imageDataUri).toBe("data:image/png;base64,aGVsbG8=");
    expect(icon?.color).toBe("#0055aa");
    expect(icon?.sfSymbol).toBe(plaidIcon.sfSymbol);
  });

  test("accepts a colour Plaid sends without its leading hash", () => {
    expect(institutionIcon({ institution_logo: "aGk=", institution_color: "0055aa" })?.color).toBe(
      "#0055aa",
    );
  });

  test("falls back to the Plaid accent when the colour is unusable", () => {
    for (const institution_color of [undefined, "", "rebeccapurple", "#12345", "#GGGGGG"]) {
      const icon = institutionIcon({ institution_logo: "aGk=", institution_color });
      expect(icon?.color).toBe(plaidIcon.color);
    }
  });

  test("no logo means no instance icon, so the source keeps the Plaid mark", () => {
    expect(institutionIcon({})).toBeUndefined();
    expect(institutionIcon({ institution_color: "#0055aa" })).toBeUndefined();
  });
});
