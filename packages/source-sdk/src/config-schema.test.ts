// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, expectTypeOf, test } from "vitest";
import {
  boolean,
  formatConfigIssues,
  list,
  number,
  object,
  path,
  secret,
  select,
  string,
  toSourceParams,
  hostConfigIssues,
  resolveDeclaredPaths,
  fieldValidator,
} from "./config-schema.js";

/** A vault source, shaped like the real one that motivated this. */
const vaultSchema = object({
  vaultPath: path({ label: "Vault path", required: true, scope: "member" }),
  // The field the old form could not express, so it lived only in a
  // hand-edited config file and nowhere in the interface.
  exclude: list(string({ label: "Pattern" }), { label: "Exclude", default: [] }),
  followSymlinks: boolean({ label: "Follow symlinks", default: false }),
});

describe("the parsed type", () => {
  test("a required field and a defaulted field are always present", () => {
    const parsed = vaultSchema.parse({ vaultPath: "/notes" });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expectTypeOf(parsed.value.vaultPath).toEqualTypeOf<string>();
    expectTypeOf(parsed.value.exclude).toEqualTypeOf<string[]>();
    expectTypeOf(parsed.value.followSymlinks).toEqualTypeOf<boolean>();
    // No cast at the call site, which is the point.
    expect(parsed.value).toEqual({ vaultPath: "/notes", exclude: [], followSymlinks: false });
  });

  test("a list of paths splits on newlines only, because a comma is a legal filename", () => {
    const schema = object({ roots: list(path({ label: "Root" }), { label: "Roots" }) });
    const parsed = schema.parse({ roots: "~/Invoices, Receipts\n/srv/docs" });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expect(parsed.value.roots).toEqual(["~/Invoices, Receipts", "/srv/docs"]);
  });

  test("a list of anything else still splits on commas", () => {
    const parsed = vaultSchema.parse({ vaultPath: "/notes", exclude: "*.tmp, drafts/**" });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expect(parsed.value.exclude).toEqual(["*.tmp", "drafts/**"]);
  });

  test("a field with neither is optional", () => {
    const schema = object({ label: string({ label: "Label" }) });
    const parsed = schema.parse({});
    if (!parsed.ok) throw new Error("expected ok");
    expectTypeOf(parsed.value.label).toEqualTypeOf<string | undefined>();
    expect(parsed.value).toEqual({});
  });

  test("a select narrows to its own options", () => {
    const schema = object({
      country: select({
        label: "Country",
        required: true,
        options: [
          { value: "gb", label: "the UK" },
          { value: "es", label: "Spain" },
        ] as const,
      }),
    });
    const parsed = schema.parse({ country: "es" });
    if (!parsed.ok) throw new Error("expected ok");
    expectTypeOf(parsed.value.country).toEqualTypeOf<"gb" | "es">();
  });
});

