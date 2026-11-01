// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { navigate, undoTask } = vi.hoisted(() => ({ navigate: vi.fn(), undoTask: vi.fn() }));
vi.mock("../lib/router.js", () => ({ navigate }));
vi.mock("../api.js", () => ({ undoTask }));
import { NoteAgentReceipt } from "./note-agent-receipt.js";

let parsed;
let host;
beforeEach(() => {
  parsed = parseHTML("<html><body><main id='root'></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root");
  navigate.mockReset();
  undoTask.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

function show(agent) {
  act(() => render(h(NoteAgentReceipt, { agent }), host));
}

const clarification = {
  state: "done",
  receipt: {
    text: "Which greenhouse booking did you mean?",
    changes: [{ text: "Moved the supply check", taskId: "task_guide", undoSeq: 8 }],
    conversationId: "chat/clarification",
  },
};

test("keeps the receipt and Undo while opening the saved thread through normal navigation", () => {
  show(clarification);
  expect(host.textContent).toContain("Which greenhouse booking did you mean?");
  expect(host.querySelector(".note-agent-undo")).not.toBeNull();
  const link = host.querySelector(".note-agent-conversation");
  expect(link?.textContent).toBe("Continue in chat");
  expect(link?.getAttribute("href")).toBe("/portal/agent/chat%2Fclarification");
  act(() => link.click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/portal/agent/chat%2Fclarification");
  expect(undoTask).not.toHaveBeenCalled();
});

test("preserves browser navigation for modified clicks", () => {
  show(clarification);
  const event = new parsed.window.Event("click", { bubbles: true, cancelable: true });
  Object.assign(event, { ctrlKey: true });
  act(() => host.querySelector(".note-agent-conversation").dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

test("offers no conversation for ordinary receipts or an unsettled revision", () => {
  show({ state: "done", receipt: { text: "Moved the task.", changes: [] } });
  expect(host.querySelector(".note-agent-conversation")).toBeNull();
  show({ ...clarification, state: "pending" });
  expect(host.textContent).toContain("Omnesis is reading");
  expect(host.querySelector(".note-agent-conversation")).toBeNull();
});

test("escapes the receipt and confines a conversation id to one internal route segment", () => {
  show({ state: "done", receipt: { text: "<img src=x onerror=alert(1)>", conversationId: "//example.org/path?x#y" } });
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector(".note-agent-conversation")?.getAttribute("href")).toBe(
    "/portal/agent/%2F%2Fexample.org%2Fpath%3Fx%23y",
  );
});
