// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { CaptureLifecycle, type CaptureEmission } from "../capture/lifecycle.js";
import { CaptureHandoffQueue } from "../capture/handoff.js";
import { extractReadableText } from "../capture/extract.js";
import { hashText } from "../capture/content-hash.js";
import { messageWithTimeout } from "./message-timeout.js";
import {
  CAPTURE_HANDOFF_FAILURE_KEY,
  type CaptureAck,
  type CaptureContentStatus,
  type CaptureEligibilityResponse,
  type ContentToSwMessage,
} from "./messages.js";
import { loadCapturePermissionState } from "./capture-permission-state.js";
import { hasExactWebScope, loadPairing } from "./pairing-record.js";
import {
  captureHandoffKey,
  capturePairingId,
  pendingHandoffKeys,
  persistCaptureHandoffGuarded,
  type HandoffStorage,
} from "./handoff-storage.js";
import { CaptureActivation } from "./capture-activation.js";
import { attachCaptureStatusListener } from "./content-status.js";
import { applyCaptureStorageAction, captureStorageAction } from "./capture-storage-change.js";

/**
 * Content-script glue — the thin boundary that wires the browser (DOM, History
 * API, Page Visibility, MutationObserver) into the pure {@link CaptureLifecycle}
 * state machine, and forwards confirmed captures to the service worker (the
 * single queue owner).
 *
 * All capture *logic* lives in `capture/lifecycle.ts`; this module only
 * translates browser events into the machine's `start` / `onFocus` / `onBlur` /
 * `onMutation` calls and injects the real side effects (`extract`, `hash`,
 * `isExcluded`, `emit`). It deliberately holds no decision logic of its own.
 *
 * The browser is handed in as a {@link ContentScriptEnvironment} rather than
 * read from globals, so the same code runs against the real page from
 * `content.ts` and against a synthetic document plus a fake `chrome` under
 * Node. The environment is the only seam: nothing here reaches for a global.
 */

/** The slice of the `chrome.*` API the content script touches. */
export interface ContentScriptChrome {
  storage: {
    local: HandoffStorage;
    onChanged: {
      addListener(
        callback: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void,
      ): void;
      removeListener(
        callback: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void,
      ): void;
    };
  };
  runtime: {
    /** The extension id, or `undefined` once the extension context is invalidated. */
    readonly id: string | undefined;
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    onMessage: Parameters<typeof attachCaptureStatusListener>[1];
  };
  extension?: { readonly inIncognitoContext: boolean };
}

/** A `MutationObserver` as the content script drives it: observe once, disconnect once. */
export interface ContentMutationObserver {
  observe(
    target: Node,
    options: { childList: boolean; subtree: boolean; characterData: boolean },
  ): void;
  disconnect(): void;
}

