// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Every device waiting for the owner's OK, on Settings → Devices, whichever way
// it asked: signing in with the Omnesis account linked to the gateway, or
// joining from the owner's Tailscale network through the gateway's own
// Tailscale device.
// Each kind keeps its own card and its own way of deciding; the owner finds
// them in one list under one title.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { CloudPairingRequests } from "./cloud-pairing-requests.js";
import { TailscaleJoinRequests } from "./tailscale-join-requests.js";

export function WaitingDevices({ tailscaleEmbed = false }) {
  const [cloudCount, setCloudCount] = useState(0);
  const [tailscaleCount, setTailscaleCount] = useState(0);
  // Nothing waiting is the normal case: with no card, error or notice inside, the
  // section is empty and takes no room.
  return html`<section class="cloud-pairing-requests" aria-label="Devices waiting for your OK">
    ${cloudCount + tailscaleCount > 0 && html`<h2 class="devices-group-title">Waiting for your OK</h2>`}
    <${CloudPairingRequests} onCount=${setCloudCount} />
    ${tailscaleEmbed && html`<${TailscaleJoinRequests} onCount=${setTailscaleCount} />`}
  </section>`;
}
