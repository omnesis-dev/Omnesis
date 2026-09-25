// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain page's watch carousel: for each example, the definition as JSON
 * and the graph it compiles to, side by side.
 *
 * Both halves are generated from one place — the definitions below — because
 * a graph drawn by hand beside a definition is a graph that will one day
 * disagree with it. The layout is the portal's own algorithm (ranks by Kahn
 * over declaration order, a synthetic box for the sink, edges read out of each
 * consuming node's `inputs` map), at slightly tighter metrics so more of a
 * wide watch fits the page.
 *
 * The examples are modelled on watches that actually run, rewritten with
 * invented tables and merchants: the shapes are the point, not anyone's data.
 *
 *   node scripts/render-watch-examples.mjs           # re-render the carousel
 *   node scripts/render-watch-examples.mjs --check   # fail if it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "website/brain.html";
const START = "<!-- watch-examples:start -->";
const END = "<!-- watch-examples:end -->";

// ── Geometry ────────────────────────────────────────────────────────────────
// The portal's constants, tightened: a narrower box and smaller type let a
// three-wide rank sit beside the definition instead of pushing it off the row.
const NODE_W = 196;
// A rank three wide at full width pushes the graph past the page. Those boxes
// take 70% and let their summary wrap instead — a rank that wide is a fan of
// sibling nodes, whose ids and types are short by construction.
const NODE_W_NARROW = 138;
const CROWDED_RANK = 3;
const SUMMARY_LINE_H = 14;
const SUMMARY_CHAR = 5.2;
// Three pinned 1.35 lines (~42px) plus 16px of padding, with room to spare.
const BASE_H = 68;
const BADGE_ROW_H = 20;
const COL_GAP = 22;
// A diagonal edge needs vertical room to read as one, and to leave the key
// chip somewhere to sit. A straight edge between two single-node ranks needs
// neither, so a chain — the tallest shape a watch takes — is not padded for a
// fan it does not have.
const RANK_GAP = 54;
const RANK_GAP_CHAIN = 34;
const PAD = 14;
const ARROW_GAP = 8;

/**
 * How many rows of chips a box has to allow for. Widths are estimated rather
 * than measured — nothing here can measure text — but counting chips alone
 * sizes every two-chip box for two rows and leaves a visible gap under the
 * pair that fits on one. The estimate is deliberately generous: over-counting
 * a row costs a little space, under-counting clips a chip.
 */
// Fitted against what the chips actually render at (chars * ~4.3 + ~17 for a
// plain one, ~18 more for the sparked LLM chip), then rounded up a little:
// over-counting a row costs a few pixels of padding, under-counting clips.
const CHIP_PAD = 15;
const CHIP_CHAR = 4.6;
const ICON = 18;

function badgeRows(badges) {
  if (badges.length === 0) return 0;
  const inner = NODE_W - 20;
  let rows = 1;
  let used = 0;
  for (const badge of badges) {
    const w = badge.label.length * CHIP_CHAR + CHIP_PAD + (badge.llm ? ICON : 0);
    if (used > 0 && used + w > inner) {
      rows += 1;
      used = 0;
    }
    used += w + 3;
  }
  return Math.min(rows, 2);
}

/** How many lines the summary wraps to at this width. Two is the cap. */
function summaryLines(node, width) {
  if (!node.summary) return 1;
  const perLine = Math.max(8, Math.floor((width - 20) / SUMMARY_CHAR));
  return Math.min(2, Math.max(1, Math.ceil(node.summary.length / perLine)));
}

const boxHeight = (node, width) =>
  BASE_H + (summaryLines(node, width) - 1) * SUMMARY_LINE_H + badgeRows(node.badges) * BADGE_ROW_H;

const list = (v) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : null);

