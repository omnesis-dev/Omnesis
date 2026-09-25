// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import definition from "./index.js";

describe("Outlook provider definition", () => {
  test("has correct provider metadata", () => {
    expect(definition.type).toBe("provider");
    expect(definition.provider.id).toBe("microsoft");
    expect(definition.authType).toBe("oauth");
  });

  test("has outlook-email source", () => {
    const source = definition.sources.find((s) => s.id === "outlook-email");
    expect(source).toBeDefined();
    expect(source!.unitName).toBe("emails");
  });

  test("has onedrive source, generally available", () => {
    const source = definition.sources.find((s) => s.id === "onedrive");
    expect(source).toBeDefined();
    expect(source!.unitName).toBe("files");
    expect(source!.experimental).toBeFalsy();
    expect(definition.sources.find((s) => s.id === "outlook-email")!.experimental).toBeFalsy();
  });

  test("every source under this provider is generally available", () => {
    // A single Microsoft consent covers all three, and none of them is gated, so
    // the "Add source" picker offers the whole provider rather than hiding part
    // of it behind OMNESIS_EXPERIMENTAL.
    for (const source of definition.sources) {
      expect(source.experimental, `${source.id} should be generally available`).toBeFalsy();
    }
  });

  test("has outlook-calendar source", () => {
    const source = definition.sources.find((s) => s.id === "outlook-calendar");
    expect(source).toBeDefined();
    expect(source!.unitName).toBe("events");
  });

  test("outlook-calendar has its own calendar icon, distinct from outlook-email", () => {
    const calendar = definition.sources.find((s) => s.id === "outlook-calendar")!.icon!;
    const email = definition.sources.find((s) => s.id === "outlook-email")!.icon!;
    // Microsoft serves no distinct hosted calendar icon, so the calendar
    // source ships an owned data-URI glyph instead of hot-linking the shared
    // Outlook product icon — otherwise it renders identically to the email
    // source in every client.
    expect(calendar.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(calendar.url).toBeUndefined();
    expect(email.imageDataUri).toBeUndefined();
    expect(calendar.imageDataUri).not.toBe(email.url);
    // Decoded SVG carries the Outlook brand blue, not currentColor.
    const svg = Buffer.from(
      calendar.imageDataUri!.replace(/^data:image\/svg\+xml;base64,/, ""),
      "base64",
    ).toString("utf8");
    expect(svg).toContain('stroke="#0078D4"');
    expect(svg).not.toContain("currentColor");
  });

  test("has authFlow, discover, and cleanupCredentials functions", () => {
    expect(typeof definition.authFlow).toBe("function");
    expect(typeof definition.discover).toBe("function");
    expect(typeof definition.cleanupCredentials).toBe("function");
  });

  test("has createContext and credentialState functions", () => {
    expect(typeof definition.createContext).toBe("function");
    expect(typeof definition.credentialState).toBe("function");
  });

  test("discover declares each account as the email address it is", async () => {
    // The account is the address the sign-in resolved. Declaring it lets the
    // self-identity resolver read a stated email instead of inferring one from
    // an `@` in the id.
    const configDir = mkdtempSync(join(tmpdir(), "outlook-discover-"));
    try {
      const accountDir = join(configDir, "outlook", "maya.reeves@example.com");
      mkdirSync(accountDir, { recursive: true });
      writeFileSync(join(accountDir, "tokens.json"), "{}");

      const accounts = await definition.discover!({ configDir });

      expect(accounts).toEqual([
        {
          id: "maya.reeves@example.com",
          subject: { kind: "email", value: "maya.reeves@example.com" },
        },
      ]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
