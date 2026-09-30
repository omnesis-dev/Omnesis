// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — browser modules are plain JavaScript.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Actual sanitizer behavior is covered by the browser suite.
vi.mock("dompurify", () => ({ default: { sanitize: (html) => html } }));
import { AssistantMarkdown } from "./assistant-markdown.js";
import { MessageBubble } from "./parts.js";
import { chatMessagesToTurns } from "../../views/agent-reducer.js";
import { PrivacyAnswerContent } from "../../views/audit/shared.js";

let host;
let originalDocument;
let originalWindow;
beforeEach(() => {
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><main></main></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = document.querySelector("main");
});
afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

async function mount(component, props) {
  await act(async () => { render(h(component, props), host); });
}

describe("completed answer rendering", () => {
  it("retains copy controls through parent rerenders and reopened durable chat turns", async () => {
    const [turn] = chatMessagesToTurns([{ role: "assistant", parts: [{ kind: "text", text: "Reference: `00123`" }] }]);
    expect(turn.done).toBe(true);
    await mount(MessageBubble, { turn, citations: [], dispatch: () => {} });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
    await mount(MessageBubble, { turn, citations: [], dispatch: () => {} });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
    await mount(MessageBubble, { turn: { ...turn }, citations: [], dispatch: () => {} });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
    await mount(MessageBubble, { turn: { ...turn, done: false }, citations: [], dispatch: () => {} });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
    render(null, host);
    await mount(MessageBubble, { turn, citations: [], dispatch: () => {} });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
  });

  it("offers marked values in the recorded conversation answer surface without detecting prose", async () => {
    await mount(PrivacyAnswerContent, { answer: "Address: `42 example street`", className: "privacy-quote" });
    expect(host.querySelector(".privacy-quote.doc-content")).not.toBeNull();
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
    await mount(PrivacyAnswerContent, { answer: "Address: 42 example street", className: "privacy-quote" });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
  });

  it("renders plain multiline values in body text with the control after the final line", async () => {
    await mount(AssistantMarkdown, { copyable: true, text: "```TEXT\n42 example street  \nExampleville\n```\n\n```javascript\nconst n = 1;\n```" });
    const block = host.querySelector(".agent-value-text-block");
    expect(block.firstChild.textContent).toBe("42 example street  \nExampleville");
    expect(block.lastChild.className).toBe("agent-value-copy-inline");
    expect(block.querySelector("pre, code")).toBeNull();
    expect(host.querySelector(".agent-value-code-block pre code").textContent).toBe("const n = 1;\n");
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(2);
  });

  it("keeps assistant plain fences in body text while streaming and only offers closed completed values", async () => {
    const props = { copyable: false, text: "```text\n42 example street\nExampleville" };
    await mount(AssistantMarkdown, props);
    expect(host.querySelector(".agent-value-text-block").textContent).toBe("42 example street\nExampleville");
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
    await mount(AssistantMarkdown, { ...props, copyable: true });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
    await mount(AssistantMarkdown, { ...props, text: props.text + "\n```" });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
    await mount(AssistantMarkdown, { ...props, text: props.text + "\n```", copyable: true });
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(1);
    await mount(MessageBubble, { turn: { role: "user", done: true, parts: [{ kind: "text", text: props.text + "\n```" }] }, citations: [], dispatch: () => {} });
    expect(host.querySelector("pre code")).not.toBeNull();
    expect(host.querySelectorAll(".agent-value-copy-btn")).toHaveLength(0);
  });
});
