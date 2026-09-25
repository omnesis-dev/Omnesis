// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { isBaileysAuthEnoent } from "./baileys-enoent-filter.js";

/**
 * The predicate is the gate that decides whether a late
 * Baileys ENOENT race gets suppressed (return true) or escalates to
 * `process.exit(1)` (return false). Pinning each filename shape +
 * the negative cases prevents a future regex tweak from silently
 * widening or narrowing the suppression scope.
 */
describe("isBaileysAuthEnoent", () => {
  // ── Positive matches: each Baileys auth-state filename prefix ───────────
  const baileysFilenames = [
    "creds.json",
    "app-state-sync-key-AAA0BBB.json",
    "sender-key-1234@s.whatsapp.net--abc.json",
    "session-1234@s.whatsapp.net.json",
    "pre-key-42.json",
  ];
  for (const filename of baileysFilenames) {
    it(`accepts ENOENT on ${filename}`, () => {
      const err = Object.assign(new Error("ENOENT"), {
        code: "ENOENT",
        path: `/Users/me/.config/omnesis/whatsapp-+44123/${filename}`,
      });
      expect(isBaileysAuthEnoent(err)).toBe(true);
    });
  }

  // ── Negative: same ENOENT code, unrelated path ──────────────────────────
  it("rejects an ENOENT inside a SQLite WAL path", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: "/Users/me/.config/omnesis/omnesis.db-wal",
    });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });

  it("rejects an ENOENT inside an attachment-extract path", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: "/tmp/omnesis-attachments/abc.pdf",
    });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });

  it("rejects a benign-looking unrelated path even with auth in the dir name", () => {
    // The regex matches the filename, not the parent — a directory
    // called "auth-state" doesn't fool it into matching.
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: "/Users/me/.config/omnesis/auth-state/debug.log",
    });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });

  // ── Negative: not an ENOENT ─────────────────────────────────────────────
  it("rejects a non-ENOENT error even on a matching filename", () => {
    const err = Object.assign(new Error("EACCES"), {
      code: "EACCES",
      path: "/Users/me/.config/omnesis/whatsapp-+44123/creds.json",
    });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });

  // ── Negative: nullish / non-error inputs ────────────────────────────────
  it("rejects null and undefined", () => {
    expect(isBaileysAuthEnoent(null)).toBe(false);
    expect(isBaileysAuthEnoent(undefined)).toBe(false);
  });

  it("rejects a plain string", () => {
    expect(isBaileysAuthEnoent("ENOENT: no such file or directory")).toBe(false);
  });

  it("rejects an Error without a `path` field", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });

  it("rejects an Error with non-string path", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: 42 as unknown,
    });
    expect(isBaileysAuthEnoent(err)).toBe(false);
  });
});
