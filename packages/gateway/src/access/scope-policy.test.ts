// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shape a saved filter takes, the spelling its typed identifiers are
 * saved in, and the check of every entry against what the source declares.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOURCE_FILTER_MAX_ENTRIES,
  canonicalSourceFilters,
  parseSourceFilter,
  sourceFilterEntryCount,
  sourceFilterSchema,
} from "./scope-policy.js";
import { filterFieldsFor, type SourceFilterFields } from "./filter-fields.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  directory,
  label,
  openFilterFixture,
  person,
  publishProfile,
  type FilterFixture,
} from "./filter-test-utils.js";
import type { SourceFilter } from "@omnesis/types";

const SOURCE = "ledger:fictional-account";

const policy = {
  sourceId: SOURCE,
  audience: { accessLevel: "fictional-level", capability: "direct" },
  rules: [
    { match: [{ capability: "membership", field: "extra.labelIds", id: "L-1" }], action: "share" },
  ],
  otherwise: "hide",
};

let fixture: FilterFixture;
let fields: SourceFilterFields;

beforeEach(() => {
  fixture = openFilterFixture();
  publishProfile(fixture.db, "ledger", 5, LEDGER_PROFILE);
  fields = filterFieldsFor(fixture.db, "ledger");
});

afterEach(() => fixture.close());

function withEntries(match: unknown[], action: "share" | "hide" = "hide") {
  return { ...policy, rules: [{ action, match }], otherwise: action === "hide" ? "share" : "hide" };
}

function personEntry(...identifiers: Array<{ type: string; value: string }>) {
  return { capability: "person", label: "Fictional contact", identifiers };
}

describe("the saved filter's shape", () => {
  it("accepts a share-only filter and a hide filter mixing every capability", () => {
    expect(parseSourceFilter(policy, fields)).toEqual(policy);
    const hidden = withEntries([
      { capability: "membership", field: "extra.labelIds", id: "L-1" },
      { capability: "tree", field: "extra.folderIds", id: "finance" },
      { capability: "tree", field: "extra.directory", id: "/home/maya/work", device: "dev-1" },
      { capability: "tree", field: "extra.directory", id: "", device: "dev-2" },
      personEntry({ type: "phone", value: "+15550100123" }),
    ]);
    expect(parseSourceFilter(hidden, fields)).toEqual(hidden);
  });

  it.each([
    { ...policy, maxAge: "90d" },
    { ...policy, audience: "keep" },
    { ...policy, audience: { accessLevel: "fictional-level", capability: "notes" } },
    { ...policy, rules: [...policy.rules, ...policy.rules] },
    { ...policy, rules: [] },
    { ...policy, otherwise: "share" },
    ...["ask", "keep", "drop"].map((action) => ({
      ...policy,
      rules: [{ ...policy.rules[0], action }],
    })),
    { ...policy, unexpected: true },
    withEntries([{ kind: "conversation", id: "chat-1" }]),
    withEntries([{ capability: "membership", field: "extra.labelIds", id: "L-1", extra: 1 }]),
    withEntries([{ capability: "membership", field: "extra.labelIds", id: "   " }]),
    withEntries([{ capability: "membership", field: "extra.labelIds", id: "" }]),
    withEntries([{ capability: "membership", field: "", id: "L-1" }]),
    withEntries([personEntry()]),
    withEntries([{ ...personEntry({ type: "phone", value: "+15550100123" }), label: " " }]),
  ])("refuses a shape it does not save (%j)", (input) => {
    expect(sourceFilterSchema.safeParse(input).success).toBe(false);
  });

  it("keeps an id exactly as the source wrote it, and accepts an empty list", () => {
    const input = withEntries([{ capability: "membership", field: "extra.labelIds", id: " ID " }]);
    expect(parseSourceFilter(input, fields).rules[0].match[0]).toEqual({
      capability: "membership",
      field: "extra.labelIds",
      id: " ID ",
    });
    expect(sourceFilterSchema.safeParse(withEntries([], "share")).success).toBe(true);
  });

  it("counts each identifier of a person entry against the limit", () => {
    const identifiers = Array.from({ length: 129 }, (_unused, index) => ({
      type: "phone",
      value: `+1555010${String(index).padStart(4, "0")}`,
    }));
    const entry = { capability: "person", label: "Contact", identifiers };
    expect(sourceFilterEntryCount([withEntries([entry]) as unknown as SourceFilter])).toBe(129);
    expect(sourceFilterSchema.safeParse(withEntries([entry, entry])).success).toBe(false);
    const items = Array.from({ length: SOURCE_FILTER_MAX_ENTRIES + 1 }, (_unused, index) =>
      label(`L-${index}`),
    );
    expect(sourceFilterSchema.safeParse(withEntries(items)).success).toBe(false);
    expect(sourceFilterSchema.safeParse(withEntries(items.slice(1))).success).toBe(true);
  });
});

