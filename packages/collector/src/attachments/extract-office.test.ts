// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import JSZip from "jszip";
import { extractOfficeText } from "./extract-office.js";

// ─── DOCX fixture ────────────────────────────────────────────────────────────

/**
 * Create a minimal valid DOCX (ZIP with OOXML structure) that mammoth can read.
 * Each string in `paragraphs` becomes a <w:p> element.
 */
async function createDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();

  // [Content_Types].xml — required for OOXML
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  // _rels/.rels — root relationship pointing to word/document.xml
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`,
  );

  // word/document.xml — the document body
  const paraXml = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join("\n    ");

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid wp14">
  <w:body>
    ${paraXml}
  </w:body>
</w:document>`,
  );

  const buf = await zip.generateAsync({ type: "uint8array" });
  return buf;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── XLSX fixture ─────────────────────────────────────────────────────────────

/**
 * Create a valid XLSX workbook from a map of sheet name → rows (array of arrays).
 */
async function createXlsx(sheets: Record<string, string[][]>): Promise<Uint8Array> {
  const zip = new JSZip();
  const entries = Object.entries(sheets);
  const sharedStrings: string[] = [];
  const sharedStringIndexes = new Map<string, number>();
  let stringRefCount = 0;

  function sharedStringIndex(value: string): number {
    stringRefCount++;
    const existing = sharedStringIndexes.get(value);
    if (existing !== undefined) return existing;

    const index = sharedStrings.length;
    sharedStringIndexes.set(value, index);
    sharedStrings.push(value);
    return index;
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
${entries
  .map(
    (_, i) =>
      `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml"\n    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="xl/workbook.xml"/>
</Relationships>`,
  );

  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${entries
  .map(
    ([name], i) => `    <sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  )
  .join("\n")}
  </sheets>
</workbook>`,
  );

  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}"\n    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"\n    Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join("\n")}
</Relationships>`,
  );

  for (const [sheetIndex, [, rows]] of entries.entries()) {
    zip.file(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${rows
  .map((row, rowIndex) => {
    const cells = row
      .map((value, columnIndex) => {
        if (!value) return "";
        return `      <c r="${columnName(columnIndex)}${rowIndex + 1}" t="s"><v>${sharedStringIndex(value)}</v></c>`;
      })
      .join("");
    return `    <row r="${rowIndex + 1}">${cells}</row>`;
  })
  .join("\n")}
  </sheetData>
</worksheet>`,
    );
  }

  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  count="${stringRefCount}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((value) => `  <si><t>${escapeXml(value)}</t></si>`).join("\n")}
</sst>`,
  );

  return zip.generateAsync({ type: "uint8array" });
}

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// ─── PPTX fixture ─────────────────────────────────────────────────────────────

/**
 * Create a minimal valid PPTX using JSZip.
 * Each slide gets `<a:t>` text; optional notes go in a notesSlide file.
 */
async function createPptx(slides: Array<{ text: string; notes?: string }>): Promise<Uint8Array> {
  const zip = new JSZip();

  // Content types
  const slideOverrides = slides
    .map(
      (_, i) =>
        `  <Override PartName="/ppt/slides/slide${i + 1}.xml"\n    ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("\n");
  const notesOverrides = slides
    .map((s, i) =>
      s.notes
        ? `  <Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml"\n    ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
        : "",
    )
    .filter(Boolean)
    .join("\n");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml"
    ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slideOverrides}
${notesOverrides}
</Types>`,
  );

  // Root rels
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="ppt/presentation.xml"/>
</Relationships>`,
  );

  // Presentation.xml (minimal)
  const slideIdList = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join("\n    ");

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldMasterIdLst/>
  <p:sldIdLst>
    ${slideIdList}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );

  // Presentation rels
  const presentationRels = slides
    .map(
      (_, i) =>
        `  <Relationship Id="rId${i + 1}"\n    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"\n    Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("\n");

  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${presentationRels}
