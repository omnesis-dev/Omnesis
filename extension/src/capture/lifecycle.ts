// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeCaptureUrl, hostOf, preferCanonicalUrl } from "./normalize.js";

/**
 * The capture decision/state machine — the testable heart of the capture
 * engine, deliberately separated from the raw `chrome.*` / DOM-event plumbing
 * (which lives in `chrome/content-script.ts`). All side effects are injected:
 *
 *   - `now()`          — epoch-ms clock (deterministic in tests).
 *   - `setTimer/clear` — schedule/cancel a one-shot callback (the dwell + the
 *                        MutationObserver debounce). The host wires these to
 *                        `setTimeout`/`clearTimeout`; tests drive a fake clock.
 *   - `isFocused()`    — "is the page focused AND visible right now?" The host
 *                        derives this from the Page Visibility API + focus/blur.
 *   - `extract()`      — read the rendered DOM → `{ title, text }` (async; may
 *                        hash). The host calls `extractReadableText(document)`.
 *   - `hash(text)`     — content hash of the extracted text (async).
 *   - `isExcluded(url)` — capture-policy probe (async; the page asks the SW).
 *   - `emit(capture)`  — hand a confirmed capture to the SW, which enqueues the
 *                        content doc (only on hash change) and a `page_visits`
 *                        row (every dwell-confirmed visit).
 *
 * Capture lifecycle:
 *
 *   - A page is *eligible* once it has accumulated **≥ DWELL_MS of FOCUSED,
 *     VISIBLE time**. The dwell timer pauses whenever the page is hidden or
 *     blurred (Page Visibility / focus) and resumes on re-focus — hidden time
 *     never counts, and a backgrounded tab never captures.
 *   - On the dwell firing: extract, then **always** emit a `page_visits` row
 *     (a real visit happened), and emit a content doc **only if** the extracted
 *     text's hash differs from the last hash emitted for this normalized URL.
 *   - A **SPA route change** (History `pushState`/`replaceState`/`popstate`)
 *     that yields a different normalized URL resets the machine to a fresh
 *     page and restarts the dwell clock. Same-normalized-URL route changes are
 *     ignored (an upsert target, not a new page).
 *   - A **DOM mutation** after the first capture schedules a re-extract with a
 *     **5s debounce, capped at a 15s max-wait** so a page that mutates forever
 *     still re-extracts; rapid mutations coalesce into one re-extract. The
 *     re-extract emits a content doc only when the body-text hash OR the title
 *     changed (so infinite-scroll feeds that keep appending don't re-push, but
 *     a late title rename still upserts), and never emits a new visit.
 *   - **Pages the capture policy excludes are skipped** entirely — no dwell, no capture.
 *
 * The machine holds at most one "current page" worth of state; navigating away
 * (route change / `reset`) discards it.
 */

/** Focused, visible dwell required before the first capture (ms). */
export const DWELL_MS = 5000;
/** Debounce window for MutationObserver-driven re-extraction (ms). */
export const MUTATION_DEBOUNCE_MS = 5000;
/**
 * Ceiling on how long the mutation debounce can be pushed back. A page that
 * mutates more often than {@link MUTATION_DEBOUNCE_MS} (a chat app that
 * re-renders constantly, a live feed) would otherwise reset the debounce
 * forever and never re-extract — so a title or body that settles after the
 * first capture would never be picked up. Once this much time has elapsed since
 * the first un-serviced mutation, the re-extract fires regardless.
 */
const MAX_MUTATION_DEBOUNCE_MS = 15000;
/** Hard boundary shared with the privileged worker message validator. */
export const MAX_CAPTURE_URL_CHARS = 8_192;
/** Page titles are useful metadata, but must not make the handoff unbounded. */
export const MAX_CAPTURE_TITLE_CHARS = 10_000;

