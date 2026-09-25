// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import JSZip from "jszip";
import { extractOpenDocumentText } from "./extract-opendocument.js";

const ODT_MIME = "application/vnd.oasis.opendocument.text";
const ODS_MIME = "application/vnd.oasis.opendocument.spreadsheet";
const ODP_MIME = "application/vnd.oasis.opendocument.presentation";

describe("extractOpenDocumentText — ODT", () => {
  test("extracts headings and paragraphs from content.xml", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body>
          <office:text>
            <text:h>project notes</text:h>
            <text:p>owner: unit alpha</text:p>
            <text:p>Next checkpoint is Friday.</text:p>
          </office:text>
        </office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODT_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("project notes");
    expect(result!.text).toContain("owner: unit alpha");
    expect(result!.text).toContain("Next checkpoint is Friday.");
    expect(result!.truncated).toBe(false);
  });

  test("truncates long text documents", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body><office:text><text:p>${"odt text ".repeat(80)}</text:p></office:text></office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODT_MIME, { maxTextLength: 40 });

    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(40);
    expect(result!.truncated).toBe(true);
  });

  test("rejects content.xml above the decompressed size cap", async () => {
    const data = await odfZip("x".repeat(5_000_100));

    await expect(extractOpenDocumentText(data, ODT_MIME)).resolves.toBeNull();
  });
});

describe("extractOpenDocumentText — ODS", () => {
  test("renders spreadsheet tables as CSV with sheet headers", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body>
          <office:spreadsheet>
            <table:table table:name="Budget">
              <table:table-row>
                <table:table-cell><text:p>Category</text:p></table:table-cell>
                <table:table-cell><text:p>Amount</text:p></table:table-cell>
              </table:table-row>
              <table:table-row>
                <table:table-cell><text:p>Research</text:p></table:table-cell>
                <table:table-cell office:value="1200"/>
              </table:table-row>
            </table:table>
          </office:spreadsheet>
        </office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODS_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Sheet: Budget");
    expect(result!.text).toContain("Category,Amount");
    expect(result!.text).toContain("Research,1200");
    expect(result!.pages).toBe(1);
  });

  test("expands small repeated columns", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body><office:spreadsheet>
          <table:table table:name="Repeats">
            <table:table-row>
              <table:table-cell table:number-columns-repeated="2"><text:p>Yes</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODS_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Yes,Yes");
  });

  test("truncates repeated spreadsheet rows at maxTextLength", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body><office:spreadsheet>
          <table:table table:name="Repeats">
            <table:table-row table:number-rows-repeated="1000">
              <table:table-cell><text:p>Repeated planning note</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODS_MIME, { maxTextLength: 72 });

    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(72);
    expect(result!.truncated).toBe(true);
  });
});

describe("extractOpenDocumentText — ODP", () => {
  test("extracts slide text in order", async () => {
    const data = await odfZip(`
      <office:document-content ${namespaces()}>
        <office:body>
          <office:presentation>
            <draw:page draw:name="Opening"><text:p>Launch review</text:p></draw:page>
            <draw:page draw:name="Plan"><text:p>Milestone map</text:p></draw:page>
          </office:presentation>
        </office:body>
      </office:document-content>`);

    const result = await extractOpenDocumentText(data, ODP_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Slide 1: Opening");
    expect(result!.text).toContain("Launch review");
    expect(result!.text.indexOf("Launch review")).toBeLessThan(
      result!.text.indexOf("Milestone map"),
    );
    expect(result!.pages).toBe(2);
  });
});

describe("extractOpenDocumentText — dispatch", () => {
  test("missing content.xml returns null", async () => {
    const zip = new JSZip();
    zip.file("mimetype", ODT_MIME);
    const data = await zip.generateAsync({ type: "uint8array" });
    expect(await extractOpenDocumentText(data, ODT_MIME)).toBeNull();
  });

  test("corrupt zip bytes return null", async () => {
    expect(await extractOpenDocumentText(new Uint8Array([1, 2, 3]), ODT_MIME)).toBeNull();
  });

  test("zero-byte data returns null", async () => {
    expect(await extractOpenDocumentText(new Uint8Array(0), ODT_MIME)).toBeNull();
    expect(await extractOpenDocumentText(new Uint8Array(0), ODS_MIME)).toBeNull();
    expect(await extractOpenDocumentText(new Uint8Array(0), ODP_MIME)).toBeNull();
  });
});

async function odfZip(contentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("content.xml", contentXml);
  return zip.generateAsync({ type: "uint8array" });
}

function namespaces(): string {
  return [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  ].join(" ");
}
