// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  getSourceFilterEditor: vi.fn(),
  getSourceFilterOptions: vi.fn(),
  previewSourceFilter: vi.fn(),
  checkFilterIdentifier: vi.fn(),
  resyncSource: vi.fn(),
}));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JavaScript.
import { SourceFilterEditor } from "./source-filter-editor.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { SourceFilterPicker } from "./source-filter-picker.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { LevelDecisionSummary } from "../views/access/level-review.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { CapabilityPicker } from "./grant-builder.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { clearScopeLabels } from "./source-filter-labels.js";

const source = {
  id: "fictional:one",
  displayName: "Fictional account",
  sourceType: "fictional-chat",
  available: true,
  filterable: true,
};
const noun = (one: string, many: string) => ({ one, many });
const zero = { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null };
const ready = { status: "ready" };
const roomField = {
  field: "extra.roomId",
  capability: "membership",
  noun: noun("room", "rooms"),
  picker: "search",
  scope: "global",
  state: ready,
  counts: zero,
};
const peopleField = {
  field: "$people",
  capability: "person",
  noun: noun("person", "people"),
  picker: "search",
  scope: "global",
  identifiers: ["email", "phone"],
  state: ready,
  counts: zero,
};
const folderField = {
  field: "extra.folder",
  capability: "tree",
  noun: noun("folder", "folders"),
  picker: "tree",
  scope: "global",
  levels: [noun("folder", "folders")],
  inside: noun("folder", "folders"),
  insideText: "Includes the folders inside.",
  state: ready,
  counts: zero,
};
const editorWith = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
  sourceId: source.id,
  sourceType: source.sourceType,
  devices: [{ id: "dev-one", name: "Studio Mac" }],
  showDeviceLevel: false,
  fields,
  ...extra,
});
const room = (id: string) => ({ capability: "membership", field: "extra.roomId", id });
const policy = {
  sourceId: source.id,
  audience: { accessLevel: "saved-level", capability: "answer" },
  rules: [{ action: "share", match: [room("stable-room")] }],
  otherwise: "hide",
};
const readyPreview = (id: string, p: typeof policy, extra: Record<string, unknown> = {}) => ({
  status: "ready",
  sourceId: id,
  total: 20,
  visible: 12,
  hidden: 8,
  tooOld: 0,
  unmatched: 3,
  tooOldText: null,
  unmatchedText: "3 records can't be matched to a room and stay hidden.",
  items: p.rules.flatMap((rule) =>
    rule.match.map((ref) => ({
      ref,
      label: (ref as { id?: string }).id === "missing-room" ? "Retired room" : "Fictional room",
      missing: (ref as { id?: string }).id === "missing-room",
      count: (ref as { id?: string }).id === "missing-room" ? 0 : 4,
    })),
  ),
  ...extra,
});
/** The review's summary of an Answer that shares the account under `saved`. */
const answerSummary = (saved: unknown) =>
  h(LevelDecisionSummary, {
    decision: "answer-data",
    rules: {
      answer: {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: [source.id] },
        release: { mode: "unreviewed" },
        scopePolicies: [saved],
      },
    },
    sources: [source],
    policies: [],
  });
