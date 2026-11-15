// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Tells the owner, on any page, that a device asked to join and waits for
// approval: one that signed in through the optional cloud relay
// (OMNESIS_CLOUD_RELAY_ENABLED=1), or a collector on the owner's Tailscale
// network asking the gateway's own Tailscale device
// (OMNESIS_TAILSCALE_EMBED_ENABLED=1). Both are decided on Settings → Devices.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cloudPairingConfig, cloudPairingRequests } from "../lib/cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "../lib/cloud-pairing-waiting.js";
import { navigate } from "../lib/router.js";
import { tailscaleJoinRequests } from "../lib/tailscale-api.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { WaitingStrip } from "./waiting-strip.js";

export const WAITING_DEVICES_PATH = "/portal/settings/devices";
const POLL_MS = 5000;

export function waitingDevicesBannerText(count) {
  return count === 1
    ? "A device is waiting for your approval to pair to this gateway."
    : `${count} devices are waiting for your approval to pair to this gateway.`;
}

/**
 * The requests of one kind that still wait, read every few seconds while `polling`; none while
 * it is not. A failed read keeps the last answer and the next one retries.
 */
function useWaiting(polling, read) {
  const [waiting, setWaiting] = useState([]);
  const refresh = async () => {
    try {
      setWaiting(await read());
    } catch {
      // Kept until the next read.
    }
  };
  // Read at once on arrival and when leaving the Devices page, where a request may just have been answered.
  useEffect(() => {
    if (polling) refresh();
    else setWaiting([]);
  }, [polling]);
  useVisiblePoll(refresh, POLL_MS, { enabled: polling });
  return waiting;
}

const readCloudRequests = async () => waitingCloudPairingRequests((await cloudPairingRequests())?.items);
const readTailscaleRequests = async () => {
  const requests = (await tailscaleJoinRequests())?.requests;
  const now = Date.now();
  return Array.isArray(requests) ? requests.filter((r) => new Date(r.expiresAt).getTime() > now) : [];
};

/**
 * One strip for every waiting request of either kind, with a count when there are several.
 * `paused` is set on the Devices page, where the approval cards themselves are on screen: the
 * strip is not shown there and does not ask the gateway.
 */
export function WaitingDevicesBanner({ cloudRelay = false, tailscaleEmbed = false, paused = false }) {
  const [cloudAvailable, setCloudAvailable] = useState(false);
  useEffect(() => {
    if (!cloudRelay) return undefined;
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
  const cloud = useWaiting(cloudRelay && cloudAvailable && !paused, readCloudRequests);
  const tailscale = useWaiting(tailscaleEmbed && !paused, readTailscaleRequests);
  const count = cloud.length + tailscale.length;
  if (paused || count === 0) return null;
  return html`<${WaitingStrip}
    className="cloud-pairing-notice"
    label="Devices waiting for approval"
    items=${[
      {
        key: "waiting-devices",
        text: waitingDevicesBannerText(count),
        actionLabel: "Review",
        // One relay request opens that request; anything else opens the list.
        onAction: () =>
          navigate(
            count === 1 && cloud.length === 1
              ? `${WAITING_DEVICES_PATH}?request=${encodeURIComponent(cloud[0].requestId)}`
              : WAITING_DEVICES_PATH,
          ),
      },
    ]}
  />`;
}