/** One line under the id, saying what this node is configured to watch. */
function summarize(node) {
  switch (node.type) {
    case "source.document_event": {
      const f = node.filter ?? {};
      return [`source=${list(f.source) ?? "any"}`, `event=${list(f.event) ?? "any"}`].join(" · ");
    }
    case "source.analytics_row":
      // The table alone: `table=… · op=…` runs past the box, and which arrivals
      // it listens to reads perfectly well as a chip.
      return `table=${node.table}`;
    case "source.time":
      return node.recurring ? `cron ${node.recurring}` : `once at ${node.one_off}`;
    case "sql":
      return "DuckDB over your analytics";
    case "llm":
      return node.mode === "investigation" ? "deliberates with tools" : "judges the evidence";
    case "stateful.wait":
      return `${node.duration} after arming`;
    case "stateful.and":
      return `every arm, within ${node.deadline}`;
    case "stateful.sequence":
      return `in order, within ${node.deadline}`;
    case "stateful.threshold":
      return `${node.n} arms within ${node.deadline}`;
    case "stateless.or":
      return "any arm";
    default:
      return null;
  }
}

/** The chips along the bottom of a box. `llm` marks the model pass itself. */
function badgesFor(node) {
  const out = [];
  if (node.judge || node.type === "llm") {
    out.push({ label: node.type === "llm" ? `LLM ${node.mode}` : "LLM judge", llm: true });
  }
  if (node.recall?.semantic) out.push({ label: "semantic recall" });
  if (node.scope?.horizon) out.push({ label: `horizon ${node.scope.horizon}` });
  if (node.on_collision) out.push({ label: `collision: ${node.on_collision}` });
  if (node.op) out.push({ label: `op=${list(node.op)}` });
  if (node.predicate) {
    // Show the predicate itself where it is short enough to read in a chip;
    // a long one would push the box wider than the rank it sits in.
    const compact = node.predicate.replace(/\s+/g, "");
    out.push({ label: compact.length <= 22 ? `predicate=${compact}` : "predicate" });
  }
  return out;
}

/** Read a definition into boxes and edges, ranked top to bottom. */
function readDag(watch) {
  const byId = new Map(watch.nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const node of watch.nodes) {
    for (const [from, input] of Object.entries(node.inputs ?? {})) {
      edges.push({ from, to: node.id, role: input.role, key: input.key });
    }
  }
  edges.push({ from: watch.sink.input, to: "__sink", role: "sink", key: null, sink: true });

  const boxes = watch.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.id,
    summary: summarize(n),
    badges: badgesFor(n),
    source: !n.inputs,
  }));
  boxes.push({
    id: "__sink",
    type: "sink",
    label: `from ${watch.sink.input}`,
    summary: watch.delivery?.kind === "agent-wake" ? "Wakes an agent" : "Notifies your devices",
    badges: watch.delivery ? [{ label: watch.delivery.kind }] : [],
    isSink: true,
  });

  // Kahn over declaration order, so two reads draw the same picture.
  const indegree = new Map(boxes.map((b) => [b.id, 0]));
  for (const e of edges) indegree.set(e.to, indegree.get(e.to) + 1);
  const ranks = [];
  let frontier = boxes.filter((b) => indegree.get(b.id) === 0);
  const placed = new Set();
  while (frontier.length) {
    ranks.push(frontier);
    frontier.forEach((b) => placed.add(b.id));
    const next = [];
    for (const b of boxes) {
      if (placed.has(b.id)) continue;
      const deps = edges.filter((e) => e.to === b.id);
      if (deps.every((e) => placed.has(e.from))) next.push(b);
    }
    frontier = next;
  }
  if (placed.size !== boxes.length) throw new Error(`${watch.name}: graph could not be ranked`);
  return { boxes, edges, ranks };
}

