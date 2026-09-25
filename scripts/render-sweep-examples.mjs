// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain page's sweep dial and the files behind it.
 *
 * Every dot on the dial is a sweep that ships, and clicking one shows that
 * sweep's actual file — front matter and the steering prompt the gateway
 * runs. Dial and files are generated together from the list below so a dot
 * cannot end up pointing at prose that is not the one it stands for.
 *
 * The prompts are copied from the gateway's own SYSTEM_SWEEPS. When one is
 * reworded there, reword it here and re-render; the page is claiming to show
 * what actually runs, and it should be made to keep that claim.
 *
 *   node scripts/render-sweep-examples.mjs           # re-render the section
 *   node scripts/render-sweep-examples.mjs --check   # fail if it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "website/brain.html";
const START = "<!-- sweep-examples:start -->";
const END = "<!-- sweep-examples:end -->";

export const SWEEPS = [
  {
    id: "may-day",
    name: "Day ahead",
    cadence: "1d",
    band: "Daily",
    at: "05:00",
    side: "right",
    y: 182.0,
    primeHorizonDays: null,
    prompt:
      "Prepare the user for the day that is starting. Look at what is happening today — meetings, appointments, scheduled events — and for the ones that merit it write an informative brief: what it is, when, with whom, and the context worth having to hand, drawn from the surrounding correspondence. Stamp each brief with the time of the event it concerns so the feed can rank it into the right part of the day, and cite the documents you drew it from. Check the open loops falling due today or very shortly and remind the user where a reminder would help. Then look a week out — across both source-owned schedules and your own recorded interpretations of upcoming time — and for anything genuinely approaching that needs preparing, surface it and open a loop if it is a real obligation nobody is tracking yet. If along the way you find a tracked obligation has already been fulfilled — a receipt, a confirmation, a reply that settles it — close its loop as done with a note and remove the briefs it made moot; never delete a loop that was actually completed, because the record of what happened is worth keeping. Check what is already in the feed before writing anything, so an earlier pass's card is updated rather than duplicated. Where an event later today would benefit from the freshest possible picture, schedule yourself a short follow-up shortly beforehand to rebuild its brief. Most days only a handful of things merit a brief, and an empty pass is a fine outcome.",
  },
  {
    id: "weekly-finances",
    name: "Weekly finances",
    cadence: "7d",
    band: "Weekly",
    at: "09:10",
    side: "left",
    y: 168.0,
    primeHorizonDays: null,
    prompt:
      "Review the past week's financial activity across every source — new or upcoming invoices and bills, subscriptions renewing, refunds owed or awaited, and any charge that looks unusual for its merchant or amount. Surface only what needs a decision or action; ignore routine, already-settled transactions.",
  },
  {
    id: "waiting-on-others",
    name: "Waiting on others",
    cadence: "7d",
    band: "Weekly",
    at: "09:40",
    side: "left",
    y: 240.0,
    primeHorizonDays: null,
    prompt:
      "Scan for things the user is waiting on from someone else — a reply, a delivery, a document, a decision, a payment — that have gone quiet past a reasonable turnaround for that person and channel. Surface the ones genuinely worth a nudge; skip anything still within a normal wait.",
  },
  {
    id: "relationships-nudge",
    name: "Relationships",
    cadence: "14d",
    band: "Fortnightly",
    at: "10:10",
    side: "left",
    y: 104.0,
    primeHorizonDays: null,
    prompt:
      "Who has the user not been in touch with for notably longer than their usual rhythm together, and are there unanswered messages or owed replies to people who matter? Surface a gentle, specific reconnect nudge only where it would genuinely land; never manufacture social pressure.",
  },
  {
    id: "health-trends",
    name: "Health trends",
    cadence: "7d",
    band: "Weekly",
    at: "10:40",
    side: "right",
    y: 130.0,
    primeHorizonDays: null,
    prompt:
      "Review the past week's health and fitness data against the user's OWN recent baseline — sleep, activity, resting heart rate, body metrics. Surface a meaningful shift or sustained trend worth their awareness. Never diagnose, never surface a single normal reading, and defer anything medical to a clinician.",
  },
  {
    id: "upcoming-horizon",
    name: "Upcoming horizon",
    cadence: "7d",
    band: "Weekly",
    at: "11:10",
    side: "right",
    y: 236.0,
    primeHorizonDays: 21,
    prompt:
      "Look ~2-3 weeks ahead across calendar, travel, deadlines, renewals, and dated obligations. Start from the primed temporal annotations in this prompt (re-ground each before acting on it) and query for any window you need beyond them — do NOT re-derive structured dates that temporal projections already carry. What is coming that benefits from acting NOW — a booking to make, a document to prepare, a decision with a closing window? Surface where early action matters; skip anything already well in hand.",
  },
  {
    id: "subscriptions-review",
    name: "Subscriptions",
    cadence: "30d",
    band: "Monthly",
    at: "11:40",
    side: "right",
    y: 78.0,
    primeHorizonDays: null,
    prompt:
      "Review recurring subscriptions, memberships, insurance, and auto-renewals visible in the corpus. Is anything renewing soon that the user might want to cancel, downgrade, or renegotiate — especially things they seem not to use? Surface renewals with a real decision window and a hint of why; ignore ones clearly wanted.",
  },
];

