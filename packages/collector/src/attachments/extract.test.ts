// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import JSZip from "jszip";
import { extractAttachmentText } from "./extract.js";

const encode = (s: string) => new TextEncoder().encode(s);

describe("extractAttachmentText", () => {
  test("returns null for unsupported MIME type", async () => {
    const result = await extractAttachmentText(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(result).toBeNull();
  });

  test("dispatches application/pdf to PDF extractor", async () => {
    // Invalid PDF data — should return null gracefully
    const result = await extractAttachmentText(new Uint8Array([1, 2, 3]), "application/pdf");
    expect(result).toBeNull();
  });

  test("returns null for empty PDF data", async () => {
    const result = await extractAttachmentText(new Uint8Array(0), "application/pdf");
    expect(result).toBeNull();
  });

  // Text-based formats
  test("dispatches text/plain to text extractor", async () => {
    const result = await extractAttachmentText(encode("Hello world"), "text/plain");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello world");
  });

  test("dispatches text/csv to text extractor", async () => {
    const result = await extractAttachmentText(encode("a,b\n1,2"), "text/csv");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("a,b\n1,2");
  });

  test("dispatches text/html to text extractor", async () => {
    const result = await extractAttachmentText(encode("<p>Hello</p>"), "text/html");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello");
  });

  test("dispatches text/markdown to text extractor", async () => {
    const result = await extractAttachmentText(encode("# Heading"), "text/markdown");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("# Heading");
  });

  test("dispatches application/json to text extractor", async () => {
    const result = await extractAttachmentText(encode('{"key":"val"}'), "application/json");
    expect(result).not.toBeNull();
    expect(result!.text).toBe('{"key":"val"}');
  });

  test("dispatches text/calendar to text extractor", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Test",
      "DTSTART:20260321T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = await extractAttachmentText(encode(ics), "text/calendar");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Test");
  });

  // Office formats — corrupt data returns null
  test("dispatches DOCX MIME to office extractor (corrupt → null)", async () => {
    const result = await extractAttachmentText(
      new Uint8Array([1, 2, 3]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result).toBeNull();
  });

  test("dispatches XLSX MIME to office extractor (corrupt → null)", async () => {
    const result = await extractAttachmentText(
      new Uint8Array([1, 2, 3]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(result).toBeNull();
  });

  test("dispatches PPTX MIME to office extractor (corrupt → null)", async () => {
    const result = await extractAttachmentText(
      new Uint8Array([1, 2, 3]),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(result).toBeNull();
  });

  test("dispatches RTF MIME to the RTF extractor", async () => {
    const result = await extractAttachmentText(
      encode(String.raw`{\rtf1\ansi dispatch note\par owner: unit alpha}`),
      "application/rtf; charset=binary",
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("dispatch note");
    expect(result!.text).toContain("owner: unit alpha");
  });

  test("dispatches legacy Office and OpenDocument MIME types (corrupt → null)", async () => {
    const corrupt = new Uint8Array([1, 2, 3]);
    for (const type of [
      "application/msword",
      "application/vnd.ms-excel",
      "application/x-msexcel",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
    ]) {
      expect(await extractAttachmentText(corrupt, type)).toBeNull();
    }
  });

  // Email formats
  test("dispatches message/rfc822 to EML extractor", async () => {
    const eml = [
      "From: alice@example.com",
      "Subject: Test",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello from EML",
    ].join("\r\n");
    const result = await extractAttachmentText(encode(eml), "message/rfc822");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello from EML");
  });

  test("returns null for application/vnd.ms-outlook (MSG unsupported)", async () => {
    const result = await extractAttachmentText(
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      "application/vnd.ms-outlook",
    );
    expect(result).toBeNull();
  });

  // Apple Wallet passes — dispatch routing (deep behavior in extract-pkpass.test.ts)
  test("dispatches application/vnd.apple.pkpass to the pkpass extractor", async () => {
    const zip = new JSZip();
    zip.file(
      "pass.json",
      JSON.stringify({
        organizationName: "Stellar Air",
        generic: { primaryFields: [{ key: "ref", label: "Ref", value: "DISPATCH-OK" }] },
      }),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const result = await extractAttachmentText(bytes, "application/vnd.apple.pkpass");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("DISPATCH-OK");
  });

  test("dispatches application/vnd.apple.pkpasses (bundle) to the pkpass extractor", async () => {
    const inner = new JSZip();
    inner.file(
      "pass.json",
      JSON.stringify({
        organizationName: "Stellar Air",
        generic: { primaryFields: [{ key: "ref", label: "Ref", value: "BUNDLE-OK" }] },
      }),
    );
    const innerBytes = await inner.generateAsync({ type: "uint8array" });
    const bundle = new JSZip();
    bundle.file("a.pkpass", innerBytes);
    const bytes = await bundle.generateAsync({ type: "uint8array" });
    const result = await extractAttachmentText(bytes, "application/vnd.apple.pkpasses");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("BUNDLE-OK");
  });

  test("pkpass dispatch honors a MIME parameter suffix", async () => {
    const zip = new JSZip();
    zip.file(
      "pass.json",
      JSON.stringify({
        organizationName: "Stellar Air",
        generic: { primaryFields: [{ key: "ref", label: "Ref", value: "PARAM-OK" }] },
      }),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const result = await extractAttachmentText(
      bytes,
      "application/vnd.apple.pkpass; charset=binary",
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("PARAM-OK");
  });

  // Empty data for all types returns null
  test("returns null for empty data across all types", async () => {
    const empty = new Uint8Array(0);
    const types = [
      "text/plain",
      "text/csv",
      "text/html",
      "text/markdown",
      "application/json",
      "text/calendar",
      "message/rfc822",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.ms-excel",
      "application/x-msexcel",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/rtf",
      "text/rtf",
      "application/vnd.apple.pkpass",
      "application/vnd.apple.pkpasses",
    ];
    for (const type of types) {
      const result = await extractAttachmentText(empty, type);
      expect(result).toBeNull();
    }
  });
});
