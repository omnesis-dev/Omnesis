// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Tells the owner, on any page, that a device asked to join and waits for
// approval, from the answer `useAttention` keeps for the whole portal. Every
// waiting device is decided on Settings → Devices.

import { html } from "htm/preact";
import { attentionText, waitingDevicesHref } from "../lib/attention.js";
import { navigate } from "../lib/router.js";
import { WaitingStrip } from "./waiting-strip.js";

/**
 * One strip for every waiting request of either kind, with a count when there are several.
 * `paused` is set on the Devices page, where the approval cards themselves are on screen.
 *
 * @param {{ devices: { cloud: Array<{ requestId: string }>, count: number }, paused?: boolean }} props
 *   `devices` is `useAttention().devices`.
 */
export function WaitingDevicesBanner({ devices, paused = false }) {
  if (paused || devices.count === 0) return null;
  return html`<${WaitingStrip}
    className="cloud-pairing-notice"
    label="Devices waiting for approval"
    items=${[
      {
        key: "waiting-devices",
        text: attentionText("devices", devices.count),
        actionLabel: "Review",
        onAction: () => navigate(waitingDevicesHref(devices)),
      },
    ]}
  />`;
}
