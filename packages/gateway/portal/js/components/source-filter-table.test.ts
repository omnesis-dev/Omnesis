// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  getSourceFilterEditor: vi.fn(),
  getSourceFilterOptions: vi.fn(),
  previewSourceFilter: vi.fn(),
  resyncSource: vi.fn(),
}));
vi.mock("../api.js", () => api);
// @ts-expect-error — Portal modules are JavaScript.
import { SourceFilterTable } from "./source-filter-table.js";
// @ts-expect-error — Portal modules are JavaScript.
import { SourceAccountHeader, sourceInstanceIcon } from "./source-account-header.js";
// @ts-expect-error — Portal modules are JavaScript.
import { clearScopeLabels, rememberScopeLabels } from "./source-filter-labels.js";
// @ts-expect-error — Portal modules are JavaScript.
import { fieldLevelNoun, refTypeLabel } from "./source-filter-fields.js";

const source = {
  id: "invented:maya@example.com",
  displayName: "Invented provider",
  icon: "/icons/invented.svg",
};
const noun = (one: string, many: string) => ({ one, many });
const editor = {
  sourceId: source.id,
  sourceType: "invented",
  devices: [
    { id: "dev-studio", name: "Studio Mac" },
    { id: "dev-travel", name: "Travel laptop" },
  ],
  showDeviceLevel: true,
  fields: [
    { field: "$people", capability: "person", noun: noun("participant", "participants") },
    { field: "extra.labelIds", capability: "membership", noun: noun("label", "labels") },
    { field: "extra.folder", capability: "tree", noun: noun("folder", "folders") },
    {
      field: "extra.shelf",
      capability: "tree",
      noun: noun("shelf or binder", "shelves and binders"),
      levels: [noun("shelf", "shelves"), noun("binder", "binders")],
    },
  ],
};
const label = (id: string) => ({ capability: "membership", field: "extra.labelIds", id });
const folder = (id: string, device?: string) => ({
  capability: "tree",
  field: "extra.folder",
  id,
  ...(device ? { device } : {}),
});
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
  clearScopeLabels();
  api.getSourceFilterEditor.mockReset().mockResolvedValue(editor);
  api.getSourceFilterOptions.mockReset().mockRejectedValue(new Error("unavailable"));
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});
async function show(props: Record<string, unknown>) {
  await act(async () => {
    render(h(SourceFilterTable, { source, ...props }), host);
  });
  await act(async () => {});
}
const column = (selector: string) =>
  [...host.querySelectorAll(selector)].map((element) => element.textContent);

test("typed addresses keep their type and value while named people keep their addresses beside the name", async () => {
  const person = (label: string, type: string, value: string) => ({
    capability: "person",
    label,
    identifiers: [{ type, value }],
  });
  await show({
    refs: [
      person("example.org", "domain", "example.org"),
      person("maya@example.com", "email", "maya@example.com"),
      person("+15550100123", "phone", "+15550100123"),
      person("Example participant", "email", "maya@example.com"),
    ],
  });
  expect(column(".compact-filter-kind")).toEqual(["Domain", "Email", "Phone", "Participant"]);
  expect(column(".compact-filter-value")).toEqual([
    "example.org",
    "maya@example.com",
    "+15550100123",
    "Example participantmaya@example.com",
  ]);
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

test("counts belong to exact matching entries, include zero, and never invent unavailable counts or opaque labels", async () => {
  rememberScopeLabels(source.id, [{ ref: label("opaque-label-id"), label: "Design", count: 99 }]);
  await show({
    refs: [label("opaque-label-id"), folder("opaque-folder-id")],
    items: [{ ref: label("opaque-label-id"), label: "Design", count: 0 }],
  });
  expect(column("tbody .compact-filter-count")).toEqual(["0", "—"]);
  expect(host.textContent).toContain("Design");
  expect(host.textContent).not.toContain("opaque-");
  expect(host.textContent).toContain("Saved folder selection");
  expect(host.querySelector('[aria-label="Matching count unavailable"]')).not.toBeNull();
});

test("a whole device is typed as a device and named from the account's devices", async () => {
  await show({ refs: [folder("", "dev-travel"), folder("~/work", "dev-studio")] });
  expect(column(".compact-filter-kind")).toEqual(["Device", "Folder"]);
  expect(host.textContent).toContain("Travel laptop");
});

test("Remove is present only in editable tables and cannot dispatch while disabled", async () => {
  const ref = label("plain");
  const onRemove = vi.fn();
  await show({ refs: [ref], onRemove });
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onRemove).toHaveBeenCalledWith(ref);
  await show({ refs: [ref], onRemove, disabled: true });
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
});

test("same-name items expose their id only when the name is ambiguous", async () => {
  const before = folder("invented-folder-before");
  const after = folder("invented-folder-after");
  rememberScopeLabels(source.id, [
    { ref: before, label: "Project files" },
    { ref: after, label: "Project files" },
  ]);
  await show({ refs: [after], comparisonRefs: [before] });
  expect(host.querySelector(".compact-filter-ref")?.textContent).toBe(
    "Selection ID: invented-folder-after",
  );
  await show({ refs: [after], comparisonRefs: [after] });
  expect(host.querySelector(".compact-filter-ref")).toBeNull();
});

test("a tree item is typed by its level's noun, from the row's own depth or the one remembered with its name", async () => {
  const shelves = editor.fields[3];
  const ref = (id: string) => ({ capability: "tree", field: "extra.shelf", id });
  expect(refTypeLabel(shelves, ref("a"), 0)).toBe("Shelf");
  expect(refTypeLabel(shelves, ref("a"), 1)).toBe("Binder");
  // The last level a field names stands for every deeper one.
  expect(refTypeLabel(shelves, ref("a"), 5)).toBe("Binder");
  // Without a depth, the field's own noun.
  expect(refTypeLabel(shelves, ref("a"))).toBe("Shelf or binder");
  expect(refTypeLabel(shelves, ref("a"), -1)).toBe("Shelf or binder");
  expect(fieldLevelNoun(editor.fields[2], 4, true)).toBe("folders");
  rememberScopeLabels(source.id, [{ ref: ref("remembered"), label: "Invented binder", depth: 1 }]);
  // A later name without a depth keeps the one already known.
  rememberScopeLabels(source.id, [{ ref: ref("remembered"), label: "Invented binder" }]);
  await show({
    refs: [ref("listed"), ref("remembered"), ref("unknown")],
    items: [{ ref: ref("listed"), label: "Invented shelf", count: 3, depth: 0 }],
  });
  expect(column(".compact-filter-kind")).toEqual(["Shelf", "Binder", "Shelf or binder"]);
});

test("an entry named without its depth is typed by whether the tree's first level lists it", async () => {
  const ref = (id: string) => ({ capability: "tree", field: "extra.shelf", id });
  api.getSourceFilterOptions.mockResolvedValue({
    sourceId: source.id,
    field: "extra.shelf",
    items: [{ ref: ref("north"), label: "North", shortLabel: "North", count: 4, depth: 0 }],
  });
  await show({ refs: [ref("north"), ref("north/atlas")] });
  // Effects of a render that settled outside act run after the next paint.
  await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
  await act(async () => {});
  expect(api.getSourceFilterOptions).toHaveBeenCalledWith(
    source.id,
    { field: "extra.shelf" },
    expect.anything(),
  );
  expect(column(".compact-filter-kind")).toEqual(["Shelf", "Binder"]);
});