// ── The dial ────────────────────────────────────────────────────────────────
// Distance from the centre is time between passes: the innermost ring runs
// daily, the outermost monthly. The gap at the top of each ring is where its
// own label sits, so it is opened only as wide as that label needs.
const CX = 300;
const CY = 180;
const RINGS = { Daily: 52, Weekly: 86, Fortnightly: 120, Monthly: 154 };
const RING_LABEL_W = { Daily: 40, Weekly: 48, Fortnightly: 88, Monthly: 66 };
const ADD_Y = 282;

const rad = (deg) => (deg * Math.PI) / 180;
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The point on a ring at a given height, on one side of the dial. */
function onRing(r, y, side) {
  const base = (Math.asin((y - CY) / r) * 180) / Math.PI;
  const deg = side === "left" ? 180 - base : base;
  return { x: CX + r * Math.cos(rad(deg)), y };
}

function renderDial() {
  const arcs = [];
  const labels = [];
  for (const [name, r] of Object.entries(RINGS)) {
    const half = (Math.asin(Math.min(0.92, (RING_LABEL_W[name] / 2 + 8) / r)) * 180) / Math.PI;
    const a = { x: CX + r * Math.cos(rad(270 + half)), y: CY + r * Math.sin(rad(270 + half)) };
    const b = { x: CX + r * Math.cos(rad(270 - half)), y: CY + r * Math.sin(rad(270 - half)) };
    arcs.push(
      `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)}A${r} ${r} 0 1 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}" />`,
    );
    labels.push(`<text x="${CX}" y="${(CY - r + 3.6).toFixed(1)}">${name}</text>`);
  }

  const dots = [];
  const ids = [];
  for (const s of SWEEPS) {
    const p = onRing(RINGS[s.band], s.y, s.side);
    dots.push(
      `<circle class="sw-dot" data-sw-sweep="${s.id}" cx="${p.x.toFixed(1)}" cy="${p.y}" r="5" tabindex="0" role="button" aria-label="Show the ${esc(s.name)} sweep" />`,
    );
    const tx = s.side === "right" ? p.x + 11 : p.x - 11;
    ids.push(
      `<text class="sw-dot-id" data-sw-sweep="${s.id}" x="${tx.toFixed(1)}" y="${(s.y + 3.8).toFixed(1)}" text-anchor="${s.side === "right" ? "start" : "end"}">${s.id}</text>`,
    );
  }

  const add = onRing(RINGS.Monthly, ADD_Y, "right");
  const addSlot = `<g class="sw-ring-add">
                  <circle cx="${add.x.toFixed(1)}" cy="${ADD_Y}" r="6.4" />
                  <path d="M${(add.x - 3.2).toFixed(1)} ${ADD_Y}h6.4M${add.x.toFixed(1)} ${ADD_Y - 3.2}v6.4" />
                  <text x="${(add.x + 14).toFixed(1)}" y="${ADD_Y + 3.8}">Add yours</text>
                </g>`;

  return `<svg
                class="sw-rings"
                viewBox="32 16 566 323"
                role="img"
                aria-label="Four concentric rings — daily, weekly, fortnightly and monthly — each carrying the sweeps that run at that cadence, plus an empty slot for one of your own"
              >
                <g class="sw-ring-track">
                  ${arcs.join("\n                  ")}
                </g>
                ${addSlot}
                <g class="sw-ring-dot">
                  ${dots.join("\n                  ")}
                </g>
                <g class="sw-ring-label">
                  ${labels.join("\n                  ")}
                </g>
                <g class="sw-ring-id">
                  ${ids.join("\n                  ")}
                </g>
              </svg>`;
}