/** Place the ranks, then find where each edge leaves and enters a box. */
function layout(dag) {
  const rows = dag.ranks.map((rank) => {
    const nodeW = rank.length >= CROWDED_RANK ? NODE_W_NARROW : NODE_W;
    return {
      rank,
      nodeW,
      height: rank.reduce((max, n) => Math.max(max, boxHeight(n, nodeW)), BASE_H),
      width: rank.length * nodeW + (rank.length - 1) * COL_GAP,
    };
  });
  const width = rows.reduce((max, r) => Math.max(max, r.width), NODE_W) + PAD * 2;
  const placed = new Map();
  let y = PAD;
  rows.forEach((row, index) => {
    const left = (width - row.width) / 2;
    row.rank.forEach((node, i) => {
      placed.set(node.id, {
        ...node,
        x: left + i * (row.nodeW + COL_GAP),
        y,
        w: row.nodeW,
        h: row.height,
      });
    });
    const next = rows[index + 1];
    const chain = next && row.rank.length === 1 && next.rank.length === 1;
    y += row.height + (next ? (chain ? RANK_GAP_CHAIN : RANK_GAP) : 0);
  });
  const height = y + PAD;

  // Spread endpoints across a box edge so a fan reads as separate lines.
  const slot = (box, count, index, atTop) => ({
    x: box.x + (box.w * (index + 1)) / (count + 1),
    y: atTop ? box.y - ARROW_GAP : box.y + box.h,
  });
  const drawn = dag.edges.map((e) => {
    const from = placed.get(e.from);
    const to = placed.get(e.to);
    const outs = dag.edges.filter((o) => o.from === e.from);
    const ins = dag.edges.filter((i) => i.to === e.to);
    const a = slot(from, outs.length, outs.indexOf(e), false);
    const b = slot(to, ins.length, ins.indexOf(e), true);
    return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  return { width, height, boxes: [...placed.values()], edges: drawn };
}

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function renderDag(watch, slug) {
  const l = layout(readDag(watch));
  // Ids are per canvas: only one panel is shown at a time, and a marker
  // defined inside a `hidden` one is not available to paint with.
  const markers = ["arm", "cancel", "sink"]
    .map(
      (k) =>
        `<marker id="wd-arrow-${k}-${slug}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wd-head-${k}" /></marker>`,
    )
    .join("");
  const lines = l.edges
    .map((e) => {
      const kind = e.sink ? "sink" : e.role === "cancel" ? "cancel" : "arm";
      const dash = kind === "cancel" ? ' stroke-dasharray="6 4"' : "";
      return `<line class="wd-line-${kind}" x1="${e.x1.toFixed(0)}" y1="${e.y1.toFixed(0)}" x2="${e.x2.toFixed(0)}" y2="${e.y2.toFixed(0)}"${dash} marker-end="url(#wd-arrow-${kind}-${slug})" />`;
    })
    .join("\n            ");

  const boxes = l.boxes
    .map((b) => {
      const cls = b.source ? " is-source" : b.isSink ? " is-sink" : "";
      const chips = b.badges
        .map(
          (x) =>
            `<span class="wd-badge${x.llm ? " wd-badge--llm" : ""}">${x.llm ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>' : ""}${esc(x.label)}</span>`,
        )
        .join("");
      return `<div class="wd-node${cls}" data-wd-node="${esc(b.id)}" role="button" tabindex="0" aria-label="Show ${esc(b.label)} in the definition" style="left: ${b.x.toFixed(0)}px; top: ${b.y}px; width: ${b.w}px; height: ${b.h}px">
              <span class="wd-type">${esc(b.type)}</span>
              <code class="wd-id">${esc(b.label)}</code>
              <span class="wd-summary">${esc(b.summary ?? "")}</span>
              <span class="wd-badges">${chips}</span>
            </div>`;
    })
    .join("\n            ");

  // A key chip sits beside the edge it annotates, offset away from the line so
  // it never lies across it.
  const labels = l.edges
    .filter((e) => e.key || e.role === "cancel")
    .map((e) => {
      const keys = e.key ? Object.keys(e.key).join(", ") : null;
      const midX = (e.x1 + e.x2) / 2;
      const midY = (e.y1 + e.y2) / 2;
      const dx = e.x2 - e.x1;
      const dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy) || 1;
      // Offset perpendicular to this edge, not by a fixed sideways nudge: a
      // chip belongs to one arrow, and on a fan of three converging edges a
      // constant push lands it nearer a neighbour's line than its own.
      let nx = -dy / len;
      let ny = dx / len;
      // Take the side facing away from the canvas's centre line, so the chips
      // on converging edges fan outward rather than stacking.
      if ((midX < l.width / 2 && nx > 0) || (midX >= l.width / 2 && nx < 0)) {
        nx = -nx;
        ny = -ny;
      }
      // Far enough along each axis to clear the line whichever way it runs.
      const chipChars = (keys ? keys.length + 2 : 0) + (e.role === "cancel" ? 7 : 0);
      const halfW = (chipChars * 5.6 + 22) / 2;
      const push = { x: nx * (halfW + 12), y: ny * 19 };
      const chips = [
        keys ? `<code class="wd-key">(${esc(keys)})</code>` : "",
        e.role === "cancel" ? '<span class="wd-note cancel">cancels</span>' : "",
      ]
        .filter(Boolean)
        .join("");
      return `<div class="wd-edge-label" style="left: ${(midX + push.x).toFixed(0)}px; top: ${(midY + push.y).toFixed(0)}px">${chips}</div>`;
    })
    .join("\n            ");

  return `<div class="wd-canvas" style="width: ${l.width}px; height: ${l.height}px">
            <svg class="wd-edges" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}" aria-hidden="true">
              <defs>${markers}</defs>
              ${lines}
            </svg>
            ${boxes}
            ${labels}
          </div>`;
}

// ── JSON, syntax-coloured ───────────────────────────────────────────────────
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?)/g;

