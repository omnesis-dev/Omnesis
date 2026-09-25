// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImapClient } from "./client.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  download: vi.fn(),
  fetchAll: vi.fn(),
  list: vi.fn(),
  logout: vi.fn(),
  search: vi.fn(),
  sockets: [] as Array<{ emitData(chunk: Buffer): void }>,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    socket = (() => {
      const listeners: Array<(chunk: Buffer) => void> = [];
      const socket = {
        prependListener: (_event: "data", listener: (chunk: Buffer) => void) => {
          listeners.unshift(listener);
        },
        removeListener: (_event: "data", listener: (chunk: Buffer) => void) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
        emitData: (chunk: Buffer) => {
          for (const listener of [...listeners]) listener(chunk);
        },
      };
      mocks.sockets.push(socket);
      return socket;
    })();
    connect = () => Promise.resolve();
    logout = mocks.logout;
    close = mocks.close;
    list = mocks.list;
    mailboxOpen = () =>
      Promise.resolve({ uidValidity: 1n, uidNext: 1, flags: new Set(), path: "INBOX" });
    search = mocks.search;
    fetchAll = mocks.fetchAll;
    download = mocks.download;
  },
}));

describe("ImapFlow adapter", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.download.mockReset();
    mocks.fetchAll.mockReset();
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.logout.mockReset().mockResolvedValue(undefined);
    mocks.search.mockReset().mockResolvedValue([]);
    mocks.sockets.length = 0;
  });

  it("times out a mailbox listing that never completes", async () => {
    vi.useFakeTimers();
    try {
      mocks.list.mockReturnValue(new Promise(() => {}));
      const client = createImapClient({
        host: "imap.example.com",
        username: "account@example.com",
        password: "invented-app-password",
      });

      const listing = expect(client.list(500, 8 * 1024 * 1024)).rejects.toThrow(
        "listing timed out",
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await listing;
      expect(mocks.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the socket when LIST bytes cross the aggregate limit", async () => {
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    mocks.list.mockImplementation(() => {
      mocks.sockets[0].emitData(Buffer.from(`* LIST () "/" "${"x".repeat(100)}"\r\n`));
      return Promise.resolve([]);
    });

    await expect(client.list(500, 100)).rejects.toThrow("listing exceeds limit");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the socket while a hostile LIST stream crosses the mailbox cap", async () => {
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    mocks.list.mockImplementation(() => {
      const lines = Array.from({ length: 501 }, (_, index) =>
        index % 2 === 0
          ? `\0\0*   LIST () "/" "Mailbox ${index}"\r\n`
          : `\0* LSUB () "/" "Mailbox ${index}"\r\n`,
      ).join("");
      const bytes = Buffer.from(lines);
      for (let offset = 0; offset < bytes.length; offset += 3) {
        mocks.sockets[0].emitData(bytes.subarray(offset, offset + 3));
      }
      return Promise.resolve([]);
    });

    await expect(client.list(500, 8 * 1024 * 1024)).rejects.toThrow("listing exceeds limit");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("passes the source mailbox cap into ImapFlow LIST", async () => {
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    await client.list(500, 8 * 1024 * 1024);

    expect(mocks.list).toHaveBeenCalledWith();
  });

  it("scopes UIDVALIDITY to the configured server", async () => {
    const first = createImapClient({
      host: "imap-one.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    const second = createImapClient({
      host: "imap-two.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const firstState = await first.open("INBOX");
    const secondState = await second.open("INBOX");

    expect(firstState.uidValidity).toMatch(/^[a-f0-9]{16}:1$/);
    expect(secondState.uidValidity).toMatch(/^[a-f0-9]{16}:1$/);
    expect(firstState.uidValidity).not.toBe(secondState.uidValidity);
  });

  it("rejects a failed SEARCH instead of treating it as an empty mailbox", async () => {
    mocks.search.mockResolvedValue(false);
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    await expect(client.search({ uid: "1:10" })).rejects.toThrow("IMAP SEARCH failed");
  });

  it("requests dates without bodies for deletion metadata, with envelope fallback", async () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    mocks.fetchAll.mockResolvedValue([
      { uid: 7, internalDate: date },
      // A broken INTERNALDATE with a valid Date: header must not wedge the
      // snapshot: the envelope date stands in, matching the paged read.
      { uid: 8, envelope: { date: new Date("2026-01-02T00:00:00.000Z") } },
    ]);
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    await expect(client.fetchMetadata([7, 8])).resolves.toEqual([
      { uid: 7, date },
      { uid: 8, date: new Date("2026-01-02T00:00:00.000Z") },
    ]);
    expect(mocks.fetchAll).toHaveBeenCalledWith(
      [7, 8],
      { uid: true, internalDate: true, envelope: true },
      { uid: true },
    );
  });

  it("hard-closes the socket when graceful logout fails", async () => {
    mocks.logout.mockRejectedValue(new Error("logout failed"));
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    await expect(client.close()).rejects.toThrow("logout failed");

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("downloads a single-part text message through ImapFlow's part-1 fallback", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 8,
        envelope: { subject: "Plain message" },
        headers: Buffer.from("References: <root@example.com>\r\n"),
        size: 12,
        bodyStructure: { type: "text/plain", size: 12 },
      },
    ]);
    mocks.download.mockResolvedValue({
      meta: { contentType: "text/plain", expectedSize: 12 },
      content: Readable.from([Buffer.from("Plain body")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([8], 512 * 1024);

    expect(mocks.download).toHaveBeenCalledWith(8, "1", { uid: true, maxBytes: 512 * 1024 });
    expect(messages[0].text).toBe("Plain body");
    // Headers absent from the buffer stay absent on the message — a marker
    // header must never materialize out of a References-only buffer.
    expect(messages[0].references).toEqual(["<root@example.com>"]);
    expect(messages[0].listUnsubscribe).toBeUndefined();
    expect(messages[0].autoSubmitted).toBeUndefined();
    expect(messages[0].precedence).toBeUndefined();
  });

  it("downloads the HTML sibling of a preferred plain part for markup scanning", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 9,
        envelope: { subject: "Booking" },
        size: 64,
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { part: "1", type: "text/plain", size: 11 },
            { part: "2", type: "text/html", size: 40 },
          ],
        },
      },
    ]);
    mocks.download
      .mockResolvedValueOnce({
        meta: { contentType: "text/plain", expectedSize: 11 },
        content: Readable.from([Buffer.from("Plain body")]),
      })
      .mockResolvedValueOnce({
        meta: { contentType: "text/html", expectedSize: 40 },
        content: Readable.from([Buffer.from("<html><body>Booking</body></html>")]),
      });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([9], 512 * 1024);

    expect(mocks.download).toHaveBeenNthCalledWith(1, 9, "1", { uid: true, maxBytes: 512 * 1024 });
    expect(mocks.download).toHaveBeenNthCalledWith(2, 9, "2", { uid: true, maxBytes: 512 * 1024 });
    expect(messages[0].text).toBe("Plain body");
    expect(messages[0].html).toBe("<html><body>Booking</body></html>");
    expect(messages[0].truncated).toBe(false);
  });

  it("downloads a text body part without downloading attachments", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 7,
        envelope: { subject: "Status" },
        headers: Buffer.from(
          "References: <root@example.com>\r\n\t<parent@example.com> <root@example.com>\r\n" +
            "List-Unsubscribe: <https://example.com/unsubscribe>,\r\n <mailto:leave@example.com>\r\n" +
            "Auto-Submitted: auto-generated\r\n" +
            "Precedence: bulk\r\n",
        ),
        size: 8_000_000,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 11 },
            {
              part: "2",
              type: "application/pdf",
              size: 8_000_000,
              disposition: "attachment",
            },
          ],
        },
      },
    ]);
    mocks.download.mockResolvedValue({
      meta: { contentType: "text/plain", expectedSize: 11 },
      content: Readable.from([Buffer.from("Status body")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([7], 512 * 1024);

    expect(mocks.download).toHaveBeenCalledWith(7, "1", { uid: true, maxBytes: 512 * 1024 });
    expect(mocks.fetchAll).toHaveBeenCalledWith(
      [7],
      expect.objectContaining({
        headers: ["references", "list-unsubscribe", "auto-submitted", "precedence"],
      }),
      { uid: true },
    );
    expect(messages).toMatchObject([
      {
        uid: 7,
        text: "Status body",
        truncated: false,
        references: ["<root@example.com>", "<parent@example.com>"],
        listUnsubscribe: "<https://example.com/unsubscribe>, <mailto:leave@example.com>",
        autoSubmitted: "auto-generated",
        precedence: "bulk",
      },
    ]);
    expect(messages[0]).not.toHaveProperty("source");
  });

  it("skips a zero-length text part in favor of its real sibling", async () => {
    // The wedge shape from live: marketing mail with an EMPTY text/plain
    // alternative beside the real HTML part. imapflow resolves `{}` for the
    // empty part, which would read as vanished and pin the page forever.
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 24070,
        envelope: { subject: "Newsletter" },
        size: 42000,
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { part: "1", type: "text/plain", size: 0, lineCount: 0 },
            { part: "2", type: "text/html", size: 41567, lineCount: 533 },
          ],
        },
      },
      {
        uid: 24071,
        envelope: { subject: "Empty" },
        size: 100,
        // A single-part message whose whole body is zero bytes: nothing to
        // download, but the message itself must still ingest.
        bodyStructure: { type: "text/plain", size: 0, lineCount: 0 },
      },
    ]);
    mocks.download.mockResolvedValue({
      meta: { contentType: "text/html", expectedSize: 41567 },
      content: Readable.from([Buffer.from("<html><body>News</body></html>")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([24070, 24071], 512 * 1024);

    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(24070, "2", { uid: true, maxBytes: 512 * 1024 });
    expect(messages[0].html).toBe("<html><body>News</body></html>");
    expect(messages[0].text).toBeUndefined();
    expect(messages[1].text).toBeUndefined();
    expect(messages[1].html).toBeUndefined();
  });

  it("treats a body part with no Content-Type MIME header as plain text", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 9,
        envelope: { subject: "Headerless" },
        size: 12,
        bodyStructure: { type: "text/plain", size: 12 },
      },
    ]);
    // imapflow leaves meta.contentType unset when the part's MIME headers
    // carry no Content-Type, even though BODYSTRUCTURE reported text/plain.
    mocks.download.mockResolvedValue({
      meta: { expectedSize: 12 },
      content: Readable.from([Buffer.from("Default body")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([9], 512 * 1024);
    expect(messages[0].text).toBe("Default body");
    expect(messages[0].html).toBeUndefined();
  });

  it("maps an expunged part's empty download to a thrown error", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 10,
        envelope: { subject: "Racing an expunge" },
        size: 12,
        bodyStructure: { type: "text/plain", size: 12 },
      },
    ]);
    mocks.download.mockResolvedValue({});
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    await expect(client.fetch([10], 512 * 1024)).rejects.toThrow("vanished before download");
    await expect(client.fetchAttachment(10, "2", 1024)).rejects.toThrow("vanished before download");
  });

  it("exposes named attachment parts from BODYSTRUCTURE without downloading them", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 11,
        envelope: { subject: "Report" },
        size: 5000,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 11 },
            {
              part: "2",
              type: "application/pdf",
              size: 4000,
              disposition: "attachment",
              dispositionParameters: { filename: "report.pdf" },
            },
            // A calendar invite exposed twice with the same filename and size
            // dedupes to its first part.
            {
              part: "3",
              type: "text/calendar",
              size: 900,
              dispositionParameters: { filename: "invite.ics" },
            },
            {
              part: "4",
              type: "application/ics",
              size: 900,
              disposition: "attachment",
              dispositionParameters: { filename: "invite.ics" },
            },
            // No filename — unnameable, never surfaced.
            { part: "5", type: "application/octet-stream", size: 7, disposition: "attachment" },
          ],
        },
      },
    ]);
    mocks.download.mockResolvedValue({
      meta: { contentType: "text/plain", expectedSize: 11 },
      content: Readable.from([Buffer.from("Report body")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([11], 512 * 1024);

    // Only the body part was downloaded.
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(messages[0].attachments).toEqual([
      { part: "2", filename: "report.pdf", mimeType: "application/pdf", size: 4000 },
      { part: "3", filename: "invite.ics", mimeType: "text/calendar", size: 900 },
    ]);
  });

  it("downloads decoded attachment bytes and fails on truncation", async () => {
    mocks.download.mockResolvedValueOnce({
      meta: { contentType: "application/pdf", expectedSize: 9 },
      content: Readable.from([Buffer.from("pdf-bytes")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const bytes = await client.fetchAttachment(11, "2", 1024);
    // One byte of headroom: a part larger than the cap provably exceeds it.
    expect(mocks.download).toHaveBeenCalledWith(11, "2", { uid: true, maxBytes: 1025 });
    expect(Buffer.from(bytes).toString("utf8")).toBe("pdf-bytes");

    // A part that overflows the cap must fail rather than hand a fragment
    // to the extractor.
    mocks.download.mockResolvedValueOnce({
      meta: { contentType: "application/pdf", expectedSize: 100 },
      content: Readable.from([Buffer.from("0123456789A")]),
    });
    await expect(client.fetchAttachment(11, "2", 10)).rejects.toThrow("exceeds");
  });

  it("fetches BODYSTRUCTURE for metadata only when attachments are requested", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 12,
        internalDate: new Date("2026-08-02T09:00:00.000Z"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 5 },
            {
              part: "2",
              type: "application/pdf",
              size: 4000,
              disposition: "attachment",
              dispositionParameters: { filename: "report.pdf" },
            },
          ],
        },
      },
    ]);
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const withAttachments = await client.fetchMetadata([12], { attachments: true });
    expect(mocks.fetchAll).toHaveBeenLastCalledWith(
      [12],
      { uid: true, internalDate: true, envelope: true, bodyStructure: true },
      { uid: true },
    );
    expect(withAttachments[0].attachments).toEqual([
      { part: "2", filename: "report.pdf", mimeType: "application/pdf", size: 4000 },
    ]);

    const without = await client.fetchMetadata([12]);
    expect(mocks.fetchAll).toHaveBeenLastCalledWith(
      [12],
      { uid: true, internalDate: true, envelope: true },
      { uid: true },
    );
    expect(without[0].attachments).toBeUndefined();
  });

  it("fails metadata when a requested BODYSTRUCTURE is omitted", async () => {
    mocks.fetchAll.mockResolvedValue([
      { uid: 13, internalDate: new Date("2026-08-02T09:00:00.000Z") },
    ]);
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    // Treating the omission as "no attachments" would silently drop child
    // ids from the snapshot and order their deletion.
    await expect(client.fetchMetadata([13], { attachments: true })).rejects.toThrow(
      "omitted requested BODYSTRUCTURE",
    );
    await expect(client.fetchMetadata([13])).resolves.toHaveLength(1);
  });

  it("surfaces a single-part root attachment and nested name= parts", async () => {
    mocks.fetchAll.mockResolvedValue([
      {
        uid: 14,
        envelope: { subject: "Just a file" },
        size: 900,
        // The whole message is the attachment: no part id on the root.
        bodyStructure: {
          type: "application/pdf",
          size: 900,
          disposition: "attachment",
          dispositionParameters: { filename: "solo.pdf" },
        },
      },
      {
        uid: 15,
        envelope: { subject: "Nested" },
        size: 2000,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 5 },
            {
              type: "multipart/related",
              childNodes: [
                { part: "2.1", type: "text/html", size: 40 },
                // Only a Content-Type name= parameter, two levels deep.
                {
                  part: "2.2",
                  type: "image/png",
                  size: 300,
                  parameters: { name: "diagram.png" },
                },
              ],
            },
          ],
        },
      },
    ]);
    mocks.download.mockResolvedValue({
      meta: { contentType: "text/plain", expectedSize: 5 },
      content: Readable.from([Buffer.from("body")]),
    });
    const client = createImapClient({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });

    const messages = await client.fetch([14, 15], 512 * 1024);

    expect(messages[0].attachments).toEqual([
      { part: "1", filename: "solo.pdf", mimeType: "application/pdf", size: 900 },
    ]);
    expect(messages[1].attachments).toEqual([
      { part: "2.2", filename: "diagram.png", mimeType: "image/png", size: 300 },
    ]);
  });
});