// ── The files ───────────────────────────────────────────────────────────────
/** One sweep as it sits on disk: a little front matter, then the prose. */
function fileLines(sweep) {
  const rows = [
    ['<span class="buf-fence">---</span>'],
    [`<span class="buf-key">name</span><span class="buf-val">: ${esc(sweep.name)}</span>`],
    [`<span class="buf-key">cadence</span><span class="buf-val">: ${sweep.cadence}</span>`],
    [
      `<span class="buf-key">at</span><span class="buf-val">: </span><span class="buf-str">"${sweep.at}"</span>`,
    ],
  ];
  if (sweep.primeHorizonDays) {
    rows.push([
      `<span class="buf-key">primeHorizonDays</span><span class="buf-val">: </span><span class="buf-num">${sweep.primeHorizonDays}</span>`,
    ]);
  }
  rows.push(
    ['<span class="buf-fence">---</span>'],
    [""],
    [`<span class="buf-prose">${esc(sweep.prompt)}</span>`],
  );
  return rows
    .map(
      ([body], i) =>
        `                    <span class="buf-ln">${i + 1}</span>\n                    <span>${body || "&nbsp;"}</span>`,
    )
    .join("\n");
}

function renderSection() {
  const panels = SWEEPS.map(
    (
      s,
      i,
    ) => `                <div class="sw-panel" data-sw-panel="${s.id}"${i === 0 ? "" : " hidden"}>
                  <div class="buf-frame sw-file">
                    <div class="sw-file-scroll">
                      <div class="buf-body">
${fileLines(s)}
                      </div>
                    </div>
                    <div class="buf-status">
                      <span class="buf-status-path">sweeps/${s.id}.md</span>
                    </div>
                  </div>
                </div>`,
  ).join("\n");

  return `            <div class="reveal">
              ${renderDial()}
            </div>

            <div class="sw-files reveal reveal-delay-1">
${panels}
            </div>`;
}

export async function renderFile() {
  const path = join(root, TARGET);
  const before = readFileSync(path, "utf8");
  const startAt = before.indexOf(START);
  const endAt = before.indexOf(END, startAt);
  if (startAt === -1 || endAt === -1) throw new Error(`${TARGET}: missing ${START} / ${END}`);
  const lineStart = before.lastIndexOf("\n", startAt) + 1;
  const indent = " ".repeat(startAt - lineStart);
  const injected =
    before.slice(0, startAt) + START + "\n" + renderSection() + "\n" + indent + before.slice(endAt);
  const config = await prettier.resolveConfig(path);
  return { path, before, after: await prettier.format(injected, { ...config, filepath: path }) };
}

async function main() {
  const check = process.argv.includes("--check");
  const { path, before, after } = await renderFile();
  if (before === after) {
    console.log(check ? "==> the sweep section is up to date" : "==> no change");
    return;
  }
  if (check) {
    console.error(
      `Stale sweep section in ${TARGET}.\nRe-render: node scripts/render-sweep-examples.mjs`,
    );
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`==> rendered ${SWEEPS.length} sweeps into ${TARGET}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