/**
 * Which lines of the pretty-printed definition declare each node.
 *
 * This is what lets a box on the graph point at the JSON that produced it.
 * It is computed from the serialised text rather than guessed at in the
 * browser: `JSON.stringify(_, null, 2)` indents deterministically, so an
 * element of the `nodes` array opens on a line that is exactly its indent
 * plus a brace, and closes on the matching one.
 *
 * Every node must resolve to a span. A box that silently linked to nothing
 * would look broken only to whoever clicked it.
 */
function declarationSpans(dsl, lines) {
  const spans = new Map();
  const nodesAt = lines.findIndex((l) => /^\s*"nodes": \[$/.test(l));
  if (nodesAt === -1) throw new Error("no `nodes` array in the serialised definition");
  const indent = lines[nodesAt].match(/^\s*/)[0].length + 2;
  const open = " ".repeat(indent) + "{";
  const close = " ".repeat(indent) + "}";

  let line = nodesAt + 1;
  let index = 0;
  while (line < lines.length && lines[line] !== " ".repeat(indent - 2) + "],") {
    if (lines[line] === open) {
      let end = line + 1;
      while (end < lines.length && lines[end] !== close && lines[end] !== close + ",") end++;
      const node = dsl.watch.nodes[index];
      if (!node) throw new Error("more objects in `nodes` than the definition declares");
      spans.set(node.id, [line, end]);
      index += 1;
      line = end + 1;
      continue;
    }
    line += 1;
  }
  if (index !== dsl.watch.nodes.length) {
    throw new Error(`located ${index} of ${dsl.watch.nodes.length} node declarations`);
  }

  const sinkAt = lines.findIndex((l) => /^\s*"sink": \{$/.test(l));
  if (sinkAt === -1) throw new Error("no `sink` in the serialised definition");
  const sinkClose = " ".repeat(lines[sinkAt].match(/^\s*/)[0].length) + "}";
  let end = sinkAt + 1;
  while (end < lines.length && lines[end] !== sinkClose && lines[end] !== sinkClose + ",") end++;
  spans.set("__sink", [sinkAt, end]);
  return spans;
}

function renderJson(dsl) {
  const text = JSON.stringify(dsl, null, 2);
  const lines = text.split("\n");
  const spans = declarationSpans(dsl, lines);
  const owner = new Map();
  for (const [id, [from, to]] of spans) {
    for (let i = from; i <= to; i++) owner.set(i, id);
  }
  return lines
    .map((line, i) => {
      let out = "";
      let last = 0;
      for (const m of line.matchAll(TOKEN)) {
        out += esc(line.slice(last, m.index));
        if (m[1] !== undefined) {
          out += `<span class="${m[2] ? "buf-key" : "buf-str"}">${esc(m[1])}</span>`;
          if (m[2]) out += `<span class="buf-val">${esc(m[2])}</span>`;
        } else if (m[3] !== undefined) out += `<span class="buf-lit">${esc(m[3])}</span>`;
        else out += `<span class="buf-num">${esc(m[4])}</span>`;
        last = m.index + m[0].length;
      }
      out += esc(line.slice(last));
      const indent = line.length - line.trimStart().length;
      const body = indent ? "&nbsp;".repeat(indent) + out.trimStart() : out;
      const owns = owner.get(i);
      const tag = owns ? ` data-buf-node="${esc(owns)}"` : "";
      return `<span class="buf-ln"${tag}>${i + 1}</span>\n                  <span${tag}>${body || "&nbsp;"}</span>`;
    })
    .map((row) => `                  ${row}`)
    .join("\n");
}

// ── The examples ────────────────────────────────────────────────────────────
const FINGERPRINT = "eef3032ba8488f3e61a908f6b28f5832";

const LISTING = {
  watch: {
    name: "x-listing-unanswered",
    nl_query:
      "Tell me when I receive an email about a property listing and I have not replied in 3 days.",
    firing_policy: "stays_active",
    ontology_fingerprint: FINGERPRINT,
    nodes: [
      {
        id: "listing",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", isSelf: false }],
        },
        recall: {
          semantic: {
            query:
              "property listing, a house or flat for sale or to rent, with an asking price or a viewing",
            threshold: 0.35,
          },
        },
        judge: {
          proposition:
            "This email is about a specific property being offered for sale or to rent — a listing, a viewing, or an agent's details for one — and it is addressed to the recipient rather than a mass mailing",
          output_schema: { why: "string" },
        },
        output_map: {
          doc_id: "$e.docId",
          thread_id: "$e.metadata.extra.threadId",
          why: "$judge.why",
        },
      },
      {
        id: "my_reply",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", isSelf: true }],
        },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "unanswered",
        type: "stateful.wait",
        inputs: {
          listing: { role: "arm", key: { thread_id: ".thread_id" } },
          my_reply: { role: "cancel", key: { thread_id: ".thread_id" } },
        },
        on_collision: "reset",
        duration: "3 days",
        output_map: { doc_id: "$n.listing.doc_id", why: "$n.listing.why" },
      },
    ],
    sink: {
      input: "unanswered",
      output_map: { evidence: "$n.unanswered.doc_id", why: "$n.unanswered.why" },
    },
    delivery: { kind: "omnesis-notify" },
  },
};

