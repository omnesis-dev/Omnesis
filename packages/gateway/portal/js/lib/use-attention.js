// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// What waits for the owner's decision, read once for the whole portal and held
// by the shell, so the strip on every page and every attention mark show one
// answer. Four topics, each read through the list route its own page uses:
//
// - devices: sign-in requests through the Omnesis account (read once the
//   gateway says sign-in pairing is configured, which takes a linked account)
//   and Tailscale join requests through the gateway's own Tailscale device,
//   when the gateway has one;
// - access: MCP clients asking to connect;
// - answers: Answer releases held for the owner's review;
// - watches: requests for a standing watch, only where watches are on.
//
// A topic is re-read when the gateway signals it changed and when the signal
// stream (re)connects — in a hidden tab, once when it comes back into view —
// when its earliest waiting item expires, since the gateway does not signal
// expiry, and on a fallback interval only while the signals are not healthy.
// A topic whose feature is off is never read.

import { useEffect, useRef, useState } from "preact/hooks";
import { getPendingAccessRequests, listPrivacyApprovals, listSubscriptionApprovals } from "../api.js";
import { cloudPairingConfig, cloudPairingRequests } from "./cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "./cloud-pairing-waiting.js";
import { tailscaleJoinRequests } from "./tailscale-api.js";
import { SIGNAL_FALLBACK_MS, usePortalSignal, useSignalFallback } from "./portal-signals.js";
import { earliestExpiry, notExpired, useRefreshAt } from "./use-refresh-at.js";
import { useVisiblePoll } from "./use-visible-poll.js";

/**
 * How many held answers or watch requests one read lists. The count comes from the gateway's
 * total; the items only give the earliest expiry, and a page this size holds every pending one in
 * practice. Both lists are newest first, so a longer backlog is caught by the fallback read.
 */
export const ATTENTION_PAGE_LIMIT = 50;
const NONE = Object.freeze([]);
export const NO_DEVICES = Object.freeze({ cloud: NONE, tailscale: NONE, count: 0, nextExpiry: null });
export const NO_ACCESS = Object.freeze({ requests: NONE, count: 0, nextExpiry: null });
export const NO_COUNT = Object.freeze({ count: 0, nextExpiry: null });

/** The gateway routes each topic is read through, resolved when called; replaced in tests. */
export const ATTENTION_API = {
  cloudPairingConfig: () => cloudPairingConfig(),
  cloudPairingRequests: () => cloudPairingRequests(),
  tailscaleJoinRequests: () => tailscaleJoinRequests(),
  getPendingAccessRequests: () => getPendingAccessRequests(),
  listPrivacyApprovals: (query) => listPrivacyApprovals(query),
  listSubscriptionApprovals: (query) => listSubscriptionApprovals(query),
};

/** Every waiting device, keeping the last answer of a kind whose read failed. */
async function readDevices(api, previous, { cloud, tailscale }) {
  const [cloudRead, tailscaleRead] = await Promise.allSettled([
    cloud ? api.cloudPairingRequests() : null,
    tailscale ? api.tailscaleJoinRequests() : null,
  ]);
  const now = Date.now();
  const cloudItems = !cloud
    ? NONE
    : cloudRead.status === "fulfilled"
      ? waitingCloudPairingRequests(cloudRead.value?.items, now)
      : previous.cloud;
  const tailscaleItems = !tailscale
    ? NONE
    : tailscaleRead.status === "fulfilled"
      ? (Array.isArray(tailscaleRead.value?.requests) ? tailscaleRead.value.requests : NONE).filter(
          (request) => notExpired(request, now),
        )
      : previous.tailscale;
  return {
    cloud: cloudItems,
    tailscale: tailscaleItems,
    count: cloudItems.length + tailscaleItems.length,
    nextExpiry: earliestExpiry([...cloudItems, ...tailscaleItems], now),
  };
}

async function readAccess(api) {
  const overview = await api.getPendingAccessRequests();
  const now = Date.now();
  const requests = (overview?.pendingRequests ?? NONE).filter((request) => notExpired(request, now));
  return { requests, count: requests.length, nextExpiry: earliestExpiry(requests, now) };
}