export interface CaptureEmission {
  /**
   * `"visit"` — a dwell-confirmed visit completed: the SW enqueues a
   * `page_visits` row **and** (when `contentChanged`) a content doc.
   * `"re-extract"` — a debounced post-mutation re-extract: the SW enqueues a
   * content doc only (always with `contentChanged: true`), never a new visit.
   */
  kind: "visit" | "re-extract";
  normalizedUrl: string;
  title: string;
  text: string;
  contentHash: string;
  /** ISO-8601 instant of this emission (the visit's `visited_at`). */
  visitedAt: string;
  /** Focused, visible dwell accumulated for this visit, in ms. */
  dwellMs: number;
  /** True when the content hash changed vs the last emit for this URL. */
  contentChanged: boolean;
}

export interface CaptureLifecycleDeps {
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
  isFocused: () => boolean;
  /**
   * Read the rendered DOM. `canonicalUrl` is the page's `<link rel="canonical">`
   * href (absolute, or null when absent) read at this same instant, so the
   * emitted document can key on the page's declared identity rather than a
   * transient address-bar URL — see {@link preferCanonicalUrl}.
   */
  extract: () => Promise<{
    title: string;
    text: string;
    canonicalUrl?: string | null;
    /**
     * The page is one the capture policy says never to record — it carries a
     * password field, say. Nothing is emitted for it, and the page is not
     * marked captured, so it is judged again when the tab regains focus (the
     * dwell re-arms) or its route changes; a page that loses its password
     * field without either never emits.
     */
    sensitive?: boolean;
  }>;
  hash: (text: string) => Promise<string>;
  /** Whether the capture policy excludes this page URL (excluded or owned host, skipped path, pause). */
  isExcluded: (url: string) => Promise<boolean>;
  emit: (capture: CaptureEmission) => void;
  /** Optional knobs (tests shorten these). */
  dwellMs?: number;
  debounceMs?: number;
  maxDebounceMs?: number;
}

interface PageState {
  rawUrl: string;
  normalizedUrl: string;
  host: string;
  /** Whether the capture policy excludes this page — resolved once per page. */
  excluded: boolean | null;
  /** Accumulated focused+visible dwell, ms. */
  dwellAccrued: number;
  /** Epoch-ms the current focused span began, or null while hidden/blurred. */
  focusedSince: number | null;
  /** Has the initial (dwell-triggered) capture happened yet? */
  captured: boolean;
  /** Last content hash emitted for this URL (gates re-push on mutation). */
  lastHash: string | null;
  /**
   * Last title emitted for this URL. Tracked alongside `lastHash` so a pure
   * title change — common on SPAs that render the shell first and swap in the
   * real `document.title` a beat later (e.g. a chat app showing a conversation
   * title only after the thread loads) — still re-emits and upserts the rename,
   * even when the readable body text (and thus `lastHash`) is unchanged.
   */
  lastTitle: string | null;
  /**
   * Last normalized URL emitted for this page (it derives the document `externalId`).
   * Usually the page's normalized address, but a `<link rel="canonical">` can
   * sharpen it (see {@link preferCanonicalUrl}); tracked so that a canonical
   * appearing *after* the first capture — same body, same title — still re-emits
   * the page under its real identity instead of the transient address.
   */
  lastEmittedUrl: string | null;
  dwellTimer: number | null;
  initialCaptureInFlight: boolean;
  debounceTimer: number | null;
  reExtractInFlight: boolean;
  mutationPending: boolean;
  /**
   * Epoch-ms of the first mutation since the last re-extract, or null when no
   * debounce is pending. Drives the max-wait ceiling so a continuously-mutating
   * page still re-extracts (see {@link MAX_MUTATION_DEBOUNCE_MS}).
   */
  debounceStartedAt: number | null;
}

