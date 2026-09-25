// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { CAPTURE_POLICY_KEY } from "../capture/policy.js";
import { CAPTURE_PERMISSION_STATE_KEY } from "./capture-permission-state.js";
import { capturePairingId, pendingHandoffKeys } from "./handoff-storage.js";
import {
  CAPTURE_PENDING_PREFIX,
  CAPTURE_STATUS_MESSAGE,
  type CaptureContentStatus,
  type ContentToSwMessage,
} from "./messages.js";
import { PAIRING_KEY } from "./pairing-record.js";
import {
  startContentScript,
  type ContentMutationObserver,
  type ContentScriptChrome,
  type ContentScriptEnvironment,
} from "./content-script.js";

/**
 * The content-script glue, driven end to end under Node: a linkedom document
 * stands in for the page, a fake `chrome` records every runtime message and
 * answers from a script, and a fake clock fires the dwell and retry timers.
 * Every fixture is invented (example.com hosts, fictional article text).
 */

const PAGE_URL = "https://news.example.com/articles/quarterly-planning?utm_source=digest#top";
const NORMALIZED_URL = "https://news.example.com/articles/quarterly-planning";
const PAIRING = {
  gatewayUrl: "https://gateway.example.com",
  scopes: ["write:web"],
  deviceId: "0d0e0f10-1111-4222-8333-444455556666",
  pairedAt: 1,
};

const ARTICLE_HTML = `<!doctype html><html><head><title>Quarterly planning notes</title></head>
  <body>
    <nav>home · about · contact</nav>
    <article>
      <h1>Quarterly planning notes</h1>
      <p>The lead analyst opened the review by walking through the revenue summary for the
         quarter, noting that the northern region outperformed every projection the
         planning team had set at the start of the year.</p>
      <p>A second speaker then presented the staffing model, arguing that two additional
         analysts would let the team close the backlog of open requests before the
         next planning cycle began in earnest.</p>
    </article>
  </body></html>`;

/** Timers fire only when `tick(ms)` advances the clock past their due time. */
class FakeClock {
  private t = 1_700_000_000_000;
  private seq = 0;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();

  now = (): number => this.t;

  setTimeout = (fn: () => void, delayMs: number): number => {
    const handle = ++this.seq;
    this.timers.set(handle, { due: this.t + delayMs, fn });
    return handle;
  };

  clearTimeout = (handle: number): void => {
    this.timers.delete(handle);
  };

  pending(): number {
    return this.timers.size;
  }

  async tick(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null;
      for (const entry of this.timers.entries()) {
        if (entry[1].due <= target && (next === null || entry[1].due < next[1].due)) next = entry;
      }
      if (!next) break;
      this.t = next[1].due;
      this.timers.delete(next[0]);
      next[1].fn();
      await settle();
    }
    this.t = target;
  }
}

