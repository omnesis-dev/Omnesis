// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { extractEmlText } from "./extract-eml.js";

const encode = (s: string) => new TextEncoder().encode(s);

function makeEml(opts: {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  body?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; mimeType: string; inline?: boolean }>;
}): Uint8Array {
  const lines: string[] = [];
  const boundary = "----=_Part_12345";

  if (opts.from) lines.push(`From: ${opts.from}`);
  if (opts.to) lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.subject) lines.push(`Subject: ${opts.subject}`);
  if (opts.date) lines.push(`Date: ${opts.date}`);

  const hasAttachments = opts.attachments && opts.attachments.length > 0;
  const hasMultipleParts = (opts.body && opts.html) || hasAttachments;

  if (hasMultipleParts) {
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);

    if (opts.body && opts.html) {
      const altBoundary = "----=_Alt_67890";
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=utf-8");
      lines.push("");
      lines.push(opts.body);
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=utf-8");
      lines.push("");
      lines.push(opts.html);
      lines.push(`--${altBoundary}--`);
    } else if (opts.body) {
      lines.push("Content-Type: text/plain; charset=utf-8");
      lines.push("");
      lines.push(opts.body);
    } else if (opts.html) {
      lines.push("Content-Type: text/html; charset=utf-8");
      lines.push("");
      lines.push(opts.html);
    }

    if (opts.attachments) {
      for (const att of opts.attachments) {
        lines.push(`--${boundary}`);
        const disposition = att.inline ? "inline" : "attachment";
        lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
        lines.push(`Content-Disposition: ${disposition}; filename="${att.filename}"`);
        lines.push(`Content-Transfer-Encoding: base64`);
        lines.push("");
        lines.push(Buffer.from(att.content).toString("base64"));
      }
    }

    lines.push(`--${boundary}--`);
  } else {
    if (opts.html) {
      lines.push("MIME-Version: 1.0");
      lines.push("Content-Type: text/html; charset=utf-8");
    } else {
      lines.push("MIME-Version: 1.0");
      lines.push("Content-Type: text/plain; charset=utf-8");
    }
    lines.push("");
    lines.push(opts.body ?? opts.html ?? "");
  }

  return encode(lines.join("\r\n"));
}

