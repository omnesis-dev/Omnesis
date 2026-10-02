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
  host = document.querySelector("main");
}
describe("conversation controls", () => {
  it("answers a choice with its clarification ID and keeps free-text input available", async () => {
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
    expect(host.querySelector('[aria-label="Your own answer"]')).not.toBeNull();
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
    await act(async () => host.querySelector(".agent-prompt-edit").click());
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
    expect(host.querySelector(".agent-prompt-edit")).toBeNull();
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
