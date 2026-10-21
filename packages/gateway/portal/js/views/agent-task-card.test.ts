// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskContextCard } from "./agent.js";
import { hasContextCard, visibleMessages } from "./agent-reducer.js";

const SNAPSHOT = {
  title: "Renew the studio lease",
  state: "open",
  due: "2099-03-20",
  sourceCount: 3,
};

describe("TaskContextCard", () => {
  let host: HTMLElement | null = null;

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    vi.unstubAllGlobals();
  });

  function card(taskId?: string, snapshot = SNAPSHOT) {
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    vi.stubGlobal("document", parsed.document);
    vi.stubGlobal("window", parsed.window);
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    act(() => {
      render(h(TaskContextCard, { snapshot, taskId }), host!);
    });
    return host!;
  }

  it("shows the task's title, state, due day and source count, linking to the task", () => {
    const host = card("loop_lease");
    const link = host.querySelector("a.agent-context-card-link");
    expect(link?.getAttribute("href")).toBe("/portal/tasks?task=loop_lease");
    expect(host.querySelector(".agent-context-card-title")?.textContent).toBe(
      "Renew the studio lease",
    );
    const facts = host.querySelector(".agent-context-card-description")?.textContent?.split(" · ");
    expect(facts).toEqual(["Open", expect.stringMatching(/^Due \w{3} 20 Mar$/), "3 sources"]);
    expect(host.textContent).toContain("About this task");
    expect(host.textContent).toContain("Open task");
  });

  it("opens the task with in-app navigation", () => {
    const host = card("loop_lease");
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("history", { pushState });
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    );
    vi.stubGlobal("window", { dispatchEvent });
    act(() => {
      host.querySelector("a")?.click();
    });
    expect(pushState).toHaveBeenCalledWith(null, "", "/portal/tasks?task=loop_lease");
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: "route-change" });
  });

  it("leaves out facts the snapshot does not have", () => {
    const host = card("loop_lease", { title: "Call the garage", state: "done", sourceCount: 0 });
    expect(host.querySelector(".agent-context-card-description")?.textContent).toBe("Done");
  });

  it("stays readable without a task id, and does not link", () => {
    const host = card();
    expect(host.querySelector(".agent-context-card")).not.toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).not.toContain("Open task");
  });
});

describe("task conversation origin", () => {
  const origin = { kind: "task", taskId: "loop_lease", runId: "loop_lease", seedMessageCount: 0 };

  it("has a context card only with its snapshot, which an empty thread opens on", () => {
    expect(hasContextCard({ ...origin, task: SNAPSHOT })).toBe(true);
    expect(hasContextCard(origin)).toBe(false);
  });

  it("hides no messages: the user's first message is the first message", () => {
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "When is this due?" }] },
      { role: "assistant", parts: [{ kind: "text", text: "On the 20th." }] },
    ];
    expect(visibleMessages(messages, { ...origin, task: SNAPSHOT })).toEqual(messages);
  });
});
