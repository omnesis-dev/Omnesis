// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";

/** A device-reported route observation, separate from authorization and TLS trust. */
export function DeviceConnectionPill({ path, revoked = false }) {
  if (revoked || !["local", "relay", "reconnecting"].includes(path)) return null;
  const labels = {local:"Local",relay:"Remote",reconnecting:"Reconnecting"};
  return html`<span class=${`device-connection-pill device-connection-${path}`} title="Recent device-reported connection path; access permissions and TLS verification are unchanged.">${labels[path]}</span>`;
}