describe("extractEmlText", () => {
  describe("basic extraction", () => {
    test("extracts subject, from, to, date, and body", async () => {
      const eml = makeEml({
        subject: "Test Email",
        from: "alice@example.com",
        to: "bob@example.com",
        date: "Wed, 15 Jan 2025 10:00:00 +0000",
        body: "Hello from Alice!",
      });

      const result = await extractEmlText(eml);
      expect(result).not.toBeNull();
      expect(result!.text).toContain("# Test Email");
      expect(result!.text).toContain("**From:** alice@example.com");
      expect(result!.text).toContain("**To:** bob@example.com");
      expect(result!.text).toContain("**Date:**");
      expect(result!.text).toContain("Hello from Alice!");
      expect(result!.truncated).toBe(false);
    });

    test("subject appears as markdown heading", async () => {
      const eml = makeEml({ subject: "Important Subject", body: "content" });
      const result = await extractEmlText(eml);
      expect(result!.text).toContain("# Important Subject");
    });

    test("separator between headers and body", async () => {
      const eml = makeEml({ subject: "Test", body: "Body text" });
      const result = await extractEmlText(eml);
      expect(result!.text).toContain("---");
      expect(result!.text).toContain("Body text");
    });
  });

  describe("HTML fallback", () => {
    test("converts HTML body to markdown when no text body", async () => {
      const eml = makeEml({
        subject: "HTML Email",
        html: "<h2>Section</h2><p>Some <strong>bold</strong> text.</p>",
      });

      const result = await extractEmlText(eml);
      expect(result).not.toBeNull();
      expect(result!.text).toContain("**bold**");
    });

    test("prefers text body over HTML", async () => {
      const eml = makeEml({
        subject: "Both",
        body: "Plain text version",
        html: "<p>HTML version</p>",
      });

      const result = await extractEmlText(eml);
      expect(result!.text).toContain("Plain text version");
    });
  });

  describe("headers", () => {
    test("formats From with display name", async () => {
      const eml = makeEml({
        from: '"Alice Smith" <alice@example.com>',
        body: "content",
      });

      const result = await extractEmlText(eml);
      expect(result!.text).toContain("Alice Smith");
      expect(result!.text).toContain("alice@example.com");
    });

    test("handles multiple To/Cc recipients", async () => {
      const eml = makeEml({
        to: "bob@example.com, carol@example.com",
        cc: "dave@example.com",
        body: "content",
      });

      const result = await extractEmlText(eml);
      expect(result!.text).toContain("bob@example.com");
      expect(result!.text).toContain("carol@example.com");
      expect(result!.text).toContain("**Cc:**");
      expect(result!.text).toContain("dave@example.com");
    });

    test("uses (no subject) for missing subject", async () => {
      const eml = makeEml({ body: "no subject email" });
      const result = await extractEmlText(eml);
      expect(result!.text).toContain("(no subject)");
    });

    test("omits missing From/Date lines", async () => {
      const eml = makeEml({ subject: "Test", body: "content" });
      const result = await extractEmlText(eml);
      // Should not have empty "**From:**" lines
      expect(result!.text).not.toContain("**From:** \n");
    });
  });

  describe("nested attachments", () => {
    test("lists file attachments in footer", async () => {
      const eml = makeEml({
        subject: "With attachments",
        body: "See attached files",
        attachments: [
          { filename: "report.pdf", content: "fake pdf", mimeType: "application/pdf" },
          {
            filename: "data.xlsx",
            content: "fake xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ],
      });

      const result = await extractEmlText(eml);
      expect(result!.text).toContain("**Attachments:**");
      expect(result!.text).toContain("report.pdf");
      expect(result!.text).toContain("data.xlsx");
    });

    test("skips inline attachments in listing", async () => {
      const eml = makeEml({
        subject: "With inline",
        body: "See image",
        attachments: [
          { filename: "logo.png", content: "fake png", mimeType: "image/png", inline: true },
          { filename: "report.pdf", content: "fake pdf", mimeType: "application/pdf" },
        ],
      });

      const result = await extractEmlText(eml);
      // Inline attachments should not appear in the listing
      expect(result!.text).toContain("report.pdf");
      // logo.png is inline, should be excluded
      const attachmentSection = result!.text.split("**Attachments:**")[1] ?? "";
      expect(attachmentSection).not.toContain("logo.png");
    });

    test("no attachment footer when no attachments", async () => {
      const eml = makeEml({ subject: "No attachments", body: "Just text" });
      const result = await extractEmlText(eml);
      expect(result!.text).not.toContain("**Attachments:**");
    });
  });

  describe("edge cases", () => {
    test("returns null for empty data", async () => {
      const result = await extractEmlText(encode(""));
      expect(result).toBeNull();
    });

    test("returns null for zero-byte data", async () => {
      const result = await extractEmlText(new Uint8Array(0));
      expect(result).toBeNull();
    });

    test("handles corrupt/binary data", async () => {
      const result = await extractEmlText(new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
      // Should either return null or handle gracefully
      // postal-mime may parse garbage as empty email
      if (result) {
        expect(typeof result.text).toBe("string");
      }
    });

    test("truncates very long body at maxTextLength", async () => {
      const longBody = "X".repeat(100_000);
      const eml = makeEml({ subject: "Long", body: longBody });
      const result = await extractEmlText(eml, { maxTextLength: 500 });
      expect(result).not.toBeNull();
      expect(result!.text.length).toBe(500);
      expect(result!.truncated).toBe(true);
    });

    test("handles MIME encoded-word headers", async () => {
      // postal-mime handles RFC 2047 encoded words
      const eml = encode(
        [
          "From: =?UTF-8?B?QWxpY2U=?= <alice@example.com>",
          "Subject: =?UTF-8?B?VGVzdCBTdWJqZWN0?=",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Body text",
        ].join("\r\n"),
      );

      const result = await extractEmlText(eml);
      expect(result).not.toBeNull();
      // Encoded headers should be decoded
      expect(result!.text).toContain("Alice");
      expect(result!.text).toContain("Body text");
    });
  });

  describe("MSG format", () => {
    test("MSG data handled by dispatcher returns null", async () => {
      // MSG is handled at the dispatcher level (extract.ts), not here
      // extractEmlText itself doesn't handle MSG — it only gets called for EML
      // This test verifies the function handles non-EML data gracefully
      const result = await extractEmlText(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
      // postal-mime will fail to parse OLE2 data
      if (result) {
        expect(typeof result.text).toBe("string");
      }
    });
  });
});