export interface ContentScriptEnvironment {
  document: Document;
  window: Pick<Window, "addEventListener" | "removeEventListener"> & {
    /** The Navigation API's entry point, absent on browsers that lack it. */
    navigation?: EventTarget;
  };
  location: Pick<Location, "href">;
  chrome: ContentScriptChrome;
  MutationObserver: new (callback: () => void) => ContentMutationObserver;
  setTimeout: (fn: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

const MESSAGE_TIMEOUT_MS = 4_500;

interface HandoffBinding {
  key: string;
  pairingId: string;
  order: string;
}

/**
 * Wire one page into the capture machine. Runs to completion synchronously
 * (the asynchronous parts — the authorization read, the eligibility probe —
 * are kicked off, not awaited), exactly as the module body of a content
 * script does when Chrome injects it.
 */
export function startContentScript(env: ContentScriptEnvironment): void {
  const { document, window, location, chrome } = env;

  /**
   * After an extension reload/update, the content scripts already injected into
   * open tabs are orphaned: their timers and MutationObserver keep firing, but
   * their `chrome.*` context is gone, so the next `chrome.runtime` call throws
   * "Extension context invalidated". We detect that and tear the orphan down once
   * (disconnect the observer, stop the machine, drop listeners) instead of
   * spewing unhandled rejections until the tab is reloaded.
   */
  let torndown = false;
  let authorizationGeneration = 0;
  let pageCaptureState: CaptureContentStatus["state"] = "checking";
  let pageCaptureReason: CaptureContentStatus["reason"];
  /** The policy's password-field rule as the worker last reported it; on by default. */
  let skipPasswordForms = true;
  const contentInstanceId = crypto.randomUUID();
  const handoffBindings = new WeakMap<CaptureEmission, Promise<HandoffBinding | null>>();
  let handoffSequence = 0;

  function handoffBinding(emission: CaptureEmission): Promise<HandoffBinding | null> {
    const existing = handoffBindings.get(emission);
    if (existing) return existing;
    const binding = (async () => {
      const config = await loadPairing(chrome.storage.local);
      if (!config) return null;
      handoffSequence += 1;
      const order = `${String(env.now()).padStart(16, "0")}.${contentInstanceId}.${String(
        handoffSequence,
      ).padStart(8, "0")}`;
      const [key, pairingId] = await Promise.all([
        captureHandoffKey(contentInstanceId, emission, order),
        capturePairingId(config),
      ]);
      return { key, pairingId, order };
    })();
    handoffBindings.set(emission, binding);
    void binding.then(
      (resolved) => {
        if (resolved === null && handoffBindings.get(emission) === binding) {
          handoffBindings.delete(emission);
        }
      },
      () => {
        // A transient storage read must not poison this emission forever. The
        // queue retry obtains a fresh binding, or tears down if this script was
        // orphaned by an extension reload.
        if (handoffBindings.get(emission) === binding) handoffBindings.delete(emission);
      },
    );
    return binding;
  }

  async function persistEmission(emission: CaptureEmission): Promise<void> {
    if (torndown || !contextAlive()) {
      teardown();
      return;
    }
    const generation = authorizationGeneration;
    const binding = await handoffBinding(emission);
    // Pages read before pairing are outside the capture contract. Treat that as
    // a clean no-op so one pre-pair emission cannot block the tab's retry pump;
    // later emissions re-evaluate config and work immediately after pairing.
    if (!binding) return;
    const stillAuthorized = (): boolean =>
      !torndown && generation === authorizationGeneration && activation.active;
    if (!stillAuthorized()) return;
    await persistCaptureHandoffGuarded(
      chrome.storage.local,
      binding.key,
      {
        at: env.now(),
        order: binding.order,
        pairingId: binding.pairingId,
        emission,
      },
      stillAuthorized,
    );
  }

  async function discardPersistedEmission(emission: CaptureEmission): Promise<void> {
    const binding = handoffBindings.get(emission);
    if (!binding) return;
    const resolved = await binding;
    if (resolved) await chrome.storage.local.remove(resolved.key);
  }

  function runtimeMessageWithTimeout<T>(message: unknown): Promise<T> {
    return messageWithTimeout(chrome.runtime.sendMessage<T>(message), MESSAGE_TIMEOUT_MS);
  }

  async function clearHandoffFailureIfEmpty(): Promise<void> {
    if ((await pendingHandoffKeys(chrome.storage.local)).length === 0) {
      await chrome.storage.local.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
    }
  }

  /** True while this content script's extension context is still alive. */
  function contextAlive(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function extensionContextInvalidated(error: unknown): boolean {
    return (
      !contextAlive() ||
      (error instanceof Error && /extension context (?:was )?invalidated/i.test(error.message))
    );
  }

  const handoff = new CaptureHandoffQueue({
    persist: persistEmission,
    discard: discardPersistedEmission,
    send: async (emission) => {
      if (torndown || !contextAlive()) {
        teardown();
        return true;
      }
      try {
        const binding = await handoffBinding(emission);
        if (!binding) return true;
        const ack = await runtimeMessageWithTimeout<CaptureAck>({
          type: "capture",
          emission,
          handoffKey: binding.key,
          pairingId: binding.pairingId,
        } satisfies ContentToSwMessage);
        return ack?.ok === true;
      } catch {
        if (!contextAlive()) {
          teardown();
          return true;
        }
        return false;
      }
    },
    setTimer: env.setTimeout,
    onStalled: (attempts) => {
      pageCaptureState = "handoff-delayed";
      pageCaptureReason = undefined;
      void chrome.storage.local
        .set({
          [CAPTURE_HANDOFF_FAILURE_KEY]: JSON.stringify({ at: env.now(), attempts }),
        })
        .catch(() => undefined);
    },
    onRecovered: () => {
      pageCaptureState = "watching";
      pageCaptureReason = undefined;
      void clearHandoffFailureIfEmpty().catch(() => undefined);
    },
  });

  const lifecycle = new CaptureLifecycle({
    now: env.now,
    setTimer: env.setTimeout,
    clearTimer: env.clearTimeout,
    isFocused: () => document.visibilityState === "visible" && document.hasFocus(),
    extract: () => {
      // Only the page can see its own DOM, so this one policy rule is applied
      // here: a page carrying a password field is a sign-in, checkout or account
      // page, and is never recorded.
      if (skipPasswordForms && hasPasswordField()) {
        return Promise.resolve({ title: "", text: "", canonicalUrl: null, sensitive: true });
      }
      return Promise.resolve({
        ...extractReadableText(document, location.href),
        canonicalUrl: canonicalHref(),
      });
    },
    hash: (text) => hashText(text),
    isExcluded: async (url) => {
      if (torndown || !contextAlive()) {
        teardown();
        return false;
      }
      try {
        const res = await runtimeMessageWithTimeout<CaptureEligibilityResponse>({
          type: "capture-eligibility",
          url,
        } satisfies ContentToSwMessage);
        skipPasswordForms = res?.skipPasswordForms !== false;
        if (res?.eligible === false) {
          pageCaptureState = res.reason === "no-policy" ? "policy-pending" : "excluded";
          pageCaptureReason = res.reason;
          return true;
        }
        if (skipPasswordForms && hasPasswordField()) {
          pageCaptureState = "excluded";
          pageCaptureReason = "password-field";
          return true;
        }
        pageCaptureState = "watching";
        pageCaptureReason = undefined;
        return false;
      } catch {
        // SW unreachable (cold-start race) — don't skip on uncertainty; the
        // worker judges the capture against the policy again before anything is
        // queued. But if the context itself is gone, this is an orphaned script:
        // go quiet.
        if (!contextAlive()) teardown();
        pageCaptureState = "watching";
        pageCaptureReason = undefined;
        return false;
      }
    },
    emit: (emission) => handoff.enqueue(emission),
  });

  /**
   * Capture is disabled entirely in incognito / private windows — Omnesis never
   * indexes private browsing. Computed once: the incognito-ness of a window is
   * fixed for the page's lifetime. When disabled, the capture machine is simply
   * never started, so every focus/mutation/route handler below is an inert no-op
   * (they all early-return on a null page).
   */
  function inIncognito(): boolean {
    try {
      return chrome.extension?.inIncognitoContext === true;
    } catch {
      return true;
    }
  }
  const activation = new CaptureActivation({
    readAllowed: async () => {
      const [config, permissionGranted] = await Promise.all([
        loadPairing(chrome.storage.local),
        loadCapturePermissionState(chrome.storage.local),
      ]);
      return config !== null && hasExactWebScope(config) && permissionGranted;
    },
    start: () => lifecycle.start(location.href),
    stop: () => lifecycle.reset(),
    markInactive: () => {
      // No pairing, no host access, or an incognito window: the popup names
      // those from its own state, so this carries no capture-settings reason.
      pageCaptureState = "excluded";
      pageCaptureReason = undefined;
    },
    setTimer: env.setTimeout,
    clearTimer: env.clearTimeout,
    isTerminalError: extensionContextInvalidated,
    onTerminalError: teardown,
  });
  if (inIncognito()) {
    activation.terminate();
    handoff.shutdown();
  } else {
    void activation.refresh();
  }

  const detachCaptureStatus = attachCaptureStatusListener(
    () =>
      ({
        state: pageCaptureState,
        ...(pageCaptureReason ? { reason: pageCaptureReason } : {}),
      }) satisfies CaptureContentStatus,
    chrome.runtime.onMessage,
  );

  // --- Wire browser events into the state machine -----------------------------

  /** Whether the rendered page currently carries a password field. */
  function hasPasswordField(): boolean {
    return document.querySelector('input[type="password"]') !== null;
  }

  /**
   * The page's `<link rel="canonical">` href (absolute — the DOM resolves it),
   * or null when absent. Read fresh at each extract so a single-page app that
   * injects/updates its canonical after load is honoured. The capture engine uses
   * it to key the document on the page's declared identity rather than a
   * transient address-bar URL (see `preferCanonicalUrl`).
   */
  function canonicalHref(): string | null {
    const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    return link?.href ?? null;
  }

  // Focus / visibility — pause the dwell clock when the tab is hidden or blurred.
  const syncFocus = (): void => {
    if (document.visibilityState === "visible" && document.hasFocus()) lifecycle.onFocus();
    else lifecycle.onBlur();
  };
  document.addEventListener("visibilitychange", syncFocus);
  window.addEventListener("focus", syncFocus);
  window.addEventListener("blur", syncFocus);

  // SPA route changes. The Navigation API's `currententrychange` fires on every
  // history-entry change, including `pushState`/`replaceState` calls the page
  // makes through its own references (how SPA routers navigate), so it is the
  // primary signal. `popstate` covers back/forward on the rare page where the
  // Navigation API is unavailable. `start()` de-dups same-URL changes, so both
  // firing for one navigation is harmless.
  const onLocationChange = (): void => {
    if (activation.active && !torndown) lifecycle.start(location.href);
  };
  window.addEventListener("popstate", onLocationChange);
  const navigation = window.navigation;
  navigation?.addEventListener("currententrychange", onLocationChange);

  // Pairing and permission changes are mirrored through storage because Chrome
  // can leave an already-injected content script alive after host access changes.
  const onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    const action = captureStorageAction(changes, areaName);
    applyCaptureStorageAction(action, {
      terminate: teardown,
      deactivate: () => {
        authorizationGeneration += 1;
        handoff.cancelPending();
        activation.deactivate();
      },
      reconcile: () => {
        authorizationGeneration += 1;
        handoff.cancelPending();
        void activation.reconcile();
      },
      // A settings change replaces no authorization, so this is not an
      // activation event: the page is judged against the new settings in place,
      // keeping its dwell, its staged captures and what it has already emitted.
      rejudge: () => void lifecycle.rejudge(),
      refresh: () => void activation.refresh(),
    });
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

  // DOM mutations — feed the machine; it debounces and gates on hash change.
  const observer = new env.MutationObserver(() => {
    if (!torndown) lifecycle.onMutation();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  /**
   * Stop this (now orphaned) content script: disconnect the observer, halt the
   * capture machine, and drop the listeners. Idempotent — invoked the first time
   * a `chrome.*` call reveals the context is gone.
   */
  function teardown(): void {
    if (torndown) return;
    torndown = true;
    authorizationGeneration += 1;
    handoff.shutdown();
    observer.disconnect();
    activation.terminate();
    document.removeEventListener("visibilitychange", syncFocus);
    window.removeEventListener("focus", syncFocus);
    window.removeEventListener("blur", syncFocus);
    window.removeEventListener("popstate", onLocationChange);
    navigation?.removeEventListener("currententrychange", onLocationChange);
    // Both Chrome event removals are best-effort because the extension context
    // may already be invalid. Detach the popup responder first so a throwing
    // storage API cannot prevent the more important status cleanup.
    detachCaptureStatus();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // Extension reload invalidated the context before teardown ran.
    }
  }
}