describe("validation", () => {
  test("a missing required field is reported by label, not by key", () => {
    const parsed = vaultSchema.parse({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([{ field: "vaultPath", message: "Vault path is required" }]);
  });

  test("every field is checked, so one form submission reports every problem", () => {
    const schema = object({
      a: string({ label: "A", required: true }),
      b: number({ label: "B", required: true }),
    });
    const parsed = schema.parse({ b: "not a number" });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues.map((i) => i.field)).toEqual(["a", "b"]);
  });

  test.each([
    ["below the minimum", 0, /at least 1/],
    ["above the maximum", 99, /at most 10/],
    ["not a whole number", 2.5, /whole number/],
  ])("a number %s is rejected", (_l, value, matcher) => {
    const schema = object({ n: number({ label: "N", min: 1, max: 10, integer: true }) });
    const parsed = schema.parse({ n: value });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.message).toMatch(matcher);
  });

  test("a pattern failure reports the author's hint rather than the regex", () => {
    const schema = object({
      handle: string({
        label: "Handle",
        pattern: "^[a-z0-9-]+$",
        patternHint: "Handle may contain lowercase letters, digits and hyphens",
      }),
    });
    const parsed = schema.parse({ handle: "has spaces" });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.message).toBe(
      "Handle may contain lowercase letters, digits and hyphens",
    );
  });

  test("a malformed pattern is reported as the author's bug, not silently ignored", () => {
    expect(() => object({ h: string({ label: "H", pattern: "^([a-z" }) })).toThrow(
      /invalid pattern in its declaration/,
    );
  });

  test.each([
    number({ label: "Count", min: 1, default: 0 }),
    number({ label: "Count", integer: true, default: 1.5 }),
    select({ label: "Choice", options: [{ value: "a", label: "A" }], default: "b" }),
    list(string({ label: "Name" }), { label: "Names", default: [42] }),
    list(number({ label: "Count" }), { label: "Counts", default: ["1"] }),
    string({ label: "Name", minLength: 3, default: "" }),
    list(string({ label: "Name", pattern: "[" }), { label: "Names" }),
  ])("rejects invalid declarations before parsing %j", (field) => {
    expect(() => object({ value: field })).toThrow();
  });

  test("parsed defaults do not share mutable list state", () => {
    const schema = object({
      names: list(string({ label: "Name" }), { label: "Names", default: ["Maya"] }),
    });
    const first = schema.parse({});
    if (!first.ok) throw new Error("expected success");
    first.value.names.push("Jamie");
    expect(schema.parse({})).toEqual({ ok: true, value: { names: ["Maya"] } });
  });

  test("required whitespace and blank numeric values are never supplied values", () => {
    const schema = object({
      root: path({ label: "Root", required: true }),
      count: number({ label: "Count", required: true }),
    });
    expect(schema.parse({ root: " \t ", count: "  " })).toEqual({
      ok: false,
      issues: [
        { field: "root", message: "Root is required" },
        { field: "count", message: "Count is required" },
      ],
    });
    expect(object({ count: number({ label: "Count" }) }).parse({ count: "  " })).toEqual({
      ok: true,
      value: {},
    });
  });

  test.each([true, false, [], [1], {}])(
    "does not coerce a nonnumeric JSON value %j into a number",
    (count) => {
      expect(object({ count: number({ label: "Count" }) }).parse({ count }).ok).toBe(false);
    },
  );

  test("a select rejects a value outside its options, listing them", () => {
    const schema = object({
      c: select({ label: "C", options: [{ value: "gb", label: "UK" }] }),
    });
    const parsed = schema.parse({ c: "fr" });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.message).toMatch(/one of: gb/);
  });

  test("a list reports the failing element by index", () => {
    const schema = object({
      names: list(string({ label: "Name", minLength: 2 }), { label: "Names" }),
    });
    const parsed = schema.parse({ names: ["ok", "x"] });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.field).toBe("names[1]");
  });

  test("a list honours its maximum", () => {
    const schema = object({
      names: list(string({ label: "Name" }), { label: "Names", maxItems: 2 }),
    });
    const parsed = schema.parse({ names: ["a", "b", "c"] });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.message).toMatch(/at most 2 entries/);
  });

  test("a whole value that is not an object is reported once", () => {
    const parsed = vaultSchema.parse("nope");
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues).toEqual([{ field: "", message: "configuration must be an object" }]);
  });
});

describe("coercion at the edges a real config file has", () => {
  test.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("a boolean posted as %s is accepted", (raw, expected) => {
    // A form posts strings and a config file is hand-edited, so rejecting
    // these on a technicality would fail the operator, not the data.
    const schema = object({ b: boolean({ label: "B" }) });
    const parsed = schema.parse({ b: raw });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expect(parsed.value.b).toBe(expected);
  });

  test("a numeric string is coerced", () => {
    const schema = object({ n: number({ label: "N" }) });
    const parsed = schema.parse({ n: "42" });
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.n).toBe(42);
  });

  test("an empty string counts as absent, so a cleared form field takes its default", () => {
    const schema = object({ s: string({ label: "S", default: "fallback" }) });
    const parsed = schema.parse({ s: "" });
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.s).toBe("fallback");
  });

  test("an empty string on a required field is still missing", () => {
    const schema = object({ s: string({ label: "S", required: true }) });
    expect(schema.parse({ s: "" }).ok).toBe(false);
  });
});