/** A pending-approval page: the gateway's total, and the earliest expiry among the items listed. */
function countPage(payload) {
  const total = Number(payload?.totalCount);
  return {
    count: Number.isFinite(total) && total > 0 ? total : 0,
    nextExpiry: earliestExpiry(payload?.approvals),
  };
}

/**
 * One topic's answer, kept current while `enabled` and reset to `empty` while not; read again at
 * once whenever `what` (what the read covers) changes. A failed read keeps the last answer, so a
 * mark never flickers away on one bad read; a read overtaken by a newer one is dropped.
 */
function useTopic({ topic, enabled, what = "", empty, read, signals }) {
  const [value, setValue] = useState(empty);
  const latest = useRef({ value, read, enabled });
  latest.current = { value, read, enabled };
  const generation = useRef(0);
  const refresh = async () => {
    if (!latest.current.enabled) return;
    const current = ++generation.current;
    try {
      const next = await latest.current.read(latest.current.value);
      if (current === generation.current && latest.current.enabled) setValue(next);
    } catch {
      // Kept until the next read.
    }
  };
  useEffect(() => {
    if (enabled) void refresh();
    else {
      generation.current += 1;
      setValue(empty);
    }
  }, [enabled, what]);
  usePortalSignal(topic, () => void refresh(), { enabled, signals });
  useSignalFallback(() => void refresh(), { enabled, signals });
  useRefreshAt(enabled ? value.nextExpiry : null, () => void refresh());
  return value;
}

/**
 * Whether the gateway offers sign-in pairing, which takes an Omnesis account linked to it. Until it
 * says yes it is asked again on every devices signal and resync — a sign-in request means it is now
 * configured — and, after a failed read, on the fallback interval and when the tab comes back into
 * view.
 */
function useCloudPairingConfigured(api, signals) {
  /** "unknown" before an answer, then "configured", "off" or "failed". */
  const [state, setState] = useState("unknown");
  const generation = useRef(0);
  const check = () => {
    const current = ++generation.current;
    api
      .cloudPairingConfig()
      .then((config) => {
        if (current === generation.current) setState(config ? "configured" : "off");
      })
      .catch(() => {
        if (current === generation.current) setState("failed");
      });
  };
  useEffect(() => {
    check();
    return () => {
      generation.current += 1;
    };
  }, []);
  usePortalSignal("devices", check, { enabled: state !== "configured", signals });
  useVisiblePoll(check, SIGNAL_FALLBACK_MS, { enabled: state === "failed" });
  return state === "configured";
}

/**
 * `{ devices, access, answers, watches }`: per topic, how many items wait (`count`) and when the
 * first of them expires (`nextExpiry`); `devices` also lists the waiting sign-in requests
 * (`cloud`) and Tailscale joins (`tailscale`), and `access` the waiting requests (`requests`).
 *
 * @param {{ tailscaleEmbed?: boolean, watches?: boolean }} features what
 *   `/status` says this gateway runs.
 * @param {{ api?: typeof ATTENTION_API, signals?: ReturnType<import("./portal-signals.js").createPortalSignals> }} [deps]
 */
export function useAttention(
  { tailscaleEmbed = false, watches = false } = {},
  { api = ATTENTION_API, signals = null } = {},
) {
  const cloud = useCloudPairingConfigured(api, signals);
  const kinds = { cloud, tailscale: tailscaleEmbed };
  return {
    devices: useTopic({
      topic: "devices",
      enabled: cloud || tailscaleEmbed,
      what: `${cloud}:${tailscaleEmbed}`,
      empty: NO_DEVICES,
      read: (previous) => readDevices(api, previous, kinds),
      signals,
    }),
    access: useTopic({ topic: "access", enabled: true, empty: NO_ACCESS, read: () => readAccess(api), signals }),
    answers: useTopic({
      topic: "answers",
      enabled: true,
      empty: NO_COUNT,
      read: async () =>
        countPage(await api.listPrivacyApprovals({ status: "pending", limit: ATTENTION_PAGE_LIMIT })),
      signals,
    }),
    watches: useTopic({
      topic: "watches",
      enabled: watches,
      empty: NO_COUNT,
      read: async () =>
        countPage(await api.listSubscriptionApprovals({ status: "pending", limit: ATTENTION_PAGE_LIMIT })),
      signals,
    }),
  };
}
