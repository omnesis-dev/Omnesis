// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStartupPage, startupPageCsp } from "./page.js";
import { StartupManager } from "./manager.js";

class Element {
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes: Record<string, string> = {};

  append(...nodes: Element[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: Element[]): void {
    this.children = nodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

const page = renderStartupPage();
const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1];

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: "storage",
    label: "Database preparation",
    state: "running",
    startedAt: 1_000,
    optional: false,
    dependsOn: [],
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    bootId: "boot-one",
    sequence: 1,
    startedAt: 500,
    state: "starting",
    steps: [step()],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function browser(fetch: ReturnType<typeof vi.fn>) {
  const elements = new Map<string, Element>();
  const events = new Map<string, () => void>();
  const location = {
    href: "https://example.org/portal/settings/models?token=fictional#details",
    reload: vi.fn(),
  };
  const document = {
    getElementById(id: string) {
      let node = elements.get(id);
      if (!node) {
        node = new Element();
        elements.set(id, node);
      }
      return node;
    },
    createElement: () => new Element(),
  };
  runInNewContext(script, {
    document,
    window: { location, addEventListener: (name: string, fn: () => void) => events.set(name, fn) },
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
  });
  return { get: document.getElementById, location, events };
}

function response(value: unknown) {
  return { ok: true, json: async () => value };
}

describe("startup page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => vi.useRealTimers());

  it("renders the embedded logo and works under a hash-only content security policy", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)![1];
    for (const content of [script, style]) {
      const digest = createHash("sha256").update(content).digest("base64");
      expect(startupPageCsp()).toContain(`'sha256-${digest}'`);
    }
    expect(startupPageCsp()).not.toContain("unsafe-inline");
    expect(startupPageCsp()).toContain("frame-ancestors 'none'");
    expect(page).toContain('class="brand-mark"');
    expect(page).toContain('role="status"');
    expect(page).toContain("prefers-reduced-motion");
    expect(page).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/);
  });

  it("shows parallel work, migration commits, elapsed time and the next pending step", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(
        snapshot({
          steps: [
            step({ progress: { current: 3, total: 8, completed: 2 } }),
            step({ id: "backend", label: "Backend discovery", optional: true }),
            step({
              id: "portal",
              label: "Portal routes",
              state: "pending",
              startedAt: undefined,
              dependsOn: ["storage"],
            }),
          ],
        }),
      ),
    );
    const ui = browser(fetch);
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      "/.well-known/omnesis-startup",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      }),
    );
    expect(ui.get("startup-steps").children).toHaveLength(3);
    const [migration, , next] = ui.get("startup-steps").children;
    expect(migration.children[1].children[0].textContent).toBe(
      "2 of 8 migrations committed · applying migration 3",
    );
    expect(migration.children[2].children[0].textContent).toBe("9s");
    expect(next.children[2].textContent).toBe("Up next");
    expect(ui.get("startup-summary").textContent).toContain("2 steps are running in parallel");
  });

  it("opens the original destination once required services are ready, including its token and fragment", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response(
          snapshot({ state: "ready", steps: [step({ state: "succeeded", finishedAt: 2_000 })] }),
        ),
      );
    const ui = browser(fetch);
    await flush();
    expect(ui.location.reload).toHaveBeenCalledTimes(1);
    expect(ui.location.href).toBe(
      "https://example.org/portal/settings/models?token=fictional#details",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { current: 0, total: 3, completed: 0 },
    { current: 2, total: 3, completed: 2 },
  ])("shows only committed counts between migrations (%j)", async (progress) => {
    const ui = browser(
      vi.fn().mockResolvedValue(response(snapshot({ steps: [step({ progress })] }))),
    );
    await flush();
    expect(ui.get("startup-steps").children[0].children[1].children[0].textContent).toBe(
      `${progress.completed} of ${progress.total} migrations committed`,
    );
  });

  it.each([
    null,
    { state: "ready" },
    snapshot({ state: "ready" }),
    snapshot({ sequence: -1 }),
    snapshot({ sequence: Number.NaN }),
    snapshot({ steps: [step({ state: "other" })] }),
    snapshot({ steps: [step({ dependsOn: ["missing"] })] }),
    snapshot({ steps: [step({ progress: { current: 0, total: 3, completed: 1 } })] }),
    snapshot({ steps: [step({ progress: { current: 4, total: 3, completed: 1 } })] }),
    snapshot({ steps: [step(), step()] }),
    snapshot({ steps: [step({ progress: { current: 1, total: 0, completed: 1 } })] }),
  ])("does not reload on malformed or prematurely ready progress (%j)", async (value) => {
    const fetch = vi.fn().mockResolvedValue(response(value));
    const ui = browser(fetch);
    await flush();
    expect(ui.location.reload).not.toHaveBeenCalled();
    expect(ui.get("startup-phase").textContent).toBe("Reconnecting to your gateway");
  });

  it("ignores stale updates within a boot and resets state for a new boot", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot({ sequence: 8 })))
      .mockResolvedValueOnce(
        response(snapshot({ sequence: 7, state: "ready", steps: [step({ state: "succeeded" })] })),
      )
      .mockResolvedValueOnce(
        response(
          snapshot({ bootId: "boot-two", sequence: 1, steps: [step({ label: "New startup" })] }),
        ),
      );
    const ui = browser(fetch);
    await flush();
    await vi.advanceTimersByTimeAsync(750);
    expect(ui.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(ui.get("startup-steps").children[0].children[1].textContent).toBe("New startup");
  });

  it("uses text nodes for labels and never interprets progress as HTML", async () => {
    const label = '<img src="example.org" onerror="alert(1)">';
    const ui = browser(vi.fn().mockResolvedValue(response(snapshot({ steps: [step({ label })] }))));
    await flush();
    const node = ui.get("startup-steps").children[0].children[1];
    expect(node.textContent).toBe(label);
    expect(node.children).toHaveLength(0);
  });

  it("keeps polling through a failed boot and distinguishes connection loss from step failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          snapshot({ state: "failed", steps: [step({ state: "failed", finishedAt: 2_000 })] }),
        ),
      )
      .mockRejectedValueOnce(new Error("private server error must not be shown"))
      .mockResolvedValueOnce(response(snapshot({ bootId: "boot-two", sequence: 0 })));
    const ui = browser(fetch);
    await flush();
    expect(ui.get("startup-title").textContent).toBe("Your gateway could not start");
    await vi.advanceTimersByTimeAsync(750);
    expect(ui.get("startup-summary").textContent).toContain("last confirmed startup state");
    expect(ui.get("startup-summary").textContent).not.toContain("private");
    await vi.advanceTimersByTimeAsync(750);
    expect(ui.get("startup-title").textContent).toMatch(/gateway is starting up/i);
  });

  it("renders a real manager failure, including dependents blocked before they started", async () => {
    const manager = new StartupManager();
    manager.start("launcher");
    manager.fail("launcher");
    const state = manager.snapshot();
    expect(
      state.steps.some((step) => step.state === "blocked" && step.startedAt === undefined),
    ).toBe(true);
    const ui = browser(vi.fn().mockResolvedValue(response(state)));
    await flush();
    expect(ui.get("startup-title").textContent).toBe("Your gateway could not start");
    expect(ui.get("startup-steps").children).toHaveLength(state.steps.length);
    expect(ui.location.reload).not.toHaveBeenCalled();
  });

  it("renders a real manager stop without mistaking unstarted blocked steps for a lost connection", async () => {
    const manager = new StartupManager();
    manager.start("launcher");
    manager.stop();
    const ui = browser(vi.fn().mockResolvedValue(response(manager.snapshot())));
    await flush();
    expect(ui.get("startup-title").textContent).toBe("Your gateway is stopping");
    expect(ui.get("startup-phase").textContent).toBe("Stopping services");
    expect(ui.location.reload).not.toHaveBeenCalled();
  });

  it("renders a skipped optional step from the real manager without requiring it to have started", async () => {
    const manager = new StartupManager();
    manager.skip("repairs");
    const state = manager.snapshot();
    const index = state.steps.findIndex((step) => step.id === "repairs");
    const ui = browser(vi.fn().mockResolvedValue(response(state)));
    await flush();
    expect(ui.get("startup-steps").children[index].children[2].textContent).toBe("Not needed");
    expect(ui.get("startup-phase").textContent).not.toBe("Reconnecting to your gateway");
  });

  it("bounds a hung request, retries, and never overlaps progress requests", async () => {
    let active = 0;
    const fetch = vi.fn().mockImplementation((_url, options: { signal: AbortSignal }) => {
      active++;
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            active--;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    });
    const ui = browser(fetch);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(active).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(active).toBe(0);
    expect(ui.get("startup-phase").textContent).toBe("Reconnecting to your gateway");
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(active).toBe(1);
    ui.events.get("pagehide")!();
    await flush();
    expect(active).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resumes polling after a back/forward-cache restore and opens the preserved destination", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot()))
      .mockResolvedValueOnce(
        response(snapshot({ sequence: 2, state: "ready", steps: [step({ state: "succeeded" })] })),
      );
    const ui = browser(fetch);
    await flush();
    ui.events.get("pagehide")!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    ui.events.get("pageshow")!();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ui.location.reload).toHaveBeenCalledTimes(1);
    expect(ui.location.href).toBe(
      "https://example.org/portal/settings/models?token=fictional#details",
    );
  });

  it("discards a pre-navigation response that settles after restoration without overlapping requests", async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    const old = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveOld = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(response(snapshot({ bootId: "new-boot" })));
    const ui = browser(fetch);
    ui.events.get("pagehide")!();
    ui.events.get("pageshow")!();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveOld(response(snapshot({ state: "ready", steps: [step({ state: "succeeded" })] })));
    await flush();
    expect(ui.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ui.get("startup-steps").children).toHaveLength(1);
    expect(ui.location.reload).not.toHaveBeenCalled();
  });
});
