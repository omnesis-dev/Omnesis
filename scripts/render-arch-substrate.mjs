// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// The collector and the substrate it feeds are drawn on two pages — the
// landing page's "How it works" pipeline and the Brain page's architecture
// diagram — and they must not drift apart. This script is the single source
// of that markup: it renders the pair (collector card, arrow, substrate card)
// and injects it into every page that declares the markers
//
//   <!-- arch-substrate:start LABEL -->
//   <!-- arch-substrate:end -->
//
// where LABEL names the second box. The landing page calls it the Gateway,
// which is the component; the Brain page calls it the Context substrate,
// which is what that component holds. Nothing else about the pair differs.
//
// Styling lives in website/arch-substrate.css, which both pages link.
//
// Refresh both pages after editing the template:
//
//   node scripts/render-arch-substrate.mjs
//
// `--check` exits non-zero on drift instead of writing; the unit test in
// render-arch-substrate.test.mjs runs the same comparison in CI, so an edit
// here that is never rendered reddens the build.
//
// The result is run through the repo's Prettier config before it is compared
// or written. The block lands at whatever depth its host page nests it, and
// Prettier rewraps long lines differently at different depths — so without
// this the two pages could never both be simultaneously formatted and
// in sync.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

import {
  appleCalendarIconDataUri,
  appleCallLogIconDataUri,
  appleContactsIconDataUri,
  appleIMessageIconDataUri,
  appleNotesIconDataUri,
  appleRemindersIconDataUri,
  appleVoicemailIconDataUri,
} from "../packages/providers/apple/src/icons.ts";
import { browserHistoryCatalogIconDataUri } from "../packages/providers/browser-history/src/icons.ts";
import { chromeBookmarksIconUrl } from "../packages/providers/chrome/src/icons.ts";
import { codexIcon } from "../packages/providers/codex/src/icon.ts";
import { coinbaseIcon } from "../packages/providers/coinbase/src/icons.ts";
import { enableBankingIcon } from "../packages/providers/enable-banking/src/icons.ts";
import { githubThreadsIcon } from "../packages/providers/github/src/icons.ts";
import {
  gmailIconUrl,
  googleCalendarIconUrl,
  googleContactsIconUrl,
  googleDriveIconUrl,
} from "../packages/providers/google/src/icons.ts";
import { granolaIcon } from "../packages/providers/granola/src/icons.ts";
import { lunchflowIcon } from "../packages/providers/lunchflow/src/icons.ts";
import { notionIcon } from "../packages/providers/notion/src/icons.ts";
import { obsidianIconUrl } from "../packages/providers/obsidian/src/icons.ts";
import {
  oneDriveIconUrl,
  outlookCalendarIconDataUri,
  outlookIconUrl,
} from "../packages/providers/outlook/src/icons.ts";
import { piIcon } from "../packages/providers/pi/src/icon.ts";
import { screenTimeIcon } from "../packages/providers/screen-time/src/icon.ts";
import { stravaIcon } from "../packages/providers/strava/src/icons.ts";
import { thingsIconUrl } from "../packages/providers/things/src/icons.ts";
import { webIcon } from "../packages/providers/web/src/icon.ts";
import { whatsappIconUrl } from "../packages/providers/whatsapp/src/icons.ts";
import { appleHealthIconDataUri } from "../packages/providers-synth/apple-health/src/icons.ts";
import { healthConnectIconDataUri } from "../packages/providers-synth/health-connect/src/icons.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function descriptorImage(icon) {
  const src = icon.imageDataUri ?? icon.url;
  if (!src) throw new Error("Website source icon has no browser-renderable image");
  return src;
}

