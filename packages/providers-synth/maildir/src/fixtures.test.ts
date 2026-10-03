// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import realMaildir from "@omnesis/provider-maildir";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadFixtureAttachments, materializeMaildir } from "./fixtures.js";
import type { MaildirCursor } from "@omnesis/provider-maildir";
import type { MaildirFixtureAttachment } from "./fixtures.js";

let scratch: string;
let universe: string;
const attachment: MaildirFixtureAttachment = {
  assetPath: "assets/scan.pdf",
  filename: "scan.pdf",
  mimeType: "application/pdf",
};
const bytes = Buffer.from([0, 255, 128, 13, 10, 37, 80, 68, 70]);
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-maildir-assets-"));
  universe = join(scratch, "universe");
  mkdirSync(join(universe, "assets"), { recursive: true });
  writeFileSync(join(universe, attachment.assetPath), bytes);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test("binary MIME parts reach the production extraction seam byte-for-byte", async () => {
  const root = join(scratch, "maildir");
  materializeMaildir(
    root,
    [
      {
        id: "binary",
        messageId: "binary@example.org",
        from: "self",
        to: ["self"],
        subject: "Scanned proof",
        body: "Attached proof",
        sentAt: "2026-01-01T12:00:00Z",
        folders: ["INBOX"],
        attachments: [attachment],
      },
    ],
    universe,
  );
  const extract = vi.fn(async (data: Uint8Array) => {
    expect(Buffer.from(data)).toEqual(bytes);
    return { text: "Extracted fixture proof", truncated: false };
  });
  const instance = await realMaildir.create!({
    accountId: "binary",
    sourceId: SourceId("maildir:binary"),
    providerId: ProviderId("maildir:binary"),
    config: { path: root, exclude: [] },
    host: fakeSourceHost({ stateDir: scratch, extractAttachment: extract }),
  });
  try {
    let cursor: MaildirCursor | null = null;
    const documents = [];
    let settled = false;
    for (let page = 0; page < 20; page++) {
      const result = await instance.sync(cursor);
      documents.push(...result.documents);
      cursor = result.cursor;
      if (!result.hasMore) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(
      documents.some(
        (doc) =>
          doc.metadata.documentType === "attachment" &&
          doc.content.includes("Extracted fixture proof"),
      ),
    ).toBe(true);
  } finally {
    await instance.dispose?.();
  }
});

test.each(["../outside.pdf", "/tmp/scan.pdf", "assets/../../outside.pdf", "assets/scan.pdf\0"])(
  "rejects unsafe asset path %j",
  (assetPath) => {
    expect(() => loadFixtureAttachments([{ ...attachment, assetPath }], universe)).toThrow();
  },
);

test("rejects symlinks to files or directories outside the universe", () => {
  writeFileSync(join(scratch, "outside.pdf"), bytes);
  symlinkSync(join(scratch, "outside.pdf"), join(universe, "escape.pdf"));
  symlinkSync(scratch, join(universe, "escape-dir"));
  for (const assetPath of ["escape.pdf", "escape-dir/outside.pdf"])
    expect(() => loadFixtureAttachments([{ ...attachment, assetPath }], universe)).toThrow(
      "escapes",
    );
});

test("allows a symlink whose resolved target remains inside the universe", () => {
  symlinkSync(join(universe, attachment.assetPath), join(universe, "inside.pdf"));
  expect(
    loadFixtureAttachments([{ ...attachment, assetPath: "inside.pdf" }], universe)[0]!.content,
  ).toEqual(bytes);
});

test.each([
  { filename: "bad\r\nHeader: injected" },
  { filename: 'bad"name.pdf' },
  { filename: "../scan.pdf" },
  { filename: ".." },
  { mimeType: "application/pdf\r\nHeader: injected" },
  { mimeType: "application/pdf; charset=utf-8" },
])("rejects unsafe MIME metadata %j", (change) => {
  expect(() => loadFixtureAttachments([{ ...attachment, ...change }], universe)).toThrow(
    "filename or MIME",
  );
});

test("refuses directories, missing files and oversized assets before reading bytes", () => {
  for (const assetPath of ["assets", "missing.pdf"])
    expect(() => loadFixtureAttachments([{ ...attachment, assetPath }], universe)).toThrow();
  truncateSync(join(universe, attachment.assetPath), 25 * 1024 * 1024 + 1);
  expect(() => loadFixtureAttachments([attachment], universe)).toThrow("25 MiB");
});

test("bounds aggregate attachment bytes and part count", () => {
  truncateSync(join(universe, attachment.assetPath), 18 * 1024 * 1024);
  expect(() => loadFixtureAttachments([attachment, attachment, attachment], universe)).toThrow(
    "50 MiB",
  );
  expect(() =>
    loadFixtureAttachments(
      Array.from({ length: 21 }, () => attachment),
      universe,
    ),
  ).toThrow("20 parts");
});
