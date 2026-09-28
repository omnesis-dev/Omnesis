// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  isIgnoredByFlags,
  isSentFolderName,
  isSkippedFolderName,
  parseMessageFileName,
  walkMaildir,
} from "./layout.js";
import { createMailbox, deliverMessage } from "./testing/maildir-writer.js";

const LIMITS = { maxMailboxes: 100, maxFiles: 1000 };
const isRoot = process.getuid?.() === 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omnesis-maildir-layout-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseMessageFileName", () => {
  test("splits the unchanging part from sorted flag letters", () => {
    expect(parseMessageFileName("1700000000.M1P2.host,U=12:2,SF")).toEqual({
      uniq: "1700000000.M1P2.host,U=12",
      flags: "FS",
    });
  });

  test("accepts the delimiters tools use where a colon is forbidden", () => {
    expect(parseMessageFileName("abc!2,S").uniq).toBe("abc");
    expect(parseMessageFileName("abc;2,RS").flags).toBe("RS");
  });

  test("lowercase letters are keywords, not flags", () => {
    expect(parseMessageFileName("abc:2,Sdt").flags).toBe("S");
  });

  test("a name without an info suffix is all identity", () => {
    expect(parseMessageFileName("1700000000.M1P2.host")).toEqual({
      uniq: "1700000000.M1P2.host",
      flags: "",
    });
  });
});

test("trashed and draft files are ignored, other flags are not", () => {
  expect(isIgnoredByFlags("ST")).toBe(true);
  expect(isIgnoredByFlags("D")).toBe(true);
  expect(isIgnoredByFlags("FRS")).toBe(false);
});

test("drafts, spam and trash folders are skipped by their last segment", () => {
  expect(isSkippedFolderName("[Gmail]/Trash")).toBe(true);
  expect(isSkippedFolderName("Junk E-mail")).toBe(true);
  expect(isSkippedFolderName("Work/Drafts")).toBe(true);
  expect(isSkippedFolderName("Archive")).toBe(false);
  expect(isSentFolderName("[Gmail]/Sent Mail")).toBe(true);
  expect(isSentFolderName("Sent Items")).toBe(true);
  expect(isSentFolderName("Receipts")).toBe(false);
});