describe("scope", () => {
  // Scope is read downstream off the derived form field, which is what the
  // collector and every client actually see; asserting it anywhere earlier
  // would prove a fact nothing consumes.
  test("member scope survives into the form, so a setting can stay on the host that supplied it", () => {
    expect(toSourceParams(vaultSchema).find((p) => p.name === "vaultPath")?.scope).toBe("member");
  });

  test("source scope is the default, and is left unstated", () => {
    const [param] = toSourceParams(object({ a: string({ label: "A" }) }));
    expect(param?.scope).toBeUndefined();
  });
});

describe("the bridge to the form clients already render", () => {
  test("carries label, scope and requiredness across", () => {
    const params = toSourceParams(vaultSchema);
    expect(params[0]).toMatchObject({
      name: "vaultPath",
      label: "Vault path",
      type: "path",
      scope: "member",
      required: true,
    });
  });

  test("a boolean becomes a two-option select, so a client can still render it", () => {
    const params = toSourceParams(vaultSchema);
    const followSymlinks = params.find((p) => p.name === "followSymlinks");
    expect(followSymlinks?.type).toBe("select");
    expect(followSymlinks?.options?.map((o) => o.value)).toEqual(["true", "false"]);
  });

  test("a list a client cannot render is still visible, with a hint saying what it holds", () => {
    // A field the old shape cannot express must not simply vanish from the
    // interface; that is exactly how a setting ends up reachable only by
    // hand-editing a config file.
    const exclude = toSourceParams(vaultSchema).find((p) => p.name === "exclude");
    expect(exclude?.type).toBe("string");
    expect(exclude?.placeholder).toBe("One pattern per line");
  });

  test("carries no functions, because the form crosses a wire to clients", () => {
    const params = toSourceParams(vaultSchema);
    expect(JSON.parse(JSON.stringify(params))).toEqual(params);
  });

  test("a select's options come across intact", () => {
    const schema = object({
      country: select({
        label: "Country",
        options: [
          { value: "gb", label: "the UK" },
          { value: "es", label: "Spain" },
        ],
      }),
    });
    expect(toSourceParams(schema)[0]?.options).toEqual([
      { value: "gb", label: "the UK" },
      { value: "es", label: "Spain" },
    ]);
  });
});

describe("secrets", () => {
  test("parse like text but are declared so a form can mask them", () => {
    const schema = object({ apiKey: secret({ label: "API key", required: true, minLength: 8 }) });
    expect(schema.parse({ apiKey: "short" }).ok).toBe(false);
    const parsed = schema.parse({ apiKey: "long-enough-key" });
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.apiKey).toBe("long-enough-key");
    expect(schema.fields.apiKey.kind).toBe("secret");
  });
});

describe("formatConfigIssues", () => {
  test("names the field when there is one", () => {
    expect(
      formatConfigIssues([
        { field: "vaultPath", message: "Vault path is required" },
        { field: "", message: "configuration must be an object" },
      ]),
    ).toBe("vaultPath: Vault path is required; configuration must be an object");
  });
});

