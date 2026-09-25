// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { hyperlink } from "./link.js";

describe("hyperlink", () => {
  test("enabled: OSC 8 shape with ST terminator", () => {
    expect(
      hyperlink("Open email", "https://mail.google.com/mail/#inbox/x", { enabled: true }),
    ).toBe("\x1b]8;;https://mail.google.com/mail/#inbox/x\x1b\\Open email\x1b]8;;\x1b\\");
  });

  test("disabled: `text (url)` fallback", () => {
    expect(hyperlink("Open email", "https://example.com", { enabled: false })).toBe(
      "Open email (https://example.com)",
    );
  });

  test("disabled with text === url: no duplicated URL", () => {
    expect(hyperlink("https://example.com", "https://example.com", { enabled: false })).toBe(
      "https://example.com",
    );
  });

  test("custom fallback renderer is honored when disabled", () => {
    expect(
      hyperlink("Open", "https://example.com", {
        enabled: false,
        fallback: (t) => t,
      }),
    ).toBe("Open");
  });

  test("custom fallback not invoked when enabled", () => {
    const out = hyperlink("Open", "https://example.com", {
      enabled: true,
      fallback: () => "NEVER",
    });
    expect(out).not.toContain("NEVER");
    expect(out).toContain("https://example.com");
  });

  test("enabled: strips injected escape bytes from a malicious title", () => {
    // A document title carrying a raw OSC 8 opener must not forge a sequence —
    // its ESC is stripped, leaving only the 4 structural ESCs (open + 2 STs +
    // close marker).
    const out = hyperlink("Invoice\x1b]8;;evil", "https://example.com", { enabled: true });
    expect(out).toBe("\x1b]8;;https://example.com\x1b\\Invoice]8;;evil\x1b]8;;\x1b\\");
    expect((out.match(/\x1b/g) ?? []).length).toBe(4);
  });

  test("enabled: strips control bytes from a malicious url", () => {
    const out = hyperlink("Open", "https://example.com\x1b]8;;x", { enabled: true });
    expect(out).toBe("\x1b]8;;https://example.com]8;;x\x1b\\Open\x1b]8;;\x1b\\");
    expect((out.match(/\x1b/g) ?? []).length).toBe(4); // injected ESC stripped
  });

  test("disabled: strips control bytes in the fallback too", () => {
    expect(hyperlink("Bad\x1btitle", "https://example.com\x07", { enabled: false })).toBe(
      "Badtitle (https://example.com)",
    );
  });
});
