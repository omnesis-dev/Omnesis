// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The tasks view as rendered: the tabs carry each view's count, Today points
 * at the capture view for adding tasks, a row's whole line opens its actions
 * while the bullet and document links keep their own clicks, and every read
 * hands its counts to the shell for the nav.
 *
 * All fixture data is invented.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  taskAction: vi.fn(),
  undoTask: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../api.js", async (original) => ({ ...(await original<Record<string, unknown>>()), ...api }));
vi.mock("../lib/router.js", async (original) => ({ ...(await original<Record<string, unknown>>()), ...router }));
// @ts-expect-error — portal is plain JS without sibling declarations.
import { TasksView, isRowToggleClick } from "./tasks.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { TASK_COUNTS_EVENT } from "../lib/task-counts.js";

const COUNTS = { today: 2, month: 10, future: 0, anytime: 3, waiting: 1, suggested: 4, proposals: 0, carried: 0 };

const task = (fields: Record<string, unknown>) => ({
  description: "",
  state: "open",
  origin: "user",
  accepted: true,
  scheduledFor: null,
  deadline: null,
  dueDay: null,
  carried: false,
  completionNote: null,
  proposedChange: null,
  actors: [],
  blockedBy: [],
  documents: [],
  ...fields,
});

let host: HTMLElement;
let win: Window;

beforeEach(() => {
  vi.clearAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  win = dom.window as unknown as Window;
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  api.listTasks.mockImplementation(async (view: string, day: string) => ({
    view,
    day,
    counts: COUNTS,
    tasks: [
      task({ id: "loop_a", title: "Book the venue walkthrough" }),
      task({
        id: "loop_b",
        title: "Send the Q4 budget review",
        documents: [{ id: "doc_1", title: "Q4 budget draft", sourceId: "notes" }],
      }),
    ],
  }));
});

afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function mount(props: Record<string, unknown> = {}) {
  await act(async () => render(h(TasksView, props), host));
  await act(async () => {
    await Promise.resolve();
  });
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  el.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("click", { bubbles: true, cancelable: true }));
}

const tabs = () => [...host.querySelectorAll(".tasks-tab")].map((tab) => tab.textContent?.trim());
const row = (id: string) =>
  [...host.querySelectorAll(".tasks-row")].find((li) => li.textContent?.includes(id)) as Element;

it("shows each view's count on its tab, never on History or a zero", async () => {
  await mount({ experimental: true });
  expect(tabs()).toEqual(["Today (2)", "Month (10)", "Future", "Anytime (3)", "Waiting (1)", "Suggested (4)", "Done"]);
});

it("points at the capture view instead of offering a text field", async () => {
  await mount();
  expect(host.querySelector(".tasks-add-input, form.tasks-add")).toBeNull();
  const hint = host.querySelector(".tasks-add-hint");
  expect(hint?.textContent?.replace(/\s+/g, " ").trim()).toBe(["Use", "Tell", "Omnesis", "to add tasks."].join(" "));
  const link = hint?.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/portal/capture");
  await act(async () => click(link ?? null));
  expect(router.navigate).toHaveBeenCalledWith("/portal/capture");
});

it("opens a row's actions from its line and its title", async () => {
  await mount();
  const venue = () => row("Book the venue walkthrough");
  await act(async () => click(venue().querySelector(".tasks-row-main")));
  expect(venue().classList.contains("expanded")).toBe(true);
  await act(async () => click(venue().querySelector(".tasks-row-main")));
  expect(venue().classList.contains("expanded")).toBe(false);
  await act(async () => click(venue().querySelector(".tasks-row-title")));
  expect(venue().classList.contains("expanded")).toBe(true);
});

it("lets the bullet, document links and empty space beside the title behave as they should", async () => {
  await mount();
  const budget = row("Send the Q4 budget review");
  const at = (selector: string) => isRowToggleClick({ target: budget.querySelector(selector) });
  // Empty space on the line, beside or under the title.
  expect(at(".tasks-row-body")).toBe(true);
  expect(at(".tasks-documents")).toBe(true);
  // Controls with their own behaviour — including a link's inner parts.
  expect(at("button.tasks-bullet")).toBe(false);
  expect(at(".tasks-row-title")).toBe(false);
  expect(at(".tasks-document-link")).toBe(false);
  expect(at(".tasks-document-title")).toBe(false);

  api.taskAction.mockResolvedValue({ task: {}, receipt: { text: "Done.", undoSeq: 7 } });
  await act(async () => click(budget.querySelector("button.tasks-bullet")));
  expect(api.taskAction).toHaveBeenCalledWith("loop_b", { action: "complete" });
});

it("hands every read's counts to the shell", async () => {
  const seen: unknown[] = [];
  win.addEventListener(TASK_COUNTS_EVENT, (event) => seen.push((event as CustomEvent).detail.counts));
  await mount();
  expect(seen).toEqual([COUNTS]);
});