const activitySegmentsIconDataUri = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#30D158" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`,
);
const locationVisitsIconDataUri = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF9F0A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`,
);
const photosIconDataUri = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0A84FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
);
const appUsageIconDataUri = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3DDC84" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
);
const omnesisChatIconDataUri = `data:image/png;base64,${readFileSync(
  join(root, "packages/gateway/portal/img/omnesis-logo.png"),
).toString("base64")}`;

/** One icon per human-facing source family; duplicate source IDs share their product mark. */
export const SOURCE_ICONS = [
  { label: "Gmail", src: gmailIconUrl },
  { label: "Outlook Email", src: outlookIconUrl },
  { label: "WhatsApp", src: whatsappIconUrl },
  { label: "Apple iMessage", src: appleIMessageIconDataUri },
  { label: "Apple Notes", src: appleNotesIconDataUri },
  { label: "Apple Reminders", src: appleRemindersIconDataUri },
  { label: "Notion", src: descriptorImage(notionIcon) },
  { label: "Obsidian", src: obsidianIconUrl },
  { label: "Things 3", src: thingsIconUrl },
  { label: "Granola", src: descriptorImage(granolaIcon) },
  { label: "Pi Sessions", src: descriptorImage(piIcon) },
  { label: "Claude Code Sessions", src: "/media/claude-code.svg" },
  { label: "Codex Sessions", src: descriptorImage(codexIcon) },
  { label: "GitHub", src: descriptorImage(githubThreadsIcon) },
  { label: "Google Calendar", src: googleCalendarIconUrl },
  { label: "Outlook Calendar", src: outlookCalendarIconDataUri },
  { label: "Apple Calendar", src: appleCalendarIconDataUri },
  { label: "Google Contacts", src: googleContactsIconUrl },
  { label: "Apple Contacts", src: appleContactsIconDataUri },
  { label: "Google Drive", src: googleDriveIconUrl },
  { label: "OneDrive", src: oneDriveIconUrl },
  { label: "Chrome Bookmarks", src: chromeBookmarksIconUrl },
  { label: "Browser History", src: browserHistoryCatalogIconDataUri },
  { label: "Web Pages", src: descriptorImage(webIcon) },
  { label: "Apple Health", src: appleHealthIconDataUri },
  { label: "Health Connect", src: healthConnectIconDataUri },
  { label: "Photos & Screenshots", src: photosIconDataUri },
  { label: "Activity Segments", src: activitySegmentsIconDataUri },
  { label: "Location Visits", src: locationVisitsIconDataUri },
  { label: "App Usage", src: appUsageIconDataUri },
  { label: "Call Log", src: appleCallLogIconDataUri },
  { label: "Apple Voicemail", src: appleVoicemailIconDataUri },
  { label: "Screen Time", src: descriptorImage(screenTimeIcon) },
  { label: "Strava", src: descriptorImage(stravaIcon) },
  { label: "Coinbase", src: descriptorImage(coinbaseIcon) },
  { label: "Enable Banking", src: descriptorImage(enableBankingIcon) },
  { label: "Lunch Flow", src: descriptorImage(lunchflowIcon) },
  { label: "Omnesis Chat", src: omnesisChatIconDataUri },
  { label: "OpenClaw", tooltip: "OpenClaw (via plugin)", src: "/media/openclaw.svg" },
  { label: "Hermes", tooltip: "Hermes (via plugin)", src: "/media/hermes.svg" },
];

function escapeHtmlAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function renderSourceIcons() {
  return SOURCE_ICONS.map(({ label, tooltip = label, src }) => {
    const escapedTooltip = escapeHtmlAttribute(tooltip);
    return `<img width="24" height="24" src="${escapeHtmlAttribute(src)}" alt="${escapedTooltip}" title="${escapedTooltip}" loading="lazy" />`;
  }).join("\n");
}

/** Pages carrying the pair. The label is read from each page's start marker. */
export const TARGETS = ["website/index.html", "website/brain.html"];

const START = /<!-- arch-substrate:start (.+?) -->/;
const END = "<!-- arch-substrate:end -->";

/**
 * The pair, as one block. `label` names the second box; the first is always
 * the collector, because a collector is a collector on every page.
 */
function template(label) {
  return `<!-- Omnesis Collector (holds its sources) -->
<div class="arch-col">
  <div class="arch-label">Collector</div>
  <div class="arch-card arch-collector">
    <div class="src-grid">
      ${renderSourceIcons()}
    </div>
    <div class="src-dots">
      <span style="background: #7ee787; opacity: 0.5"></span>
      <span style="background: #d2a8ff; opacity: 1"></span>
      <span style="background: #ffa657; opacity: 0.5"></span>
    </div>
    <div class="arch-caption">Supports 40+ sources</div>
  </div>
</div>

<div class="arch-arrow">
  <svg viewBox="0 0 36 18"><path d="M0 5 H24 V1 L36 9 L24 17 V13 H0 Z" /></svg>
