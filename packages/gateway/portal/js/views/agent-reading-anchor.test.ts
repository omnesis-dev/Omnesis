// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal view from vitest.
// Opening a conversation lands at the top of its latest reply rather than at
// the bottom of the transcript. linkedom has no layout, so each turn is given
// a fixed height and its on-screen position follows the container's scroll.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAgentClient: vi.fn(), getAgentModel: vi.fn() }));
vi.mock("../lib/agent-client.js", () => ({ createAgentClient: mocks.createAgentClient }));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getAgentModel: mocks.getAgentModel,
}));
// DOMPurify needs a real DOM; the transcript text itself is not under test.
vi.mock("../shared/agent-ui/markdown.js", () => ({
  renderMarkdown: (value) => `<p>${value}</p>`,
  renderCopyableMarkdown: (value) => ({ html: `<p>${value}</p>`, targets: [] }),
}));
import { AgentView } from "./agent.js";

const VIEWPORT = 500;
// Turn heights in the transcript, in order; the reply is taller than the view.
const HEIGHTS = { "u-0": 80, "a-1": 120, "u-2": 80, "a-3": 2400 };

function installLayout(window) {
  const proto = window.HTMLElement.prototype;
  const top = (id) => {
    let y = 0;
    for (const [turn, height] of Object.entries(HEIGHTS)) {
      if (turn === id) return y;
      y += height + 16;
    }
    return y;
  };
  const total = Object.values(HEIGHTS).reduce((sum, height) => sum + height + 16, 0);
  proto.getBoundingClientRect = function () {
    const id = this.getAttribute("data-turn-id");
    if (!id) return { top: 0, bottom: VIEWPORT, height: VIEWPORT };
    const scroller = this.closest(".agent-conversation");
    const y = top(id) - (scroller?.scrollTop ?? 0);
    return { top: y, bottom: y + HEIGHTS[id], height: HEIGHTS[id] };
  };
  const scrolled = new WeakMap();
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return scrolled.get(this) ?? 0;
    },
    set(value) {
      scrolled.set(this, value);
    },
  });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => total });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => VIEWPORT });
  return { top, total };
}

const text = (role, body) => ({ role, parts: [{ kind: "text", text: body }] });

describe("Agent conversation reading anchor", () => {
  let host, originalDocument, originalWindow;
  afterEach(() => {
    if (host) render(null, host);
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  async function open(messages, { busy = false } = {}) {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.defineProperty(parsed.window, "location", {
      configurable: true,
      value: { pathname: "/portal/agent/convo-1", href: "https://localhost/portal/agent/convo-1" },
    });
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    vi.stubGlobal("Event", parsed.window.Event);
    vi.stubGlobal("CustomEvent", parsed.window.CustomEvent);
    const layout = installLayout(parsed.window);
    host = parsed.document.querySelector("#root");
    const client = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true, backend: "codex" }),
      createSession: vi.fn().mockResolvedValue({
        sessionId: "convo-1",
        model: "example-model",
        backend: "codex",
        messages,
        messageCount: messages.length,
        busy,
        messagesAreVisible: true,
      }),
      getControls: vi.fn().mockResolvedValue({ busy }),
      listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
      onEvent: vi.fn(() => () => {}),
      onResync: vi.fn(() => () => {}),
      send: vi.fn(),
      close: vi.fn(),
    };
    mocks.createAgentClient.mockReturnValue(client);
    mocks.getAgentModel.mockResolvedValue({ configured: true, modelName: "Example model" });
    await act(async () => {
      render(h(AgentView, { convoId: "convo-1" }), host);
    });
    await vi.waitFor(() => expect(host.querySelector("[data-turn-id]")).not.toBeNull());
    return { scroller: host.querySelector(".agent-conversation"), layout };
  }

  it("opens with the top of the latest reply at the top of the view", async () => {
    const { scroller, layout } = await open([
      text("user", "What changed in the Q4 budget review?"),
      text("assistant", "Two lines moved."),
      text("user", "Walk me through the travel line."),
      text("assistant", "Travel rose because of the team offsite. ".repeat(60)),
    ]);
    // The transcript can commit before its passive scroll effect runs.
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(layout.top("a-3") - 8));
    const reply = scroller.querySelector('[data-turn-id="a-3"]').getBoundingClientRect();
    expect(reply.top).toBeGreaterThanOrEqual(0);
    expect(reply.top).toBeLessThan(VIEWPORT);
    expect(scroller.scrollTop).toBeLessThan(layout.total - VIEWPORT);
  });

  it("stays at the bottom when the owner's message is still waiting for a reply", async () => {
    const { scroller, layout } = await open([
      text("user", "What changed in the Q4 budget review?"),
      text("assistant", "Two lines moved."),
      text("user", "Walk me through the travel line."),
    ]);
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(layout.total));
  });
});
