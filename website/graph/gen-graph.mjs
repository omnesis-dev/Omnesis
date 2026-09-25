// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Generator for the round "unified graph → timeline" SVG inlined in
// website/index.html (the `.graph-flatten` section).
//
// WHY THIS EXISTS: the graph is ~30 nodes/edges of hand-tuned geometry. Rather
// than hand-edit 200 coordinates in the HTML, edit the model/constants here and
// re-run — it rebuilds the SVG and splices it back into index.html in place.
//
//   node website/graph/gen-graph.mjs
//
// Design: "You" is the centre hub; the 9 other nodes sit on a circle. The
// document chain (PDF1→PDF2→PDF3→PDF4) is a contiguous perimeter arc, and the
// ring is rotated (ROT) so Gmail lands near the top and the tenancy WhatsApp
// near the bottom — that's what lets the two citation cards in index.html stack
// above/below the circle. Visual language matches the Gateway card in the
// "Your data, indexed in the background" section: clean filled disks, thin
// brand-coloured edges, no glow (except the accent ring on "You").
//
// The CSS (`.gf-*` rules) and the two citation cards live in index.html; if you
// move a cited node (Gmail / the tenancy WhatsApp) re-check those card offsets.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "index.html");

const C = { x: 480, y: 410 }; // circle centre (user units)
const R = 320; // node-ring radius
const VIEWBOX = "38 8 884 824"; // tight box framing the circle
const ROT = -70; // ring rotation: Gmail→top, tenancy WhatsApp→bottom

const D2R = Math.PI / 180;
// angle measured from top (0 = straight up), clockwise, plus the global ROT.
const pos = (deg, r = R) => ({
  x: C.x + r * Math.sin((deg + ROT) * D2R),
  y: C.y - r * Math.cos((deg + ROT) * D2R),
});

// ── Nodes ── type: person | app | doc. `step` is kept for parity with the
// timeline's chronological order but the graph now reveals all at once.
const N = {
  you: { type: "person", you: true, ...pos(0, 0) },
  john: { type: "person", ...pos(20) },
  gmail: {
    type: "app",
    ...pos(60),
    img: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v10/192px.svg",
    imgSize: 44,
  },
  pdf1: { type: "doc", ...pos(100) },
  pdf2: { type: "doc", ...pos(140), drive: true },
  pdf3: { type: "doc", ...pos(180) },
  pdf4: { type: "doc", ...pos(220) },
  wa1: {
    type: "app",
    ...pos(260),
    img: "https://static.whatsapp.net/rsrc.php/y1/r/FJbTMJqMap7.svg",
    imgSize: 40,
  }, // tenancy-agreement.pdf conversation — the bottom node, cited by the chat bubble
  maria: { type: "person", ...pos(300) },
  wa2: {
    type: "app",
    ...pos(340),
    img: "https://static.whatsapp.net/rsrc.php/y1/r/FJbTMJqMap7.svg",
    imgSize: 40,
  },
};

const NR = { person: 34, app: 38, doc: 30 }; // doc = half-side of the 60px square

// ── Edges ── stroke: "edge" (neutral grey) | a brand hex | a gradient id.
const E = [
  { a: "john", b: "gmail", stroke: "edge" }, // Sender
  { a: "you", b: "gmail", stroke: "edge" }, // Recipient
  { a: "gmail", b: "pdf1", stroke: "#EA4335" }, // Attachment
  { a: "you", b: "pdf2", stroke: "edge" }, // Owner
  { a: "pdf1", b: "pdf2", stroke: "grad12" }, // Duplicate (red→yellow)
  { a: "you", b: "wa1", stroke: "edge" }, // Participant
  { a: "maria", b: "wa1", stroke: "edge" }, // Participant
  { a: "wa1", b: "pdf3", stroke: "#25D366" }, // Attachment
  { a: "pdf2", b: "pdf3", stroke: "grad23" }, // Duplicate (yellow→green)
  { a: "you", b: "wa2", stroke: "edge" }, // Participant
  { a: "maria", b: "wa2", stroke: "edge" }, // Participant
  { a: "wa2", b: "pdf4", stroke: "#25D366" }, // Attachment
  { a: "pdf3", b: "pdf4", stroke: "#25D366" }, // Near-duplicate
];

const f1 = (v) => Number(v.toFixed(1));
const out = [];
const p = (s) => out.push(s);

p(`<svg
            viewBox="${VIEWBOX}"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            font-family="Inter,sans-serif"
          >`);

p(`            <defs>
              <symbol id="ico-person" viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="5" fill="currentColor" />
                <path d="M3.5 22c0-4.7 3.8-8.5 8.5-8.5s8.5 3.8 8.5 8.5" fill="currentColor" />
              </symbol>
              <symbol id="ico-file" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                <path d="M10 9H8" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
              </symbol>
              <filter id="g-you-glow" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="6" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>`);