describe("walkMaildir", () => {
  test("a root that is a mailbox is INBOX, and Maildir++ folders decode their dots", () => {
    createMailbox(root);
    createMailbox(join(root, ".Sent"));
    createMailbox(join(root, ".Work.Travel"));
    mkdirSync(join(root, ".notmuch", "xapian"), { recursive: true });
    const walk = walkMaildir(root, [], LIMITS);
    expect(walk.mailboxes.map((m) => [m.id, m.name, m.sent]).sort()).toEqual([
      ["", "INBOX", false],
      [".Sent", "Sent", true],
      [".Work.Travel", "Work/Travel", false],
    ]);
    expect(walk.gaps).toEqual([]);
  });

  test("verbatim nested folders are named by their path, including Gmail's", () => {
    createMailbox(join(root, "INBOX"));
    createMailbox(join(root, "[Gmail]", "All Mail"));
    createMailbox(join(root, "[Gmail]", "Sent Mail"));
    createMailbox(join(root, "[Gmail]", "Spam"));
    createMailbox(join(root, "Projects"));
    createMailbox(join(root, "Projects", "Launch"));
    const names = walkMaildir(root, [], LIMITS)
      .mailboxes.map((m) => m.name)
      .sort();
    expect(names).toEqual([
      "INBOX",
      "Projects",
      "Projects/Launch",
      "[Gmail]/All Mail",
      "[Gmail]/Sent Mail",
    ]);
  });

  test("a top-level Inbox folder in any casing is INBOX; a nested one keeps its name", () => {
    createMailbox(join(root, "Inbox"));
    createMailbox(join(root, "Work", "inbox"));
    const names = walkMaildir(root, [], LIMITS)
      .mailboxes.map((m) => m.name)
      .sort();
    expect(names).toEqual(["INBOX", "Work/inbox"]);
  });

  test("exclude patterns match folder names case-insensitively", () => {
    createMailbox(join(root, "INBOX"));
    createMailbox(join(root, "[Gmail]", "All Mail"));
    createMailbox(join(root, "Newsletters", "Weekly"));
    const names = walkMaildir(root, ["[gmail]/all mail", "Newsletters/**"], LIMITS).mailboxes.map(
      (m) => m.name,
    );
    expect(names).toEqual(["INBOX"]);
  });

  test("lists new and cur, keeps flags only for cur, and drops trashed and draft files", () => {
    const inbox = createMailbox(join(root, "INBOX"));
    deliverMessage(inbox, "100.a.host", "Subject: a\r\n\r\nx", { subdir: "new" });
    deliverMessage(inbox, "101.b.host", "Subject: b\r\n\r\nx", { flags: "FS" });
    deliverMessage(inbox, "102.c.host", "Subject: c\r\n\r\nx", { flags: "ST" });
    deliverMessage(inbox, "103.d.host", "Subject: d\r\n\r\nx", { flags: "D" });
    writeFileSync(join(inbox, "cur", ".hidden"), "");
    const files = walkMaildir(root, [], LIMITS).files.sort((a, b) => a.uniq.localeCompare(b.uniq));
    expect(files).toEqual([
      { mailboxId: "INBOX", uniq: "100.a.host", relPath: "new/100.a.host", flags: "" },
      { mailboxId: "INBOX", uniq: "101.b.host", relPath: "cur/101.b.host:2,FS", flags: "FS" },
    ]);
  });

  test("keywords do not mark a message trashed, and symbolic links are never followed", () => {
    const inbox = createMailbox(join(root, "INBOX"));
    deliverMessage(inbox, "100.a.host", "Subject: a\r\n\r\nx", { flags: "S" });
    renameSync(join(inbox, "cur", "100.a.host:2,S"), join(inbox, "cur", "100.a.host:2,Sdt"));
    symlinkSync(join(root, "elsewhere"), join(inbox, "cur", "200.link.host:2,S"));
    expect(walkMaildir(root, [], LIMITS).files).toEqual([
      { mailboxId: "INBOX", uniq: "100.a.host", relPath: "cur/100.a.host:2,Sdt", flags: "S" },
    ]);
  });

  test("an excluded folder name is matched literally, brackets and all", () => {
    createMailbox(join(root, "INBOX"));
    createMailbox(join(root, "[Gmail]", "All Mail"));
    createMailbox(join(root, "G", "All Mail"));
    const names = walkMaildir(root, ["[Gmail]/All Mail"], LIMITS).mailboxes.map((m) => m.name);
    // As a glob character class the brackets would also match "G/All Mail".
    expect(names.sort()).toEqual(["G/All Mail", "INBOX"]);
  });

  test("a leading ! or braces in a pattern are part of a folder name, never negation", () => {
    createMailbox(join(root, "INBOX"));
    createMailbox(join(root, "Work"));
    const names = walkMaildir(root, ["!Work", "{INBOX,Work}"], LIMITS).mailboxes.map((m) => m.name);
    expect(names.sort()).toEqual(["INBOX", "Work"]);
  });

  test("pipes and other special files are never taken for messages", () => {
    const inbox = createMailbox(join(root, "INBOX"));
    execFileSync("mkfifo", [join(inbox, "cur", "300.pipe.host:2,S")]);
    deliverMessage(inbox, "100.a.host", "Subject: a\r\n\r\nx", { flags: "S" });
    expect(walkMaildir(root, [], LIMITS).files.map((f) => f.uniq)).toEqual(["100.a.host"]);
  });

  test("a message caught in both new and cur resolves to cur", () => {
    const inbox = createMailbox(join(root, "INBOX"));
    deliverMessage(inbox, "100.a.host", "Subject: a\r\n\r\nx", { subdir: "new" });
    deliverMessage(inbox, "100.a.host", "Subject: a\r\n\r\nx", { flags: "S" });
    expect(walkMaildir(root, [], LIMITS).files.map((f) => f.relPath)).toEqual([
      "cur/100.a.host:2,S",
    ]);
  });

  test("a root with no mailboxes is an error, not an empty walk", () => {
    mkdirSync(join(root, "not-mail"));
    expect(() => walkMaildir(root, [], LIMITS)).toThrow(/No mail folders found/);
  });

  test("a missing root names what to check", () => {
    const missing = join(root, "gone");
    let error: unknown;
    try {
      walkMaildir(missing, [], LIMITS);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).message).toMatch(/mounted/);
  });

  test("the mailbox and message limits are runaway guards", () => {
    createMailbox(join(root, "A"));
    createMailbox(join(root, "B"));
    expect(() => walkMaildir(root, [], { maxMailboxes: 1, maxFiles: 10 })).toThrow(
      /more than 1 folders/,
    );
    const a = join(root, "A");
    deliverMessage(a, "1.x", "Subject: 1\r\n\r\nx");
    deliverMessage(a, "2.x", "Subject: 2\r\n\r\nx");
    expect(() => walkMaildir(root, [], { maxMailboxes: 10, maxFiles: 1 })).toThrow(
      /more than 1 messages/,
    );
  });

  test.skipIf(isRoot)("an unreadable mailbox is a gap, not an absence", () => {
    createMailbox(join(root, "INBOX"));
    const locked = createMailbox(join(root, "Archive"));
    deliverMessage(locked, "1.x", "Subject: 1\r\n\r\nx");
    chmodSync(join(locked, "cur"), 0o000);
    try {
      const walk = walkMaildir(root, [], LIMITS);
      expect(walk.gaps.map((g) => g.mailboxId)).toEqual(["Archive"]);
      expect(walk.files).toEqual([]);
    } finally {
      chmodSync(join(locked, "cur"), 0o755);
    }
  });

  test.skipIf(isRoot)("an unreadable Maildir++ folder is a gap, unless it is one left out", () => {
    createMailbox(root);
    const work = createMailbox(join(root, ".Work"));
    const trash = createMailbox(join(root, ".Trash"));
    chmodSync(work, 0o000);
    chmodSync(trash, 0o000);
    try {
      const walk = walkMaildir(root, [], LIMITS);
      expect(walk.gaps.map((g) => g.mailboxId)).toEqual([".Work"]);
      expect(walk.mailboxes.map((m) => m.name)).toEqual(["INBOX"]);
    } finally {
      chmodSync(work, 0o755);
      chmodSync(trash, 0o755);
    }
  });

  test.skipIf(isRoot)("an unreadable root is a permission error with a remedy", () => {
    createMailbox(join(root, "INBOX"));
    chmodSync(root, 0o000);
    try {
      expect(() => walkMaildir(root, [], LIMITS)).toThrow(
        expect.objectContaining({
          kind: "permission",
          remediation: expect.objectContaining({ steps: expect.any(Array) as unknown }) as unknown,
        }) as Error,
      );
    } finally {
      chmodSync(root, 0o755);
    }
  });
});
