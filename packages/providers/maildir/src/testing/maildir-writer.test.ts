// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseMessageFileName } from "../layout.js";
import { deliverMessage, maildirFileName } from "./maildir-writer.js";

test.each(["linux", "darwin", "win32"] as const)(
  "fixture filenames preserve flag and message identities on %s",
  (platform) => {
    const filename = maildirFileName("123.fixture", "cur", "SF", platform);
    expect(filename).toBe(`123.fixture${platform === "win32" ? "!" : ":"}2,FS`);
    expect(parseMessageFileName(filename)).toEqual({ uniq: "123.fixture", flags: "FS" });
    expect(maildirFileName("123.fixture", "new", "SF", platform)).toBe("123.fixture");
  },
);

test("flagged messages are delivered through tmp into a readable host filename", () => {
  const root = mkdtempSync(join(tmpdir(), "maildir-writer-test-"));
  try {
    const path = deliverMessage(root, "123.fixture", "Subject: invented\r\n\r\nbody", {
      flags: "SF",
    });
    expect(readFileSync(path, "utf8")).toBe("Subject: invented\r\n\r\nbody");
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
    expect(readdirSync(join(root, "cur"))).toEqual([maildirFileName("123.fixture", "cur", "SF")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