for (const e of E) {
  if (e.stroke === "grad12" || e.stroke === "grad23") {
    const A = N[e.a],
      B = N[e.b];
    const c0 = e.stroke === "grad12" ? "#EA4335" : "#FBBC04";
    const c1 = e.stroke === "grad12" ? "#FBBC04" : "#25D366";
    p(
      `              <linearGradient id="${e.stroke}" gradientUnits="userSpaceOnUse" x1="${f1(A.x)}" y1="${f1(A.y)}" x2="${f1(B.x)}" y2="${f1(B.y)}"><stop offset="0" stop-color="${c0}" /><stop offset="1" stop-color="${c1}" /></linearGradient>`,
    );
  }
}
p(`            </defs>`);

// edges — Gateway-card weight; brand links crisp, neutral person links faint
p(`            <g stroke-width="5" stroke-linecap="round" fill="none">`);
for (const e of E) {
  const A = N[e.a],
    B = N[e.b];
  const strokeAttr =
    e.stroke === "edge"
      ? `style="stroke: var(--graph-edge)"`
      : e.stroke.startsWith("grad")
        ? `stroke="url(#${e.stroke})"`
        : `stroke="${e.stroke}"`;
  const op = e.stroke === "edge" ? "0.4" : "0.92";
  p(
    `              <line x1="${f1(A.x)}" y1="${f1(A.y)}" x2="${f1(B.x)}" y2="${f1(B.y)}" ${strokeAttr} opacity="${op}" />`,
  );
}
p(`            </g>`);

// nodes — filled disks (mask the edges) + icon on top; "You" gets the accent ring
p(`            <!-- NODES -->`);
for (const k of Object.keys(N)) {
  const n = N[k];
  p(`            <g class="g-node">`);
  if (n.type === "person") {
    const r = NR.person;
    if (n.you) {
      p(
        `              <circle cx="${f1(n.x)}" cy="${f1(n.y)}" r="${r}" style="fill: var(--bg-secondary)" />`,
      );
      p(
        `              <use href="#ico-person" x="${f1(n.x - 22)}" y="${f1(n.y - 21)}" width="44" height="44" style="color: var(--accent)" filter="url(#g-you-glow)" />`,
      );
      p(
        `              <circle cx="${f1(n.x)}" cy="${f1(n.y)}" r="${r}" fill="none" style="stroke: var(--accent)" stroke-width="2.5" filter="url(#g-you-glow)" />`,
      );
    } else {
      p(
        `              <circle cx="${f1(n.x)}" cy="${f1(n.y)}" r="${r}" style="fill: var(--bg-secondary)" />`,
      );
      p(
        `              <use href="#ico-person" x="${f1(n.x - 22)}" y="${f1(n.y - 21)}" width="44" height="44" style="color: var(--graph-edge)" />`,
      );
    }
  } else if (n.type === "app") {
    const r = NR.app;
    const s = n.imgSize;
    p(
      `              <circle cx="${f1(n.x)}" cy="${f1(n.y)}" r="${r}" style="fill: var(--bg-secondary)" />`,
    );
    p(
      `              <image href="${n.img}" x="${f1(n.x - s / 2)}" y="${f1(n.y - s / 2)}" width="${s}" height="${s}" />`,
    );
  } else {
    p(
      `              <rect x="${f1(n.x - 30)}" y="${f1(n.y - 30)}" width="60" height="60" rx="18" style="fill: var(--bg-secondary)" />`,
    );
    p(
      `              <use href="#ico-file" x="${f1(n.x - 17)}" y="${f1(n.y - 17)}" width="34" height="34" />`,
    );
    if (n.drive)
      p(
        `              <image href="https://www.gstatic.com/images/branding/productlogos/drive_2020q4/v10/192px.svg" x="${f1(n.x + 1)}" y="${f1(n.y + 5)}" width="24" height="24" />`,
      );
  }
  p(`            </g>`);
}
p(`          </svg>`);

const svg = out.join("\n");

// Splice into index.html: replace the <svg> inside <div id="graph-viz"> in place.
let html = readFileSync(INDEX_HTML, "utf8");
const re = /(<div class="graph-viz" id="graph-viz">\s*)<svg[\s\S]*?<\/svg>/;
if (!re.test(html)) {
  console.error('Could not find <div id="graph-viz"><svg> in index.html');
  process.exit(1);
}
html = html.replace(re, `$1${svg}`);
writeFileSync(INDEX_HTML, html);
console.log(`Updated ${INDEX_HTML} with regenerated graph (${svg.length} bytes).`);
