// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Render the landing page's "Manage from anywhere" CLI surface as an inline
// HTML/CSS terminal (not a pixel screenshot), so it stays crisp, themes with
// the page (light/dark), and carries no macOS window furniture.
//
// It runs `omnesis status` against a gateway, takes the real rendered output,
// colourises it to match the CLI (green ✓/synced/100%, dim idle/sizes/ranges,
// dim header), and injects it into website/index.html between the
// `<!-- cli-terminal:start -->` / `<!-- cli-terminal:end -->` markers. The
// command line is shown as `omnesis status`.
//
// Run against the synthetic demo gateway (John Smith corpus — no personal
// data); scripts/record-cli-terminal.sh boots that gateway and sets the env:
//   OMNESIS_GATEWAY_URL, OMNESIS_TOKEN, OMNESIS_CONFIG_DIR, NODE_EXTRA_CA_CERTS

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = join(root, "website", "index.html");
const START = "<!-- cli-terminal:start -->";
const END = "<!-- cli-terminal:end -->";

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Capture the real `omnesis status` output (no colour — we re-colour to HTML).
const raw = execFileSync("npx", ["tsx", "packages/cli/src/index.ts", "status"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  maxBuffer: 10 * 1024 * 1024,
});

// Keep from the "Omnesis Status" header through the source table; drop the
// trailing "Process Health" block (machine-specific, and below the fold in
// the showcase) and any leading/trailing blank lines.
const lines = raw.replace(/\r/g, "").split("\n");
const startIdx = lines.findIndex((l) => l.includes("Omnesis Status"));
let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes("Process Health"));
if (endIdx === -1) endIdx = lines.length;
const body = lines.slice(startIdx, endIdx);
while (body.length && body[body.length - 1].trim() === "") body.pop();

// Colourise a single line, preserving its monospace spacing.
function colourise(line) {
  let h = esc(line);

  // Header + separator rows render dim as a whole.
  if (/^\s*Source\s+State\s+Count/.test(line)) return `<span class="t-dim">${h}</span>`;
  if (/^─+$/.test(line.trim())) return `<span class="t-dim">${h}</span>`;

  // Title line: "Omnesis Status (DB: …)".
  if (line.includes("Omnesis Status")) {
    return h.replace(
      /^(Omnesis Status)(.*)$/,
      '<span class="t-head">$1</span><span class="t-dim">$2</span>',
    );
  }

  // Source rows.
  h = h.replace(/^✓/, '<span class="t-ok">✓</span>');
  h = h.replace(/^·/, '<span class="t-dim">·</span>');
  h = h.replace(/\bsynced\b/, '<span class="t-ok">synced</span>');
  h = h.replace(/\bidle\b/, '<span class="t-dim">idle</span>');
  h = h.replace(/(^|\s)100%/, '$1<span class="t-ok">100%</span>');
  // Dim the detail columns (size, recency, interval, date ranges) like the CLI.
  h = h.replace(/\b(\d[\d.,]*)\s(KB|MB|GB|B)\b/g, '<span class="t-dim">$1 $2</span>');
  h = h.replace(/\b(\d+[smhd])\sago\b/g, '<span class="t-dim">$1 ago</span>');
  h = h.replace(
    /\b\d{2}\/\d{2}\/\d{2}-\d{2}\/\d{2}\/\d{2}\b/g,
    (m) => `<span class="t-dim">${m}</span>`,
  );
  return h;
}

const statusHtml = body.map(colourise).join("\n");

const block =
  `\n          <p class="cli-cmd">` +
  `<span class="t-prompt">omnesis&nbsp;❯</span> ` +
  `<span class="t-cmd">omnesis status</span></p>\n` +
  `          <pre class="cli-pre">${statusHtml}</pre>\n        `;

const html = readFileSync(indexHtml, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END);
if (s === -1 || e === -1) {
  console.error(`Markers ${START} / ${END} not found in ${indexHtml}`);
  process.exit(1);
}
const next = html.slice(0, s + START.length) + block + html.slice(e);
writeFileSync(indexHtml, next);
console.log(`Injected ${body.length} status lines into ${indexHtml}`);