/** One deviation query, parameterised — the three arms differ only in band. */
const deviation = (table, metric, band) =>
  `WITH daily AS (SELECT cast(start_time AS DATE) AS day, avg(value) AS v FROM ${table} WHERE metric_slug = '${metric}' GROUP BY 1), subject AS (SELECT v FROM daily WHERE day = $today - INTERVAL 1 DAY), baseline AS (SELECT avg(v) AS avg_v, count(*) AS n_days FROM daily WHERE day BETWEEN $today - INTERVAL 31 DAY AND $today - INTERVAL 2 DAY) SELECT ($today - INTERVAL 1 DAY) AS day, baseline.n_days >= 14 AND abs(subject.v - baseline.avg_v) >= ${band} * baseline.avg_v AS fires, round(100.0 * (subject.v - baseline.avg_v) / baseline.avg_v, 1) AS deviation_pct FROM subject, baseline`;

const BODY_SIGNAL = {
  watch: {
    name: "x-body-signal-day",
    nl_query: "Tell me when sleep, HRV and heart rate all deviated from my usual on the same day.",
    firing_policy: "stays_active",
    ontology_fingerprint: FINGERPRINT,
    nodes: [
      {
        id: "morning_tick",
        type: "source.time",
        recurring: "0 9 * * *",
        output_map: { due_at: "$e.dueAt" },
      },
      {
        id: "sleep_dev",
        type: "sql",
        inputs: { morning_tick: { role: "arm" } },
        query: deviation("health_sleep", "asleep_minutes", "0.30"),
        output_map: { day: "day", deviation_pct: "deviation_pct" },
      },
      {
        // HRV carries a wider band than the others: at 30% it deviates on a
        // fifth of days and would dominate the conjunction.
        id: "hrv_dev",
        type: "sql",
        inputs: { morning_tick: { role: "arm" } },
        query: deviation("health_vitals", "hrv", "0.45"),
        output_map: { day: "day", deviation_pct: "deviation_pct" },
      },
      {
        id: "hr_dev",
        type: "sql",
        inputs: { morning_tick: { role: "arm" } },
        query: deviation("health_vitals", "heart_rate", "0.30"),
        output_map: { day: "day", deviation_pct: "deviation_pct" },
      },
      {
        id: "all_three",
        type: "stateful.and",
        inputs: {
          sleep_dev: { role: "arm", key: { day: ".day" } },
          hrv_dev: { role: "arm", key: { day: ".day" } },
          hr_dev: { role: "arm", key: { day: ".day" } },
        },
        deadline: "1 day",
        on_collision: "ignore",
        output_map: {
          sleep_pct: "$n.sleep_dev.deviation_pct",
          hrv_pct: "$n.hrv_dev.deviation_pct",
          hr_pct: "$n.hr_dev.deviation_pct",
        },
      },
    ],
    sink: {
      input: "all_three",
      output_map: {
        sleep_pct: "$n.all_three.sleep_pct",
        hrv_pct: "$n.all_three.hrv_pct",
        hr_pct: "$n.all_three.hr_pct",
      },
    },
    delivery: { kind: "omnesis-notify" },
  },
};

