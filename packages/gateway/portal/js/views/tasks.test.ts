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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  taskAction: vi.fn(),
  undoTask: vi.fn(),
  openTaskConversation: vi.fn(),
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

/** Let a clicked action finish: its request, the reload and the re-render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("a suggestion", () => {
  beforeEach(() => {
    api.listTasks.mockImplementation(async (view: string, day: string) => ({
      view,
      day,
      counts: COUNTS,
      tasks: [task({ id: "loop_s", title: "Renew the parking permit", origin: "brain", accepted: false })],
    }));
    api.taskAction.mockResolvedValue({ task: {}, receipt: { text: "Done.", undoSeq: 9 } });
  });
  const suggestion = () => row("Renew the parking permit");
  const button = (label: string) =>
    [...suggestion().querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;

  it("is marked already done from its bullet", async () => {
    await mount({ experimental: true, taskView: "suggested" });
    const bullet = suggestion().querySelector("button.tasks-bullet");
    expect(bullet?.getAttribute("aria-label")).toBe("Mark “Renew the parking permit” as already done");
    await act(async () => click(bullet));
    expect(api.taskAction).toHaveBeenCalledWith("loop_s", { action: "complete" });
  });

  it("offers Accept, Accept with note, Mark as done and Ignore", async () => {
    await mount({ experimental: true, taskView: "suggested" });
    const labels = [...suggestion().querySelectorAll(".tasks-suggestion-actions button")].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(["Accept", "Accept with note", "Mark as done", "Ignore"]);
    await act(async () => click(button("Ignore")));
    expect(api.taskAction).toHaveBeenLastCalledWith("loop_s", { action: "ignore" });
    await settle();
    await act(async () => click(button("Mark as done")));
    expect(api.taskAction).toHaveBeenLastCalledWith("loop_s", { action: "complete" });
    await settle();
    await act(async () => click(button("Accept")));
    expect(api.taskAction).toHaveBeenLastCalledWith("loop_s", { action: "accept" });
  });

  it("is accepted with a note the user writes", async () => {
    await mount({ experimental: true, taskView: "suggested" });
    await act(async () => click(button("Accept with note")));
    const field = suggestion().querySelector("textarea") as unknown as HTMLTextAreaElement;
    expect(field.getAttribute("aria-label")).toBe("Note about “Renew the parking permit”");
    await act(async () => {
      field.value = "  the old one runs out on the 20th ";
      field.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });
    const form = suggestion().querySelector("form.tasks-suggestion-note");
    await act(async () => {
      form?.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.taskAction).toHaveBeenCalledWith("loop_s", {
      action: "accept",
      note: "the old one runs out on the 20th",
      noteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});

describe("an action in flight", () => {
  function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const venue = () => row("Book the venue walkthrough");
  const bullet = () => venue().querySelector("button.tasks-bullet") as Element;
  const alert = () => host.querySelector(".tasks-error");

  it("shows the completion at once and sends no second request", async () => {
    const reply = deferred();
    api.taskAction.mockReturnValue(reply.promise);
    await mount();
    await act(async () => click(bullet()));
    expect(venue().classList.contains("pending")).toBe(true);
    expect(venue().getAttribute("aria-busy")).toBe("true");
    expect(bullet().classList.contains("tasks-bullet-done")).toBe(true);
    expect(bullet().hasAttribute("disabled")).toBe(true);
    await act(async () => click(bullet()));
    await act(async () => click(bullet()));
    expect(api.taskAction).toHaveBeenCalledTimes(1);

    const reads = api.listTasks.mock.calls.length;
    await act(async () => reply.resolve({ task: {}, receipt: { text: "Done: Book the venue walkthrough", undoSeq: 3 } }));
    await settle();
    expect(api.listTasks.mock.calls.length).toBe(reads + 1);
    expect(venue().classList.contains("pending")).toBe(false);
    expect(bullet().hasAttribute("disabled")).toBe(false);
  });

  it("restores the row and shows the error when the action fails", async () => {
    const reply = deferred();
    api.taskAction.mockReturnValue(reply.promise);
    await mount();
    await act(async () => click(bullet()));
    await act(async () => reply.reject(Object.assign(new Error("HTTP 409"), { serverMessage: "the task changed meanwhile" })));
    await settle();
    expect(venue().classList.contains("pending")).toBe(false);
    expect(bullet().classList.contains("tasks-bullet-open")).toBe(true);
    expect(alert()?.textContent).toContain("the task changed meanwhile");
  });

  it("treats a completion the gateway finds already done as applied", async () => {
    api.taskAction.mockRejectedValue(
      Object.assign(new Error("HTTP 400"), { code: "TASK_ALREADY_DONE", serverMessage: "the task is already done" }),
    );
    await mount();
    const reads = api.listTasks.mock.calls.length;
    await act(async () => click(bullet()));
    await settle();
    expect(alert()).toBeNull();
    expect(api.listTasks.mock.calls.length).toBe(reads + 1);
  });

  it("still reports that refusal for an action that is not a completion", async () => {
    api.taskAction.mockRejectedValue(
      Object.assign(new Error("HTTP 400"), { code: "TASK_ALREADY_DONE", serverMessage: "the task is already done" }),
    );
    await mount();
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    const strike = [...venue().querySelectorAll(".tasks-actions button")].find((b) => b.textContent?.trim() === "Strike");
    await act(async () => click(strike ?? null));
    await settle();
    expect(alert()?.textContent).toContain("the task is already done");
  });

  it("disables every action in the open row, the Done button and the moves included", async () => {
    const reply = deferred();
    api.taskAction.mockReturnValue(reply.promise);
    await mount();
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    const actions = () => [...venue().querySelectorAll(".tasks-done-btn, .tasks-actions button")];
    const labelled = (label: string) => actions().find((b) => b.textContent?.trim() === label) ?? null;
    await act(async () => click(labelled("Strike")));
    expect(api.taskAction).toHaveBeenCalledWith("loop_a", { action: "strike" });
    const disabled = actions()
      .filter((b) => b.hasAttribute("disabled"))
      .map((b) => b.textContent?.trim());
    expect(disabled).toEqual(expect.arrayContaining(["Done", "Tomorrow", "Strike"]));
    // Reading the task's history or opening the editor changes nothing, so they stay available.
    expect(labelled("History")?.hasAttribute("disabled")).toBe(false);
    // The bullet keeps the task's own ring for an action that is not a completion.
    expect(bullet().classList.contains("tasks-bullet-open")).toBe(true);
    await act(async () => click(labelled("Done")));
    expect(api.taskAction).toHaveBeenCalledTimes(1);
    await act(async () => reply.resolve({ task: {}, receipt: { text: "Struck", undoSeq: 4 } }));
    await settle();
    expect(labelled("Done")?.hasAttribute("disabled")).toBe(false);
  });
});

describe("Chat about this", () => {
  const venue = () => row("Book the venue walkthrough");
  const chatButton = () =>
    [...venue().querySelectorAll(".tasks-actions button")].find((b) =>
      b.textContent?.includes("Chat about this"),
    ) ?? null;
  const actionLabels = () =>
    [...venue().querySelectorAll(".tasks-actions button")].map((b) => b.textContent?.trim());

  it("sits right of History, only where the gateway serves it", async () => {
    await mount();
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    expect(chatButton()).toBeNull();

    render(null, host);
    await mount({ chatAvailable: true });
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    const labels = actionLabels();
    expect(labels.slice(-2)).toEqual(["History", "Chat about this"]);
  });

  it("opens a new conversation about the task and shows it", async () => {
    api.openTaskConversation.mockResolvedValue({ conversation: { id: "s_chat 1" } });
    await mount({ chatAvailable: true });
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    await act(async () => click(chatButton()));
    await settle();
    expect(api.openTaskConversation).toHaveBeenCalledWith("loop_a");
    expect(router.navigate).toHaveBeenCalledWith("/portal/agent/s_chat%201");
  });

  it("says why when the conversation cannot be opened, and stays on the task", async () => {
    api.openTaskConversation.mockRejectedValue(
      Object.assign(new Error("503"), { serverMessage: "The agent is not available." }),
    );
    await mount({ chatAvailable: true });
    await act(async () => click(venue().querySelector(".tasks-row-title")));
    await act(async () => click(chatButton()));
    await settle();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(venue().querySelector(".tasks-chat-error")?.textContent).toBe(
      "Couldn't open a chat: The agent is not available.",
    );
    expect(chatButton()?.hasAttribute("disabled")).toBe(false);
  });
});
