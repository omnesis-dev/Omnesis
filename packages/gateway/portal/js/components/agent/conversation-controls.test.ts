// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — browser JS components exercised in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationControls } from "./conversation-controls.js";
import { Composer, MessageBubble } from "./parts.js";

// Sanitization itself is covered in the portal browser suite.
vi.mock("dompurify", () => ({ default: { sanitize: (html) => html } }));

let host;
afterEach(() => {
  if (host) render(null, host);
  vi.unstubAllGlobals();
});
function setup() {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  const values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  window.innerWidth = 1024;
  window.innerHeight = 768;
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  host = document.querySelector("main");
}
async function openMenu() {
  const target = host.querySelector(".agent-message-actions");
  target.getBoundingClientRect = () => ({ left: 10, bottom: 40 });
  await act(async () =>
    target.dispatchEvent(new window.Event("contextmenu", { bubbles: true, cancelable: true })),
  );
}
describe("conversation controls", () => {
  it("answers a flat choice with its clarification ID without a second composer", async () => {
    setup();
    const onAnswer = vi.fn().mockResolvedValue(true);
    await act(async () =>
      render(
        h(ConversationControls, {
          onAnswer,
          controls: {
            pendingClarification: {
              id: "question-one",
              question: "Which period?",
              choices: [{ label: "This week", description: "The current calendar week" }],
            },
            queuedMessages: [{ id: "queued-one", text: "Include milestones", status: "queued" }],
          },
        }),
        host,
      ),
    );
    expect(host.textContent).toContain("Which period?");
    expect(host.textContent).toContain("Queued");
    expect(host.querySelector("input")).toBeNull();
    await act(async () => host.querySelector(".agent-clarification-choices button").click());
    expect(onAnswer).toHaveBeenCalledWith("This week", { clarificationId: "question-one" });
  });
  it("offers follow-up and interrupt while busy and preserves draft on failed submission", async () => {
    setup();
    const onSubmit = vi.fn().mockResolvedValue(false);
    await act(async () => render(h(Composer, { busy: true, draftKey: "test", onSubmit }), host));
    await act(async () => {
      const input = host.querySelector("textarea");
      input.value = "Use the revised plan";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Send follow-up");
    const interrupt = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupt and send",
    );
    await act(async () => interrupt.click());
    expect(onSubmit).toHaveBeenCalledWith("Use the revised plan", { mode: "interrupt" });
    expect(host.querySelector("textarea").value).toBe("Use the revised plan");
    await act(async () => render(null, host));
    await act(async () => render(h(Composer, { draftKey: "test", onSubmit }), host));
    expect(host.querySelector("textarea").value).toBe("Use the revised plan");
  });
  it("copies a sent prompt for editing while retaining the original bubble", async () => {
    setup();
    const onEdit = vi.fn();
    await act(async () =>
      render(
        h(MessageBubble, {
          turn: { role: "user", parts: [{ kind: "text", text: "Original prompt" }], done: true },
          citations: [],
          onEdit,
        }),
        host,
      ),
    );
    expect(host.textContent).not.toContain("Edit and resend");
    await openMenu();
    await act(async () =>
      [...host.querySelectorAll('[role="menuitem"]')]
        .find((button) => button.textContent === "Edit and resend")
        .click(),
    );
    expect(onEdit).toHaveBeenCalledWith("Original prompt");
    expect(host.textContent).toContain("Original prompt");
  });
  it("hides prompt editing when the conversation can no longer accept turns", async () => {
    setup();
    await act(async () =>
      render(
        h(MessageBubble, {
          turn: { role: "user", parts: [{ kind: "text", text: "Original prompt" }], done: true },
          citations: [],
          onEdit: vi.fn(),
          canEdit: false,
        }),
        host,
      ),
    );
    await openMenu();
    expect(host.textContent).not.toContain("Edit and resend");
    expect(host.querySelector('[role="menuitem"]').textContent).toBe("Copy");
  });
  it("preserves research mode when explicitly retrying a failed gateway submission", async () => {
    setup();
    const onAnswer = vi.fn().mockResolvedValue(true);
    await act(async () =>
      render(
        h(ConversationControls, {
          onAnswer,
          controls: {
            queuedMessages: [
              {
                id: "failed-one",
                text: "Research the milestones",
                status: "failed",
                deepResearch: true,
                clarificationId: "old-question",
              },
            ],
          },
        }),
        host,
      ),
    );
    await act(async () => host.querySelector("button").click());
    expect(onAnswer).toHaveBeenCalledWith("Research the milestones", {
      mode: "queue",
      deepResearch: true,
    });
  });
  it("coalesces queued paragraphs and sends existing receipt IDs without resubmitting text", async () => {
    setup();
    const onSendNow = vi.fn().mockResolvedValue(undefined);
    const controls = {
      capabilities: { queueSendNow: true, coalescedQueue: true },
      queuedMessages: [
        { id: "one", text: "Include milestones", status: "queued" },
        { id: "two", text: "And their owners", status: "queued" },
      ],
    };
    await act(async () => render(h(ConversationControls, { controls, onSendNow }), host));
    expect(host.querySelectorAll(".agent-queued-message")).toHaveLength(1);
    expect(host.querySelector(".agent-msg-body").textContent).toBe(
      "Include milestones\n\nAnd their owners",
    );
    await openMenu();
    await act(async () =>
      [...host.querySelectorAll('[role="menuitem"]')]
        .find((button) => button.textContent === "Send now")
        .click(),
    );
    expect(onSendNow).toHaveBeenCalledWith(["one", "two"]);
    await act(async () =>
      render(
        h(ConversationControls, { controls: { ...controls, capabilities: undefined }, onSendNow }),
        host,
      ),
    );
    expect(host.querySelectorAll(".agent-queued-message")).toHaveLength(2);
    await openMenu();
    expect(host.textContent).not.toContain("Send now");
  });
  it("copies agent messages from the context menu and dismisses it with Escape", async () => {
    setup();
    await act(async () =>
      render(
        h(MessageBubble, {
          turn: { role: "assistant", parts: [{ kind: "text", text: "A summary" }], done: true },
          citations: [],
        }),
        host,
      ),
    );
    await openMenu();
    expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
    await act(async () => host.querySelector('[role="menuitem"]').click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("A summary");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await openMenu();
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    event.key = "Escape";
    await act(async () => host.querySelector('[role="menu"]').dispatchEvent(event));
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it("offers Copy for unconfirmed text while retaining explicit retry", async () => {
    setup();
    await act(async () =>
      render(
        h(ConversationControls, { unconfirmed: { text: "A pending message" }, onAnswer: vi.fn() }),
        host,
      ),
    );
    await openMenu();
    await act(async () => host.querySelector('[role="menuitem"]').click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("A pending message");
    expect(host.textContent).toContain("Retry original message");
  });
  it("clears acknowledged input even when browser storage is unavailable", async () => {
    setup();
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    });
    await act(async () =>
      render(h(Composer, { draftKey: "blocked", onSubmit: vi.fn().mockResolvedValue(true) }), host),
    );
    await act(async () => {
      const input = host.querySelector("textarea");
      input.value = "A new question";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Draft could not be saved");
    await act(async () =>
      host
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector("textarea").value).toBe("");
  });
});
