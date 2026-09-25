// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import * as CFB from "cfb";
import { extractLegacyOfficeText } from "./extract-legacy-office.js";

const DOC_MIME = "application/msword";
const XLS_MIME = "application/vnd.ms-excel";
const XLS_ALT_MIME = "application/x-msexcel";
const PPT_MIME = "application/vnd.ms-powerpoint";

describe("extractLegacyOfficeText — DOC", () => {
  test("recovers text runs from an OLE WordDocument stream", async () => {
    const data = oleFile({
      WordDocument: concat([
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        utf16("legacy doc planning memo\nbudget owner: unit alpha"),
      ]),
    });

    const result = await extractLegacyOfficeText(data, DOC_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("legacy doc planning memo");
    expect(result!.text).toContain("budget owner: unit alpha");
    expect(result!.truncated).toBe(false);
  });

  test("truncates recovered Word text", async () => {
    const data = oleFile({ WordDocument: utf16("legacy doc " + "content ".repeat(40)) });
    const result = await extractLegacyOfficeText(data, DOC_MIME, { maxTextLength: 48 });

    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(48);
    expect(result!.truncated).toBe(true);
  });

  test("corrupt Word bytes return null", async () => {
    const result = await extractLegacyOfficeText(new Uint8Array([1, 2, 3, 4]), DOC_MIME);
    expect(result).toBeNull();
  });
});

describe("extractLegacyOfficeText — XLS", () => {
  test("renders BIFF shared-string cells as CSV with sheet headers", async () => {
    const data = createXls({
      name: "Inventory",
      rows: [
        ["Item", "Count"],
        ["Notebook", "7"],
        ["Lamp", "3"],
      ],
    });

    const result = await extractLegacyOfficeText(data, XLS_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("## Sheet: Inventory");
    expect(result!.text).toContain("Item,Count");
    expect(result!.text).toContain("Notebook,7");
    expect(result!.text).toContain("Lamp,3");
    expect(result!.pages).toBe(1);
    expect(result!.truncated).toBe(false);
  });

  test("routes application/x-msexcel through the same BIFF parser", async () => {
    const data = createXls({ name: "Summary", rows: [["Metric", "Value"]] });
    const result = await extractLegacyOfficeText(data, XLS_ALT_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Metric,Value");
  });

  test("reads shared strings continued into BIFF CONTINUE records", async () => {
    const text = "continued shared string checkpoint for team alpha";
    const data = createXlsWithContinuedSst({ name: "LongStrings", value: text });

    const result = await extractLegacyOfficeText(data, XLS_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain(text);
  });

  test("corrupt spreadsheet bytes return null", async () => {
    const result = await extractLegacyOfficeText(new Uint8Array([0xca, 0xfe]), XLS_MIME);
    expect(result).toBeNull();
  });
});

describe("extractLegacyOfficeText — PPT", () => {
  test("extracts text atoms from a PowerPoint Document stream", async () => {
    const data = oleFile({
      "PowerPoint Document": concat([
        pptTextCharsAtom("Quarterly roadmap"),
        pptTextBytesAtom("pilot group: unit beta"),
      ]),
    });

    const result = await extractLegacyOfficeText(data, PPT_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Quarterly roadmap");
    expect(result!.text).toContain("pilot group: unit beta");
    expect(result!.truncated).toBe(false);
  });

  test("falls back to printable OLE text runs for non-atom streams", async () => {
    const data = oleFile({
      "PowerPoint Document": utf16("fallback slide text for sample venue"),
    });

    const result = await extractLegacyOfficeText(data, PPT_MIME);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("fallback slide text for sample venue");
  });

  test("corrupt presentation bytes return null", async () => {
    const result = await extractLegacyOfficeText(new Uint8Array([0xba, 0xad]), PPT_MIME);
    expect(result).toBeNull();
  });
});

describe("extractLegacyOfficeText — dispatch", () => {
  test("zero-byte data returns null", async () => {
    expect(await extractLegacyOfficeText(new Uint8Array(0), DOC_MIME)).toBeNull();
    expect(await extractLegacyOfficeText(new Uint8Array(0), XLS_MIME)).toBeNull();
    expect(await extractLegacyOfficeText(new Uint8Array(0), PPT_MIME)).toBeNull();
  });

  test("unknown MIME type returns null", async () => {
    const data = oleFile({ WordDocument: utf16("hello") });
    expect(await extractLegacyOfficeText(data, "application/octet-stream")).toBeNull();
  });
});

function oleFile(entries: Record<string, Uint8Array>): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(entries)) {
    CFB.utils.cfb_add(cfb, name, Buffer.from(content));
  }
  return CFB.write(cfb, { type: "buffer" }) as Buffer;
}

function createXls(sheet: { name: string; rows: string[][] }): Uint8Array {
  const strings = sheet.rows.flat();
  const stringIndexes = new Map<string, number>();
  for (const value of strings) {
    if (!stringIndexes.has(value)) stringIndexes.set(value, stringIndexes.size);
  }

  const sharedStrings = Array.from(stringIndexes.keys());
  const sheetRecords = [
    biffRecord(0x0809, new Uint8Array(16)),
    ...sheet.rows.flatMap((row, rowIndex) =>
      row.map((value, columnIndex) =>
        biffRecord(0x00fd, labelSst(rowIndex, columnIndex, stringIndexes.get(value) ?? 0)),
      ),
    ),
    biffRecord(0x000a, new Uint8Array(0)),
  ];

  let globalRecords = [
    biffRecord(0x0809, new Uint8Array(16)),
    biffRecord(0x00fc, sst(sharedStrings, strings.length)),
    biffRecord(0x0085, boundSheet(0, sheet.name)),
    biffRecord(0x000a, new Uint8Array(0)),
  ];
  const sheetOffset = concat(globalRecords).length;
  globalRecords = [
    biffRecord(0x0809, new Uint8Array(16)),
    biffRecord(0x00fc, sst(sharedStrings, strings.length)),
    biffRecord(0x0085, boundSheet(sheetOffset, sheet.name)),
    biffRecord(0x000a, new Uint8Array(0)),
  ];

  return oleFile({ Workbook: concat([...globalRecords, ...sheetRecords]) });
}

function createXlsWithContinuedSst(sheet: { name: string; value: string }): Uint8Array {
  const textBytes = utf16(sheet.value);
  const stringHeader = new Uint8Array(3);
  writeU16(stringHeader, 0, sheet.value.length);
  stringHeader[2] = 0x01;

  const splitAt = 18;
  const sstFirstRecord = concat([u32(1), u32(1), stringHeader, textBytes.slice(0, splitAt)]);
  const sstContinueRecord = concat([new Uint8Array([0x01]), textBytes.slice(splitAt)]);

  const sheetRecords = [
    biffRecord(0x0809, new Uint8Array(16)),
    biffRecord(0x00fd, labelSst(0, 0, 0)),
    biffRecord(0x000a, new Uint8Array(0)),
  ];

  const makeGlobalRecords = (sheetOffset: number) => [
    biffRecord(0x0809, new Uint8Array(16)),
    biffRecord(0x00fc, sstFirstRecord),
    biffRecord(0x003c, sstContinueRecord),
    biffRecord(0x0085, boundSheet(sheetOffset, sheet.name)),
    biffRecord(0x000a, new Uint8Array(0)),
  ];

  let globalRecords = makeGlobalRecords(0);
  globalRecords = makeGlobalRecords(concat(globalRecords).length);
  return oleFile({ Workbook: concat([...globalRecords, ...sheetRecords]) });
}

function biffRecord(type: number, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  writeU16(header, 0, type);
  writeU16(header, 2, data.length);
  return concat([header, data]);
}

function boundSheet(offset: number, name: string): Uint8Array {
  const nameBytes = utf16(name);
  const data = new Uint8Array(8 + nameBytes.length);
  writeU32(data, 0, offset);
  data[6] = name.length;
  data[7] = 0x01;
  data.set(nameBytes, 8);
  return data;
}

function sst(strings: string[], totalRefs: number): Uint8Array {
  const parts: Uint8Array[] = [u32(totalRefs), u32(strings.length)];
  for (const value of strings) parts.push(biffString(value));
  return concat(parts);
}

function biffString(value: string): Uint8Array {
  const text = utf16(value);
  const data = new Uint8Array(3 + text.length);
  writeU16(data, 0, value.length);
  data[2] = 0x01;
  data.set(text, 3);
  return data;
}

function labelSst(row: number, column: number, sstIndex: number): Uint8Array {
  const data = new Uint8Array(10);
  writeU16(data, 0, row);
  writeU16(data, 2, column);
  writeU16(data, 4, 0);
  writeU32(data, 6, sstIndex);
  return data;
}

function pptTextCharsAtom(text: string): Uint8Array {
  return pptRecord(0x0fa0, utf16(text));
}

function pptTextBytesAtom(text: string): Uint8Array {
  return pptRecord(0x0fa8, new TextEncoder().encode(text));
}

function pptRecord(type: number, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  writeU16(header, 2, type);
  writeU32(header, 4, data.length);
  return concat([header, data]);
}

function utf16(text: string): Uint8Array {
  return Buffer.from(text, "utf16le");
}

function u32(value: number): Uint8Array {
  const data = new Uint8Array(4);
  writeU32(data, 0, value);
  return data;
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
