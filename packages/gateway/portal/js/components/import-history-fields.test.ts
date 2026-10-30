// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript.
import * as importHistoryFields from "./import-history-fields.js";

const { visibleImportFields, hasMissingRequired, importValues } = importHistoryFields;

const FIELDS = [
  {
    key: "kind",
    label: "Kind",
    type: "select",
    required: true,
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
  { key: "aPath", label: "A path", type: "file", required: true, when: { field: "kind", equals: "a" } },
  { key: "bPath", label: "B path", type: "directory", required: true, when: { field: "kind", equals: "b" } },
  { key: "bSecret", label: "B secret", type: "secret", required: true, when: { field: "kind", equals: "b" } },
  { key: "note", label: "Note", type: "string" },
];

const keys = (fields: Array<{ key: string }>) => fields.map((f) => f.key);

describe("history-import form fields", () => {
  it("shows only the unconditional fields until the variant is chosen", () => {
    expect(keys(visibleImportFields(FIELDS, { kind: "" }))).toEqual(["kind", "note"]);
  });

  it("shows exactly the chosen variant's fields", () => {
    expect(keys(visibleImportFields(FIELDS, { kind: "a" }))).toEqual(["kind", "aPath", "note"]);
    expect(keys(visibleImportFields(FIELDS, { kind: "b" }))).toEqual(["kind", "bPath", "bSecret", "note"]);
  });

  it("requires only the visible fields", () => {
    expect(hasMissingRequired(FIELDS, { kind: "" })).toBe(true);
    expect(hasMissingRequired(FIELDS, { kind: "a", aPath: "/x/backup" })).toBe(false);
    expect(hasMissingRequired(FIELDS, { kind: "b", bPath: "/x/dir", bSecret: "  " })).toBe(true);
  });

  it("sends the trimmed visible values and drops the other variant's", () => {
    expect(
      importValues(FIELDS, { kind: "a", aPath: " /x/backup ", bPath: "/stale", bSecret: "s", note: "" }),
    ).toEqual({ kind: "a", aPath: "/x/backup", note: "" });
  });
});