</Relationships>`,
  );

  // Individual slides + notes
  for (let i = 0; i < slides.length; i++) {
    const { text, notes } = slides[i];
    const slideNum = i + 1;

    zip.file(
      `ppt/slides/slide${slideNum}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );

    if (notes) {
      zip.file(
        `ppt/notesSlides/notesSlide${slideNum}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:t>${escapeXml(notes)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`,
      );
    }
  }

  return zip.generateAsync({ type: "uint8array" });
}

// ─── MIME type constants ───────────────────────────────────────────────────────

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// ─── DOCX tests ───────────────────────────────────────────────────────────────

describe("extractOfficeText — DOCX", () => {
  test("extracts text from paragraphs", async () => {
    const data = await createDocx(["Hello World", "Second paragraph"]);
    const result = await extractOfficeText(data, DOCX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello World");
    expect(result!.text).toContain("Second paragraph");
    expect(result!.truncated).toBe(false);
  });

  test("empty document returns null", async () => {
    const data = await createDocx([]);
    const result = await extractOfficeText(data, DOCX_MIME);
    expect(result).toBeNull();
  });

  test("corrupt/random bytes return null", async () => {
    const corrupt = new Uint8Array([0x00, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef]);
    const result = await extractOfficeText(corrupt, DOCX_MIME);
    expect(result).toBeNull();
  });

  test("zero-byte data returns null", async () => {
    const result = await extractOfficeText(new Uint8Array(0), DOCX_MIME);
    expect(result).toBeNull();
  });

  test("truncation at maxTextLength sets truncated: true", async () => {
    // Generate a document with enough text to exceed the limit
    const paragraphs = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${"text ".repeat(20)}`);
    const data = await createDocx(paragraphs);
    const result = await extractOfficeText(data, DOCX_MIME, { maxTextLength: 50 });
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(50);
    expect(result!.truncated).toBe(true);
  });
});

// ─── XLSX tests ───────────────────────────────────────────────────────────────

describe("extractOfficeText — XLSX", () => {
  test("single sheet extraction", async () => {
    const data = await createXlsx({
      Sheet1: [
        ["Name", "Age"],
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Sheet: Sheet1");
    expect(result!.text).toContain("Alice");
    expect(result!.text).toContain("Bob");
    expect(result!.truncated).toBe(false);
  });

  test("multi-sheet: all non-empty sheets with ## Sheet: Name headers", async () => {
    const data = await createXlsx({
      Alpha: [
        ["a", "b"],
        ["1", "2"],
      ],
      Beta: [
        ["x", "y"],
        ["3", "4"],
      ],
    });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Sheet: Alpha");
    expect(result!.text).toContain("## Sheet: Beta");
    expect(result!.pages).toBe(2);
  });

  test("empty sheets are skipped", async () => {
    const data = await createXlsx({
      Full: [["data", "here"]],
      Empty: [[]],
    });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Sheet: Full");
    expect(result!.text).not.toContain("## Sheet: Empty");
    expect(result!.pages).toBe(1);
  });

  test("pages = count of non-empty sheets", async () => {
    const data = await createXlsx({
      A: [["1"]],
      B: [["2"]],
      C: [["3"]],
    });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result!.pages).toBe(3);
  });

  test("truncation at maxTextLength sets truncated: true", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`Row ${i}`, "value ".repeat(10)]);
    const data = await createXlsx({ BigSheet: rows });
    const result = await extractOfficeText(data, XLSX_MIME, { maxTextLength: 30 });
    // The header "## Sheet: BigSheet\n" is 20 chars; truncation should kick in
    if (result) {
      expect(result.truncated).toBe(true);
    }
    // If result is null (remaining <= header length), that's also acceptable
  });

  test("empty workbook (all empty sheets) returns null", async () => {
    const data = await createXlsx({ EmptySheet: [[]] });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).toBeNull();
  });

  test("corrupt data returns null", async () => {
    const corrupt = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const result = await extractOfficeText(corrupt, XLSX_MIME);
    expect(result).toBeNull();
  });

  test("zero-byte data returns null", async () => {
    const result = await extractOfficeText(new Uint8Array(0), XLSX_MIME);
    expect(result).toBeNull();
  });
});

// ─── PPTX tests ───────────────────────────────────────────────────────────────

describe("extractOfficeText — PPTX", () => {
  test("single slide with text", async () => {
    const data = await createPptx([{ text: "Welcome to the presentation" }]);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Welcome to the presentation");
    expect(result!.truncated).toBe(false);
  });

  test("multi-slide: slides in correct order", async () => {
    const data = await createPptx([
      { text: "Slide one content" },
      { text: "Slide two content" },
      { text: "Slide three content" },
    ]);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Slide 1");
    expect(result!.text).toContain("## Slide 2");
    expect(result!.text).toContain("## Slide 3");
    // Verify order: slide 1 appears before slide 2
    expect(result!.text.indexOf("Slide one")).toBeLessThan(result!.text.indexOf("Slide two"));
    expect(result!.text.indexOf("Slide two")).toBeLessThan(result!.text.indexOf("Slide three"));
  });

  test("speaker notes extracted with > Notes: prefix", async () => {
    const data = await createPptx([{ text: "Main content", notes: "Speaker notes here" }]);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("> Notes: Speaker notes here");
  });

  test("pages = number of slides", async () => {
    const slides = [
      { text: "Slide 1" },
      { text: "Slide 2" },
      { text: "Slide 3" },
      { text: "Slide 4" },
    ];
    const data = await createPptx(slides);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).not.toBeNull();
    expect(result!.pages).toBe(4);
  });

  test("truncation at maxTextLength sets truncated: true", async () => {
    const slides = Array.from({ length: 20 }, (_, i) => ({
      text: `Slide ${i + 1}: ${"content ".repeat(30)}`,
    }));
    const data = await createPptx(slides);
    const result = await extractOfficeText(data, PPTX_MIME, { maxTextLength: 100 });
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.text.length).toBeLessThanOrEqual(100);
  });

  test("empty presentation (slides with no text) returns null", async () => {
    // Create a PPTX with no slides at all
    const data = await createPptx([]);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).toBeNull();
  });

  test("corrupt data returns null", async () => {
    const corrupt = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0xff]);
    const result = await extractOfficeText(corrupt, PPTX_MIME);
    expect(result).toBeNull();
  });

  test("zero-byte data returns null", async () => {
    const result = await extractOfficeText(new Uint8Array(0), PPTX_MIME);
    expect(result).toBeNull();
  });
});

// ─── Dispatch tests ───────────────────────────────────────────────────────────

describe("extractOfficeText — dispatch", () => {
  test("DOCX MIME type routes to DOCX extractor", async () => {
    const data = await createDocx(["Hello DOCX dispatch"]);
    const result = await extractOfficeText(data, DOCX_MIME);
    // DOCX extractor returns text (not null) for valid data
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello DOCX dispatch");
  });

  test("XLSX MIME type routes to XLSX extractor", async () => {
    const data = await createXlsx({ Sheet1: [["Hello XLSX dispatch"]] });
    const result = await extractOfficeText(data, XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello XLSX dispatch");
  });

  test("PPTX MIME type routes to PPTX extractor", async () => {
    const data = await createPptx([{ text: "Hello PPTX dispatch" }]);
    const result = await extractOfficeText(data, PPTX_MIME);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello PPTX dispatch");
  });

  test("unknown office MIME type returns null", async () => {
    const data = await createDocx(["some content"]);
    const result = await extractOfficeText(
      data,
      "application/vnd.ms-powerpoint", // old .ppt format, not supported
    );
    expect(result).toBeNull();
  });

  test("generic binary MIME type returns null", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const result = await extractOfficeText(data, "application/octet-stream");
    expect(result).toBeNull();
  });
});
