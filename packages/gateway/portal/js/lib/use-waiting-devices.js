// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The devices waiting for the owner's OK, read once for the whole portal: the
// strip on every page and the marks on Settings and its Devices tab all show
// this one answer. A device asks either by signing in through the optional
// cloud relay (OMNESIS_CLOUD_RELAY_ENABLED=1) or by joining from the owner's
// Tailscale network through the gateway's own Tailscale device
// (OMNESIS_TAILSCALE_EMBED_ENABLED=1). With neither, nothing is read.

import { useEffect, useState } from "preact/hooks";
import { cloudPairingConfig, cloudPairingRequests } from "./cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "./cloud-pairing-waiting.js";
import { tailscaleJoinRequests } from "./tailscale-api.js";
import { useVisiblePoll } from "./use-visible-poll.js";

/** How often the portal asks while the tab is visible; a tab coming back into view asks at once. */
export const WAITING_DEVICES_POLL_MS = 5000;

const NONE = Object.freeze([]);

const readCloudRequests = async () => waitingCloudPairingRequests((await cloudPairingRequests())?.items);
const readTailscaleRequests = async () => {
  const requests = (await tailscaleJoinRequests())?.requests;
  const now = Date.now();
  return Array.isArray(requests) ? requests.filter((r) => new Date(r.expiresAt).getTime() > now) : [];
};

/**
 * The requests of one kind that still wait, read at once when `enabled` turns on and then every
 * few seconds; none while it is off. A failed read keeps the last answer and the next one retries,
 * so a badge never flickers away on one bad read.
 */
function useWaitingKind(enabled, read) {
  const [waiting, setWaiting] = useState(NONE);
  const refresh = async () => {
    try {
      setWaiting(await read());
    } catch {
      // Kept until the next read.
    }
  };
  useEffect(() => {
    if (enabled) refresh();
    else setWaiting(NONE);
  }, [enabled]);
  useVisiblePoll(refresh, WAITING_DEVICES_POLL_MS, { enabled });
  return waiting;
}

/**
 * `{ cloud, tailscale, count }`: the waiting sign-in requests, the waiting Tailscale join
 * requests, and how many there are together. Sign-in requests are read only once the gateway says
 * sign-in pairing is configured, as its cards are.
 */
export function useWaitingDevices({ cloudRelay = false, tailscaleEmbed = false } = {}) {
  const [cloudAvailable, setCloudAvailable] = useState(false);
  useEffect(() => {
    if (!cloudRelay) {
      setCloudAvailable(false);
      return undefined;
    }
    let active = true;
    cloudPairingConfig()
      .then((config) => {
        if (active && config) setCloudAvailable(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [cloudRelay]);
  const cloud = useWaitingKind(cloudRelay && cloudAvailable, readCloudRequests);
  const tailscale = useWaitingKind(tailscaleEmbed, readTailscaleRequests);
  return { cloud, tailscale, count: cloud.length + tailscale.length };
}

/** "2 devices are waiting for your approval": the words every mark and the strip share. */
export function waitingDevicesText(count) {
  return count === 1
    ? "A device is waiting for your approval to pair to this gateway."
    : `${count} devices are waiting for your approval to pair to this gateway.`;
}