let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  clearScopeLabels();
  api.getSourceFilterEditor
    .mockReset()
    .mockResolvedValue(editorWith([roomField, peopleField, folderField]));
  api.getSourceFilterOptions
    .mockReset()
    .mockImplementation(async (id: string, query: { field: string }) => ({
      sourceId: id,
      field: query.field,
      items: [
        {
          ref: room("stable-room"),
          label: "Fictional room",
          shortLabel: "Fictional room",
          count: 4,
        },
      ],
    }));
  api.previewSourceFilter
    .mockReset()
    .mockImplementation(async (id: string, p: typeof policy) => readyPreview(id, p));
  api.checkFilterIdentifier.mockReset();
  api.resyncSource.mockReset().mockResolvedValue({ ok: true, mode: "in-place" });
});
afterEach(() => {
  act(() => render(null, host));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function flushUI() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
/** Effects of renders that settled outside act run after the next paint; option loads wait 150 ms. */
async function waitOptions() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 175));
  });
}
async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    render(
      h(SourceFilterEditor, {
        source,
        capability: "answer",
        accessLevel: "saved-level",
        savedPolicy: policy,
        enabled: true,
        onApply: vi.fn(),
        onRemove: vi.fn(),
        onClose: vi.fn(),
        ...props,
      }),
      host,
    );
  });
  if (
    props.enabled !== false &&
    props.savedPolicy !== null &&
    host.textContent?.includes("What should be shared?")
  ) {
    await act(async () => button("Continue").click());
  }
  await flushUI();
  await waitOptions();
}
/** Any control that asks the owner to refresh something by hand. */
function refreshControls() {
  return [...host.querySelectorAll("button")]
    .map((item) => item.textContent?.trim() ?? "")
    .filter((label) => /refresh/iu.test(label));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const searchOf = (many: string) =>
  host.querySelector<HTMLInputElement>(
    `.source-filter-picker[aria-label="Choose ${many}"] input[type=search]`,
  )!;

test("the selected table, counts and the gateway's hidden-record sentence, with no separate review page", async () => {
  const saved = { ...policy, rules: [{ action: "share", match: [room("missing-room")] }] };
  await mount({ savedPolicy: saved });
  expect(host.textContent).toContain("Retired room");
  expect(host.textContent).toContain("Unavailable · selection retained");
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("12 shared8 hidden");
  expect(
    [...host.querySelectorAll(".source-filter-unchecked p")].map((line) => line.textContent),
  ).toEqual(["3 records can't be matched to a room and stay hidden."]);
  expect(host.textContent).not.toContain("Review this filter");
  expect(host.textContent).not.toMatch(/finish syncing|couldn.t be checked|Preparing/u);
  expect(host.querySelectorAll("details")).toHaveLength(0);
});

test("both hidden-record sentences show when both counts are not zero, and neither when both are", async () => {
  api.previewSourceFilter.mockImplementation(async (id: string, p: typeof policy) =>
    readyPreview(id, p, {
      tooOld: 312,
      tooOldText: "312 older items could not be resynced and stay hidden from agents using this filter.",
    }),
  );
  await mount();
  expect(
    [...host.querySelectorAll(".source-filter-unchecked p")].map((line) => line.textContent),
  ).toEqual([
    "312 older items could not be resynced and stay hidden from agents using this filter.",
    "3 records can't be matched to a room and stay hidden.",
  ]);
  act(() => render(null, host));
  api.previewSourceFilter.mockImplementation(async (id: string, p: typeof policy) =>
    readyPreview(id, p, { unmatched: 0, unmatchedText: null }),
  );
  clearScopeLabels();
  await mount();
  expect(host.querySelector(".source-filter-unchecked")).toBeNull();
});

test("counts the gateway is still working out show Counting… and are asked for again; Apply never waits", async () => {
  const onApply = vi.fn();
  api.previewSourceFilter
    .mockReset()
    .mockResolvedValueOnce({ status: "pending", retryAfterMs: 300 })
    .mockImplementation(async (id: string, p: typeof policy) => readyPreview(id, p));
  await mount({ onApply });
  expect(host.querySelector(".source-filter-pending")?.textContent).toBe("Counting…");
  expect(host.querySelector(".source-filter-pending .source-filter-spinner")).not.toBeNull();
  expect(refreshControls()).toEqual([]);
  expect(button("Apply filter").disabled).toBe(false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await flushUI();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(2);
  expect(api.previewSourceFilter.mock.calls[1]![1]).toEqual(api.previewSourceFilter.mock.calls[0]![1]);
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("12 shared");
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(policy);
});

test("counts that cannot be loaded say so in one sentence with one way to try again", async () => {
  api.previewSourceFilter.mockReset().mockRejectedValueOnce(new Error("offline"));
  await mount();
  expect(host.querySelector(".source-filter-count-error")?.textContent).toBe(
    "Counts could not be loaded.Try again",
  );
  expect(button("Apply filter").disabled).toBe(false);
  api.previewSourceFilter.mockImplementation(async (id: string, p: typeof policy) => readyPreview(id, p));
  await act(async () => button("Try again").click());
  await flushUI();
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("12 shared");
});

test("saved filters remain inspectable and immutable when the authoring gate is off", async () => {
  const onApply = vi.fn(),
    onRemove = vi.fn();
  await mount({ enabled: false, onApply, onRemove });
  expect(host.textContent).toContain("saved filter remains enforced");
  expect(host.textContent).not.toContain("Apply filter");
  expect(host.querySelector("input[type=search]")).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test("an unsupported saved field is retained and never converted to an editable one-bucket policy", async () => {
  const saved = { ...policy, maxAge: { days: 3 } },
    onApply = vi.fn();
  await mount({ savedPolicy: saved, onApply });
  expect(host.textContent).toContain("complete saved policy is preserved");
  expect(host.textContent).not.toContain("Apply filter");
  expect(onApply).not.toHaveBeenCalled();
  expect(saved.maxAge).toEqual({ days: 3 });
});

test("late preview responses cannot replace the decision the owner is reviewing", async () => {
  const old = deferred<unknown>(),
    fresh = deferred<unknown>();
  api.previewSourceFilter
    .mockReset()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const onApply = vi.fn();
  await mount({ onApply });
  await act(async () => button("Back").click());
  const except = [...host.querySelectorAll<HTMLInputElement>(".source-filter-mode input")][2]!;
  await act(async () => {
    except.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => button("Continue").click());
  await act(async () => fresh.resolve(readyPreview(source.id, policy, { visible: 7, hidden: 13 })));
  await act(async () => old.resolve(readyPreview(source.id, policy, { visible: 99, hidden: 1 })));
  await flushUI();
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("7 shared");
  expect(host.querySelector(".source-filter-counts")?.textContent).not.toContain("99");
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({
      otherwise: "share",
      rules: [{ action: "hide", match: policy.rules[0]!.match }],
    }),
  );
});

test("the header names the filter mode with what it means and the capability as its pill", async () => {
  await mount();
  const context = host.querySelector(".filter-task-context")!;
  const mode = context.querySelector(".access-pill")!;
  expect(mode.textContent).toBe("Share matching content");
  expect(mode.getAttribute("title")).toBe(
    "Only content that matches the criteria in the table below will be shared.",
  );
  expect(context.querySelector(".capability-pill")?.textContent).toBe("Answer");
});

test("each ready field gets its own search, named in the field's words, and people get the typed-address row", async () => {
  await mount();
  expect(
    [...host.querySelectorAll(".filter-builder-searches .source-filter-search")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Search rooms", "Search people", "Search folders"]);
  expect(host.querySelector(".source-filter-typed > span")?.textContent).toBe(
    "Add an email or phone number",
  );
  expect(api.getSourceFilterOptions).not.toHaveBeenCalled();
});

test.each([
  [
    { status: "needs-resync", cost: "This reads about 900 messages a day.", text: "Room filters need Fictional to be resynced. Your rooms stay searchable meanwhile. This reads about 900 messages a day." },
    "Room filters need Fictional to be resynced. Your rooms stay searchable meanwhile. This reads about 900 messages a day.",
    true,
  ],
  [
    { status: "collector-behind", devices: [{ id: "dev-one", name: "Studio Mac" }], text: "Update Omnesis on Studio Mac to use these filters." },
    "Update Omnesis on Studio Mac to use these filters.",
    false,
  ],
  [{ status: "gateway-behind", text: "Update this Omnesis gateway to use these filters." }, "Update this Omnesis gateway to use these filters.", false],
  [{ status: "list-pending", text: "Waiting for Fictional to send its list of rooms." }, "Waiting for Fictional to send its list of rooms.", false],
])("a field in state %o shows the gateway's sentence in place of its search", async (state, text, resync) => {
  api.getSourceFilterEditor.mockResolvedValue(editorWith([{ ...roomField, state }, peopleField]));
  await mount();
  const block = host.querySelector<HTMLElement>('.source-filter-field-state[aria-label="Rooms"]')!;
  expect(block.querySelector("strong")?.textContent).toBe("Rooms");
  expect(block.querySelector(".source-filter-state p")?.textContent).toBe(text);
  expect(block.querySelector("button")?.textContent).toBe(resync ? "Resync Fictional account" : undefined);
  expect(searchOf("rooms")).toBeNull();
  // The other field stays usable, and the saved entry on the waiting field stays saved.
  expect(searchOf("people")).not.toBeNull();
  expect(host.querySelector(".compact-filter-table")?.textContent).toContain("Fictional room");
  expect(button("Apply filter").disabled).toBe(false);
  expect(refreshControls()).toEqual([]);
});

test("Resync starts an in-place resync, shows it starting, then the gateway's progress, read again by itself", async () => {
  const needs = {
    status: "needs-resync",
    cost: null,
    text: "Room filters need Fictional to be resynced. Your rooms stay searchable meanwhile.",
  };
  const resyncing = { status: "resyncing", processed: 212, total: 900, text: "Resyncing Fictional: 212 of about 900." };
  const started = deferred<unknown>();
  api.resyncSource.mockReturnValue(started.promise);
  api.getSourceFilterEditor
    .mockReset()
    .mockResolvedValueOnce(editorWith([{ ...roomField, state: needs }]))
    .mockResolvedValueOnce(editorWith([{ ...roomField, state: needs }]))
    .mockResolvedValue(editorWith([{ ...roomField, state: resyncing }], { retryAfterMs: 200 }));
  await mount();
  await act(async () => button("Resync Fictional account").click());
  expect(api.resyncSource).toHaveBeenCalledWith(source.id, { mode: "in-place" });
  expect(host.querySelector(".source-filter-state p")?.textContent).toBe("Resyncing Fictional account…");
  expect(host.querySelector(".source-filter-state button")).toBeNull();
  await act(async () => started.resolve({ ok: true, mode: "in-place" }));
  await flushUI();
  // The gateway may still say it needs a resync for a moment; the owner's request stays shown.
  expect(host.querySelector(".source-filter-state p")?.textContent).toBe("Resyncing Fictional account…");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5100));
  });
  await flushUI();
  expect(host.querySelector(".source-filter-state p")?.textContent).toBe("Resyncing Fictional: 212 of about 900.");
  const bar = host.querySelector("progress.source-filter-progress")!;
  expect([bar.getAttribute("value"), bar.getAttribute("max")]).toEqual(["212", "900"]);
  const reads = api.getSourceFilterEditor.mock.calls.length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await flushUI();
  expect(api.getSourceFilterEditor.mock.calls.length).toBeGreaterThan(reads);
}, 10_000);

test("a resync that cannot start says so and offers the button again", async () => {
  const needs = { status: "needs-resync", cost: null, text: "Room filters need Fictional to be resynced." };
  api.getSourceFilterEditor.mockResolvedValue(editorWith([{ ...roomField, state: needs }]));
  api.resyncSource.mockRejectedValue(Object.assign(new Error("x"), { serverMessage: "Fictional is not connected." }));
  await mount();
  await act(async () => button("Resync Fictional account").click());
  await flushUI();
  expect(host.querySelector(".source-filter-state [role='alert']")?.textContent).toBe(
    "Fictional is not connected.",
  );
  expect(button("Resync Fictional account")).not.toBeNull();
});

test("fields waiting for the same resync share one block and one button, with no search for either", async () => {
  const needs = (noun: string) => ({
    status: "needs-resync",
    cost: "This reads about 900 messages a day.",
    text: `${noun} filters need Fictional to be resynced. Your rooms stay searchable meanwhile. This reads about 900 messages a day.`,
  });
  api.getSourceFilterEditor.mockResolvedValue(
    editorWith([
      { ...peopleField, state: needs("People") },
      { ...roomField, state: needs("Room") },
      folderField,
    ]),
  );
  await mount();
  const blocks = [...host.querySelectorAll<HTMLElement>(".source-filter-field-state")];
  expect(blocks.map((block) => block.getAttribute("aria-label"))).toEqual(["People and rooms"]);
  expect(blocks[0]!.querySelector(".source-filter-state p")?.textContent).toBe(
    "People and room filters need Fictional to be resynced. Your rooms stay searchable meanwhile. This reads about 900 messages a day.",
  );
  expect(blocks[0]!.querySelectorAll("button")).toHaveLength(1);
  expect(searchOf("people")).toBeNull();
  expect(searchOf("rooms")).toBeNull();
  expect(host.querySelector(".source-filter-typed")).toBeNull();
  expect(searchOf("folders")).not.toBeNull();
});

test("a resync in progress is one block for the account; fields in other states keep their own", async () => {
  const resyncing = { status: "resyncing", processed: 212, total: 900, text: "Resyncing Fictional: 212 of about 900." };
  const pending = { status: "list-pending", text: "Waiting for Fictional to send its list of folders." };
  api.getSourceFilterEditor.mockResolvedValue(
    editorWith([
      { ...roomField, state: resyncing },
      { ...peopleField, state: resyncing },
      { ...folderField, state: pending },
    ]),
  );
  await mount();
  const blocks = [...host.querySelectorAll<HTMLElement>(".source-filter-field-state")];
  expect(blocks.map((block) => block.getAttribute("aria-label"))).toEqual(["Rooms and people", "Folders"]);
  expect(blocks[0]!.querySelectorAll("progress")).toHaveLength(1);
  expect(blocks[0]!.querySelector("p")?.textContent).toBe("Resyncing Fictional: 212 of about 900.");
  expect(blocks[1]!.textContent).toContain("Waiting for Fictional to send its list of folders.");
});

test("sentences that do not open the gateway's usual way are shown one after another", async () => {
  // @ts-expect-error — portal modules are plain JavaScript.
  const { sharedResyncText } = await import("./source-filter-fields.js");
  expect(
    sharedResyncText([
      { state: { text: "Label filters need Fictional to be resynced. It reads about 900 a day." } },
      { state: { text: "People filters need Fictional to be resynced. It reads about 900 a day." } },
      { state: { text: "Folder filters need Fictional to be resynced. It reads about 900 a day." } },
    ]),
  ).toBe("Label, people and folder filters need Fictional to be resynced. It reads about 900 a day.");
  expect(sharedResyncText([{ state: { text: "Resync first." } }, { state: { text: "Then again." } }])).toBe(
    "Resync first. Then again.",
  );
});

test("an editor that cannot be loaded says so, keeps the saved entries and can be asked again", async () => {
  api.getSourceFilterEditor.mockReset().mockRejectedValueOnce(new Error("offline"));
  await mount();
  expect(host.textContent).toContain("This account’s filters could not be loaded.");
  expect(host.querySelector(".compact-filter-table")?.textContent).toContain("Fictional room");
  api.getSourceFilterEditor.mockResolvedValue(editorWith([roomField]));
  await act(async () => button("Try again").click());
  await flushUI();
  expect(searchOf("rooms")).not.toBeNull();
});

test("a late picker response from another account is aborted and never displayed", async () => {
  const old = deferred<unknown>(),
    fresh = deferred<unknown>();
  api.getSourceFilterOptions
    .mockReset()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const editor = editorWith([roomField]);
  await act(async () =>
    render(h(SourceFilterPicker, { source, editor, field: roomField, selected: [], onToggle: vi.fn() }), host),
  );
  await waitOptions();
  const other = { ...source, id: "fictional:two" };
  await act(async () =>
    render(h(SourceFilterPicker, { source: other, editor, field: roomField, selected: [], onToggle: vi.fn() }), host),
  );
  await waitOptions();
  const row = (label: string, count: number) => ({ ref: room("shared-native-id"), label, shortLabel: label, count });
  await act(async () => fresh.resolve({ sourceId: other.id, items: [row("Second account room", 2)] }));
  await act(async () => old.resolve({ sourceId: source.id, items: [row("First account room", 99)] }));
  await flushUI();
  expect(host.textContent).toContain("Second account room");
  expect(host.textContent).not.toContain("First account room");
});

test("a typed address is read by the gateway and added in its spelling; a refusal shows the gateway's sentence", async () => {
  const onToggle = vi.fn();
  await act(async () =>
    render(
      h(SourceFilterEditor, {
        source,
        capability: "answer",
        accessLevel: "saved-level",
        savedPolicy: policy,
        enabled: true,
        onApply: vi.fn(),
        onRemove: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  await act(async () => button("Continue").click());
  await flushUI();
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Value']")!;
  const select = host.querySelector<HTMLSelectElement>("select[aria-label='Type']")!;
  expect([...select.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toEqual([
    "email",
    "phone",
  ]);
  await act(async () => {
    for (const option of select.querySelectorAll("option"))
      option.toggleAttribute("selected", option.getAttribute("value") === "phone");
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  api.checkFilterIdentifier.mockResolvedValueOnce({
    error: "Enter a valid phone number. Include the international country code.",
  });
  await type(input, "+44 (0)7700 900123");
  await act(async () => button("Add").click());
  await flushUI();
  expect(api.checkFilterIdentifier).toHaveBeenLastCalledWith("phone", "+44 (0)7700 900123");
  expect(host.querySelector(".source-filter-exact [role='alert']")?.textContent).toBe(
    "Enter a valid phone number. Include the international country code.",
  );
  api.checkFilterIdentifier.mockResolvedValueOnce({ identifier: { type: "phone", value: "+15550100142" } });
  await type(input, "00 1 (555) 010-0142");
  await act(async () => button("Add").click());
  await flushUI();
  expect(host.querySelector(".source-filter-exact [role='alert']")).toBeNull();
  expect(input.value).toBe("");
  const rows = [...host.querySelectorAll(".compact-filter-table tbody tr")].map((row) => row.textContent);
  expect(rows.some((text) => text?.startsWith("Phone+15550100142"))).toBe(true);
  expect(onToggle).not.toHaveBeenCalled();
});

test("the picker of a tree browses level by level, short names inside, full names in search, empty folders included", async () => {
  const folder = (id: string) => ({ capability: "tree", field: "extra.folder", id });
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { field: string; q?: string; parentId?: string }) => ({
      sourceId: id,
      field: query.field,
      items: query.q
        ? [{ ref: folder("~/work/atlas-api"), label: "~/work/atlas-api", shortLabel: "atlas-api", count: 4 }]
        : query.parentId
          ? [
              { ref: folder("~/work/atlas-api"), label: "~/work/atlas-api", shortLabel: "atlas-api", count: 4, parentId: "~/work", depth: 1 },
              { ref: folder("~/work/empty-drafts"), label: "~/work/empty-drafts", shortLabel: "empty-drafts", count: 0, parentId: "~/work", depth: 1 },
            ]
          : [{ ref: folder("~/work"), label: "~/work", shortLabel: "work", count: 4, hasChildren: true, depth: 0 }],
    }),
  );
  await mount();
  const search = searchOf("folders");
  await act(async () => search.dispatchEvent(new window.Event("input", { bubbles: true })));
  await waitOptions();
  const picker = search.closest(".source-filter-picker")!;
  expect(picker.querySelector(".source-filter-breadcrumbs")?.textContent).toContain("All folders");
  expect(picker.querySelector(".filter-option-hint")?.textContent).toBe("Includes the folders inside.");
  await act(async () => picker.querySelector<HTMLButtonElement>('button[aria-label="Open work"]')!.click());
  await waitOptions();
  expect(api.getSourceFilterOptions).toHaveBeenLastCalledWith(
    source.id,
    { field: "extra.folder", parentId: "~/work" },
    expect.any(AbortSignal),
  );
  expect([...picker.querySelectorAll(".source-filter-options li label")].map((row) => row.textContent)).toEqual([
    "atlas-api4 matching",
    "empty-drafts0 matching",
  ]);
  expect(picker.querySelector(".source-filter-select-location")?.textContent).toBe("Select this folder");
  await type(search, "atlas");
  await waitOptions();
  expect(picker.querySelector(".source-filter-options li label")?.textContent).toBe("~/work/atlas-api4 matching");
  expect(picker.querySelector(".source-filter-breadcrumbs")).toBeNull();
});

test("a field whose items belong to a device starts at the devices when the account has several", async () => {
  const project = { ...folderField, field: "extra.project", noun: noun("project folder", "project folders"), scope: "device", levels: [noun("project folder", "project folders")], insideText: "Includes the project folders inside." };
  const device = (id: string) => ({ capability: "tree", field: "extra.project", id: "", device: id });
  api.getSourceFilterEditor.mockResolvedValue(
    editorWith([project], { showDeviceLevel: true, devices: [{ id: "dev-one", name: "Studio Mac" }, { id: "dev-two", name: "Travel laptop" }] }),
  );
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { field: string; device?: string; parentId?: string }) => ({
      sourceId: id,
      field: query.field,
      items: query.device
        ? [{ ref: { capability: "tree", field: "extra.project", id: "~", device: query.device }, label: "~", shortLabel: "~", count: 3, depth: 0 }]
        : [
            { ref: device("dev-one"), label: "Studio Mac", shortLabel: "Studio Mac", count: 3, hasChildren: true },
            { ref: device("dev-two"), label: "Travel laptop", shortLabel: "Travel laptop", count: 1, hasChildren: true },
          ],
    }),
  );
  const onApply = vi.fn();
  await mount({ savedPolicy: null, onApply });
  const only = [...host.querySelectorAll<HTMLInputElement>(".source-filter-mode input")][1]!;
  await act(async () => only.dispatchEvent(new window.Event("change", { bubbles: true })));
  await act(async () => button("Continue").click());
  await flushUI();
  await waitOptions();
  const search = searchOf("project folders");
  await act(async () => search.dispatchEvent(new window.Event("input", { bubbles: true })));
  await waitOptions();
  const picker = search.closest(".source-filter-picker")!;
  expect(api.getSourceFilterOptions).toHaveBeenLastCalledWith(source.id, { field: "extra.project" }, expect.any(AbortSignal));
  expect(picker.querySelector(".source-filter-breadcrumbs")?.textContent).toContain("All devices");
  const travel = [...picker.querySelectorAll<HTMLInputElement>(".source-filter-options input")][1]!;
  await act(async () => travel.dispatchEvent(new window.Event("change", { bubbles: true })));
  await act(async () => picker.querySelector<HTMLButtonElement>('button[aria-label="Open Studio Mac"]')!.click());
  await waitOptions();
  expect(api.getSourceFilterOptions).toHaveBeenLastCalledWith(
    source.id,
    { field: "extra.project", device: "dev-one" },
    expect.any(AbortSignal),
  );
  expect(picker.querySelector(".source-filter-select-location")?.textContent).toBe("Select this device");
  await flushUI();
  await act(async () => button("Apply filter").click());
  expect(onApply.mock.calls[0]![0].rules[0].match).toEqual([device("dev-two")]);
  expect([...host.querySelectorAll(".compact-filter-kind")].map((cell) => cell.textContent)).toEqual(["Device"]);
});

test("a tree whose levels have their own names says which level each row and location is at", async () => {
  const repoField = {
    ...folderField,
    field: "extra.repository",
    noun: noun("repository", "repositories"),
    levels: [noun("owner", "owners"), noun("repository", "repositories")],
    insideText: "Includes the repositories inside.",
  };
  const repo = (id: string) => ({ capability: "tree", field: "extra.repository", id });
  api.getSourceFilterEditor.mockResolvedValue(editorWith([repoField]));
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { field: string; parentId?: string }) => ({
      sourceId: id,
      field: query.field,
      items: query.parentId
        ? [{ ref: repo("repo:1"), label: "northstar-labs/atlas-api", shortLabel: "atlas-api", count: 2, parentId: "owner:1", depth: 1 }]
        : [{ ref: repo("owner:1"), label: "northstar-labs", shortLabel: "northstar-labs", count: 5, hasChildren: true, depth: 0 }],
    }),
  );
  await mount({ savedPolicy: { ...policy, rules: [{ action: "share", match: [repo("owner:1")] }] } });
  await waitOptions();
  // The saved owner is named as an owner although the preview gave no depth.
  expect([...host.querySelectorAll(".compact-filter-kind")].map((cell) => cell.textContent)).toEqual(["Owner"]);
  const search = searchOf("repositories");
  await act(async () => search.dispatchEvent(new window.Event("input", { bubbles: true })));
  await waitOptions();
  const picker = search.closest(".source-filter-picker")!;
  expect(picker.querySelector(".source-filter-breadcrumbs")?.textContent).toContain("All owners");
  expect(picker.querySelector(".source-filter-options small")?.textContent).toBe("Owner · 5 matching");
  await act(async () => picker.querySelector<HTMLButtonElement>('button[aria-label="Open northstar-labs"]')!.click());
  await waitOptions();
  expect(picker.querySelector(".source-filter-select-location")?.textContent).toBe("Select this owner");
  expect(picker.querySelector(".source-filter-options small")?.textContent).toBe("Repository · 2 matching");
  expect(picker.querySelector(".source-filter-options li label span")?.textContent).toBe("atlas-api");
});

test("search results overlay the selected table and Escape dismisses search before the modal", async () => {
  const onClose = vi.fn();
  await mount({ onClose });
  const [first, second] = [
    ...host.querySelectorAll<HTMLInputElement>(".filter-builder-searches input[type=search]"),
  ];
  await type(first!, "room");
  await waitOptions();
  expect(first!.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelectorAll(".source-filter-results:not([hidden])")).toHaveLength(1);
  const escape = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  await act(async () => {
    first!.closest(".source-filter-picker")!.dispatchEvent(escape);
  });
  expect(first!.getAttribute("aria-expanded")).toBe("false");
  expect(onClose).not.toHaveBeenCalled();
  await type(second!, "person");
  expect(second!.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  });
  expect(second!.getAttribute("aria-expanded")).toBe("false");
  expect(onClose).not.toHaveBeenCalled();
});

test("changing the source closes the child draft without previewing the old policy for the new account", async () => {
  const onClose = vi.fn(),
    onApply = vi.fn();
  await mount({ onClose, onApply });
  api.previewSourceFilter.mockClear();
  await act(async () =>
    render(
      h(SourceFilterEditor, {
        source: { ...source, id: "fictional:other" },
        capability: "answer",
        accessLevel: "saved-level",
        savedPolicy: policy,
        enabled: true,
        onApply,
        onRemove: vi.fn(),
        onClose,
      }),
      host,
    ),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
});

test("a saved name not yet resolved reads as loading until the preview names it", async () => {
  const response = deferred<unknown>();
  const ref = { capability: "membership", field: "extra.labelIds", id: "unresolved-label-47" };
  api.getSourceFilterEditor.mockResolvedValue(
    editorWith([{ ...roomField, field: "extra.labelIds", noun: noun("label", "labels") }]),
  );
  api.previewSourceFilter.mockReturnValue(response.promise);
  await mount({ savedPolicy: { ...policy, rules: [{ action: "share", match: [ref] }] } });
  expect(host.textContent).toContain("Counting…");
  expect(host.textContent).toContain("Saved label selection");
  expect(host.textContent).toContain("Loading name");
  await act(async () =>
    response.resolve({ ...readyPreview(source.id, policy), items: [{ ref, label: "Resolved label", count: 4 }] }),
  );
  await flushUI();
  expect(host.textContent).toContain("Resolved label");
});

test("saved rule summaries keep missing entries without showing their opaque ids", async () => {
  const ref = room("opaque-summary-room-88");
  const saved = { ...policy, rules: [{ action: "share", match: [ref] }] };
  api.previewSourceFilter.mockResolvedValue({
    ...readyPreview(source.id, saved),
    items: [{ ref, label: ref.id, missing: true, count: 0 }],
  });
  await act(async () => render(answerSummary(saved), host));
  await flushUI();
  await waitOptions();
  expect(host.textContent).toContain("Saved selection");
  expect(host.textContent).toContain("Unavailable · selection retained");
  expect(host.textContent).not.toContain(ref.id);
});

test("an unfiltered account opens as All content and continuing cannot imply a new restriction", async () => {
  const onApply = vi.fn(),
    onRemove = vi.fn(),
    onClose = vi.fn();
  await mount({ savedPolicy: null, onApply, onRemove, onClose });
  const all = [...host.querySelectorAll<HTMLLabelElement>(".source-filter-mode label")].find((row) =>
    row.textContent?.includes("All content"),
  )!;
  expect(all.querySelector<HTMLInputElement>("input")!.hasAttribute("checked")).toBe(true);
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
  await act(async () => button("Done").click());
  expect(onClose).toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test("an account that is no longer connected lists its saved filters, counts nothing, and applies a removal", async () => {
  const kept = room("kept-room");
  const saved = { ...policy, rules: [{ action: "share", match: [...policy.rules[0]!.match, kept] }] };
  const onApply = vi.fn();
  await mount({ source: { id: source.id, displayName: "Fictional", available: false }, savedPolicy: saved, onApply });
  expect(host.querySelector(".source-filter-notice")?.textContent).toBe(
    "This account is no longer connected. Saved filters can be removed but not added.",
  );
  expect(host.querySelector("input[type=search]")).toBeNull();
  const removals = () => [...host.querySelectorAll<HTMLButtonElement>(".compact-filter-remove")];
  expect(removals()).toHaveLength(2);
  expect(host.textContent).not.toContain("Counts could not be loaded");
  expect(button("Apply filter").disabled).toBe(true);
  await act(async () => removals()[0]!.click());
  expect(button("Apply filter").disabled).toBe(false);
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith({ ...saved, rules: [{ action: "share", match: [kept] }] });
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
});

test("removing every saved filter of an account that is no longer connected leaves nothing to apply", async () => {
  await mount({ source: { id: source.id, displayName: "Fictional", available: false } });
  await act(async () => host.querySelector<HTMLButtonElement>(".compact-filter-remove")!.click());
  expect(button("Apply filter").disabled).toBe(true);
});

test("a new Direct capability starts with Answer filters rebound to its own draft audience and zero revision", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "allowlist", sourceIds: [source.id] },
    filterRevision: 0,
    scopePolicies: [{ ...policy, audience: { accessLevel: "new", capability: "answer" } }],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(CapabilityPicker, {
        value: { answer },
        onChange,
        linkDirect: true,
        sourceFiltersEnabled: true,
      }),
      host,
    ),
  );
  const direct = [...host.querySelectorAll("label")]
    .find((label) => label.querySelector("strong")?.textContent === "Direct")!
    .querySelector("input") as HTMLInputElement;
  direct.checked = true;
  await act(async () => {
    direct.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const next = onChange.mock.lastCall![0];
  expect(next.answer).toBe(answer);
  expect(next.direct).toMatchObject({
    filterRevision: 0,
    scopePolicies: [{ audience: { accessLevel: "new", capability: "direct" } }],
  });
  expect(next.direct.scopePolicies[0]).not.toBe(answer.scopePolicies[0]);
});

test("unlinking a new Direct draft before enabling it keeps Answer filters independent", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    scopePolicies: [policy],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(CapabilityPicker, {
        value: { answer },
        onChange,
        linkDirect: false,
      }),
      host,
    ),
  );
  const direct = [...host.querySelectorAll("label")]
    .find((label) => label.querySelector("strong")?.textContent === "Direct")!
    .querySelector("input") as HTMLInputElement;
  direct.checked = true;
  await act(async () => {
    direct.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct.scopePolicies).toBeUndefined();
  expect(onChange.mock.lastCall![0].answer.scopePolicies).toEqual([policy]);
});

test.each([false, null, undefined])(
  "new Direct never copies filtered Answer while authoring is %s",
  async (sourceFiltersEnabled) => {
    const answer = {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      scopePolicies: [policy],
    };
    const onChange = vi.fn();
    await act(async () =>
      render(
        h(CapabilityPicker, { value: { answer }, onChange, linkDirect: true, sourceFiltersEnabled }),
        host,
      ),
    );
    const input = [...host.querySelectorAll("label")]
      .find((label) => label.querySelector("strong")?.textContent === "Direct")!
      .querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.checked = true;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0].answer).toBe(answer);
    expect(onChange.mock.lastCall![0].direct.scopePolicies ?? []).toEqual([]);
  },
);

test("removing and restoring a capability preserves its own filtered draft without copying its sibling", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    scopePolicies: [],
  };
  const direct = {
    capability: "direct",
    sources: { mode: "all", sourceIds: [] },
    filterRevision: 4,
    scopePolicies: [{ ...policy, audience: { accessLevel: "new", capability: "direct" } }],
  };
  const onChange = vi.fn();
  let value = { answer, direct };
  const mountPicker = () =>
    render(h(CapabilityPicker, { value, onChange, linkDirect: true, sourceFiltersEnabled: true }), host);
  await act(async () => mountPicker());
  const input = () =>
    [...host.querySelectorAll("label")]
      .find((label) => label.querySelector("strong")?.textContent === "Direct")!
      .querySelector("input") as HTMLInputElement;
  await act(async () => {
    input().checked = false;
    input().dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct).toBeUndefined();
  value = onChange.mock.lastCall![0];
  await act(async () => mountPicker());
  await act(async () => {
    input().checked = true;
    input().dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct).toBe(direct);
});