const UNEXPLAINED_PAYMENT = {
  watch: {
    name: "x-unexplained-large-payment",
    nl_query:
      "Tell me when an unusually large payment is made and it can't be explained by a bill I received or a subscription.",
    firing_policy: "stays_active",
    ontology_fingerprint: FINGERPRINT,
    nodes: [
      {
        id: "spend",
        type: "source.analytics_row",
        table: "bank_transactions",
        op: ["inserted"],
        predicate: "amount < 0",
        output_map: {
          txn_key: "$e.row.transaction_key",
          amount: "$e.row.amount",
          currency: "$e.row.currency",
          merchant: "$e.row.merchant_name",
        },
      },
      {
        id: "above_p99",
        type: "sql",
        inputs: { spend: { role: "arm" } },
        query:
          "WITH baseline AS (SELECT quantile_cont(abs(amount), 0.99) AS p99, count(*) AS n_txns FROM bank_transactions WHERE amount < 0 AND currency = $n.spend.currency AND transaction_key <> $n.spend.txn_key AND transaction_date BETWEEN $today - INTERVAL 30 DAY AND $today) SELECT baseline.n_txns >= 14 AND abs(CAST($n.spend.amount AS DECIMAL(18,4))) > baseline.p99 AS fires, round(baseline.p99, 2) AS p99 FROM baseline",
        output_map: { p99: "p99" },
      },
      // Investigation rather than judge: deciding this needs evidence the
      // upstream nodes never carried, so the node goes and looks for it — the
      // bill itself, a renewal notice, or earlier charges of the same shape.
      // It asks whether the charge IS explained and fires on the negation, so
      // finding proof is what keeps the watch quiet.
      {
        id: "explained",
        type: "llm",
        mode: "investigation",
        inputs: { above_p99: { role: "arm" } },
        proposition:
          "This charge is explained by something already in the corpus: a bill or invoice received for it, or a recurring subscription with proof of it — a confirmation, a renewal notice, or earlier charges of the same shape from the same merchant.",
        output_schema: { explained: "bool", proof: "string" },
        fire_when: "NOT explained",
        scope: { horizon: "180 days" },
        budget: { tool_calls: 12, tokens: 40000 },
        output_map: { proof: "proof" },
      },
    ],
    sink: {
      input: "explained",
      output_map: {
        evidence: "$n.spend.txn_key",
        merchant: "$n.spend.merchant",
        proof: "$n.explained.proof",
      },
    },
    delivery: { kind: "omnesis-notify" },
  },
};

