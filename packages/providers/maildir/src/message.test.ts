// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { messageKey, parseMessageFile, scanMessage } from "./message.js";
import { renderMessage } from "./testing/maildir-writer.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-maildir-message-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("messageKey", () => {
  test("every copy of a message shares one key, however its id is bracketed", () => {
    expect(messageKey("<abc@example.org>", "INBOX", "1")).toBe(
      messageKey(" abc@example.org ", "Archive", "2"),
    );
    expect(messageKey("abc@example.org", "INBOX", "1")).toMatch(/^mid:[0-9a-f]{32}$/);
  });

  test("a message without an id is keyed by its file", () => {
    expect(messageKey(undefined, "INBOX", "1")).toMatch(/^file:/);
    expect(messageKey(undefined, "INBOX", "1")).not.toBe(messageKey(undefined, "INBOX", "2"));
    expect(messageKey("<>", "INBOX", "1")).toBe(messageKey(undefined, "INBOX", "1"));
  });
});

describe("scanMessage", () => {
  test("reads the identity and date from the headers alone", async () => {
    const raw = renderMessage({
      messageId: "scan@example.org",
      from: { address: "jamie.lopez@example.org" },
      to: [{ address: "maya.reeves@example.com" }],
      subject: "Scan",
      date: "2026-02-01T12:00:00Z",
      text: "body",
    });
    const scanned = await scanMessage(write("m", raw), "INBOX", "x", () => 0);
    expect(scanned).toEqual({
      key: messageKey("scan@example.org", "INBOX", "x"),
      dateMs: Date.parse("2026-02-01T12:00:00Z"),
    });
  });

  test("falls back to the file's modification time when neither header nor name dates it", async () => {
    const scanned = await scanMessage(
      write("m", "Subject: x\n\nbody"),
      "INBOX",
      "no-time",
      () => 1234.5,
    );
    expect(scanned.dateMs).toBe(1234);
  });

  test("an unparseable Date header falls back too", async () => {
    const scanned = await scanMessage(
      write("m", "Date: someday\nSubject: x\n\nbody"),
      "INBOX",
      "1700000000.x",
      () => 0,
    );
    expect(scanned.dateMs).toBe(1_700_000_000_000);
  });

  test("a named pipe is refused at once rather than waited on", async () => {
    const pipe = join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);
    await expect(scanMessage(pipe, "INBOX", "x", () => 0)).rejects.toMatchObject({
      code: "ENOTREGULAR",
    });
    await expect(parseMessageFile(pipe)).rejects.toMatchObject({ code: "ENOTREGULAR" });
  });

  test("a symbolic link is not followed", async () => {
    const target = write("target", "Subject: x\n\nbody");
    const link = join(dir, "link");
    symlinkSync(target, link);
    await expect(parseMessageFile(link)).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("a file that is not there is an error the caller classifies", async () => {
    await expect(scanMessage(join(dir, "missing"), "INBOX", "x", () => 0)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("text that is not UTF-8", () => {
  test("a raw Latin-1 subject is read in the charset the message declares", async () => {
    const raw = Buffer.concat([
      Buffer.from("From: <jamie.lopez@example.org>\r\nSubject: ", "latin1"),
      Buffer.from("Hébergement réservé", "latin1"),
      Buffer.from("\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n", "latin1"),
      Buffer.from("Voilà le détail.", "latin1"),
    ]);
    const path = join(dir, "m");
    writeFileSync(path, raw);
    const parsed = await parseMessageFile(path);
    expect(parsed.subject).toBe("Hébergement réservé");
    expect(parsed.text?.trim()).toBe("Voilà le détail.");
    expect((await scanMessage(path, "INBOX", "x", () => 0)).key).toMatch(/^file:|^mid:/);
  });

  test("a body with no charset that is not UTF-8 reads as windows-1252", async () => {
    const path = join(dir, "m");
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from("Subject: plain\r\n\r\n", "latin1"),
        // 0x96 is an en dash in windows-1252 and not a character in Latin-1.
        Buffer.from("Café crème ", "latin1"),
        Buffer.from([0x96]),
        Buffer.from(" ça va", "latin1"),
      ]),
    );
    expect((await parseMessageFile(path)).text?.trim()).toBe("Café crème – ça va");
  });

  test("a Latin-1 text attachment reaches the extractor as UTF-8, keeping its size", async () => {
    const raw = renderMessage({
      from: { address: "jamie.lopez@example.org" },
      to: [{ address: "maya.reeves@example.com" }],
      subject: "Notes",
      date: "2026-02-01T12:00:00Z",
      text: "see attached",
      attachments: [{ filename: "notes.txt", mimeType: "text/plain", content: "" }],
    }).replace(
      /(filename="notes.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n)/,
      `$1${Buffer.from("Résumé à jour", "latin1").toString("base64")}`,
    );
    const parsed = await parseMessageFile(write("m", raw));
    const notes = parsed.attachments.find((a) => a.filename === "notes.txt")!;
    expect(new TextDecoder().decode(notes.content)).toBe("Résumé à jour");
    expect(notes.size).toBe(13);
  });

  test("valid UTF-8 is left as it is", async () => {
    const path = write(
      "m",
      "Subject: Été\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nÇa marche.",
    );
    const parsed = await parseMessageFile(path);
    expect(parsed.subject).toBe("Été");
    expect(parsed.text?.trim()).toBe("Ça marche.");
  });
});

describe("dates and threading headers", () => {
  test("a message without a Date header is dated by its topmost Received header", async () => {
    const raw = [
      "Received: from mx.example.net by mail.example.org; Tue, 2 Mar 2010 10:00:00 +0000",
      "Received: from host.example.com by mx.example.net; Tue, 2 Mar 2010 09:59:00 +0000",
      "Subject: undated",
      "",
      "body",
    ].join("\r\n");
    const path = write("m", raw);
    // The file name carries the time a mirroring tool downloaded it.
    const scanned = await scanMessage(path, "INBOX", "1790611077.x", () => 0);
    expect(scanned.dateMs).toBe(Date.parse("2010-03-02T10:00:00Z"));
    expect((await parseMessageFile(path)).date?.toISOString()).toBe("2010-03-02T10:00:00.000Z");
  });

  test("In-Reply-To yields its first message id, without comments", async () => {
    const path = write(
      "m",
      "Subject: re\r\nIn-Reply-To: <a@example.org> (message from Jamie) <b@example.org>\r\n\r\nbody",
    );
    expect((await parseMessageFile(path)).inReplyTo).toBe("a@example.org");
  });
});

describe("parseMessageFile", () => {
  test("flattens address groups and reads threading headers", async () => {
    const raw = [
      "From: Jamie Lopez <jamie.lopez@example.org>",
      "To: Project team: Maya Reeves <maya.reeves@example.com>, david.lin@example.io;",
      "Subject: =?utf-8?Q?Caf=C3=A9_plans?=",
      "Message-ID: <c@example.org>",
      "In-Reply-To: <b@example.org>",
      "References: <a@example.org>\r\n <b@example.org>",
      "Precedence: bulk",
      "Auto-Submitted: auto-generated",
      "",
      "body",
    ].join("\r\n");
    const parsed = await parseMessageFile(write("m", raw));
    expect(parsed.subject).toBe("Café plans");
    expect(parsed.to).toEqual([
      { name: "Maya Reeves", address: "maya.reeves@example.com" },
      { address: "david.lin@example.io" },
    ]);
    expect(parsed.messageId).toBe("c@example.org");
    expect(parsed.inReplyTo).toBe("b@example.org");
    expect(parsed.references).toEqual(["a@example.org", "b@example.org"]);
    expect(parsed.precedence).toBe("bulk");
    expect(parsed.autoSubmitted).toBe("auto-generated");
    expect(parsed.headersOnly).toBe(false);
  });

  test("keeps named, non-empty attachments once each", async () => {
    const raw = renderMessage({
      from: { address: "jamie.lopez@example.org" },
      to: [{ address: "maya.reeves@example.com" }],
      subject: "Files",
      date: "2026-02-01T12:00:00Z",
      text: "see attached",
      attachments: [
        { filename: "plan.pdf", mimeType: "application/pdf", content: "plan" },
        { filename: "plan.pdf", mimeType: "application/pdf", content: "plan" },
        { filename: "empty.txt", mimeType: "text/plain", content: "" },
      ],
    });
    const parsed = await parseMessageFile(write("m", raw));
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.size])).toEqual([
      ["plan.pdf", "application/pdf", 4],
    ]);
  });
});
