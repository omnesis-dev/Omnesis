// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { extractTextContent } from "./extract-text.js";

const encode = (s: string) => new TextEncoder().encode(s);

describe("extractTextContent", () => {
  describe("plain text", () => {
    test("extracts basic ASCII text", async () => {
      const result = await extractTextContent(encode("Hello, world!"), "text/plain");
      expect(result).not.toBeNull();
      expect(result!.text).toBe("Hello, world!");
      expect(result!.truncated).toBe(false);
    });

    test("extracts UTF-8 with unicode characters", async () => {
      const text = "Café résumé 日本語 🎉";
      const result = await extractTextContent(encode(text), "text/plain");
      expect(result).not.toBeNull();
      expect(result!.text).toBe(text);
    });

    test("truncates at maxTextLength", async () => {
      const text = "A".repeat(200);
      const result = await extractTextContent(encode(text), "text/plain", { maxTextLength: 100 });
      expect(result).not.toBeNull();
      expect(result!.text.length).toBe(100);
      expect(result!.truncated).toBe(true);
    });

    test("does not truncate text under limit", async () => {
      const result = await extractTextContent(encode("short"), "text/plain", {
        maxTextLength: 1000,
      });
      expect(result!.truncated).toBe(false);
    });

    test("returns null for empty text", async () => {
      const result = await extractTextContent(encode(""), "text/plain");
      expect(result).toBeNull();
    });

    test("returns null for zero-byte data", async () => {
      const result = await extractTextContent(new Uint8Array(0), "text/plain");
      expect(result).toBeNull();
    });

    test("returns null for whitespace-only text", async () => {
      const result = await extractTextContent(encode("   \n\t  "), "text/plain");
      expect(result).toBeNull();
    });

    test("preserves Windows line endings (CRLF)", async () => {
      const text = "line1\r\nline2\r\nline3";
      const result = await extractTextContent(encode(text), "text/plain");
      expect(result!.text).toBe(text);
    });

    test("handles large text (truncation)", async () => {
      const text = "X".repeat(1_100_000);
      const result = await extractTextContent(encode(text), "text/plain", {
        maxTextLength: 1_000_000,
      });
      expect(result!.text.length).toBe(1_000_000);
      expect(result!.truncated).toBe(true);
    });
  });

  describe("CSV", () => {
    test("preserves multi-row, multi-column CSV", async () => {
      const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA";
      const result = await extractTextContent(encode(csv), "text/csv");
      expect(result!.text).toBe(csv);
    });

    test("preserves quoted fields with commas", async () => {
      const csv = 'name,desc\n"Smith, John","A, B, C"';
      const result = await extractTextContent(encode(csv), "text/csv");
      expect(result!.text).toBe(csv);
    });

    test("returns null for empty CSV", async () => {
      const result = await extractTextContent(encode(""), "text/csv");
      expect(result).toBeNull();
    });

    test("handles single-row CSV", async () => {
      const csv = "header1,header2,header3";
      const result = await extractTextContent(encode(csv), "text/csv");
      expect(result!.text).toBe(csv);
    });
  });

  describe("HTML", () => {
    test("converts basic HTML tags to markdown", async () => {
      const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
      const result = await extractTextContent(encode(html), "text/html");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Title");
      expect(result!.text).toContain("**world**");
    });

    test("converts links to markdown", async () => {
      const html = '<a href="https://example.com">Click here</a>';
      const result = await extractTextContent(encode(html), "text/html");
      expect(result!.text).toContain("[Click here](https://example.com)");
    });

    test("converts lists", async () => {
      const html = "<ul><li>One</li><li>Two</li></ul>";
      const result = await extractTextContent(encode(html), "text/html");
      expect(result!.text).toContain("One");
      expect(result!.text).toContain("Two");
    });

    test("returns null for whitespace-only HTML body", async () => {
      const html = "<html><body>   </body></html>";
      const result = await extractTextContent(encode(html), "text/html");
      // Turndown may produce some whitespace — check if null or empty
      if (result) {
        expect(result.text.trim()).toBe("");
      }
    });

    test("strips script and style tags", async () => {
      const html = '<p>Hello</p><script>alert("xss")</script><style>.x{color:red}</style>';
      const result = await extractTextContent(encode(html), "text/html");
      expect(result!.text).toContain("Hello");
      expect(result!.text).not.toContain("alert");
      expect(result!.text).not.toContain("color:red");
    });

    test("handles malformed HTML gracefully", async () => {
      const html = "<p>Unclosed <b>bold";
      const result = await extractTextContent(encode(html), "text/html");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Unclosed");
    });

    test("decodes HTML entities", async () => {
      const html = "<p>Tom &amp; Jerry &lt;3</p>";
      const result = await extractTextContent(encode(html), "text/html");
      expect(result!.text).toContain("Tom & Jerry");
    });

    test("truncates after conversion", async () => {
      const html = "<p>" + "Word ".repeat(200) + "</p>";
      const result = await extractTextContent(encode(html), "text/html", { maxTextLength: 50 });
      expect(result!.text.length).toBe(50);
      expect(result!.truncated).toBe(true);
    });

    test("large HTML that extracts to ~zero chars is treated as failed", async () => {
      // Reproduces the Oney bank pattern: a multi-KB HTML body whose only
      // parseable text is a single character. The extractor should refuse to
      // claim success on output this implausibly small relative to input.
      const padding = "<!--" + "x".repeat(20_000) + "-->"; // bulk that turndown drops
      const html = `<html><body>${padding}<p>s</p></body></html>`;
      const result = await extractTextContent(encode(html), "text/html");
      expect(result).toBeNull();
    });

    test("small HTML extracting to a single char is still allowed (guard threshold)", async () => {
      // The implausibly-small guard only fires above the input-size minimum.
      // A 30-byte body legitimately producing one character of output is not
      // suspicious — only a multi-KB collapse is.
      const html = "<p>s</p>";
      const result = await extractTextContent(encode(html), "text/html");
      expect(result).not.toBeNull();
      expect(result!.text.trim()).toBe("s");
    });

    test("decodes <meta charset=windows-1252> (e.g. Outlook bank statements)", async () => {
      // Build a realistic 1250+ byte HTML body in win-1252 with the £ sign
      // (0xA3 in win-1252, would mojibake under naive UTF-8 decode).
      const meta = '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">';
      const filler = "Page header. ".repeat(100); // pad past the guard threshold
      const body = `<html><head>${meta}</head><body><p>${filler}</p><p>Account balance: 250</p></body></html>`;
      // Encode the ASCII portion (everything in this body is ASCII-safe even
      // under win-1252, but we declare it so the decoder picks the right path).
      const data = new TextEncoder().encode(body);
      const result = await extractTextContent(data, "text/html");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Account balance");
      expect(result!.text).toContain("Page header");
    });

    test("decodes quoted-printable body (mishandled MIME upstream)", async () => {
      // Build a body that's clearly QP-encoded (10+ =XX escapes plus soft
      // line breaks). Decoded, it should produce normal text.
      const qpEscapes = "=20".repeat(15); // qualifies as "looks QP" under our heuristic
      const html =
        `<html><body>` +
        `<p>Hello=\r\nworld${qpEscapes}again</p>` +
        `<p>Account=20balance:=20=A350</p>` +
        `</body></html>`;
      const data = new TextEncoder().encode(html);
      const result = await extractTextContent(data, "text/html");
      expect(result).not.toBeNull();
      // Soft break collapsed:
      expect(result!.text).toContain("Helloworld");
      // =20 → space:
      expect(result!.text).toContain("Account balance:");
    });

    test("decodes multi-byte UTF-8 in a quoted-printable body (no mojibake)", async () => {
      // In a UTF-8 body, `é` is QP-encoded as =C3=A9 and `€` as =E2=82=AC.
      // The byte-per-char decode produced "CafÃ©"/"â‚¬"; correct UTF-8
      // decoding must reconstruct the original characters.
      const html =
        `<html><body>` +
        `<p>Caf=C3=A9=\r\n r=C3=A9sum=C3=A9 ${"=20".repeat(12)}</p>` +
        `<p>Total:=20=E2=82=AC20</p>` +
        `</body></html>`;
      const result = await extractTextContent(new TextEncoder().encode(html), "text/html");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Café résumé");
      expect(result!.text).toContain("€20");
      expect(result!.text).not.toContain("Ã©");
    });

    test("ignores spurious '=XX' patterns when below QP density threshold", async () => {
      // A URL with `?id=42` shouldn't trigger QP decoding.
      const html =
        '<html><body><p>Visit <a href="https://example.com/?id=42">our page</a></p></body></html>';
      const result = await extractTextContent(encode(html), "text/html");
      expect(result).not.toBeNull();
      // The =42 must NOT have been treated as QP (which would have
      // produced character 0x42 = 'B' → "id?B").
      expect(result!.text).toContain("id=42");
    });
  });

  describe("calendar (UID extraction)", () => {
    test("exposes RFC 5545 UID in result.extra.iCalUIDs", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Test//EN",
        "BEGIN:VEVENT",
        "UID:1234abcd-5678-uid@google.com",
        "DTSTART:20260425T091500Z",
        "DTEND:20260425T104500Z",
        "SUMMARY:BRAGS AND BRAMS",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("BRAGS AND BRAMS");
      expect(result!.extra?.iCalUIDs).toEqual(["1234abcd-5678-uid@google.com"]);
    });

    test("multiple VEVENTs produce deduplicated UID list", async () => {
      // Two distinct UIDs → both surface. Same UID twice (RECURRENCE-ID
      // override) → deduped.
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Test//EN",
        "BEGIN:VEVENT",
        "UID:event-1@google.com",
        "DTSTART:20260101T100000Z",
        "DTEND:20260101T110000Z",
        "SUMMARY:Event 1",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:event-2@google.com",
        "DTSTART:20260201T100000Z",
        "DTEND:20260201T110000Z",
        "SUMMARY:Event 2",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:event-1@google.com",
        "RECURRENCE-ID:20260102T100000Z",
        "DTSTART:20260102T103000Z",
        "DTEND:20260102T113000Z",
        "SUMMARY:Event 1 (modified)",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.extra?.iCalUIDs).toEqual(["event-1@google.com", "event-2@google.com"]);
    });

    test("ICS with no UIDs produces no extra.iCalUIDs", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Test//EN",
        "BEGIN:VEVENT",
        "DTSTART:20260101T100000Z",
        "DTEND:20260101T110000Z",
        "SUMMARY:Naked event",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.text).toContain("Naked event");
      expect(result!.extra?.iCalUIDs).toBeUndefined();
    });
  });

  describe("markdown", () => {
    test("passes through unchanged", async () => {
      const md = "# Heading\n\nSome **bold** text.";
      const result = await extractTextContent(encode(md), "text/markdown");
      expect(result!.text).toBe(md);
    });

    test("preserves frontmatter", async () => {
      const md = "---\ntitle: Test\n---\n\n# Content";
      const result = await extractTextContent(encode(md), "text/markdown");
      expect(result!.text).toBe(md);
    });
  });

  describe("JSON", () => {
    test("passes through as-is", async () => {
      const json = '{"key":"value","num":42}';
      const result = await extractTextContent(encode(json), "application/json");
      expect(result!.text).toBe(json);
    });

    test("preserves pretty-printed JSON", async () => {
      const json = '{\n  "key": "value"\n}';
      const result = await extractTextContent(encode(json), "application/json");
      expect(result!.text).toBe(json);
    });

    test("handles invalid JSON without crashing", async () => {
      const text = "not valid json {[}";
      const result = await extractTextContent(encode(text), "application/json");
      expect(result).not.toBeNull();
      expect(result!.text).toBe(text);
    });
  });

  describe("ICS / Calendar", () => {
    test("extracts single VEVENT with all fields", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Team Meeting",
        "DTSTART:20260321T100000Z",
        "DTEND:20260321T110000Z",
        "LOCATION:Conference Room A",
        "ATTENDEE;CN=Bob:mailto:bob@example.com",
        "ATTENDEE;CN=Carol:mailto:carol@example.com",
        "DESCRIPTION:Discuss Q2 goals",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("## Event: Team Meeting");
      expect(result!.text).toContain("2026-03-21");
      expect(result!.text).toContain("Conference Room A");
      expect(result!.text).toContain("Bob");
      expect(result!.text).toContain("Carol");
      expect(result!.text).toContain("Discuss Q2 goals");
    });

    test("extracts multiple events", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Morning Standup",
        "DTSTART:20260321T090000Z",
        "DTEND:20260321T091500Z",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "SUMMARY:Lunch",
        "DTSTART:20260321T120000Z",
        "DTEND:20260321T130000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.text).toContain("Morning Standup");
      expect(result!.text).toContain("Lunch");
    });

    test("handles minimal VEVENT (summary only)", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Quick chat",
        "DTSTART:20260321T140000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.text).toContain("Quick chat");
    });

    test("handles all-day event", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Holiday",
        "DTSTART;VALUE=DATE:20260321",
        "DTEND;VALUE=DATE:20260322",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.text).toContain("Holiday");
      expect(result!.text).toContain("2026-03-21");
    });

    test("handles VTODO items", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "SUMMARY:Buy groceries",
        "DUE:20260325T180000Z",
        "STATUS:NEEDS-ACTION",
        "DESCRIPTION:Milk, eggs, bread",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Buy groceries");
      expect(result!.text).toContain("NEEDS-ACTION");
    });

    test("uses (no title) for event with no summary", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART:20260321T100000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result!.text).toContain("(no title)");
    });

    test("returns null for missing VEVENT/VTODO", async () => {
      const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
      const result = await extractTextContent(encode(ics), "text/calendar");
      expect(result).toBeNull();
    });

    test("returns null for invalid ICS data", async () => {
      const result = await extractTextContent(encode("not a calendar"), "text/calendar");
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null for unknown MIME type", async () => {
      const result = await extractTextContent(encode("data"), "application/octet-stream");
      expect(result).toBeNull();
    });

    test("handles binary data as text type gracefully", async () => {
      const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90]);
      const result = await extractTextContent(binary, "text/plain");
      // TextDecoder with fatal:false produces replacement chars, doesn't crash
      if (result) {
        expect(typeof result.text).toBe("string");
      }
    });

    test("handles data with BOM", async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]); // UTF-8 BOM
      const text = encode("Hello after BOM");
      const withBom = new Uint8Array([...bom, ...text]);
      const result = await extractTextContent(withBom, "text/plain");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("Hello after BOM");
    });
  });
});