export class CaptureLifecycle {
  private readonly d: Required<
    Omit<CaptureLifecycleDeps, "dwellMs" | "debounceMs" | "maxDebounceMs">
  > & {
    dwellMs: number;
    debounceMs: number;
    maxDebounceMs: number;
  };
  private page: PageState | null = null;
  /**
   * Fences the asynchronous capture-policy probe. A probe that resolves
   * after a newer one was issued for the same page is discarded, so a stale
   * answer cannot overwrite a fresher verdict.
   */
  private exclusionProbe = 0;

  constructor(deps: CaptureLifecycleDeps) {
    this.d = {
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      isFocused: deps.isFocused,
      extract: deps.extract,
      hash: deps.hash,
      isExcluded: deps.isExcluded,
      emit: deps.emit,
      dwellMs: deps.dwellMs ?? DWELL_MS,
      debounceMs: deps.debounceMs ?? MUTATION_DEBOUNCE_MS,
      maxDebounceMs: deps.maxDebounceMs ?? MAX_MUTATION_DEBOUNCE_MS,
    };
  }

  /**
   * Begin (or restart) tracking a page. Called on initial load and on every
   * SPA route change. A route change to the same normalized URL is a no-op so
   * the dwell clock isn't reset by hash-only or replaceState churn.
   */
  start(rawUrl: string): void {
    const normalizedUrl = normalizeCaptureUrl(rawUrl);
    if (normalizedUrl.length > MAX_CAPTURE_URL_CHARS) {
      this.reset();
      return;
    }
    if (this.page && this.page.normalizedUrl === normalizedUrl) {
      // Same logical page — keep the existing dwell/state.
      return;
    }
    this.reset();
    this.page = {
      rawUrl,
      normalizedUrl,
      host: hostOf(rawUrl),
      excluded: null,
      dwellAccrued: 0,
      focusedSince: null,
      captured: false,
      lastHash: null,
      lastTitle: null,
      lastEmittedUrl: null,
      dwellTimer: null,
      initialCaptureInFlight: false,
      debounceStartedAt: null,
      debounceTimer: null,
      reExtractInFlight: false,
      mutationPending: false,
    };
    // Resolve ownership, then start the dwell clock if focused.
    void this.resolveExclusionThenArm();
  }

  /** Tear down all timers and forget the current page. */
  reset(): void {
    if (this.page?.dwellTimer != null) this.d.clearTimer(this.page.dwellTimer);
    if (this.page?.debounceTimer != null) this.d.clearTimer(this.page.debounceTimer);
    this.page = null;
  }

  /** The page gained focus/visibility — resume accruing dwell. */
  onFocus(): void {
    const p = this.page;
    if (!p || p.excluded) return;
    if (p.focusedSince == null) {
      p.focusedSince = this.d.now();
      this.armDwellTimer();
    }
  }

  /** The page lost focus or became hidden — pause accruing dwell. */
  onBlur(): void {
    const p = this.page;
    if (!p || p.excluded) return;
    if (p.focusedSince != null) {
      p.dwellAccrued += this.d.now() - p.focusedSince;
      p.focusedSince = null;
    }
    if (p.dwellTimer != null) {
      this.d.clearTimer(p.dwellTimer);
      p.dwellTimer = null;
    }
  }

  /**
   * A DOM mutation was observed. Only meaningful after the first capture: it
   * schedules a debounced re-extract. Before the first capture, the dwell
   * itself will trigger the (first) extract, so mutations are ignored.
   *
   * The debounce coalesces rapid mutations into one re-extract, but is capped by
   * {@link MAX_MUTATION_DEBOUNCE_MS}: a page that never goes quiet for a full
   * debounce window (a chat app re-rendering constantly) still re-extracts once
   * the ceiling elapses, so a title/body that settles after the first capture is
   * not lost to a perpetually-reset timer.
   */
  onMutation(): void {
    const p = this.page;
    if (!p || p.excluded) return;
    if (!p.captured) {
      if (p.initialCaptureInFlight) p.mutationPending = true;
      return;
    }
    if (p.reExtractInFlight) {
      p.mutationPending = true;
      return;
    }
    this.scheduleMutation(p);
  }

