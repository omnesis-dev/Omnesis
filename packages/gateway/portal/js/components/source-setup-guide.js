// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

const deviceKinds = new Set([
  "collector",
  "cli",
  "portal",
  "ios",
  "android",
  "agent",
  "browser",
  "integration",
]);
const utf8 = new TextEncoder();
// Reject oversized UTF-16 input before allocating; UTF-8 encoding is then bounded too.
const text = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  utf8.encode(value).byteLength <= limit &&
  value.trim().length > 0;

/** Explicit null still declares guide handling; only two missing fields mean ordinary collector setup. */
export function hasSourceSetupGuide(descriptor) {
  return (
    descriptor != null &&
    (Object.prototype.hasOwnProperty.call(descriptor, "setupGuide") ||
      Object.prototype.hasOwnProperty.call(descriptor, "setupGuideContent"))
  );
}

export function safeSetupLink(value) {
  if (
    !text(value, 2048) ||
    value !== value.trim() ||
    !/^https:\/\//iu.test(value) ||
    /[\u0000-\u001f\u007f\\]/u.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      /^https:\/\/[^/?#]*@/iu.test(value)
    )
      return null;
    return utf8.encode(url.href).byteLength <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

/** Same bounded version1 presentation contract as the native companion guide; never a mutation plan. */
export function sourceSetupGuide(descriptor) {
  const guide = descriptor?.setupGuideContent;
  if (
    !text(descriptor?.setupGuide, 128) ||
    !guide ||
    guide.version !== 1 ||
    !text(guide.title, 160) ||
    !Array.isArray(guide.paragraphs) ||
    guide.paragraphs.length < 1 ||
    guide.paragraphs.length > 8 ||
    !guide.paragraphs.every((item) => text(item, 2000)) ||
    !Array.isArray(guide.links) ||
    guide.links.length > 4 ||
    !guide.links.every((link) => link && text(link.label, 120) && safeSetupLink(link.url)) ||
    (guide.note != null && !text(guide.note, 2000)) ||
    (guide.pairing != null &&
      (!deviceKinds.has(guide.pairing.deviceKind) || !text(guide.pairing.label, 120)))
  )
    return null;
  return guide;
}

export function SourceSetupGuide({ descriptor }) {
  const guide = sourceSetupGuide(descriptor);
  if (!guide)
    return html`<section class="source-setup-guide" data-setup-guide="unavailable">
      <h3>Companion setup</h3>
      <p>
        This gateway does not provide a supported setup guide. Update Omnesis on the gateway before
        continuing.
      </p>
    </section>`;
  return html`<section class="source-setup-guide" data-setup-guide="available">
    <h3>${guide.title}</h3>
    ${guide.paragraphs.map((paragraph, index) => html`<p key=${index}>${paragraph}</p>`)}
    <div class="add-source-actions">
      ${guide.links.map(
        (link, index) =>
          html`<a
            key=${index}
            class=${index === 0 ? "btn-primary" : "btn-tiny"}
            data-setup-install
            href=${safeSetupLink(link.url)}
            target="_blank"
            rel="noreferrer noopener"
            >${link.label}</a
          >`,
      )}
      ${
        guide.pairing &&
        html`<a
          data-setup-pairing
          href=${`/portal/settings/devices?pair=${encodeURIComponent(guide.pairing.deviceKind)}`}
          onClick=${(event) => {
            event.preventDefault();
            navigate(
              `/portal/settings/devices?pair=${encodeURIComponent(guide.pairing.deviceKind)}`,
            );
          }}
          >${guide.pairing.label}</a
        >`
      }
    </div>
    ${guide.note && html`<p class="muted">${guide.note}</p>`}
  </section>`;
}
