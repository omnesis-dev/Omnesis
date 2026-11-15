// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Collectors on the owner's Tailscale network that asked to join this gateway
// and wait for a yes, shown on Settings → Devices with every other device
// waiting for the owner's OK. Rendered only when the gateway runs with
// OMNESIS_TAILSCALE_EMBED_ENABLED=1, which `/status` advertises as
// `tailscaleEmbed: true`.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { decideTailscaleJoin, tailscaleJoinRequests } from "../lib/tailscale-api.js";
import { usePortalSignal, useSignalFallback } from "../lib/portal-signals.js";
import { earliestExpiry, useRefreshAt } from "../lib/use-refresh-at.js";

/** How long "Approved studio-mac." stays after a decision. */
const NOTICE_MS = 8000;

/** "expires in 9 min": how long a request still waits, rounded up to the minute. */
export function expiresIn(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  if (ms < 60_000) return "expires in under a minute";
  return `expires in ${Math.ceil(ms / 60_000)} min`;
}

/** "22:41": when the collector asked, in this browser's own clock format. */
function askedAt(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? undefined
    : `asked ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * One collector waiting to join, asked as a question about that machine. Approving may ask for
 * the owner's passkey first, as every loosening action on this gateway can.
 */
export function TailscaleJoinRequest({ request, onDecided }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function decide(approve) {
    if (busy) return;
    setBusy(approve ? "approve" : "deny");
    setError("");
    try {
      await decideTailscaleJoin(request.id, approve);
      if (active.current) onDecided(request, approve ? "approved" : "denied");
    } catch (failure) {
      if (!active.current) return;
      if (failure?.status === 404) onDecided(request, "gone");
      else setError(failure?.serverMessage || failure?.message || "Could not save your answer.");
    } finally {
      if (active.current) setBusy("");
    }
  }
  const machine = `${request.machine}${request.os ? ` (${request.os})` : ""}`;
  const meta = ["Collector", "via Tailscale", request.login, askedAt(request.requestedAt), expiresIn(request.expiresAt)]
    .filter(Boolean);
  return html`<article
    class="cloud-pairing-request tailscale-join-request"
    id=${`tailscale-join-request-${request.id}`}
    aria-label=${`${request.name} wants to connect`}
  >
    <h3>${request.name} wants to connect</h3>
    <p class="devices-muted">${meta.join(" · ")}</p>
    <p>
      It asks from ${machine}, a device on your Tailscale network signed in as ${request.login}.
    </p>
    <p class="cloud-pairing-question">Is ${request.machine} one of your devices?</p>
    <div class="cloud-pairing-actions">
      <button class="btn-primary" disabled=${Boolean(busy)} onClick=${() => decide(true)}>
        ${busy === "approve" ? "Approving…" : "Yes, approve"}
      </button>
      <button class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => decide(false)}>
        ${busy === "deny" ? "Denying…" : "No, deny"}
      </button>
    </div>
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
  </article>`;
}

const DECIDED = {
  approved: (name) => `Approved ${name}. It joins within a few seconds.`,
  denied: (name) => `Denied ${name}.`,
  gone: () => "This request expired or was already decided.",
};

/**
 * The waiting collectors, read when the gateway signals one arrived or was decided, when the first
 * one expires, and on an interval while the signals are not healthy. `onCount` hears how many wait, so the
 * Devices page can title the list it shares with other requests.
 */
export function TailscaleJoinRequests({ onCount = () => {}, load = tailscaleJoinRequests }) {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Requests answered here. A read that was already on its way when one was answered still
  // lists it; the card stays gone all the same.
  const decidedIds = useRef(new Set());
  const refresh = async () => {
    try {
      const response = await load();
      setRequests(Array.isArray(response?.requests) ? response.requests : []);
      setError("");
    } catch (failure) {
      setError(failure?.serverMessage || failure?.message || "Could not read the waiting devices.");
    }
  };
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    refresh();
  }, []);
  usePortalSignal("devices", refresh);
  useSignalFallback(refresh);
  // A request leaves once it is out of time, also between two reads.
  const waiting = requests.filter(
    (request) => !decidedIds.current.has(request.id) && expiresIn(request.expiresAt) !== "expired",
  );
  useRefreshAt(earliestExpiry(waiting), refresh);
  useEffect(() => onCount(waiting.length), [waiting.length]);
  const decided = (request, outcome) => {
    decidedIds.current.add(request.id);
    setNotice(DECIDED[outcome](request.name));
    setRequests((current) => current.filter((item) => item.id !== request.id));
    refresh();
  };
  return html`
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
    ${notice && html`<p class="tailscale-join-notice" role="status">${notice}</p>`}
    ${waiting.map(
      (request) => html`<${TailscaleJoinRequest} key=${request.id} request=${request} onDecided=${decided} />`,
    )}
  `;
}