  private scheduleMutation(p: PageState): void {
    if (this.page !== p || p.excluded || !p.captured) return;
    const now = this.d.now();
    if (p.debounceStartedAt == null) p.debounceStartedAt = now;
    if (p.debounceTimer != null) this.d.clearTimer(p.debounceTimer);
    // Normal debounce, but never wait past maxDebounceMs since the first
    // un-serviced mutation.
    const remainingCap = this.d.maxDebounceMs - (now - p.debounceStartedAt);
    const wait = Math.max(0, Math.min(this.d.debounceMs, remainingCap));
    p.debounceTimer = this.d.setTimer(() => {
      p.debounceTimer = null;
      p.debounceStartedAt = null;
      void this.reExtract().catch(() => this.scheduleMutation(p));
    }, wait);
  }

  private async resolveExclusionThenArm(): Promise<void> {
    const p = this.page;
    if (!p) return;
    const probe = ++this.exclusionProbe;
    const excluded = p.host ? await this.d.isExcluded(p.normalizedUrl) : false;
    // The page may have changed, or a newer probe may have answered, while we
    // awaited — bail if so.
    if (this.page !== p || this.exclusionProbe !== probe) return;
    p.excluded = excluded;
    if (excluded) return; // skip entirely — no dwell, no capture
    // If the host reports focus now, start the clock.
    if (this.d.isFocused()) this.onFocus();
  }

  /**
   * Judge the page being tracked against the capture policy again, after the
   * settings behind that policy changed. The page keeps everything it has
   * accrued — its dwell, whether it has already been captured, the hash of what
   * it last emitted — so a page that becomes eligible again is not captured a
   * second time and no duplicate visit is recorded. A page that has just become
   * excluded stops accruing dwell and drops its pending re-extract, keeping
   * whatever it has already contributed.
   */
  async rejudge(): Promise<void> {
    const p = this.page;
    if (!p) return;
    const probe = ++this.exclusionProbe;
    const excluded = p.host ? await this.d.isExcluded(p.normalizedUrl) : false;
    if (this.page !== p || this.exclusionProbe !== probe || excluded === p.excluded) return;
    if (excluded) {
      // Fold the dwell accrued so far and stop the clock before the exclusion
      // takes effect; `onBlur` and `scheduleMutation` both ignore an excluded page.
      this.onBlur();
      if (p.debounceTimer != null) this.d.clearTimer(p.debounceTimer);
      p.debounceTimer = null;
      p.debounceStartedAt = null;
      p.mutationPending = false;
      p.excluded = true;
      return;
    }
    p.excluded = false;
    if (this.d.isFocused()) this.onFocus();
  }

  private armDwellTimer(): void {
    const p = this.page;
    if (!p || p.captured || p.initialCaptureInFlight || p.focusedSince == null) return;
    const remaining = Math.max(0, this.d.dwellMs - p.dwellAccrued);
    if (p.dwellTimer != null) this.d.clearTimer(p.dwellTimer);
    p.dwellTimer = this.d.setTimer(() => {
      p.dwellTimer = null;
      void this.onDwellComplete().catch(() => this.scheduleInitialRetry(p));
    }, remaining);
  }

  private scheduleInitialRetry(p: PageState): void {
    if (
      this.page !== p ||
      p.captured ||
      p.initialCaptureInFlight ||
      p.excluded ||
      p.focusedSince == null
    ) {
      return;
    }
    p.dwellTimer = this.d.setTimer(() => {
      p.dwellTimer = null;
      void this.onDwellComplete().catch(() => this.scheduleInitialRetry(p));
    }, this.d.debounceMs);
  }

  private dwellSoFar(p: PageState): number {
    return p.dwellAccrued + (p.focusedSince != null ? this.d.now() - p.focusedSince : 0);
  }

