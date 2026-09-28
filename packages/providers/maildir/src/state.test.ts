// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MaildirIndex } from "./index-store.js";
import { maildirStateSpec } from "./state.js";

describe("maildirStateSpec", () => {
  test("decodes the one shape every page returns", () => {
    expect(maildirStateSpec.decode({ generation: "g-1", seq: 0 })).toEqual({
      generation: "g-1",
      seq: 0,
    });
    expect(maildirStateSpec.decode({ generation: "g-1", seq: 42 })).toEqual({
      generation: "g-1",
      seq: 42,
    });
  });

  test.each([
    null,
    [],
    { generation: "", seq: 1 },
    { generation: "g", seq: -1 },
    { generation: "g", seq: 1.5 },
    { generation: "x".repeat(65), seq: 1 },
    { seq: 1 },
  ])("rejects %j", (value) => {
    expect(maildirStateSpec.decode(value)).toBeNull();
  });

  test("an unreadable cursor restarts from the tree, which is always there to re-read", () => {
    expect(maildirStateSpec.onUnreadable).toBe("rebootstrap");
  });
});

describe("MaildirIndex", () => {
  test("drops rows newer than the committed page, and all rows of another generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-maildir-index-"));
    try {
      const index = new MaildirIndex(join(dir, "index.sqlite"));
      index.alignWithCursor("g1", 0);
      const row = (key: string, seq: number) => ({
        key,
        signature: "s",
        seq,
        hasDocument: true,
        attachments: [],
      });
      index.recordEmissions("g1", [row("a", 1), row("b", 2)], []);
      index.alignWithCursor("g1", 1);
      expect([...index.allEmitted().keys()]).toEqual(["a"]);
      index.alignWithCursor("g2", 5);
      expect(index.allEmitted().size).toBe(0);
      expect(() => index.recordEmissions("g1", [row("c", 6)], [])).toThrow(/restarted/);
      index.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps what it learned about files across generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-maildir-index-"));
    try {
      const path = join(dir, "index.sqlite");
      const index = new MaildirIndex(path);
      index.applyListing([{ mailboxId: "INBOX", uniq: "1", relPath: "cur/1:2,S", flags: "S" }], []);
      index.recordScans([{ mailboxId: "INBOX", uniq: "1", key: "mid:k", dateMs: 5, size: 10 }]);
      index.alignWithCursor("g1", 0);
      index.close();
      const reopened = new MaildirIndex(path);
      reopened.alignWithCursor("g2", 0);
      expect(reopened.allFiles()).toEqual([
        {
          mailboxId: "INBOX",
          uniq: "1",
          relPath: "cur/1:2,S",
          flags: "S",
          key: "mid:k",
          dateMs: 5,
          size: 10,
        },
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