describe("a list is settable through the channel operators actually have", () => {
  test("newline-only lists preserve commas inside stored glob patterns", () => {
    const schema = object({
      exclude: list(string({ label: "Pattern" }), { label: "Exclude", separator: "newline" }),
    });
    expect(schema.parse({ exclude: "*.{tmp,bak}\narchive/**" })).toEqual({
      ok: true,
      value: { exclude: ["*.{tmp,bak}", "archive/**"] },
    });
  });
  const schema = object({
    exclude: list(string({ label: "Pattern" }), { label: "Exclude", default: [] }),
  });

  test.each([
    ["newline separated", "archive/**\ntemplates/**"],
    ["comma separated", "archive/**,templates/**"],
    ["mixed, with stray whitespace", " archive/** ,\n templates/** \n"],
  ])("%s text becomes a list", (_l, raw) => {
    // A stored param is a string and every client posts one. A list that only
    // accepted an array would be declarable and unsettable -- and, since a
    // failed parse skips the source, unsettable in a way that is worse than
    // not declaring it at all.
    const parsed = schema.parse({ exclude: raw });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expect(parsed.value.exclude).toEqual(["archive/**", "templates/**"]);
  });

  test("an array still works, for a caller that has one", () => {
    const parsed = schema.parse({ exclude: ["a", "b"] });
    expect(parsed.ok && parsed.value.exclude).toEqual(["a", "b"]);
  });

  test("an empty string is absent, so the default applies", () => {
    expect(schema.parse({ exclude: "" }).ok && schema.parse({ exclude: "" })).toMatchObject({
      value: { exclude: [] },
    });
  });

  test("element validation still applies to each parsed entry", () => {
    const strict = object({
      names: list(string({ label: "Name", minLength: 3 }), { label: "Names" }),
    });
    const parsed = strict.parse({ names: "ok-name,xy" });
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.issues[0]?.field).toBe("names[1]");
  });
});

describe("a field can be declared without being asked at add time", () => {
  const schema = object({
    dbPath: path({ label: "Database", required: true }),
    excludeProfiles: list(string({ label: "Profile" }), {
      label: "Exclude profiles",
      default: [],
      advanced: true,
    }),
  });

  test("an advanced field is left off the form", () => {
    // Some settings are escape hatches, not setup questions. Putting one on
    // the add form asks a question at the only moment the form is ever shown.
    expect(toSourceParams(schema).map((p) => p.name)).toEqual(["dbPath"]);
  });

  test("but it is still parsed, defaulted and typed", () => {
    const parsed = schema.parse({ dbPath: "/db", excludeProfiles: "work,personal" });
    if (!parsed.ok) throw new Error(formatConfigIssues(parsed.issues));
    expect(parsed.value.excludeProfiles).toEqual(["work", "personal"]);
  });
});