  private async onDwellComplete(): Promise<void> {
    const p = this.page;
    if (!p || p.captured || p.initialCaptureInFlight || p.excluded) return;
    // Guard against a timer that fired after focus was lost.
    if (this.dwellSoFar(p) < this.d.dwellMs) {
      this.armDwellTimer();
      return;
    }
    p.initialCaptureInFlight = true;
    try {
      const { title: extractedTitle, text, canonicalUrl, sensitive } = await this.d.extract();
      if (this.page !== p) return;
      // A sign-in or checkout page dwelt on is never recorded, not even as a visit.
      if (sensitive) return;
      const contentHash = await this.d.hash(text);
      if (this.page !== p) return;

      const title = boundedTitle(extractedTitle);
      const emittedUrl = boundedEmissionUrl(p.rawUrl, canonicalUrl);
      p.captured = true;
      const changed = contentHash !== p.lastHash;
      p.lastHash = contentHash;
      p.lastTitle = title;
      p.lastEmittedUrl = emittedUrl;
      this.d.emit({
        kind: "visit",
        normalizedUrl: emittedUrl,
        title,
        text,
        contentHash,
        visitedAt: new Date(this.d.now()).toISOString(),
        dwellMs: Math.round(this.dwellSoFar(p)),
        contentChanged: changed,
      });
    } finally {
      if (this.page === p) {
        p.initialCaptureInFlight = false;
        if (p.captured && p.mutationPending) {
          p.mutationPending = false;
          this.scheduleMutation(p);
        }
      }
    }
  }

  /**
   * Debounced re-extract after DOM mutations. Emits a content doc only when the
   * body-text hash or the title changed (so churny feeds don't re-push, but a
   * late title rename does); never emits a new visit (a mutation is not a new
   * visit). When nothing changed, emits nothing.
   */
  private async reExtract(): Promise<void> {
    const p = this.page;
    if (!p || p.excluded || !p.captured) return;
    if (p.reExtractInFlight) {
      p.mutationPending = true;
      return;
    }
    p.reExtractInFlight = true;
    try {
      const { title: extractedTitle, text, canonicalUrl, sensitive } = await this.d.extract();
      if (this.page !== p) return;
      if (sensitive) return;
      const contentHash = await this.d.hash(text);
      if (this.page !== p) return;
      const title = boundedTitle(extractedTitle);
      const emittedUrl = boundedEmissionUrl(p.rawUrl, canonicalUrl);
      // Re-emit when the body text, the title, OR the resolved identity changed.
      // An unchanged page doesn't churn the corpus, but a late title rename or a
      // canonical link that settles after the first capture (same body) does
      // upsert the page under its real title / identity.
      if (contentHash === p.lastHash && title === p.lastTitle && emittedUrl === p.lastEmittedUrl) {
        return;
      }
      p.lastHash = contentHash;
      p.lastTitle = title;
      p.lastEmittedUrl = emittedUrl;
      this.d.emit({
        kind: "re-extract",
        normalizedUrl: emittedUrl,
        title,
        text,
        contentHash,
        visitedAt: new Date(this.d.now()).toISOString(),
        dwellMs: Math.round(this.dwellSoFar(p)),
        contentChanged: true,
      });
    } finally {
      if (this.page === p) {
        p.reExtractInFlight = false;
        if (p.mutationPending) {
          p.mutationPending = false;
          this.scheduleMutation(p);
        }
      }
    }
  }
}

function boundedTitle(title: string): string {
  return title.slice(0, MAX_CAPTURE_TITLE_CHARS);
}

function boundedEmissionUrl(rawUrl: string, canonicalUrl?: string | null): string {
  const liveUrl = normalizeCaptureUrl(rawUrl);
  const preferred = normalizeCaptureUrl(preferCanonicalUrl(rawUrl, canonicalUrl));
  return preferred.length <= MAX_CAPTURE_URL_CHARS ? preferred : liveUrl;
}
