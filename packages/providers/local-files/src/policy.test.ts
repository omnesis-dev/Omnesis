// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { classifyFile, isRefusedPath, subtreePruneReason } from "./policy.js";

describe("classifyFile", () => {
  test("indexes text and binary allow-list types", () => {
    expect(classifyFile("notes.txt")).toEqual({
      kind: "index",
      mimeType: "text/plain",
      via: "text",
    });
    expect(classifyFile("doc.MD")).toEqual({
      kind: "index",
      mimeType: "text/markdown",
      via: "text",
    });
    expect(classifyFile("data.csv")).toEqual({ kind: "index", mimeType: "text/csv", via: "text" });
    expect(classifyFile("quote.pdf")).toMatchObject({ kind: "index", via: "extract" });
    expect(classifyFile("deck.pptx")).toMatchObject({ kind: "index", via: "extract" });
    expect(classifyFile("sheet.XLSX")).toMatchObject({ kind: "index", via: "extract" });
    expect(classifyFile("saved.eml")).toMatchObject({ kind: "index", via: "extract" });
  });

  test("defers images, refuses archives and media", () => {
    expect(classifyFile("shot.png")).toEqual({ kind: "skip", reason: "image-deferred" });
    expect(classifyFile("photo.JPG")).toEqual({ kind: "skip", reason: "image-deferred" });
    expect(classifyFile("backup.zip")).toEqual({ kind: "skip", reason: "archive" });
    expect(classifyFile("disk.dmg")).toEqual({ kind: "skip", reason: "archive" });
    expect(classifyFile("clip.mp4")).toEqual({ kind: "skip", reason: "media" });
    expect(classifyFile("note.mp3")).toEqual({ kind: "skip", reason: "media" });
  });

  test("refuses secrets before reading", () => {
    expect(classifyFile(".env")).toEqual({ kind: "skip", reason: "secret" });
    expect(classifyFile(".env.production")).toEqual({ kind: "skip", reason: "secret" });
    expect(classifyFile("id_rsa")).toEqual({ kind: "skip", reason: "secret" });
    expect(classifyFile("backup.pem")).toEqual({ kind: "skip", reason: "secret" });
    expect(classifyFile("vault.kdbx")).toEqual({ kind: "skip", reason: "secret" });
    expect(classifyFile("notes.txt")).not.toEqual({ kind: "skip", reason: "secret" });
  });

  test("skips dotfiles, iCloud placeholders, extensionless files", () => {
    expect(classifyFile(".DS_Store")).toEqual({ kind: "skip", reason: "dotfile" });
    // The name macOS actually writes: hidden, and re-suffixed. A test using
    // the un-hidden spelling passes against a classifier that never sees one.
    expect(classifyFile(".report.pdf.icloud")).toEqual({
      kind: "skip",
      reason: "icloud-placeholder",
    });
    expect(classifyFile("Makefile")).toEqual({ kind: "skip", reason: "no-extension" });
    expect(classifyFile("script.sh")).toEqual({ kind: "skip", reason: "type-excluded" });
  });
});

describe("isRefusedPath", () => {
  test("refuses dot segments, dependency trees, and secret dirs", () => {
    expect(isRefusedPath(".git/config")).toBe(true);
    expect(isRefusedPath("proj/node_modules/lib/index.js")).toBe(true);
    expect(isRefusedPath("proj/.venv/bin/activate")).toBe(true);
    expect(isRefusedPath(".ssh/id_rsa")).toBe(true);
    expect(isRefusedPath("Docs/report.pdf")).toBe(false);
    expect(isRefusedPath("Projects/House/quotes.pdf")).toBe(false);
  });

  test("refuses platform config dirs and app bundles", () => {
    expect(isRefusedPath("Library/Caches/x")).toBe(true);
    expect(isRefusedPath(".config/app/settings.json")).toBe(true);
    expect(isRefusedPath("Fancy.app/Contents/Info.plist")).toBe(true);
  });
});

describe("subtreePruneReason", () => {
  test("a .git entry prunes the whole working tree, file or dir", () => {
    // Directory or linked-worktree/submodule file: the name is what matters.
    expect(subtreePruneReason([".git", "README.md", "src"])).toBe("git-repo");
    expect(subtreePruneReason(["src", "notes.txt"])).toBeNull();
    expect(subtreePruneReason([])).toBeNull();
  });

  test("an .obsidian entry prunes the vault", () => {
    expect(subtreePruneReason(["daily.md", ".obsidian"])).toBe("obsidian-vault");
  });

  test("git wins when both markers are present", () => {
    expect(subtreePruneReason([".git", ".obsidian"])).toBe("git-repo");
  });

  test("marker names match exactly", () => {
    expect(subtreePruneReason([".GIT", "notes.txt"])).toBeNull();
    expect(subtreePruneReason(["git", "notes.txt"])).toBeNull();
  });
});
