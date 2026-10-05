// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
const sanitizer = vi.hoisted(() => vi.fn((html: string) => html));
vi.mock("dompurify", () => ({ default: { sanitize: sanitizer } }));
import { createFindConversation } from "./find-conversation.js";
import { FindProgress } from "./find-progress.js";
import type { FindView } from "./find-service.js";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  const host = document.querySelector("main") as unknown as HTMLElement;
  const flush = vi.fn();
  const conversation = createFindConversation(host, flush);
  dispose = () => conversation.render();
  const view: FindView = {
    supported: true,
    enabled: true,
    pendingApproval: false,
    query: "invented",
    resultsQuery: "invented",
    results: [],
    canonicalizers: [],
    running: true,
    interrupted: false,
  };
  return { host, flush, conversation, view };
}
describe("portal components in Chrome", () => {
  it("renders source titles and document lines, then follows the portal rolling dismiss lifecycle", async () => {
    vi.useFakeTimers();
    const p = mount();
    const progress = new FindProgress();
    progress.update("agent.tool.start", {
      toolCallId: "read",
      tool: "fetch_document",
      args: { documentId: "doc" },
      argsSummary: "Invented guide",
    });
    progress.update("agent.tool.result", {
      toolCallId: "read",
      result: {
        kind: "document",
        ref: { documentId: "doc", title: "Invented guide", sourceId: "example:account" },
        document: { content: "Invented first line.\nInvented second line." },
      },
    });
    await act(async () => p.conversation.render({ ...p.view, tools: progress.snapshot() }));
    expect(p.host.querySelector(".agent-ephemeral-doc-title")?.textContent).toContain(
      "Invented guide",
    );
    expect(p.host.querySelectorAll(".agent-ephemeral-doc-line")).toHaveLength(2);
    expect(p.host.textContent).toContain("Invented first line.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(p.host.querySelector(".agent-ephemeral")).toBeNull();
    expect(p.flush).toHaveBeenCalledWith("read", undefined);
  });
  it("renders SQL hooks and query timers on a second run, then releases the buffered narration", async () => {
    vi.useFakeTimers();
    const p = mount();
    await act(async () =>
      p.conversation.render({
        ...p.view,
        progressId: "first",
        agentText: "An invented earlier answer.",
      }),
    );
    const progress = new FindProgress();
    progress.update("agent.tool.start", {
      toolCallId: "sql",
      tool: "run_sql",
      args: { sql: "SELECT value FROM example_records" },
    });
    progress.update("agent.tool.result", {
      toolCallId: "sql",
      result: { kind: "sql.rows", columns: ["value"], rows: [["Invented result"]] },
    });
    progress.update("agent.text.delta", { delta: "The invented result is ready." });
    await act(async () =>
      p.conversation.render({ ...p.view, progressId: "second", tools: progress.snapshot() }),
    );
    expect(p.host.textContent).not.toContain("An invented earlier answer.");
    expect(p.host.querySelector(".agent-ephemeral-sql-line")?.textContent).toContain(
      "SELECT value",
    );
    expect(p.host.textContent).toContain("Invented result");
    expect(p.host.textContent).not.toContain("The invented result is ready.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(p.flush).toHaveBeenCalledWith("sql", "second");
    expect(p.host.querySelector(".agent-ephemeral")).toBeNull();
    progress.flush("sql");
    await act(async () =>
      p.conversation.render({ ...p.view, progressId: "second", tools: progress.snapshot() }),
    );
    expect(p.host.textContent).toContain("The invented result is ready.");
  });

  it("uses the shared Markdown component and does not revive a dismissed card", async () => {
    const p = mount();
    await act(async () =>
      p.conversation.render({
        ...p.view,
        running: false,
        tools: [
          { kind: "tool", toolCallId: "old", tool: "search_documents", tailDismissed: true },
          { kind: "text", text: "An **invented** answer." },
        ],
      }),
    );
    expect(p.host.querySelector("strong")?.textContent).toBe("invented");
    expect(sanitizer).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ FORBID_TAGS: ["img"] }),
    );
    expect(p.host.querySelector(".agent-ephemeral")).toBeNull();
    p.conversation.render();
    expect(p.host.hidden).toBe(true);
    expect(p.host.children).toHaveLength(0);
  });
});
