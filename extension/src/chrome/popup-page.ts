// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { pauseRemainingMs } from "@omnesis/provider-web/capture-policy";
import { PushClient } from "../push/index.js";
import { PAUSE_ONE_DAY_MS, PAUSE_ONE_HOUR_MS } from "../capture/policy.js";
import { chromeLocalStore, hasExactWebScope, loadConfig } from "./storage.js";
import { composeStatus, type CaptureStatus } from "./status.js";
import {
  currentPagePresentation,
  inspectCurrentPage,
  type CurrentPageResult,
} from "./current-page.js";
import { hasActiveFailure, warningFor } from "./status-presentation.js";
import { hasCaptureAccess } from "./content-registration.js";
import {
  CAPTURE_STATUS_MESSAGE,
  type ExclusionAck,
  type PopupToSwMessage,
  type PauseAck,
} from "./messages.js";

/**
 * Popup controller — the "is it working, and let me control it" surface.
 *
 * Renders the one composed {@link CaptureStatus} (shared with the toolbar badge
 * via the service worker): connection + scope health, queue depth, last-sync /
 * paired-since, a recent-synced proof-of-life list, and the capture controls.
 * The pause and the exclusions are settings every browser paired to the
 * gateway shares, so those actions are sent to the SW, which applies them on
 * the gateway and refreshes the badge; everything else is read straight from
 * the durable store.
 *
 * Untrusted page titles/URLs from the recent log are rendered via `textContent`
 * only — never `innerHTML` — so a crafted page title can't inject markup here.
 *
 * The page and the `chrome` API are parameters of {@link initPopup} so the
 * controller runs against `popup.html` parsed under Node as well as in the
 * real popup window.
 */

/** The slice of the `chrome.*` API the popup touches directly. */
export interface PopupChrome {
  runtime: {
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    getManifest(): { version: string };
    openOptionsPage(): Promise<void>;
  };
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<chrome.tabs.Tab[]>;
    sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
  };
}

/** Machine-readable summary states; `data-state` carries them for tests and styling. */
type SummaryState =
  | "unpaired"
  | "paused"
  | "not-syncing"
  | "syncing"
  | "ready"
  | "not-capturing"
  | "control-failed"
  | "check-failed";