class FakeMutationObserver implements ContentMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: Node | null = null;
  disconnected = false;

  constructor(readonly callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }

  observe(target: Node): void {
    this.observed = target;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

/** Stands in for `window.navigation`: one `currententrychange` listener set. */
class FakeNavigation {
  readonly listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
  fire(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A window whose listeners can be counted and fired by hand. */
class FakeWindow {
  readonly listeners = new Map<string, Set<() => void>>();
  readonly navigation = new FakeNavigation();

  addEventListener = (type: string, listener: () => void): void => {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  };

  removeEventListener = (type: string, listener: () => void): void => {
    this.listeners.get(type)?.delete(listener);
  };

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count + this.navigation.listeners.size;
  }
}

type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;
type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void | Promise<unknown>;
type Responder = (message: ContentToSwMessage) => unknown;

/** `chrome.storage.local`, `storage.onChanged` and `runtime` over an in-memory record. */
class FakeChrome {
  readonly storage: Record<string, unknown>;
  readonly messages: ContentToSwMessage[] = [];
  readonly storageListeners = new Set<StorageListener>();
  readonly messageListeners = new Set<MessageListener>();
  /** Mutable context flags the `chrome.runtime` / `chrome.extension` getters read live. */
  readonly live: { runtimeId: string | undefined; incognito: boolean } = {
    runtimeId: "extension-test",
    incognito: false,
  };
  respond: Responder = (message) => {
    if (message.type === "capture-eligibility") return { eligible: true, skipPasswordForms: true };
    return { ok: true, accepted: true };
  };

  readonly api: ContentScriptChrome;

  constructor(storage: Record<string, unknown>) {
    this.storage = storage;
    // Getters cannot be arrow functions, so they read the live flags through a
    // captured reference instead of the object literal's own `this`.
    const { live } = this;
    this.api = {
      storage: {
        local: {
          get: (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(
              Object.fromEntries(
                list.filter((key) => key in this.storage).map((key) => [key, this.storage[key]]),
              ),
            );
          },
          getKeys: () => Promise.resolve(Object.keys(this.storage)),
          set: (items) => {
            Object.assign(this.storage, items);
            return Promise.resolve();
          },
          remove: (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete this.storage[key];
            return Promise.resolve();
          },
        },
        onChanged: {
          addListener: (listener) => {
            this.storageListeners.add(listener);
          },
          removeListener: (listener) => {
            this.storageListeners.delete(listener);
          },
        },
      },
      runtime: {
        get id() {
          return live.runtimeId;
        },
        sendMessage: async <T>(message: unknown): Promise<T> => {
          if (live.runtimeId === undefined) throw new Error("Extension context invalidated.");
          const typed = message as ContentToSwMessage;
          this.messages.push(typed);
          return (await this.respond(typed)) as T;
        },
        onMessage: {
          addListener: (listener) => {
            this.messageListeners.add(listener);
          },
          removeListener: (listener) => {
            this.messageListeners.delete(listener);
          },
        },
      },
      get extension() {
        return { inIncognitoContext: live.incognito };
      },
    };
  }

  /** The worker's view of the page, read through the popup's status message. */
  status(): CaptureContentStatus | undefined {
    let answer: CaptureContentStatus | undefined;
    for (const listener of this.messageListeners) {
      listener(CAPTURE_STATUS_MESSAGE, {}, (response) => {
        answer = response as CaptureContentStatus;
      });
    }
    return answer;
  }

  storageChanged(
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName = "local",
  ): void {
    for (const listener of this.storageListeners) listener(changes, areaName);
  }

  captures(): Array<Extract<ContentToSwMessage, { type: "capture" }>> {
    return this.messages.filter(
      (message): message is Extract<ContentToSwMessage, { type: "capture" }> =>
        message.type === "capture",
    );
  }

  eligibilityUrls(): string[] {
    return this.messages.flatMap((message) =>
      message.type === "capture-eligibility" ? [message.url] : [],
    );
  }
}

/** Let promise chains (real `crypto.subtle` hashing included) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Page {
  chrome: FakeChrome;
  clock: FakeClock;
  window: FakeWindow;
  document: Document;
  location: { href: string };
  observer: () => FakeMutationObserver;
}

function pairedStorage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PAIRING_KEY]: JSON.stringify(PAIRING),
    [CAPTURE_PERMISSION_STATE_KEY]: true,
    ...overrides,
  };
}

function openPage(
  options: {
    html?: string;
    href?: string;
    storage?: Record<string, unknown>;
    focused?: boolean;
    incognito?: boolean;
    respond?: Responder;
  } = {},
): Page {
  FakeMutationObserver.instances = [];
  const { document } = parseHTML(options.html ?? ARTICLE_HTML);
  const focused = options.focused ?? true;
  Object.assign(document, {
    visibilityState: focused ? "visible" : "hidden",
    hasFocus: () => focused,
  });
  const chrome = new FakeChrome(options.storage ?? pairedStorage());
  chrome.live.incognito = options.incognito ?? false;
  if (options.respond) chrome.respond = options.respond;
  const clock = new FakeClock();
  const window = new FakeWindow();
  const location = { href: options.href ?? PAGE_URL };
  const env: ContentScriptEnvironment = {
    document: document as unknown as Document,
    window: window as unknown as ContentScriptEnvironment["window"],
    location,
    chrome: chrome.api,
    MutationObserver: FakeMutationObserver,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  };
  startContentScript(env);
  return {
    chrome,
    clock,
    window,
    document: env.document,
    location,
    observer: () => FakeMutationObserver.instances[0],
  };
}

async function waitForState(
  page: Page,
  state: CaptureContentStatus["state"],
  reason?: CaptureContentStatus["reason"],
): Promise<void> {
  await vi.waitFor(() =>
    expect(page.chrome.status()).toEqual({ state, ...(reason ? { reason } : {}) }),
  );
}

describe("content script — page start", () => {
  it("asks the worker about the normalized URL and reports the page as watched", async () => {
    const page = openPage();
    expect(page.chrome.status()).toEqual({ state: "checking" });
    await vi.waitFor(() => expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL]));
    await waitForState(page, "watching");
    expect(page.observer().observed).toBe(page.document.documentElement);
  });

  it.each([
    ["excluded-domain", "excluded"],
    ["paused", "excluded"],
    ["no-policy", "policy-pending"],
  ] as const)("an ineligible page (%s) reads %s and never arms a dwell", async (reason, state) => {
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? { eligible: false, reason, skipPasswordForms: true }
          : { ok: true, accepted: true },
    });
    // The reason travels with the state so the popup can name the setting
    // that applies rather than saying only that some setting does.
    await waitForState(page, state, reason);
    expect(page.clock.pending()).toBe(0);
    await page.clock.tick(10_000);
    expect(page.chrome.captures()).toEqual([]);
  });

  it("does not ask anything for an unpaired page and reads as excluded", async () => {
    const page = openPage({ storage: { [CAPTURE_PERMISSION_STATE_KEY]: true } });
    await waitForState(page, "excluded");
    expect(page.chrome.messages).toEqual([]);
  });

  it("never starts in an incognito window", async () => {
    const page = openPage({ incognito: true });
    await settle();
    expect(page.chrome.status()).toEqual({ state: "excluded" });
    expect(page.chrome.messages).toEqual([]);
    expect(page.clock.pending()).toBe(0);
  });

  it("treats a page that already carries a password field as excluded", async () => {
    const page = openPage({
      html: ARTICLE_HTML.replace("<nav>", '<form><input type="password"></form><nav>'),
    });
    await waitForState(page, "excluded", "password-field");
    expect(page.clock.pending()).toBe(0);
  });
});

describe("content script — capture handoff", () => {
  it("hands a dwell-confirmed capture to the worker bound to the pairing, then clears the staged copy", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.chrome.captures()).toHaveLength(1));
    const [capture] = page.chrome.captures();
    expect(capture.pairingId).toBe(await capturePairingId(PAIRING));
    expect(capture.handoffKey?.startsWith(CAPTURE_PENDING_PREFIX)).toBe(true);
    expect(capture.emission).toMatchObject({
      kind: "visit",
      normalizedUrl: NORMALIZED_URL,
      title: "Quarterly planning notes",
      contentChanged: true,
      dwellMs: 5_000,
    });
    expect(capture.emission.text).toContain("lead analyst");
    expect(capture.emission.text).not.toContain("<");
    // The worker's acknowledgement releases the durable recovery copy.
    await vi.waitFor(async () =>
      expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toEqual([]),
    );
    expect(page.chrome.status()).toEqual({ state: "watching" });
  });

  it("stages the capture durably while the worker has not acknowledged it", async () => {
    let answerCapture: ((ack: unknown) => void) | undefined;
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? { eligible: true, skipPasswordForms: true }
          : new Promise((resolve) => {
              answerCapture = resolve;
            }),
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.chrome.captures()).toHaveLength(1));
    const [capture] = page.chrome.captures();
    const staged = await pendingHandoffKeys(page.chrome.api.storage.local);
    expect(staged).toEqual([capture.handoffKey]);
    const record = JSON.parse(String(page.chrome.storage[staged[0]])) as {
      pairingId: string;
      emission: unknown;
    };
    expect(record.pairingId).toBe(capture.pairingId);
    expect(record.emission).toEqual(capture.emission);

    answerCapture?.({ ok: true, accepted: true });
    await vi.waitFor(async () =>
      expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toEqual([]),
    );
  });

  it("retries an unacknowledged handoff and reports the delay to the popup", async () => {
    let attempts = 0;
    const page = openPage({
      respond: (message) => {
        if (message.type === "capture-eligibility") {
          return { eligible: true, skipPasswordForms: true };
        }
        attempts += 1;
        return attempts <= 4
          ? { ok: false, reason: "queue-unavailable" }
          : { ok: true, accepted: true };
      },
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(attempts).toBe(1));
    // The retry ladder is 1s, 5s, 30s; the fourth failure passes its end and stalls.
    for (const delay of [1_000, 5_000, 30_000]) {
      await page.clock.tick(delay);
      await settle();
    }
    await vi.waitFor(() => expect(attempts).toBe(4));
    expect(page.chrome.status()).toEqual({ state: "handoff-delayed" });
    await page.clock.tick(30_000);
    await vi.waitFor(() => expect(attempts).toBe(5));
    await waitForState(page, "watching");
  });

  it("emits nothing for a page whose password field appears before the dwell completes", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    const form = page.document.createElement("form");
    const input = page.document.createElement("input");
    input.setAttribute("type", "password");
    form.appendChild(input);
    page.document.body.appendChild(form);
    await page.clock.tick(5_000);
    await settle();
    expect(page.chrome.captures()).toEqual([]);
    expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toEqual([]);
  });

  it("captures a password-bearing page when the policy turns the rule off", async () => {
    const page = openPage({
      html: ARTICLE_HTML.replace("<nav>", '<form><input type="password"></form><nav>'),
      respond: (message) =>
        message.type === "capture-eligibility"
          ? { eligible: true, skipPasswordForms: false }
          : { ok: true, accepted: true },
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.chrome.captures()).toHaveLength(1));
  });

  it("feeds DOM mutations into a debounced re-extract that emits only on change", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.chrome.captures()).toHaveLength(1));

    // An unchanged page mutates: the re-extract runs but nothing is emitted.
    page.observer().callback();
    await page.clock.tick(5_000);
    await settle();
    expect(page.chrome.captures()).toHaveLength(1);

    // A body change re-emits the page as a re-extract, never as a new visit.
    const extra = page.document.createElement("p");
    extra.textContent =
      "A late paragraph landed after the first capture and changes the readable body of the page.";
    page.document.querySelector("article")?.appendChild(extra);
    page.observer().callback();
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.chrome.captures()).toHaveLength(2));
    expect(page.chrome.captures()[1].emission).toMatchObject({
      kind: "re-extract",
      contentChanged: true,
    });
  });
});

describe("content script — popup status responder", () => {
  it("answers only the capture-status message", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    const respond = vi.fn();
    const results = [...page.chrome.messageListeners].map((listener) =>
      listener({ type: "something-else" }, {}, respond),
    );
    expect(results).toEqual([false]);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("content script — SPA route changes", () => {
  it("re-judges the page on currententrychange and popstate, and ignores same-URL churn", async () => {
    const page = openPage();
    await waitForState(page, "watching");

    page.location.href = "https://news.example.com/articles/staffing-model?utm_medium=mail";
    page.window.navigation.fire();
    await vi.waitFor(() =>
      expect(page.chrome.eligibilityUrls()).toEqual([
        NORMALIZED_URL,
        "https://news.example.com/articles/staffing-model",
      ]),
    );

    // Hash-only navigation normalizes to the same page: no new probe.
    page.location.href = "https://news.example.com/articles/staffing-model#section-2";
    page.window.navigation.fire();
    page.window.fire("popstate");
    await settle();
    expect(page.chrome.eligibilityUrls()).toHaveLength(2);

    page.location.href = "https://news.example.com/";
    page.window.fire("popstate");
    await vi.waitFor(() => expect(page.chrome.eligibilityUrls()).toHaveLength(3));
    expect(page.chrome.eligibilityUrls()[2]).toBe("https://news.example.com/");
  });

  it("does not restart the machine for a route change while capture is inactive", async () => {
    const page = openPage({ storage: { [CAPTURE_PERMISSION_STATE_KEY]: true } });
    await waitForState(page, "excluded");
    page.location.href = "https://news.example.com/other";
    page.window.fire("popstate");
    await settle();
    expect(page.chrome.messages).toEqual([]);
  });
});

describe("content script — teardown on context invalidation", () => {
  it("goes quiet once the extension context is gone", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    expect(page.window.listenerCount()).toBe(4);
    expect(page.chrome.storageListeners.size).toBe(1);
    expect(page.chrome.messageListeners.size).toBe(1);

    page.chrome.live.runtimeId = undefined;
    page.location.href = "https://news.example.com/after-reload";
    page.window.fire("popstate");
    await settle();

    expect(page.observer().disconnected).toBe(true);
    expect(page.window.listenerCount()).toBe(0);
    expect(page.chrome.storageListeners.size).toBe(0);
    expect(page.chrome.messageListeners.size).toBe(0);
    expect(page.clock.pending()).toBe(0);
    // Nothing was sent for the orphaned navigation.
    expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL]);
  });

  it("tears down when the worker call itself reports the invalidated context", async () => {
    const page = openPage({
      respond: (message) => {
        if (message.type === "capture-eligibility") {
          return { eligible: true, skipPasswordForms: true };
        }
        page.chrome.live.runtimeId = undefined;
        throw new Error("Extension context was invalidated.");
      },
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(() => expect(page.observer().disconnected).toBe(true));
    expect(page.chrome.messageListeners.size).toBe(0);
    expect(page.chrome.storageListeners.size).toBe(0);
  });
});

describe("content script — storage changes", () => {
  it("terminates when Chrome host access is withdrawn", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    page.chrome.storageChanged({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: false } });
    await settle();
    expect(page.observer().disconnected).toBe(true);
    expect(page.chrome.storageListeners.size).toBe(0);
    expect(page.chrome.messageListeners.size).toBe(0);
  });

  it("deactivates on unpair, dropping a staged handoff, and re-activates on a new pairing", async () => {
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? { eligible: true, skipPasswordForms: true }
          : new Promise(() => undefined),
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(async () =>
      expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toHaveLength(1),
    );

    delete page.chrome.storage[PAIRING_KEY];
    page.chrome.storageChanged({ [PAIRING_KEY]: { oldValue: JSON.stringify(PAIRING) } });
    await waitForState(page, "excluded");
    await vi.waitFor(async () =>
      expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toEqual([]),
    );
    expect(page.observer().disconnected).toBe(false);
    page.location.href = "https://news.example.com/while-unpaired";
    page.window.fire("popstate");
    await settle();
    expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL]);

    const rePaired = { ...PAIRING, deviceId: "1e1f2021-2222-4333-8444-555566667777" };
    page.chrome.storage[PAIRING_KEY] = JSON.stringify(rePaired);
    page.chrome.storageChanged({ [PAIRING_KEY]: { newValue: JSON.stringify(rePaired) } });
    await vi.waitFor(() =>
      expect(page.chrome.eligibilityUrls()).toEqual([
        NORMALIZED_URL,
        "https://news.example.com/while-unpaired",
      ]),
    );
    await waitForState(page, "watching");
  });

  it("re-judges the page under a replaced pairing identity", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    const moved = { ...PAIRING, gatewayUrl: "https://other-gateway.example.com" };
    page.chrome.storage[PAIRING_KEY] = JSON.stringify(moved);
    page.chrome.storageChanged({
      [PAIRING_KEY]: { oldValue: JSON.stringify(PAIRING), newValue: JSON.stringify(moved) },
    });
    await vi.waitFor(() =>
      expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL, NORMALIZED_URL]),
    );
  });

  it("keeps the running page untouched by a same-identity pairing refresh", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    const stamped = { ...PAIRING, gatewayVersion: "0.4.6" };
    page.chrome.storage[PAIRING_KEY] = JSON.stringify(stamped);
    page.chrome.storageChanged({
      [PAIRING_KEY]: { oldValue: JSON.stringify(PAIRING), newValue: JSON.stringify(stamped) },
    });
    await settle();
    expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL]);
  });

  it("re-judges a page that was waiting for the first copy of the capture settings", async () => {
    let policyLoaded = false;
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? policyLoaded
            ? { eligible: true, skipPasswordForms: true }
            : { eligible: false, reason: "no-policy", skipPasswordForms: true }
          : { ok: true, accepted: true },
    });
    await waitForState(page, "policy-pending", "no-policy");
    policyLoaded = true;
    const copy = JSON.stringify({ policy: {}, fetchedAt: 1 });
    page.chrome.storage[CAPTURE_POLICY_KEY] = copy;
    page.chrome.storageChanged({ [CAPTURE_POLICY_KEY]: { oldValue: "", newValue: copy } });
    await waitForState(page, "watching");
    expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL, NORMALIZED_URL]);
  });

  it("stops an open watched page once the settings exclude it", async () => {
    let excluded = false;
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? excluded
            ? { eligible: false, reason: "excluded-domain", skipPasswordForms: true }
            : { eligible: true, skipPasswordForms: true }
          : { ok: true, accepted: true },
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    expect(page.chrome.captures()).toHaveLength(1);

    excluded = true;
    page.chrome.storageChanged({
      [CAPTURE_POLICY_KEY]: {
        oldValue: JSON.stringify({ policy: { excludedDomains: [] }, fetchedAt: 1 }),
        newValue: JSON.stringify({
          policy: { excludedDomains: ["news.example.com"] },
          fetchedAt: 2,
        }),
      },
    });
    // The page already open is judged again and stops, without a reload.
    await waitForState(page, "excluded", "excluded-domain");
    await page.clock.tick(60_000);
    expect(page.chrome.captures()).toHaveLength(1);
  });

  it("re-judges without re-capturing a page the changed settings still allow", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    expect(page.chrome.captures()).toHaveLength(1);

    // A settings change that says nothing new about this page: it is judged a
    // second time, but keeps its dwell and what it already emitted, so no
    // duplicate visit is recorded.
    page.chrome.storageChanged({
      [CAPTURE_POLICY_KEY]: {
        oldValue: JSON.stringify({ policy: { excludedDomains: [] }, fetchedAt: 1 }),
        newValue: JSON.stringify({
          policy: { excludedDomains: ["unrelated.example.org"] },
          fetchedAt: 2,
        }),
      },
    });
    await vi.waitFor(() =>
      expect(page.chrome.eligibilityUrls()).toEqual([NORMALIZED_URL, NORMALIZED_URL]),
    );
    await page.clock.tick(60_000);
    expect(page.chrome.captures()).toHaveLength(1);
    await waitForState(page, "watching");
  });

  it("keeps a staged capture staged across a settings change", async () => {
    const page = openPage({
      respond: (message) =>
        message.type === "capture-eligibility"
          ? { eligible: true, skipPasswordForms: true }
          : new Promise(() => undefined),
    });
    await waitForState(page, "watching");
    await page.clock.tick(5_000);
    await vi.waitFor(async () =>
      expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toHaveLength(1),
    );

    // Settings replace no authorization, so the capture waiting to be handed
    // over is not discarded the way an unpair discards it.
    page.chrome.storageChanged({
      [CAPTURE_POLICY_KEY]: {
        oldValue: JSON.stringify({ policy: { excludedDomains: [] }, fetchedAt: 1 }),
        newValue: JSON.stringify({
          policy: { excludedDomains: ["unrelated.example.org"] },
          fetchedAt: 2,
        }),
      },
    });
    await settle();
    expect(await pendingHandoffKeys(page.chrome.api.storage.local)).toHaveLength(1);
  });

  it("re-activates when host access is granted to an already-open page", async () => {
    const page = openPage({ storage: { [PAIRING_KEY]: JSON.stringify(PAIRING) } });
    await waitForState(page, "excluded");
    expect(page.chrome.messages).toEqual([]);
    page.chrome.storage[CAPTURE_PERMISSION_STATE_KEY] = true;
    page.chrome.storageChanged({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: true } });
    await waitForState(page, "watching");
  });

  it("ignores changes in other storage areas", async () => {
    const page = openPage();
    await waitForState(page, "watching");
    page.chrome.storageChanged({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: false } }, "sync");
    await settle();
    expect(page.observer().disconnected).toBe(false);
    expect(page.chrome.status()).toEqual({ state: "watching" });
  });
});