export const EXAMPLES = [
  { id: "listing", tab: "Unanswered listing", dsl: LISTING },
  { id: "body", tab: "Body signals", dsl: BODY_SIGNAL },
  { id: "payment", tab: "Unexplained payment", dsl: UNEXPLAINED_PAYMENT },
];

// ── Injection ───────────────────────────────────────────────────────────────
function renderCarousel() {
  const tabs = EXAMPLES.map(
    (e, i) =>
      `            <button
              class="wt-tab"
              type="button"
              role="tab"
              id="wt-tab-${e.id}"
              aria-controls="wt-panel-${e.id}"
              aria-selected="${i === 0}"
              data-wt-tab="${e.id}"
            >
              ${esc(e.tab)}
            </button>`,
  ).join("\n");

  const panels = EXAMPLES.map(
    (e, i) => `          <div
            class="wt-panel"
            role="tabpanel"
            id="wt-panel-${e.id}"
            aria-labelledby="wt-tab-${e.id}"
            data-wt-panel="${e.id}"
            ${i === 0 ? "" : "hidden"}
          >
            <p class="wt-ask">
              <span class="wt-ask-mark" aria-hidden="true">&ldquo;</span>${esc(e.dsl.watch.nl_query)}<span
                class="wt-ask-mark"
                aria-hidden="true"
                >&rdquo;</span
              >
            </p>
            <div class="wt-showcase">
              <div class="wt-code-cell">
                <div class="buf-frame wt-code">
                  <div class="wt-code-scroll">
                    <div class="buf-body">
${renderJson(e.dsl)}
                    </div>
                  </div>
                  <div class="buf-status">
                    <span class="buf-status-path">watches/${esc(e.dsl.watch.name)}.json</span>
                  </div>
                </div>
              </div>
              <div class="wt-dag">
                ${renderDag(e.dsl.watch, e.id)}
              </div>
            </div>
          </div>`,
  ).join("\n");

  return `        <div class="wt-tabs" role="tablist" aria-label="Watch examples">
${tabs}
        </div>

${panels}`;
}

export async function renderFile() {
  const path = join(root, TARGET);
  const before = readFileSync(path, "utf8");
  const startAt = before.indexOf(START);
  const endAt = before.indexOf(END, startAt);
  if (startAt === -1 || endAt === -1) {
    throw new Error(`${TARGET}: missing ${START} / ${END} markers`);
  }
  const lineStart = before.lastIndexOf("\n", startAt) + 1;
  const indent = " ".repeat(startAt - lineStart);
  const injected =
    before.slice(0, startAt) +
    START +
    "\n" +
    renderCarousel() +
    "\n" +
    indent +
    before.slice(endAt);
  const config = await prettier.resolveConfig(path);
  const after = await prettier.format(injected, { ...config, filepath: path });
  return { path, before, after };
}

async function main() {
  const check = process.argv.includes("--check");
  const { path, before, after } = await renderFile();
  if (before === after) {
    console.log(check ? "==> the carousel is up to date" : "==> no change");
    return;
  }
  if (check) {
    console.error(
      `Stale watch carousel in ${TARGET}.\nRe-render: node scripts/render-watch-examples.mjs`,
    );
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`==> rendered ${EXAMPLES.length} watch examples into ${TARGET}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