/** A coarse "2m ago" / "3h ago" / "just now" relative time. */
function relativeTime(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** "resumes in 59m" / "resumes in 23h 59m" for a timed pause. */
function resumesIn(remainingMs: number): string {
  const totalMin = Math.ceil(remainingMs / 60000);
  if (totalMin < 60) return `resumes in ${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `resumes in ${hr}h${min ? ` ${min}m` : ""}`;
}

/** "Jun 23" style short date for the paired-since line. */
function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Wire the popup document: render the cached state at once, then re-check with the worker. */
export function initPopup(document: Document, chrome: PopupChrome): void {
  let countdownTimer: number | null = null;
  let renderRequest = 0;
  /** The host excluded from this popup, so the click keeps a visible result. */
  let excludedHere: string | null = null;

  function $(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el;
  }

  function setState(state: SummaryState, label: string): void {
    const el = $("state");
    el.textContent = label;
    el.dataset.state = state;
  }

  /** Tell the service worker to change the pause state, then re-render. */
  async function sendControl(msg: PopupToSwMessage): Promise<void> {
    try {
      const ack = await chrome.runtime.sendMessage<PauseAck>(msg);
      if (!ack?.ok) throw new Error(ack?.reason ?? "background worker unavailable");
      await render();
    } catch {
      $("warn").textContent =
        "The capture control did not reach the extension background worker. Reload the extension and try again.";
      document.body.dataset.warn = "true";
      setState("control-failed", "Control failed");
    }
  }

  function showCheckFailure(): void {
    if ($("warn").textContent === "") {
      $("warn").textContent =
        "The extension background check failed. Reload this extension from chrome://extensions.";
      document.body.dataset.warn = "true";
      setState("check-failed", "Check failed");
    }
  }

  async function renderSafely(): Promise<void> {
    try {
      await render();
    } catch {
      showCheckFailure();
    }
  }

  /** Render the temporary-disable controls for the current pause state. */
  function renderControls(status: CaptureStatus, now: number): void {
    const host = $("controls");
    host.replaceChildren();
    host.hidden = false;

    if (status.pause.paused) {
      const line = document.createElement("div");
      line.className = "pause-line";
      const remaining = pauseRemainingMs({ until: status.pause.until }, now);
      line.textContent =
        remaining === null
          ? "Capture paused in every paired browser"
          : `Capture paused in every paired browser — ${resumesIn(remaining)}`;
      host.appendChild(line);

      const resume = document.createElement("button");
      resume.textContent = "Resume capturing";
      resume.addEventListener("click", () => void sendControl({ type: "resume" }));
      host.appendChild(resume);
      return;
    }

    const label = document.createElement("div");
    label.className = "controls-label muted";
    label.textContent = "Pause capture in every paired browser";
    host.appendChild(label);

    const row = document.createElement("div");
    row.className = "btn-row";
    const buttons: Array<{ text: string; until: number | null }> = [
      { text: "1 hour", until: now + PAUSE_ONE_HOUR_MS },
      { text: "1 day", until: now + PAUSE_ONE_DAY_MS },
      { text: "Until I resume", until: null },
    ];
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = "secondary chip";
      btn.textContent = b.text;
      btn.addEventListener("click", () => void sendControl({ type: "set-pause", until: b.until }));
      row.appendChild(btn);
    }
    host.appendChild(row);
  }

  /** Render the recent-synced proof-of-life list (newest first, capped for the popup). */
  function renderRecent(status: CaptureStatus, now: number): void {
    const wrap = $("recent-wrap") as HTMLDetailsElement;
    const list = $("recent-list");
    list.replaceChildren();
    const items = status.recent.slice(0, 12);
    if (items.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    $("recent-count").textContent = `(${status.recent.length})`;
    for (const r of items) {
      const li = document.createElement("li");
      li.className = "recent-item";

      const title = document.createElement("span");
      title.className = "recent-title";
      title.textContent = r.title || r.url; // textContent — page titles are untrusted
      title.title = r.url; // tooltip; the title attribute is rendered as plain text, not HTML

      const when = document.createElement("span");
      when.className = "recent-when muted";
      when.textContent = relativeTime(r.at, now);

      li.append(title, when);
      list.appendChild(li);
    }
  }

  async function renderCurrentPageStatus(
    paired: boolean,
    hostPermissionOk: boolean,
    existingActiveFailure: boolean,
    request: number,
  ): Promise<void> {
    const target = $("current-page");
    const result = await inspectCurrentPage(paired, hostPermissionOk, {
      queryActiveTab: async () =>
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
      readCaptureStatus: (tabId) => chrome.tabs.sendMessage(tabId, CAPTURE_STATUS_MESSAGE),
    });
    if (request !== renderRequest) return;
    target.textContent = result.label;
    target.dataset.state = result.state;
    renderExcludeControl(result);
    const presentation = currentPagePresentation(
      result,
      $("warn").textContent ?? "",
      existingActiveFailure,
    );
    if (presentation.activeFailure && !existingActiveFailure) {
      $("warn").textContent = presentation.warning;
      document.body.dataset.warn = "true";
      document.body.dataset.notice = "false";
      ($("ack-warning") as HTMLButtonElement).hidden = true;
      setState("not-capturing", "Not capturing");
    }
  }

  /**
   * Offer to exclude the active tab's site, and say what the click did. The
   * exclusion is shared: it lands on the gateway and every paired browser stops
   * capturing the domain. Once excluded from here the button is replaced by a
   * line naming the domain, so the click has a result the user can see even
   * before the page itself is judged again.
   */
  function renderExcludeControl(result: CurrentPageResult): void {
    const wrap = $("exclude-wrap");
    const button = $("exclude-site") as HTMLButtonElement;
    const done = $("exclude-done");
    // The confirmation belongs to the host it named; if the tab has moved on,
    // the control goes back to offering that new host.
    if (excludedHere !== null && excludedHere !== result.host) excludedHere = null;
    if (excludedHere !== null) {
      wrap.hidden = false;
      button.hidden = true;
      done.hidden = false;
      done.textContent = `${excludedHere} is excluded.`;
      return;
    }
    done.hidden = true;
    const offer =
      result.host !== undefined &&
      (result.state === "watching" ||
        result.state === "checking" ||
        result.state === "handoff-delayed" ||
        result.state === "not-attached");
    wrap.hidden = !offer;
    if (!offer || result.host === undefined) return;
    const host = result.host;
    button.hidden = false;
    button.textContent = `Exclude ${host}`; // textContent — the host is page-controlled
    button.disabled = false;
    button.onclick = () => {
      button.disabled = true;
      void (async () => {
        try {
          const ack = await chrome.runtime.sendMessage<ExclusionAck>({
            type: "add-excluded-domain",
            input: host,
          } satisfies PopupToSwMessage);
          if (!ack?.ok) throw new Error(ack?.reason ?? "background worker unavailable");
          excludedHere = host;
          await render();
        } catch (error) {
          $("warn").textContent =
            `Could not exclude ${host}: ${error instanceof Error ? error.message : String(error)}`;
          document.body.dataset.warn = "true";
          button.disabled = false;
        }
      })();
    };
  }

  async function render(): Promise<void> {
    const request = ++renderRequest;
    const now = Date.now();
    const config = await loadConfig();
    const client =
      config && hasExactWebScope(config)
        ? new PushClient({
            gatewayUrl: config.gatewayUrl,
            token: config.token,
            fetch: (input, init) => fetch(input, init),
            store: chromeLocalStore,
          })
        : null;
    const status = await composeStatus({
      config,
      client,
      hostPermissionOk: !config || (await hasCaptureAccess()),
      store: chromeLocalStore,
      now,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    if (request !== renderRequest) return;

    document.body.dataset.paired = String(status.paired);
    document.body.dataset.paused = String(status.pause.paused);

    const warn = warningFor(status);
    document.body.dataset.warn = String(warn !== "");
    $("warn").textContent = warn;

    // The summary state must remain consistent with active warning detail.
    // Historical loss notices remain visible without claiming current sync is
    // still broken.
    const activeFailure = hasActiveFailure(status);
    const historicalLoss = Boolean(
      status.queueCorruption || status.queueOverflow || status.handoffOverflow || status.failure,
    );
    document.body.dataset.notice = String(historicalLoss && !activeFailure);
    ($("ack-warning") as HTMLButtonElement).hidden = activeFailure || !historicalLoss;
    if (!status.paired) setState("unpaired", "Not paired");
    else if (status.pause.paused) setState("paused", "Paused");
    else if (activeFailure) setState("not-syncing", "Not syncing");
    else if (status.queueDepth > 0) setState("syncing", "Syncing");
    else setState("ready", "Ready");

    $("gateway").textContent = status.gatewayUrl
      ? `${status.gatewayUrl}${status.gatewayVersion ? ` · v${status.gatewayVersion}` : ""}`
      : "—";
    $("queue").textContent = status.paired ? String(status.queueDepth) : "—";
    $("last-sync").textContent = status.lastSyncAt ? relativeTime(status.lastSyncAt, now) : "—";
    // Gateway reachability/authentication is distinct from an actual page sync.
    $("last-checked").textContent = !status.paired
      ? "—"
      : status.lastCheckedAt
        ? relativeTime(status.lastCheckedAt, now)
        : "checking…";
    $("paired-since").textContent = status.pairedAt ? shortDate(status.pairedAt) : "—";
    $("scope").textContent = !status.paired ? "—" : status.scopeOk ? "Yes" : "No";

    if (status.paired) {
      renderControls(status, now);
      renderRecent(status, now);
    } else {
      $("controls").hidden = true;
      $("exclude-wrap").hidden = true;
      ($("recent-wrap") as HTMLDetailsElement).hidden = true;
    }
    void renderCurrentPageStatus(status.paired, status.hostPermissionOk, activeFailure, request);

    // Live-tick the countdown while a timed pause is active and the popup is open.
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (status.pause.paused && status.pause.until !== null) {
      countdownTimer = setInterval(() => void renderSafely(), 30000) as unknown as number;
    }
  }

  ($("open-options") as HTMLButtonElement).addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  ($("ack-warning") as HTMLButtonElement).addEventListener("click", () => {
    void sendControl({ type: "dismiss-diagnostics" });
  });
  // Render the cached state immediately so the popup is never blank, then ask
  // the service worker to run a fresh liveness/auth probe and re-render when it
  // reports back — so opening the popup answers "is this actually working?" with
  // an up-to-the-second verdict (a dead token flips to a re-pair warning here).
  void renderSafely();
  void chrome.runtime
    .sendMessage<PauseAck>({ type: "check-now" })
    .then((ack) => {
      if (!ack?.ok) throw new Error(ack?.reason ?? "background worker unavailable");
      return renderSafely();
    })
    .catch(showCheckFailure);
}