</div>
<!-- ${label} — models people + documents into one graph -->
<div class="arch-col">
  <div class="arch-label">${label}</div>
  <div class="arch-card arch-gateway">
    <div class="gw-graph">
      <!-- Cross-source graph: timeline-style nodes (bg disk masks the
       edge, source icon on top); each edge is a gradient between the
       two sources' brand colors, like the timeline spine. -->
      <svg viewBox="0 0 180 180" fill="none" aria-hidden="true">
        <defs>
          <filter id="gw-you-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient
            id="gw-e1"
            gradientUnits="userSpaceOnUse"
            x1="40"
            y1="140"
            x2="90"
            y2="110"
          >
            <stop offset="0" stop-color="#EA4335" />
            <stop offset="1" stop-color="#FBBC04" />
          </linearGradient>
          <linearGradient
            id="gw-e2"
            gradientUnits="userSpaceOnUse"
            x1="90"
            y1="110"
            x2="140"
            y2="140"
          >
            <stop offset="0" stop-color="#FBBC04" />
            <stop offset="1" stop-color="#25D366" />
          </linearGradient>
          <linearGradient
            id="gw-e4"
            gradientUnits="userSpaceOnUse"
            x1="90"
            y1="110"
            x2="140"
            y2="40"
          >
            <stop offset="0" stop-color="#FBBC04" />
            <stop offset="1" stop-color="#0A84FF" />
          </linearGradient>
          <!-- Chrome (#4285F4) → Obsidian (#7C3AED): source brand colors -->
          <linearGradient
            id="gw-e5"
            gradientUnits="userSpaceOnUse"
            x1="90"
            y1="20"
            x2="40"
            y2="40"
          >
            <stop offset="0" stop-color="#4285F4" />
            <stop offset="1" stop-color="#7C3AED" />
          </linearGradient>
        </defs>
        <!-- document ↔ document links: gradient between brand colors -->
        <g stroke-width="2" stroke-linecap="round" opacity="0.92">
          <path d="M40 140 Q68.6 131 90 110" fill="none" stroke="url(#gw-e1)" />
          <path d="M90 110 Q111.4 131 140 140" fill="none" stroke="url(#gw-e2)" />
          <path d="M90 110 Q123.4 81 140 40" fill="none" stroke="url(#gw-e4)" />
          <path d="M90 20 Q62.6 24 40 40" fill="none" stroke="url(#gw-e5)" />
        </g>
        <!-- person ↔ document edges -->
        <g
          style="stroke: var(--graph-edge)"
          stroke-width="2"
          stroke-linecap="round"
          opacity="0.4"
        >
          <path d="M90 77 Q57.4 102.5 40 140" fill="none" />
          <path d="M90 77 Q86 93.5 90 110" fill="none" />
          <path d="M90 77 Q107.4 114.5 140 140" fill="none" />
          <path d="M90 77 Q119.4 64.5 140 40" fill="none" />
          <path d="M90 77 Q53.4 75.1 20 90" fill="none" />
          <path d="M90 160 Q62.6 156 40 140" fill="none" />
          <path d="M160 90 Q156 117.4 140 140" fill="none" />
          <path d="M160 90 Q156 62.6 140 40" fill="none" />
          <!-- "You" hub ↔ Obsidian / Chrome -->
          <path d="M90 77 Q69.4 52.5 40 40" fill="none" />
          <path d="M90 77 Q96.8 48.5 90 20" fill="none" />
        </g>
        <!-- node bg disks: filled, borderless, match the card background
         so they blend in while masking the edges underneath -->
        <g style="fill: var(--bg-secondary)">
          <circle cx="40" cy="140" r="10.5" />
          <circle cx="90" cy="110" r="10.5" />
          <circle cx="140" cy="140" r="10.5" />
          <circle cx="140" cy="40" r="10.5" />
          <circle cx="40" cy="40" r="10.5" />
          <circle cx="20" cy="90" r="10.5" />
          <circle cx="90" cy="20" r="10.5" />
          <circle cx="90" cy="77" r="10.5" />
          <circle cx="90" cy="160" r="10.5" />
          <circle cx="160" cy="90" r="10.5" />
        </g>
        <!-- source icons + person glyphs on top -->
        <g>
          <image
            href="https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v10/192px.svg"
            x="34"
            y="134"
            width="12"
            height="12"
          />
          <image
            href="https://www.gstatic.com/images/branding/productlogos/drive_2020q4/v10/192px.svg"
            x="84"
            y="104"
            width="12"
            height="12"
          />
          <image
            href="https://static.whatsapp.net/rsrc.php/y1/r/FJbTMJqMap7.svg"
            x="134"
            y="134"
            width="12"
            height="12"
          />
          <image
            href="https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/Outlook-Icon-FY26?resMode=sharp2&amp;op_usm=1.5,0.65,15,0&amp;wid=128&amp;hei=128&amp;qlt=100&amp;fmt=png-alpha&amp;fit=constrain"
            x="134"
            y="34"
            width="12"
            height="12"
          />
          <image
            href="https://obsidian.md/images/obsidian-logo-gradient.svg"
            x="34"
            y="34"
            width="12"
            height="12"
          />
          <image
            href="https://obsidian.md/images/obsidian-logo-gradient.svg"
            x="14"
            y="84"
            width="12"
            height="12"
          />
          <image
            href="https://www.google.com/chrome/static/images/favicons/android-icon-192x192.png"
            x="84"
            y="14"
            width="12"
            height="12"
          />
          <g style="fill: var(--graph-edge)">
            <circle cx="90" cy="157" r="2.6" />
            <path d="M85.6 161.4 a 4.4 4.2 0 0 0 8.8 0 Z" />
            <circle cx="160" cy="87" r="2.6" />
            <path d="M155.6 91.4 a 4.4 4.2 0 0 0 8.8 0 Z" />
          </g>
          <!-- "You" — the highlighted person hub (same size as the other
           person nodes; only recolored + glow so it reads as You) -->
          <circle
            cx="90"
            cy="77"
            r="10.5"
            fill="none"
            style="stroke: var(--accent)"
            stroke-width="1.6"
            filter="url(#gw-you-glow)"
          />
          <g style="fill: var(--accent)" filter="url(#gw-you-glow)">
            <circle cx="90" cy="74" r="2.6" />
            <path d="M85.6 78.4 a 4.4 4.2 0 0 0 8.8 0 Z" />
          </g>
        </g>
      </svg>
    </div>
    <div class="arch-caption">
      Omnesis materializes your digital life into a searchable people and document graph
    </div>
  </div>
</div>`;
}

/** Re-indent the block to sit at `indent` spaces, matching the host page. */
function indentBlock(block, indent) {
  const pad = " ".repeat(indent);
  return block
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/**
 * Replace the marked region of one page. Returns the new text, and throws a
 * pointed error if the page does not declare the markers — a silent no-op
 * here would mean a page quietly falling out of sync.
 */
export function render(html, file) {
  const startMatch = html.match(START);
  if (!startMatch) throw new Error(`${file}: no <!-- arch-substrate:start LABEL --> marker`);
  const label = startMatch[1].trim();
  const startAt = html.indexOf(startMatch[0]);
  const endAt = html.indexOf(END, startAt);
  if (endAt === -1) throw new Error(`${file}: no ${END} marker after the start marker`);

  // The markers sit at the block's own indentation, which the emitted markup
  // then adopts, so a page can nest the pair wherever its diagram needs it.
  const lineStart = html.lastIndexOf("\n", startAt) + 1;
  const indent = startAt - lineStart;

  const body = indentBlock(template(label), indent);
  return (
    html.slice(0, startAt) +
    startMatch[0] +
    "\n" +
    body +
    "\n" +
    " ".repeat(indent) +
    html.slice(endAt)
  );
}

/** Inject into one page and format the result, as Prettier would leave it. */
export async function renderFile(target) {
  const path = join(root, target);
  const before = readFileSync(path, "utf8");
  const config = await prettier.resolveConfig(path);
  const after = await prettier.format(render(before, target), { ...config, filepath: path });
  return { path, before, after };
}

async function main() {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const target of TARGETS) {
    const { path, before, after } = await renderFile(target);
    if (before === after) continue;
    if (check) stale.push(target);
    else writeFileSync(path, after);
  }
  if (check && stale.length) {
    console.error(
      `Stale arch-substrate block in: ${stale.join(", ")}\n` +
        "Re-render with: node scripts/render-arch-substrate.mjs",
    );
    process.exit(1);
  }
  if (!check) console.log(`arch-substrate rendered into ${TARGETS.length} pages`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
