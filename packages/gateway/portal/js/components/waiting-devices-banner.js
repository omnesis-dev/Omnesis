// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Tells the owner, on any page, that a device asked to join and waits for
// approval, from the answer `useWaitingDevices` keeps for the whole portal.
// Every waiting device is decided on Settings → Devices.

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import { waitingDevicesText } from "../lib/use-waiting-devices.js";
import { WaitingStrip } from "./waiting-strip.js";

export const WAITING_DEVICES_PATH = "/portal/settings/devices";

/**
 * Where a person goes to answer: one sign-in request opens that request, anything else the list.
 *
 * @param {{ cloud: Array<{ requestId: string }>, count: number }} waiting from `useWaitingDevices`
 */
export function waitingDevicesHref(waiting) {
  return waiting.count === 1 && waiting.cloud.length === 1
    ? `${WAITING_DEVICES_PATH}?request=${encodeURIComponent(waiting.cloud[0].requestId)}`
    : WAITING_DEVICES_PATH;
}

/**
 * One strip for every waiting request of either kind, with a count when there are several.
 * `paused` is set on the Devices page, where the approval cards themselves are on screen.
 */
export function WaitingDevicesBanner({ waiting, paused = false }) {
  if (paused || waiting.count === 0) return null;
  return html`<${WaitingStrip}
    className="cloud-pairing-notice"
    label="Devices waiting for approval"
    items=${[
      {
        key: "waiting-devices",
        text: waitingDevicesText(waiting.count),
        actionLabel: "Review",
        onAction: () => navigate(waitingDevicesHref(waiting)),
      },
    ]}
  />`;
}