describe("path constraints, checked where the filesystem is", () => {
  const probe = (present: Record<string, "file" | "dir">, home = "/home/tester") => ({
    resolve: (p: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p),
    exists: (p: string) => p in present,
    isDirectory: (p: string) => present[p] === "dir",
    join: (...parts: string[]) => parts.join("/"),
  });

  const vault = object({
    vaultPath: path({
      label: "Vault path",
      required: true,
      mustExist: "directory",
      mustContain: ".obsidian",
      containsHint: "That folder is not a vault: it has no .obsidian directory",
    }),
  });

  test("checks each list element and derives the same form validator", () => {
    const schema = object({
      roots: list(
        path({
          label: "Root",
          mustExist: "directory",
          check: (value) => (value === "/denied" ? "Root is unreadable" : null),
        }),
        { label: "Roots" },
      ),
    });
    const filesystem = probe({ "/ok": "dir", "/denied": "dir" });
    expect(hostConfigIssues(schema, { roots: ["/ok", "/missing", "/denied"] }, filesystem)).toEqual(
      [
        { field: "roots[1]", message: "Root does not exist: /missing" },
        { field: "roots[2]", message: "Root is unreadable" },
      ],
    );
    const validate = toSourceParams(schema, filesystem)[0]?.validate;
    expect(validate).toBeTypeOf("function");
    expect(validate?.("/ok\n/missing")).toBe("Root does not exist: /missing");
    expect(validate?.("/ok\n/denied")).toBe("Root is unreadable");
    expect(validate?.("/ok")).toBeNull();
  });

  test("a numeric check sees the coerced number rather than an empty value", () => {
    const schema = object({
      count: number({ label: "Count", check: (value) => (value === "2" ? null : "Expected two") }),
    });
    expect(hostConfigIssues(schema, { count: 2 }, probe({}))).toEqual([]);
    expect(hostConfigIssues(schema, { count: 3 }, probe({}))).toEqual([
      { field: "count", message: "Expected two" },
    ]);
    expect(fieldValidator(schema, "count", probe({}))?.("02")).toBeNull();
  });

  test("a folder that exists and contains the marker passes", () => {
    expect(
      hostConfigIssues(
        vault,
        { vaultPath: "/notes" },
        probe({ "/notes": "dir", "/notes/.obsidian": "dir" }),
      ),
    ).toEqual([]);
  });

  test("a missing path says it is missing, not that it is the wrong sort of folder", () => {
    // The hint answers one question — what makes this folder the thing the
    // source wants — and an unmounted drive is not that question. Letting it
    // cover every branch tells an operator whose path is simply gone that
    // their folder is not a vault.
    const issues = hostConfigIssues(vault, { vaultPath: "/gone" }, probe({}));
    expect(issues).toEqual([{ field: "vaultPath", message: "Vault path does not exist: /gone" }]);
  });

  test("a file where a folder belongs says so", () => {
    const issues = hostConfigIssues(
      vault,
      { vaultPath: "/notes.txt" },
      probe({ "/notes.txt": "file" }),
    );
    expect(issues).toEqual([
      { field: "vaultPath", message: "Vault path must be a folder: /notes.txt" },
    ]);
  });

  test("a folder the process cannot read is refused before a source is handed it", () => {
    // Accepted, it looked connected and then withheld its first snapshot; for a
    // vault it failed the marker check instead and blamed a missing .obsidian.
    const issues = hostConfigIssues(
      vault,
      { vaultPath: "/locked" },
      {
        ...probe({ "/locked": "dir" }),
        readable: () => false,
      },
    );
    expect(issues).toEqual([{ field: "vaultPath", message: "Vault path cannot be read: /locked" }]);
  });

  test("a folder without the marker gets the hint — the check a shape-only schema would have dropped", () => {
    const issues = hostConfigIssues(vault, { vaultPath: "/notes" }, probe({ "/notes": "dir" }));
    expect(issues).toEqual([
      { field: "vaultPath", message: "That folder is not a vault: it has no .obsidian directory" },
    ]);
  });

  test("a file wearing the marker's name is not the marker", () => {
    // The distinction the old hand-written validator made and a bare existence
    // check loses: a stray file called `.obsidian` is not a settings folder.
    const issues = hostConfigIssues(
      vault,
      { vaultPath: "/notes" },
      probe({ "/notes": "dir", "/notes/.obsidian": "file" }),
    );
    expect(issues).toHaveLength(1);
  });

  test("a source can ask for a file inside the folder instead", () => {
    const schema = object({
      p: path({ label: "P", mustContain: "index.db", mustContainKind: "file" }),
    });
    expect(
      hostConfigIssues(schema, { p: "/d" }, probe({ "/d": "dir", "/d/index.db": "file" })),
    ).toEqual([]);
    expect(
      hostConfigIssues(schema, { p: "/d" }, probe({ "/d": "dir", "/d/index.db": "dir" })),
    ).toHaveLength(1);
  });

  test("an absent optional path is not checked", () => {
    const optional = object({ p: path({ label: "P", mustExist: "file" }) });
    expect(hostConfigIssues(optional, {}, probe({}))).toEqual([]);
  });

  test("a file constraint rejects a directory", () => {
    const schema = object({ db: path({ label: "Database", mustExist: "file" }) });
    const issues = hostConfigIssues(schema, { db: "/data" }, probe({ "/data": "dir" }));
    expect(issues[0]?.message).toMatch(/must be a file/);
  });

  test("a schema with no path constraints touches nothing", () => {
    const plain = object({ s: string({ label: "S" }) });
    expect(hostConfigIssues(plain, { s: "anything" }, probe({}))).toEqual([]);
  });
});

