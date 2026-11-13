// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — Portal modules are JavaScript.
import { SourceFilterTable, sourceFilterKindLabel } from "./source-filter-table.js";
// @ts-expect-error — Portal modules are JavaScript.
import { SourceAccountHeader, sourceInstanceIcon } from "./source-account-header.js";
// @ts-expect-error — Portal modules are JavaScript.
import { clearScopeLabels, rememberScopeLabels, scopeNestingHint } from "./source-filter-labels.js";

const source = {
  id: "invented:maya@example.com",
  displayName: "Invented provider",
  icon: "/icons/invented.svg",
  scopes: {
    items: [
      { kind: "participant", noun: { one: "participant" } },
      { kind: "label", noun: { one: "label" } },
      { kind: "folder", noun: { one: "folder" } },
    ],
  },
};
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
  clearScopeLabels();
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});

test("exact wire identifiers retain their type and value while named participants retain identifier context", () => {
  const refs = [
    {
      kind: "participant",
      label: "example.org",
      identifiers: [{ type: "domain", value: "example.org" }],
    },
    {
      kind: "participant",
      label: "maya@example.com",
      identifiers: [{ type: "email", value: "maya@example.com" }],
    },
    {
      kind: "participant",
      label: "+15550100123",
      identifiers: [{ type: "phone", value: "+15550100123" }],
    },
    {
      kind: "participant",
      label: "Example participant",
      identifiers: [{ type: "email", value: "maya@example.com" }],
    },
  ];
  act(() => render(h(SourceFilterTable, { source, refs }), host));
  expect([...host.querySelectorAll(".compact-filter-kind")].map((e) => e.textContent)).toEqual([
    "Domain",
    "Email",
    "Phone",
    "Participant",
  ]);
  const values = [...host.querySelectorAll(".compact-filter-value")].map((e) => e.textContent);
  expect(values).toEqual([
    "example.org",
    "maya@example.com",
    "+15550100123",
    "Example participantmaya@example.com",
  ]);
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

test("counts belong to exact matching refs, include zero, and never invent unavailable counts or opaque labels", () => {
  const label = { kind: "label", id: "opaque-label-id" },
    folder = { kind: "folder", id: "opaque-folder-id" };
  rememberScopeLabels(source.id, [{ ref: label, label: "Design", count: 99 }]);
  act(() =>
    render(
      h(SourceFilterTable, {
        source,
        refs: [label, folder],
        items: [{ ref: label, label: "Design", count: 0 }],
      }),
      host,
    ),
  );
  expect(
    [...host.querySelectorAll("tbody .compact-filter-count")].map((e) => e.textContent),
  ).toEqual(["0", "—"]);
  expect(host.textContent).toContain("Design");
  expect(host.textContent).not.toContain("opaque-");
  expect(host.querySelector('[aria-label="Matching count unavailable"]')).not.toBeNull();
});

test("Remove is present only in editable tables and cannot dispatch while disabled", () => {
  const ref = {
    kind: "participant",
    label: "example.org",
    identifiers: [{ type: "domain", value: "example.org" }],
  };
  const onRemove = vi.fn();
  act(() => render(h(SourceFilterTable, { source, refs: [ref], onRemove }), host));
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onRemove).toHaveBeenCalledWith(ref);
  act(() => render(h(SourceFilterTable, { source, refs: [ref], onRemove, disabled: true }), host));
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onRemove).toHaveBeenCalledOnce();
});

test("source headings keep descriptor icons and source/account identity together and reject unsafe icon URLs", () => {
  act(() => render(h(SourceAccountHeader, { source }), host));
  expect(host.querySelector(".compact-source-header img")?.getAttribute("src")).toBe(source.icon);
  expect(host.querySelector(".compact-source-header strong")?.textContent).toBe(source.displayName);
  expect(host.querySelector(".compact-source-account")?.textContent).toBe("maya@example.com");
  act(() =>
    render(
      sourceInstanceIcon({ ...source, icon: "https://tracker.invalid/icon.svg" }, source.id),
      host,
    ),
  );
  expect(host.querySelector('img[src^="https:"]')).toBeNull();
  expect(sourceFilterKindLabel(source, { kind: "folder", id: "folder" })).toBe("Folder");
});

test("same-name native selections expose stable identity only when the name is ambiguous", () => {
  const before = { kind: "folder", id: "invented-folder-before" };
  const after = { kind: "folder", id: "invented-folder-after" };
  rememberScopeLabels(source.id, [
    { ref: before, label: "Project files" },
    { ref: after, label: "Project files" },
  ]);
  act(() =>
    render(h(SourceFilterTable, { source, refs: [after], comparisonRefs: [before] }), host),
  );
  expect(host.querySelector(".compact-filter-ref")?.textContent).toBe(
    "Selection ID: invented-folder-after",
  );
  expect(host.querySelectorAll("button, details")).toHaveLength(0);
  act(() => render(h(SourceFilterTable, { source, refs: [after], comparisonRefs: [after] }), host));
  expect(host.querySelector(".compact-filter-ref")).toBeNull();
});

test("a tree item is typed by its level's noun, from the row's own depth or the one remembered with its name", () => {
  const shelves = {
    ...source,
    scopes: {
      items: [
        {
          kind: "folder",
          noun: { one: "shelf or binder", many: "shelves and binders" },
          levels: [{ one: "shelf" }, { one: "binder" }],
        },
        { kind: "label", noun: { one: "label" } },
      ],
    },
  };
  const ref = (id: string) => ({ kind: "folder", id });
  expect(sourceFilterKindLabel(shelves, ref("a"), 0)).toBe("Shelf");
  expect(sourceFilterKindLabel(shelves, ref("a"), 1)).toBe("Binder");
  // The last level a source names stands for every deeper one.
  expect(sourceFilterKindLabel(shelves, ref("a"), 5)).toBe("Binder");
  // Without a depth — an older gateway, or a selection it no longer holds — the kind's own noun.
  expect(sourceFilterKindLabel(shelves, ref("a"))).toBe("Shelf or binder");
  expect(sourceFilterKindLabel(shelves, ref("a"), -1)).toBe("Shelf or binder");
  expect(sourceFilterKindLabel(shelves, { kind: "label", id: "l" }, 1)).toBe("Label");
  // A source with one noun for every item ignores depth.
  expect(sourceFilterKindLabel(source, ref("a"), 1)).toBe("Folder");

  rememberScopeLabels(shelves.id, [
    { ref: ref("remembered-binder"), label: "Invented binder", depth: 1 },
  ]);
  // A later hint without a depth keeps the one already known.
  rememberScopeLabels(shelves.id, [{ ref: ref("remembered-binder"), label: "Invented binder" }]);
  act(() =>
    render(
      h(SourceFilterTable, {
        source: shelves,
        refs: [ref("listed-shelf"), ref("remembered-binder"), ref("unknown")],
        items: [{ ref: ref("listed-shelf"), label: "Invented shelf", count: 3, depth: 0 }],
      }),
      host,
    ),
  );
  expect([...host.querySelectorAll(".compact-filter-kind")].map((e) => e.textContent)).toEqual([
    "Shelf",
    "Binder",
    "Shelf or binder",
  ]);
});

test("the nesting hint of a tree with one noun reads as a sentence whatever the noun", () => {
  const tree = (many: string) => ({
    ...source,
    scopes: { items: [{ kind: "folder", noun: { one: "invented", many } }] },
  });
  expect(scopeNestingHint(tree("folders"), "folder", 0)).toBe("Includes the folders inside.");
  expect(scopeNestingHint(tree("project folders"), "folder", 3)).toBe(
    "Includes the project folders inside.",
  );
});
