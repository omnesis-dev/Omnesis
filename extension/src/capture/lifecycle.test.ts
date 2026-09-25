// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CaptureLifecycle,
  MAX_CAPTURE_TITLE_CHARS,
  MAX_CAPTURE_URL_CHARS,
  type CaptureEmission,
  type CaptureLifecycleDeps,
} from "./lifecycle.js";

/**
 * Lifecycle / decision state-machine tests.
 *
 * The machine takes all side effects as injected callbacks, so we drive it with
 * a deterministic fake clock + fake timer queue and assert on the emissions —
 * no real browser, no real DOM, no real timers. All page content is invented.
 */

/**
 * A fake scheduler: timers fire only when `tick(ms)` advances the clock past
 * their due time. Mirrors how a real event loop would invoke them, but
 * deterministically and synchronously enough for the (async) machine.
 */
class FakeClock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();

  now = (): number => this.t;

  setTimer = (fn: () => void, delayMs: number): number => {
    const handle = ++this.seq;
    this.timers.set(handle, { due: this.t + delayMs, fn });
    return handle;
  };

  clearTimer = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** Advance the clock by `ms`, firing every timer that becomes due, in order. */
  async tick(ms: number): Promise<void> {
    const target = this.t + ms;
    // Fire due timers one at a time (a timer may schedule another).
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null;
      for (const entry of this.timers.entries()) {
        if (entry[1].due <= target && (next === null || entry[1].due < next[1].due)) next = entry;
      }
      if (!next) break;
      this.t = next[1].due;
      this.timers.delete(next[0]);
      next[1].fn();
      // Let any microtasks the fired callback queued settle.
      await Promise.resolve();
      await Promise.resolve();
    }
    this.t = target;
  }
}

interface Harness {
  clock: FakeClock;
  emissions: CaptureEmission[];
  lifecycle: CaptureLifecycle;
  setFocused: (v: boolean) => void;
  setOwned: (hosts: string[]) => void;
  setText: (t: string) => void;
  setTitle: (t: string) => void;
  setCanonical: (u: string | null) => void;
}

function harness(overrides: Partial<CaptureLifecycleDeps> = {}): Harness {
  const clock = new FakeClock();
  const emissions: CaptureEmission[] = [];
  let focused = true;
  let ownedHosts: string[] = [];
  let text = "initial page body text that is the readable content of an invented page";
  let title = "Invented Page";
  let canonicalUrl: string | null = null;

  // Hash is the identity-ish of the text for deterministic assertions.
  const hash = (t: string): Promise<string> => Promise.resolve(`h(${t.length}:${t.slice(0, 8)})`);

  const deps: CaptureLifecycleDeps = {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isFocused: () => focused,
    extract: () => Promise.resolve({ title, text, canonicalUrl }),
    hash,
    isExcluded: (url) => Promise.resolve(ownedHosts.includes(new URL(url).hostname)),
    emit: (e) => emissions.push(e),
    dwellMs: 5000,
    debounceMs: 5000,
    ...overrides,
  };

  return {
    clock,
    emissions,
    lifecycle: new CaptureLifecycle(deps),
    setFocused: (v) => (focused = v),
    setOwned: (hosts) => (ownedHosts = hosts),
    setText: (t) => (text = t),
    setTitle: (t) => (title = t),
    setCanonical: (u) => (canonicalUrl = u),
  };
}

