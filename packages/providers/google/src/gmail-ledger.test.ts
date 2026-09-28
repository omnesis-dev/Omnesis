// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GMAIL_OUTPUT_REVISION } from "./constants.js";
import { createGmailSource, createMockGmail } from "./testing/mock-google.js";
import type { AttachmentExtractFn, ExtractionResult } from "@omnesis/core";
import type { GmailSyncCursor } from "./gmail.js";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const HOUR = 60 * 60 * 1000;

function messageWith(
  id: string,
  parts: Array<Record<string, unknown>>,
  html?: string,
): Record<string, unknown> {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "1704067200000",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "Subject", value: "Quarterly plan" },
        { name: "From", value: "maya.reeves@example.com" },
        { name: "To", value: "jamie.lopez@example.org" },
        { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("See attached.") } },
        ...(html ? [{ mimeType: "text/html", body: { data: b64(html) } }] : []),
        ...parts,
      ],
    },
  };
}

const pdf = {
  filename: "plan.pdf",
  mimeType: "application/pdf",
  body: { attachmentId: "att-pdf", size: 2048 },
};
const scan = {
  filename: "scan.png",
  mimeType: "image/png",
  body: { attachmentId: "att-png", size: 90_000 },
};

describe("Gmail attachment ledger", () => {
  let gmail: ReturnType<typeof createMockGmail>;
  let stateDir: string;
  let now: number;
  let outcome: Record<string, ExtractionResult | null>;
  let extract: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "omnesis-gmail-ledger-"));
    now = Date.UTC(2026, 0, 1);
    gmail = createMockGmail();
    gmail.users.messages.attachments.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: { data: b64(params.id) } }),
    );
    outcome = {
      "application/pdf": { text: "Plan for the quarter", truncated: false },
      "image/png": { text: "Whiteboard notes", truncated: false },
    };
    extract = vi.fn((_data: Uint8Array, mime: string) => Promise.resolve(outcome[mime] ?? null));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function source() {
    return createGmailSource(gmail, {
      stateDir,
      now: () => now,
      extractAttachment: extract as unknown as AttachmentExtractFn,
      attachmentConfig: {
        enabled: true,
        maxSizeBytes: 25_000_000,
        allowedTypes: ["application/pdf", "image/png", "text/plain"],
        maxTextLength: 500_000,
      },
    });
  }

  function incrementalCursor(extra: Partial<GmailSyncCursor> = {}): GmailSyncCursor {
    return {
      phase: "incremental",
      historyId: "h-1",
      outputRevision: GMAIL_OUTPUT_REVISION,
      ...extra,
    };
  }

  /** History that says `ids` changed labels, so each is fetched again. */
  function relabelled(ids: string[]) {
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({
        data: {
          history: [{ labelsAdded: ids.map((id) => ({ message: { id }, labelIds: ["STARRED"] })) }],
          historyId: "h-2",
        },
      }),
    );
  }

  test("a message fetched again keeps its extracted attachments without reading them again", async () => {
    const src = source();
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [pdf]) }));

    const first = await src.sync(null);
    expect(first.documents.map((d) => d.externalId)).toHaveLength(2);
    expect(extract).toHaveBeenCalledTimes(1);

    relabelled(["m-1"]);
    const second = await src.sync(first.cursor as GmailSyncCursor);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledTimes(1);
    // The parent keeps its marker; the child was already indexed.
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]!.metadata.extra?.attachments).toEqual([
      { filename: "plan.pdf", mimeType: "application/pdf", size: 2048, extracted: true },
    ]);
  });

  test("an attachment whose page the gateway never committed is read again", async () => {
    const src = source();
    gmail.users.messages.list = vi.fn(() => Promise.resolve({ data: { messages: [] } }));
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [pdf]) }));
    const committed = (await src.sync(null)).cursor as GmailSyncCursor;

    // A page reads m-1's attachment, then fails to commit: the collector runs
    // the next page from the cursor the gateway still holds.
    relabelled(["m-1"]);
    await src.sync(committed);
    const retried = await src.sync(committed);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(retried.documents.map((d) => d.externalId)).toEqual([
      "m-1",
      expect.stringMatching(/^m-1\/att\//),
    ]);

    // Once that page commits, the next fetch reuses it.
    await src.sync(retried.cursor as GmailSyncCursor);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("a failed extraction is retried after 1 h, 6 h and 24 h, then left alone", async () => {
    const src = source();
    outcome["image/png"] = null;
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [scan]) }));
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({ data: { history: [], historyId: "h-2" } }),
    );

    let cursor = (await src.sync(null)).cursor as GmailSyncCursor;
    expect(extract).toHaveBeenCalledTimes(1);

    const tried = () => extract.mock.calls.length;
    for (const [wait, expected] of [
      [HOUR - 1, 1],
      [1, 2],
      [6 * HOUR, 3],
      [24 * HOUR, 4],
      [1000 * HOUR, 4],
    ] as const) {
      now += wait;
      cursor = (await src.sync(cursor)).cursor as GmailSyncCursor;
      expect(tried()).toBe(expected);
    }
  });

  test("a retry that succeeds emits the child document and stops retrying", async () => {
    const src = source();
    outcome["image/png"] = null;
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [scan]) }));
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({ data: { history: [], historyId: "h-2" } }),
    );
    let cursor = (await src.sync(null)).cursor as GmailSyncCursor;

    outcome["image/png"] = { text: "Whiteboard notes", truncated: false };
    now += HOUR;
    const retried = await src.sync(cursor);
    expect(retried.documents.map((d) => d.externalId)).toEqual([
      "m-1",
      expect.stringMatching(/^m-1\/att\//),
    ]);
    cursor = retried.cursor as GmailSyncCursor;
    now += 100 * HOUR;
    await src.sync(cursor);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("an image skipped while OCR was paused waits without using up a try", async () => {
    const src = source();
    outcome["image/png"] = { text: "", truncated: false, deferred: true };
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [scan]) }));
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({ data: { history: [], historyId: "h-2" } }),
    );
    const first = await src.sync(null);
    expect(first.documents[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({
        filename: "scan.png",
        extracted: false,
        reason: "extraction-deferred",
      }),
    ]);
    expect(extract).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      expect.objectContaining({ reportDeferred: true }),
    );

    // Paused five times over: every hour it is tried again, and never given up on.
    let cursor = first.cursor as GmailSyncCursor;
    for (let i = 0; i < 5; i++) {
      now += HOUR;
      cursor = (await src.sync(cursor)).cursor as GmailSyncCursor;
    }
    expect(extract).toHaveBeenCalledTimes(6);
  });

  test("a cursor from another collector or a reset starts the ledger empty", async () => {
    const src = source();
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [pdf]) }));
    await src.sync(null);

    relabelled(["m-1"]);
    await src.sync(incrementalCursor({ ledger: { id: "another-ledger", seq: 7 } }));
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("a small image the HTML shows inline is decoration, not an attachment", async () => {
    const src = source();
    const logo = {
      filename: "image001.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<logo-1@example.com>" }],
      body: { attachmentId: "att-logo", size: 4_000 },
    };
    const screenshot = {
      filename: "image002.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<shot-1@example.com>" }],
      body: { attachmentId: "att-shot", size: 400_000 },
    };
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: messageWith(
          "m-1",
          [logo, screenshot],
          '<p>See below</p><img src="cid:shot-1@example.com"><p>Maya</p><img src="cid:logo-1@example.com">',
        ),
      }),
    );
    const result = await src.sync(null);
    expect(result.documents[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({ filename: "image002.png", extracted: true }),
    ]);
    expect(result.documents[0]!.content).not.toContain("image001.png");
  });

  test("a text attachment is extracted in the charset its part declares", async () => {
    const src = source();
    const notes = {
      filename: "notes.txt",
      mimeType: "text/plain",
      headers: [
        { name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"; name="notes.txt"' },
      ],
      body: { attachmentId: "att-txt", size: 300 },
    };
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [notes]) }));
    await src.sync(null);
    expect(extract).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "text/plain; charset=ISO-8859-1",
      expect.anything(),
    );
  });
});
