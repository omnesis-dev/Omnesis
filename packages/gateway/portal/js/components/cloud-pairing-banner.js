// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Tells the owner, on any page, that a device signed in and waits for approval.
// Rendered only when the gateway runs with OMNESIS_CLOUD_RELAY_ENABLED=1.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cloudPairingConfig, cloudPairingRequests } from "../lib/cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "../lib/cloud-pairing-waiting.js";
import { navigate } from "../lib/router.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { WaitingStrip } from "./waiting-strip.js";

export const CLOUD_PAIRING_DEVICES_PATH = "/portal/settings/devices";
const POLL_MS = 5000;

export function cloudPairingBannerText(count) {
  return count === 1
    ? "A device is waiting for your approval to pair to this gateway."
    : `${count} devices are waiting for your approval to pair to this gateway.`;
}

/**
 * One strip for every waiting request, with a count when there are several.
 * `paused` is set on the Devices page, where the approval cards themselves are
 * on screen: the strip is not shown there and does not ask the gateway.
 */
export function CloudPairingBanner({ paused = false }) {
  const [available, setAvailable] = useState(false);
  const [count, setCount] = useState(0);
  const refresh = async () => {
    try {
      const response = await cloudPairingRequests();
      setCount(waitingCloudPairingRequests(response?.items).length);
    } catch {
      // A failed read keeps the last answer; the next one retries.
    }
  };
  useEffect(() => {
    let active = true;
    cloudPairingConfig()
      .then((config) => {
        if (active && config) setAvailable(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const polling = available && !paused;
  // Read at once on arrival and when leaving the Devices page, where a request may just have been answered.
  useEffect(() => {
    if (polling) refresh();
    else setCount(0);
  }, [polling]);
  useVisiblePoll(refresh, POLL_MS, { enabled: polling });
  if (!polling || count === 0) return null;
  return html`<${WaitingStrip}
    className="cloud-pairing-notice"
    label="Devices waiting for approval"
    items=${[
      {
        key: "cloud-pairing",
        text: cloudPairingBannerText(count),
        actionLabel: "Review",
        onAction: () => navigate(CLOUD_PAIRING_DEVICES_PATH),
      },
    ]}
  />`;
}
