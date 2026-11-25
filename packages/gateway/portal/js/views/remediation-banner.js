// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// RemediationBanner — the surface for a sync failure the operator has to act
// on, on the Sources page. A source whose collector reported a structured
// remedy with its error (an access grant the host keys on the collector's
// executable, say) gets one card per device and remedy, listing every source
// that grant frees, the steps, the executable to list, and the restart.
// Devices needing pairing also link to their repair and forget flows.

import { html } from "htm/preact";
import { useMemo } from "preact/hooks";
import { sourceLabel } from "../lib/format.js";
import { groupRemediationsByDevice } from "./remediation-grouping.js";

/**
 * One remedy for one device, rendered without hooks so it can be tested as a
 * plain function. `deviceName` is resolved by the caller.
 */
export function RemediationCard({ group, deviceName, device }) {
  const { remediation, affectedSourceIds } = group;
  const needsPairing = device?.revokedAt && device?.needsPairing;
  const devicePath = `/portal/settings/devices?device=${encodeURIComponent(group.deviceId)}`;
  const steps = [...remediation.steps];
  if (remediation.restartRequired) steps.push("Restart the collector.");
  return html`
    <div class="sources-banner-v2 needs-access">
      <div class="reauth-banner-text">
        <strong>${remediation.summary} on ${deviceName}</strong>
        <div class="reauth-banner-sources">
          ${affectedSourceIds.length} source${affectedSourceIds.length === 1 ? "" : "s"} waiting:${" "}
          ${affectedSourceIds.map((id, i) => html`
            <span class="reauth-banner-src" key=${id}>
              ${i > 0 ? ", " : ""}${sourceLabel(id)}
            </span>
          `)}
        </div>
        <ol class="remediation-steps">
          ${steps.map((step, i) => html`<li key=${i}>${step}</li>`)}
        </ol>
        ${needsPairing && html`
          <div class="remediation-actions">
            ${device.kind !== "portal" && html`<a class="btn-primary" href=${`${devicePath}&deviceAction=repair`}>Pair again</a>`}
            <a class="btn-secondary" href=${`${devicePath}&deviceAction=forget`}>Forget device</a>
          </div>
        `}
        ${remediation.executable && html`
          <div class="remediation-executable">
            <span class="remediation-executable-label">Executable running the collector</span>
            <code title="Add this file to the list — it is the process reading the data, not the terminal or app that started it">${remediation.executable}</code>
          </div>
        `}
      </div>
    </div>
  `;
}

/**
 * Renders one card per (device, remedy) with at least one source in `error`
 * carrying a structured remediation. `deviceById` is the page's device map,
 * which names a group its source row could not — a member of a multi-device
 * source, whose row names the owning device rather than the member.
 */
export function RemediationBanner({ sources, deviceById }) {
  const groups = useMemo(() => groupRemediationsByDevice(sources), [sources]);
  if (groups.length === 0) return null;

  const deviceNameOf = (g) =>
    g.deviceName ??
    deviceById?.get(g.deviceId)?.name ??
    (typeof g.deviceId === "string" ? g.deviceId.slice(0, 8) : "its collector");

  return html`
    <div class="reauth-banner-stack" role="status">
      ${groups.map((g) => html`
        <${RemediationCard}
          key=${`${g.deviceId ?? ""}:${g.remediation.summary}:${g.remediation.executable ?? ""}`}
          group=${g}
          deviceName=${deviceNameOf(g)}
          device=${deviceById?.get(g.deviceId)}
        />
      `)}
    </div>
  `;
}
