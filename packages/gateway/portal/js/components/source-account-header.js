// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { sourceIcon } from "../lib/format.js";
import { sourceAccountOf } from "../lib/source-id.js";
import { sourceId, sourceLabel } from "./grant-builder-state.js";

export function sourceInstanceIcon(source, id) {
  const icon = source.icon;
  const safeIcon =
    typeof icon === "string" &&
    (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(icon) || /^\/(?![\\/])/.test(icon));
  return safeIcon ? html`<img src=${icon} alt="" />` : sourceIcon(id, { size: 20 });
}

/** An account's icon, source name and account; an account that is gone says so on its account line. */
export function SourceAccountHeader({ source }) {
  const id = sourceId(source);
  const account = sourceAccountOf(id);
  return html`<span class="compact-source-header">
    <span class="compact-source-icon" aria-hidden="true">${sourceInstanceIcon(source, id)}</span>
    <strong>${sourceLabel(source)}</strong>
    <span class="compact-source-account"
      >${source.available === false ? [account, "no longer connected"].filter(Boolean).join(" · ") : account || "Connected account"}</span
    >
  </span>`;
}