describe("what a form can ask before the operator submits", () => {
  const probe = (present: Record<string, "file" | "dir">, home = "/home/tester") => ({
    resolve: (p: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p),
    exists: (p: string) => p in present,
    isDirectory: (p: string) => present[p] === "dir",
    join: (...parts: string[]) => parts.join("/"),
  });

  const vault = object({
    vaultPath: path({ label: "Vault path", required: true, mustExist: "directory" }),
    note: string({ label: "Note" }),
  });

  test("a constrained field yields a validator, an unconstrained one does not", () => {
    // The distinction matters downstream: a param with no validator skips the
    // round trip to the host entirely rather than asking it a question whose
    // answer is always yes.
    expect(fieldValidator(vault, "vaultPath", probe({}))).toBeTypeOf("function");
    expect(fieldValidator(vault, "note", probe({}))).toBeUndefined();
    expect(fieldValidator(vault, "absent", probe({}))).toBeUndefined();
  });

  test("the validator answers for one field without the rest being filled in", () => {
    const check = fieldValidator(vault, "vaultPath", probe({ "/notes": "dir" }))!;
    expect(check("/notes")).toBeNull();
    expect(check("/gone")).toMatch(/does not exist/);
  });

  test("a blank value is not an error here, because required is the parser's job", () => {
    // Reporting "required" while the operator has not finished typing would
    // mark every field red the moment the form opened.
    const check = fieldValidator(vault, "vaultPath", probe({}))!;
    expect(check("")).toBeNull();
  });
});

describe("a path is expanded before it is looked for", () => {
  const probe = {
    resolve: (p: string) => (p.startsWith("~/") ? `/home/tester/${p.slice(2)}` : p),
    exists: (p: string) => p === "/home/tester/.tool",
    isDirectory: (p: string) => p === "/home/tester/.tool",
    join: (...parts: string[]) => parts.join("/"),
  };
  const schema = object({ home: path({ label: "Tool home", mustExist: "directory" }) });

  test("a tilde path the operator typed resolves to their home directory", () => {
    expect(hostConfigIssues(schema, { home: "~/.tool" }, probe)).toEqual([]);
  });

  test("the message quotes what was typed, not what it expanded to", () => {
    // The operator can act on the string they entered; the expansion is an
    // implementation detail they did not choose.
    const issues = hostConfigIssues(schema, { home: "~/.missing" }, probe);
    expect(issues[0]?.message).toContain("~/.missing");
  });
});

describe("the escape hatch for what data cannot express", () => {
  const probe = {
    resolve: (p: string) => p,
    exists: (p: string) => p === "/found",
    isDirectory: () => true,
    join: (...parts: string[]) => parts.join("/"),
  };

  test("a check runs after the declarative constraints pass", () => {
    const calls: string[] = [];
    const schema = object({
      p: path({
        label: "P",
        mustExist: "directory",
        check: (value) => {
          calls.push(value);
          return "still not acceptable";
        },
      }),
    });
    expect(hostConfigIssues(schema, { p: "/found" }, probe)[0]?.message).toBe(
      "still not acceptable",
    );
    expect(calls).toEqual(["/found"]);
  });

  test("a check does not run when a declarative constraint already failed", () => {
    // One message per field, and the specific failure is the one that already
    // has an answer. Running both would also mean the check has to cope with
    // a path it has been told does not exist.
    let ran = false;
    const schema = object({
      p: path({
        label: "P",
        mustExist: "directory",
        check: () => {
          ran = true;
          return null;
        },
      }),
    });
    expect(hostConfigIssues(schema, { p: "/gone" }, probe)).toHaveLength(1);
    expect(ran).toBe(false);
  });

  test("a blank field is left alone unless the source says blank is an answer", () => {
    let ran = false;
    const quiet = object({ p: path({ label: "P", check: () => ((ran = true), "no") }) });
    expect(hostConfigIssues(quiet, { p: "" }, probe)).toEqual([]);
    expect(ran).toBe(false);

    const detecting = object({
      p: path({
        label: "P",
        checkWhenEmpty: true,
        check: () => "nothing found on this machine",
      }),
    });
    expect(hostConfigIssues(detecting, { p: "" }, probe)[0]?.message).toBe(
      "nothing found on this machine",
    );
  });

  test("a check on a non-path field runs too", () => {
    const schema = object({
      token: string({ label: "Token", check: (v) => (v.startsWith("sk-") ? null : "wrong shape") }),
    });
    expect(hostConfigIssues(schema, { token: "sk-1" }, probe)).toEqual([]);
    expect(hostConfigIssues(schema, { token: "nope" }, probe)).toHaveLength(1);
  });

  test("a field that only has a check still yields a validator", () => {
    const schema = object({ p: path({ label: "P", check: () => "no" }) });
    expect(fieldValidator(schema, "p", probe)).toBeTypeOf("function");
  });
});