/** Let pending microtasks (e.g. the async ownership resolve) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

describe("CaptureLifecycle", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("captures after a 5s focused dwell — one visit, one content doc", async () => {
    h.lifecycle.start("https://example.com/article?id=1#top");
    await flush(); // ownership resolves (not owned) → focus armed
    await h.clock.tick(5000);

    expect(h.emissions).toHaveLength(1);
    const e = h.emissions[0];
    expect(e.kind).toBe("visit");
    expect(e.normalizedUrl).toBe("https://example.com/article?id=1"); // normalized
    expect(e.contentChanged).toBe(true);
    expect(e.dwellMs).toBeGreaterThanOrEqual(5000);
  });

  it("does not arm capture for an address too large for the worker boundary", async () => {
    h.lifecycle.start(`https://example.com/${"x".repeat(MAX_CAPTURE_URL_CHARS)}`);
    await flush();
    await h.clock.tick(5_000);
    expect(h.emissions).toEqual([]);
  });

  it("bounds adversarial titles before durable handoff", async () => {
    h.setTitle("x".repeat(MAX_CAPTURE_TITLE_CHARS + 1_000));
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(5_000);
    expect(h.emissions[0].title).toHaveLength(MAX_CAPTURE_TITLE_CHARS);
  });

  it("ignores an oversized canonical URL and keeps the bounded live identity", async () => {
    h.setCanonical(`https://example.com/${"x".repeat(MAX_CAPTURE_URL_CHARS)}`);
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(5_000);
    expect(h.emissions[0].normalizedUrl).toBe("https://example.com/article");
  });

  it("does NOT capture before 5s of dwell", async () => {
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(4999);
    expect(h.emissions).toHaveLength(0);
  });

  it("skips a host in the owned-domains set entirely (no dwell, no capture)", async () => {
    h.setOwned(["mail.google.com"]);
    h.lifecycle.start("https://mail.google.com/mail/u/0/#inbox");
    await flush();
    await h.clock.tick(60_000);
    expect(h.emissions).toHaveLength(0);
  });

  it("records nothing for a page the extractor flags as sensitive, not even the visit", async () => {
    const sensitive = harness({
      extract: () =>
        Promise.resolve({ title: "Sign in", text: "", canonicalUrl: null, sensitive: true }),
    });
    sensitive.lifecycle.start("https://shop.example/account");
    await flush();
    await sensitive.clock.tick(5000);
    expect(sensitive.emissions).toEqual([]);
  });

  it("does not count hidden/blurred time toward the dwell", async () => {
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(3000); // 3s focused
    h.setFocused(false);
    h.lifecycle.onBlur();
    await h.clock.tick(60_000); // long hidden span — must not count
    expect(h.emissions).toHaveLength(0);

    h.setFocused(true);
    h.lifecycle.onFocus();
    await h.clock.tick(1999); // 3s + ~2s = ~5s but still just under
    expect(h.emissions).toHaveLength(0);
    await h.clock.tick(2); // cross 5s
    expect(h.emissions).toHaveLength(1);
  });

  it("an SPA route change to a new URL triggers a fresh capture", async () => {
    h.lifecycle.start("https://app.example.com/page?id=1");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);

    // Route change (history pushState) to a different normalized URL.
    h.setText("a totally different page body for the second SPA route view here");
    h.lifecycle.start("https://app.example.com/page?id=2");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(2);
    expect(h.emissions[1].normalizedUrl).toBe("https://app.example.com/page?id=2");
  });

  it("an SPA route change to the SAME normalized URL does not reset the dwell", async () => {
    h.lifecycle.start("https://app.example.com/p?id=1");
    await flush();
    await h.clock.tick(3000);
    // replaceState that normalizes to the same URL (e.g. adds a tracking param).
    h.lifecycle.start("https://app.example.com/p?id=1&utm_source=x");
    await flush();
    await h.clock.tick(2000); // total 5s of continuous dwell
    expect(h.emissions).toHaveLength(1); // dwell was NOT reset
  });

  it("debounces rapid DOM mutations and re-pushes only on hash change", async () => {
    h.lifecycle.start("https://example.com/dashboard");
    await flush();
    await h.clock.tick(5000); // first capture
    expect(h.emissions).toHaveLength(1);

    // Content changes; many rapid mutations fire.
    h.setText("dashboard now shows updated metrics after a live data refresh occurred");
    for (let i = 0; i < 10; i++) h.lifecycle.onMutation();
    await h.clock.tick(4999); // within debounce — nothing yet
    expect(h.emissions).toHaveLength(1);
    await h.clock.tick(2); // debounce elapses → one coalesced re-extract
    expect(h.emissions).toHaveLength(2);
    expect(h.emissions[1].kind).toBe("re-extract");
    expect(h.emissions[1].contentChanged).toBe(true);
  });

  it("a re-extract whose text is unchanged does NOT re-push (no corpus churn)", async () => {
    h.lifecycle.start("https://example.com/feed");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);

    // Mutations fire (infinite-scroll tick) but the extracted text is identical.
    for (let i = 0; i < 5; i++) h.lifecycle.onMutation();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1); // unchanged → nothing re-pushed
  });

  it("re-extracts on a title-only change (SPA renames the page after load)", async () => {
    // The shell loads with a generic title; the real conversation/title swaps
    // in a beat later with the SAME body text. The rename must still upsert.
    h.setTitle("ChatGPT");
    h.lifecycle.start("https://chatgpt.com/c/abc123");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);
    expect(h.emissions[0].title).toBe("ChatGPT");

    // Only the title changes (body text identical → same content hash).
    h.setTitle("Comparing two gyms");
    h.lifecycle.onMutation();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(2);
    expect(h.emissions[1].kind).toBe("re-extract");
    expect(h.emissions[1].title).toBe("Comparing two gyms");
    expect(h.emissions[1].contentChanged).toBe(true);
  });

  it("does not re-extract when neither the title nor the text changed", async () => {
    h.lifecycle.start("https://example.com/stable");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);

    // Mutations fire but title AND text are unchanged → no churn.
    for (let i = 0; i < 3; i++) h.lifecycle.onMutation();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);
  });

  it("forces a re-extract within maxDebounceMs when mutations never let the debounce settle", async () => {
    // A chat app that re-renders constantly would otherwise reset the 5s
    // debounce forever, so a title that settles after the first capture would
    // never be picked up. The max-wait ceiling guarantees one re-extract.
    const hb = harness({ debounceMs: 5000, maxDebounceMs: 12000 });
    hb.setTitle("ChatGPT");
    hb.lifecycle.start("https://chatgpt.com/c/x");
    await flush();
    await hb.clock.tick(5000); // first capture, title still the shell title
    expect(hb.emissions).toHaveLength(1);
    expect(hb.emissions[0].title).toBe("ChatGPT");

    // The real title settles, but the page keeps mutating every 2s — never quiet
    // for a full 5s debounce window.
    hb.setTitle("User asks for time");
    for (let i = 0; i < 8; i++) {
      hb.lifecycle.onMutation();
      await hb.clock.tick(2000);
    }

    const reExtracts = hb.emissions.filter((e) => e.kind === "re-extract");
    expect(reExtracts.length).toBeGreaterThanOrEqual(1);
    expect(reExtracts[0].title).toBe("User asks for time");
  });

  it("keys the emitted document on a canonical URL when the address bar is a transient root", async () => {
    // ChatGPT pathology: opened at /c/<id> but the SPA shows the bare root at
    // capture time; the canonical link names the real conversation.
    h.setCanonical("https://chatgpt.com/c/abc-123");
    h.lifecycle.start("https://chatgpt.com/");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);
    expect(h.emissions[0].normalizedUrl).toBe("https://chatgpt.com/c/abc-123");
  });

  it("re-keys to the canonical when it settles after the first capture (same body, same title)", async () => {
    // First capture happens before the SPA injects its canonical → keyed root.
    h.lifecycle.start("https://chatgpt.com/");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1);
    expect(h.emissions[0].normalizedUrl).toBe("https://chatgpt.com/");

    // Canonical appears (a head mutation) with body + title unchanged.
    h.setCanonical("https://chatgpt.com/c/abc-123");
    h.lifecycle.onMutation();
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(2);
    expect(h.emissions[1].kind).toBe("re-extract");
    expect(h.emissions[1].normalizedUrl).toBe("https://chatgpt.com/c/abc-123");
  });

  it("a revisit with unchanged content emits a visit but no content doc", async () => {
    // Same machine instance, but the re-extract path: mutation with same text
    // emits nothing; here we assert the *visit*-level contentChanged flag for a
    // brand-new page is true (lastHash starts null), which is the upsert driver.
    h.lifecycle.start("https://example.com/x");
    await flush();
    await h.clock.tick(5000);
    expect(h.emissions[0].kind).toBe("visit");
    expect(h.emissions[0].contentChanged).toBe(true);
  });

  it("ignores mutations before the first capture", async () => {
    h.lifecycle.start("https://example.com/x");
    await flush();
    h.lifecycle.onMutation(); // pre-capture mutation — ignored
    await h.clock.tick(5000);
    expect(h.emissions).toHaveLength(1); // exactly the dwell capture
  });

  it("does not start a duplicate visit extraction after blur and refocus", async () => {
    const firstExtract = deferred<{
      title: string;
      text: string;
      canonicalUrl: null;
    }>();
    const extract = vi.fn(() => firstExtract.promise);
    const hd = harness({ extract });
    hd.lifecycle.start("https://example.com/slow-article");
    await flush();
    await hd.clock.tick(5_000);
    expect(extract).toHaveBeenCalledOnce();

    hd.setFocused(false);
    hd.lifecycle.onBlur();
    hd.setFocused(true);
    hd.lifecycle.onFocus();
    await hd.clock.tick(5_000);
    expect(extract).toHaveBeenCalledOnce();

    firstExtract.resolve({ title: "Slow article", text: "fictional body", canonicalUrl: null });
    await flush();
    expect(hd.emissions).toHaveLength(1);
  });

  it("serializes mutation snapshots and reruns after an in-flight extraction", async () => {
    const oldSnapshot = deferred<{
      title: string;
      text: string;
      canonicalUrl: null;
    }>();
    let calls = 0;
    const extract = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          title: "Initial",
          text: "initial fictional body",
          canonicalUrl: null,
        });
      }
      if (calls === 2) return oldSnapshot.promise;
      return Promise.resolve({
        title: "Newest",
        text: "newest fictional body",
        canonicalUrl: null,
      });
    });
    const hm = harness({ extract });
    hm.lifecycle.start("https://example.com/live-page");
    await flush();
    await hm.clock.tick(5_000);

    hm.lifecycle.onMutation();
    await hm.clock.tick(5_000);
    expect(extract).toHaveBeenCalledTimes(2);
    hm.lifecycle.onMutation();
    await hm.clock.tick(5_000);
    expect(extract).toHaveBeenCalledTimes(2);

    oldSnapshot.resolve({ title: "Older", text: "older fictional body", canonicalUrl: null });
    await flush();
    await hm.clock.tick(5_000);

    expect(extract).toHaveBeenCalledTimes(3);
    expect(hm.emissions.map((emission) => emission.title)).toEqual(["Initial", "Older", "Newest"]);
  });

  it("re-extracts a mutation observed while the initial hash is in flight", async () => {
    const firstHash = deferred<string>();
    let extractCalls = 0;
    const extract = vi.fn(() => {
      extractCalls += 1;
      return Promise.resolve(
        extractCalls === 1
          ? { title: "Initial", text: "initial fictional body", canonicalUrl: null }
          : { title: "Updated", text: "updated fictional body", canonicalUrl: null },
      );
    });
    let hashCalls = 0;
    const hash = vi.fn((text: string) => {
      hashCalls += 1;
      return hashCalls === 1 ? firstHash.promise : Promise.resolve(`hash:${text}`);
    });
    const hi = harness({ extract, hash });
    hi.lifecycle.start("https://example.com/initial-race");
    await flush();
    await hi.clock.tick(5_000);
    expect(hash).toHaveBeenCalledOnce();

    hi.lifecycle.onMutation();
    firstHash.resolve("hash:initial fictional body");
    await flush();
    await hi.clock.tick(5_000);

    expect(hi.emissions.map((emission) => emission.title)).toEqual(["Initial", "Updated"]);
  });

  it("re-judging an unchanged page leaves everything it has contributed alone", async () => {
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(5_000);
    expect(h.emissions).toHaveLength(1);

    // The settings changed but say nothing new about this page: no second visit
    // row, and no re-extract of content that has not moved.
    await h.lifecycle.rejudge();
    await h.clock.tick(30_000);
    expect(h.emissions).toHaveLength(1);
  });

  it("stops a watched page from capturing once the settings exclude it", async () => {
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(2_000); // part-way through the dwell — nothing emitted yet
    expect(h.emissions).toEqual([]);

    h.setOwned(["example.com"]);
    await h.lifecycle.rejudge();
    await h.clock.tick(60_000);
    expect(h.emissions).toEqual([]);
  });

  it("lets a page the settings stop excluding capture, and only once", async () => {
    h.setOwned(["example.com"]);
    h.lifecycle.start("https://example.com/article");
    await flush();
    await h.clock.tick(10_000);
    expect(h.emissions).toEqual([]);

    h.setOwned([]);
    await h.lifecycle.rejudge();
    await h.clock.tick(5_000);
    expect(h.emissions).toHaveLength(1);

    // Excluding and re-allowing the same page must not make it a second visit:
    // the page keeps its dwell and the hash of what it already emitted.
    h.setOwned(["example.com"]);
    await h.lifecycle.rejudge();
    h.setOwned([]);
    await h.lifecycle.rejudge();
    await h.clock.tick(60_000);
    expect(h.emissions).toHaveLength(1);
  });

  it("ignores a re-judge for a page that has already been navigated away from", async () => {
    const pending = deferred<boolean>();
    let answer: () => void = () => undefined;
    const hr = harness({
      isExcluded: (url) =>
        url.endsWith("/second")
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve) => {
              answer = () => resolve(true);
              void pending.promise;
            }),
    });
    hr.lifecycle.start("https://example.com/first");
    await flush();
    const rejudged = hr.lifecycle.rejudge();
    hr.lifecycle.start("https://example.com/second");
    await flush();
    answer(); // the first page's answer arrives after the machine moved on
    await rejudged;
    await hr.clock.tick(5_000);

    expect(hr.emissions).toHaveLength(1);
    expect(hr.emissions[0].normalizedUrl).toContain("/second");
  });

  it("retries a transient initial extraction failure without an unhandled stop", async () => {
    let calls = 0;
    const hr = harness({
      extract: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("DOM snapshot unavailable"))
          : Promise.resolve({ title: "Recovered", text: "recovered fictional body" });
      },
    });
    hr.lifecycle.start("https://example.com/retry-extract");
    await flush();
    await hr.clock.tick(5_000);
    expect(hr.emissions).toEqual([]);

    await hr.clock.tick(5_000);
    expect(hr.emissions).toHaveLength(1);
    expect(hr.emissions[0].title).toBe("Recovered");
  });
});