describe("entries checked against the source's declaration", () => {
  it.each([
    ["a field the source does not declare", { capability: "membership", field: "x", id: "a" }],
    ["the wrong capability", { capability: "tree", field: "extra.labelIds", id: "L-1" }],
    ["no device on a per-device field", { capability: "tree", field: "extra.directory", id: "a" }],
    ["a device on a field shared by every device", { ...label("L-1"), device: "dev-1" }],
    ["a whole device on a field shared by every device", { ...label(""), device: "dev-1" }],
  ])("refuses %s", (_name, entry) => {
    const input = withEntries([entry]);
    expect(sourceFilterSchema.safeParse(input).success).toBe(true);
    expect(() => parseSourceFilter(input, fields)).toThrow(/cannot be applied to this source/);
  });

  it("refuses every entry of a source that declares nothing filterable", () => {
    expect(() => parseSourceFilter(policy, { state: "no-profile" })).toThrow(/cannot be applied/);
    expect(() => parseSourceFilter(policy, { state: "collector-behind" })).toThrow(
      /cannot be applied/,
    );
  });

  it("refuses an identifier type the source does not write", () => {
    publishProfile(fixture.db, "parley", 1, PARLEY_PROFILE);
    const phonesOnly = filterFieldsFor(fixture.db, "parley");
    const byEmail = withEntries([personEntry({ type: "email", value: "maya@example.org" })]);
    const byPhone = withEntries([personEntry({ type: "phone", value: "+15550100123" })]);
    expect(() => parseSourceFilter(byEmail, phonesOnly)).toThrow(/cannot be applied/);
    expect(() => parseSourceFilter(byPhone, phonesOnly)).not.toThrow();
    expect(() => parseSourceFilter(byEmail, fields)).not.toThrow();
  });
});

describe("typed identifiers", () => {
  it("saves the spelling the gateway compares, however the identifier was typed", () => {
    const parsed = parseSourceFilter(
      withEntries([
        personEntry(
          { type: "phone", value: "+1 (555) 010-0123" },
          { type: "phone", value: "0015550100124" },
          { type: "phone", value: "tel:+1-555-010-0125" },
          { type: "email", value: "Fictional Contact <Contact@Example.ORG>" },
          { type: "email", value: "mailto:fictional.scope.check+filter@gmail.com" },
          { type: "domain", value: "@Example.ORG" },
        ),
      ]),
      fields,
    );
    expect(parsed.rules[0].match[0]).toEqual({
      capability: "person",
      label: "Fictional contact",
      identifiers: [
        { type: "phone", value: "+15550100123" },
        { type: "phone", value: "+15550100124" },
        { type: "phone", value: "+15550100125" },
        { type: "email", value: "contact@example.org" },
        { type: "email", value: "fictionalscopecheck@gmail.com" },
        { type: "domain", value: "example.org" },
      ],
    });
  });

  it.each(["opaque@lid", "15550100123", "+12", "(555) 010-0123", "+44 (0)7700 900123"])(
    "refuses the phone number %s",
    (value) => {
      const result = sourceFilterSchema.safeParse(
        withEntries([personEntry({ type: "phone", value })]),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("international country code");
    },
  );

  it.each(["example..org", "example.org/path", "*.example.org", "example.org.evil/", "localhost"])(
    "refuses the domain %s",
    (value) => {
      expect(
        sourceFilterSchema.safeParse(withEntries([personEntry({ type: "domain", value })])).success,
      ).toBe(false);
    },
  );
});

describe("canonical order", () => {
  it("orders accounts and entries without touching the caller's filters or the identifiers", () => {
    const input: SourceFilter[] = [
      {
        sourceId: "second",
        audience: { accessLevel: "level", capability: "direct" },
        rules: [
          {
            action: "hide",
            match: [
              person("Contact", ["phone", "+15550100123"], ["email", "contact@example.org"]),
              label("L-9"),
              directory("dev-1", "/home/maya/work"),
            ],
          },
        ],
        otherwise: "share",
      },
      {
        sourceId: "first",
        audience: { accessLevel: "level", capability: "direct" },
        rules: [{ action: "share", match: [] }],
        otherwise: "hide",
      },
    ];
    const before = JSON.stringify(input);
    const canonical = canonicalSourceFilters(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(canonical.map((filter) => filter.sourceId)).toEqual(["first", "second"]);
    const entries = canonical[1]!.rules[0].match;
    expect(entries.map((entry) => entry.capability)).toEqual(["membership", "person", "tree"]);
    expect(entries[1]).toEqual({
      capability: "person",
      label: "Contact",
      identifiers: [
        { type: "email", value: "contact@example.org" },
        { type: "phone", value: "+15550100123" },
      ],
    });
    expect(canonicalSourceFilters(canonical)).toEqual(canonical);
  });
});