describe("the derived form carries what the host can check", () => {
  const probe = {
    resolve: (p: string) => p,
    exists: () => false,
    isDirectory: () => false,
    join: (...parts: string[]) => parts.join("/"),
  };

  test("without a probe the form is pure data, as a wire payload must be", () => {
    const schema = object({ p: path({ label: "P", mustExist: "directory" }) });
    expect(toSourceParams(schema)[0]).not.toHaveProperty("validate");
  });

  test("with a probe the constrained field carries its validator", () => {
    const schema = object({ p: path({ label: "P", mustExist: "directory" }) });
    const [param] = toSourceParams(schema, probe);
    expect(param?.validate?.("/gone")).toMatch(/does not exist/);
    expect(param).not.toHaveProperty("validateWhenEmpty");
  });

  test("a field that wants checking while blank says so", () => {
    const schema = object({
      p: path({ label: "P", checkWhenEmpty: true, check: () => "nothing detected" }),
    });
    expect(toSourceParams(schema, probe)[0]?.validateWhenEmpty).toBe(true);
  });

  test("an advanced field carries no validator because it carries no form field", () => {
    const schema = object({
      p: path({ label: "P", advanced: true, mustExist: "directory" }),
    });
    expect(toSourceParams(schema, probe)).toEqual([]);
  });
});

describe("a source is handed the path the host checked", () => {
  const probe = {
    resolve: (p: string) => (p.startsWith("~/") ? `/home/tester/${p.slice(2)}` : p),
    exists: () => true,
    isDirectory: () => true,
    join: (...parts: string[]) => parts.join("/"),
  };
  const schema = object({
    home: path({ label: "Home" }),
    note: string({ label: "Note" }),
    roots: list(path({ label: "Root" }), { label: "Roots", default: [] }),
    patterns: list(string({ label: "Pattern" }), { label: "Patterns", default: [] }),
  });

  test("a declared path arrives resolved", () => {
    // The failure this closes: the check expanded the tilde and the factory
    // did not, so a path an operator was told was fine could not be opened.
    expect(resolveDeclaredPaths(schema, { home: "~/vault" }, probe)).toEqual({
      home: "/home/tester/vault",
    });
  });

  test("only paths are touched", () => {
    expect(resolveDeclaredPaths(schema, { home: "/a", note: "~/not-a-path" }, probe)).toEqual({
      home: "/a",
      note: "~/not-a-path",
    });
  });

  test("every path in a list arrives resolved too", () => {
    // A multi-root source declares one field holding several paths, and each
    // of them is a path the host promised to resolve.
    expect(
      resolveDeclaredPaths(schema, { roots: ["~/notes", "/srv/docs"], patterns: ["~/x"] }, probe),
    ).toEqual({ roots: ["/home/tester/notes", "/srv/docs"], patterns: ["~/x"] });
  });

  test("a blank or absent path is left as it is", () => {
    expect(resolveDeclaredPaths(schema, { home: "  " }, probe)).toEqual({ home: "  " });
    expect(resolveDeclaredPaths(schema, {}, probe)).toEqual({});
  });

  test("the input is not mutated, so what gets stored keeps the operator's spelling", () => {
    const stored = { home: "~/vault" };
    resolveDeclaredPaths(schema, stored, probe);
    expect(stored).toEqual({ home: "~/vault" });
  });
});

describe("what a client is told about a field", () => {
  test("the source's own explanation reaches the form", () => {
    // A label can only say what a field is called. For an optional setting the
    // operator's real question is what happens if they leave it alone, and
    // only the source can answer that.
    const schema = object({
      p: path({ label: "Sessions", help: "Leave blank to use this machine's own." }),
    });
    expect(toSourceParams(schema)[0]?.help).toBe("Leave blank to use this machine's own.");
  });
});
