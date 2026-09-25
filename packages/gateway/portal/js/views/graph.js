// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Graph-debug view. A text input + depth selector + "Walk" button that
 * hits `GET /documents/:id/graph` and hands the response to the SVG
 * renderer in `lib/graph-render.js`. This file owns input/state/routing
 * only; all drawing lives in the renderer module.
 *
 * Rendered as the Graph sub-tab of the Debug page. URL:
 * /portal/debug/graph[?documentId=…&depth=N]. The id + depth are mirrored
 * into the URL so a walk is shareable / reloadable. The `routePath` prop
 * lets the host page decide where those params are mirrored.
 */

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { navigate, replaceUrl } from "../lib/router.js";
import { getDocumentGraph, lookupDocumentsByUrl } from "../api.js";
import { renderGraph } from "../lib/graph-render.js";
import { collapseDuplicateClusters } from "../lib/graph-collapse-duplicates.js";

const DEFAULT_ROUTE_PATH = "/portal/debug/graph";
const DEFAULT_DEPTH = 10;
const DEFAULT_FANOUT_CAP = 50;
const DEFAULT_COLLAPSE = true;
const DEFAULT_SHOW_MENTIONS = true;
const DEFAULT_HIDE_ATTACHMENT_PEOPLE = false;

export function GraphView({
  initialDocumentId = "",
  initialDepth = DEFAULT_DEPTH,
  initialFanoutCap = DEFAULT_FANOUT_CAP,
  initialCollapse = DEFAULT_COLLAPSE,
  initialShowMentions = DEFAULT_SHOW_MENTIONS,
  initialHideAttachmentPeople = DEFAULT_HIDE_ATTACHMENT_PEOPLE,
  routePath = DEFAULT_ROUTE_PATH,
} = {}) {
  const [docId, setDocId] = useState(initialDocumentId);
  const [depth, setDepth] = useState(initialDepth);
  const [fanoutCap, setFanoutCap] = useState(initialFanoutCap);
  const [collapse, setCollapse] = useState(initialCollapse);
  const [showMentions, setShowMentions] = useState(initialShowMentions);
  const [hideAttachmentPeople, setHideAttachmentPeople] = useState(initialHideAttachmentPeople);
  const [rawGraph, setRawGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Popover state for merged-node hover. `null` = closed.
  // Shape: `{ vertex, x, y }` with x,y in canvas-wrap-relative px.
  const [popover, setPopover] = useState(null);
  const svgRef = useRef(null);
  const popoverHideTimer = useRef(null);

  // Mentions filter — when the "Show mentions" toggle is off, drop
  // every `mentioned`-role edge and any person vertex left orphan as
  // a result. Other roles (sender, recipient, owner, author,
  // attendee, participant, editor, contact) stay untouched.
  const filteredGraph = useMemo(() => {
    if (!rawGraph) return null;
    if (showMentions) return rawGraph;
    const edges = rawGraph.edges.filter((e) => e.type !== "mentioned");
    const personIdsKept = new Set();
    for (const e of edges) {
      if (typeof e.from === "string" && e.from.startsWith("person:")) personIdsKept.add(e.from);
      if (typeof e.to === "string" && e.to.startsWith("person:")) personIdsKept.add(e.to);
    }
    const vertices = rawGraph.vertices.filter(
      (v) => v.kind !== "person" || personIdsKept.has(v.id),
    );
    return { ...rawGraph, vertices, edges };
  }, [rawGraph, showMentions]);

  // "Hide attachment ↔ people" toggle — when on, drop every person
  // edge whose other endpoint is a documentType=attachment vertex.
  // Rationale: an extracted attachment inherits its people from the
  // parent doc (recipients of the email become recipients of the
  // attachment), so the edges duplicate signal already carried by
  // the parent.
  const graphInput = useMemo(() => {
    if (!filteredGraph) return null;
    if (!hideAttachmentPeople) return filteredGraph;
    const attachmentDocIds = new Set();
    for (const v of filteredGraph.vertices) {
      if (v.kind === "document" && v.documentType === "attachment") {
        attachmentDocIds.add(v.id);
      }
    }
    const isPerson = (id) => typeof id === "string" && id.startsWith("person:");
    const edges = filteredGraph.edges.filter((e) => {
      const fromAtt = attachmentDocIds.has(e.from);
      const toAtt = attachmentDocIds.has(e.to);
      if ((fromAtt && isPerson(e.to)) || (toAtt && isPerson(e.from))) return false;
      return true;
    });
    const personIdsKept = new Set();
    for (const e of edges) {
      if (isPerson(e.from)) personIdsKept.add(e.from);
      if (isPerson(e.to)) personIdsKept.add(e.to);
    }
    const vertices = filteredGraph.vertices.filter(
      (v) => v.kind !== "person" || personIdsKept.has(v.id),
    );
    return { ...filteredGraph, vertices, edges };
  }, [filteredGraph, hideAttachmentPeople]);

  // Apply (or skip) the client-side duplicate collapse based on the
  // toggle. `useMemo` avoids recomputing on unrelated re-renders.
  const visibleGraph = useMemo(() => {
    if (!graphInput) return null;
    return collapse ? collapseDuplicateClusters(graphInput) : graphInput;
  }, [graphInput, collapse]);

  // Re-render the SVG whenever the visible graph changes. The renderer
  // is self-contained (clears + redraws) so we don't track previous
  // state. Popover gets reset because vertex identities may shift.
  useEffect(() => {
    if (!svgRef.current || !visibleGraph) return;
    setPopover(null);
    renderGraph(svgRef.current, visibleGraph, {
      onVertexClick: (vertex) => {
        if (vertex.kind === "document" && vertex.documentId) {
          navigate(`/portal/doc/${encodeURIComponent(vertex.documentId)}`);
        } else if (vertex.kind === "person" && vertex.personId) {
          navigate(`/portal/people/${encodeURIComponent(vertex.personId)}`);
        }
      },
      onVertexHover: (vertex, rect) => {
        if (popoverHideTimer.current) {
          clearTimeout(popoverHideTimer.current);
          popoverHideTimer.current = null;
        }
        if (!vertex) {
          // Delay the hide so the user can move the cursor into the
          // popover without it dismissing.
          popoverHideTimer.current = setTimeout(() => setPopover(null), 180);
          return;
        }
        // Place the popover just to the right of the node bubble,
        // clamped within the canvas-wrap by max-width on the popover
        // itself.
        setPopover({
          vertex,
          x: rect.right + 8,
          y: rect.top + rect.height / 2 - 12,
        });
      },
    });
  }, [visibleGraph]);

  // Clean up any pending hide timer on unmount.
  useEffect(() => () => {
    if (popoverHideTimer.current) clearTimeout(popoverHideTimer.current);
  }, []);

  // Auto-run if the URL arrived with a documentId.
  useEffect(() => {
    if (initialDocumentId) run(initialDocumentId, initialDepth, initialFanoutCap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Banner for URLs that couldn't be reverse-looked up against the
  // index. Separate from `error` because a partial-resolve still
  // produces a usable graph — we just want to flag the misses.
  const [unresolvedUrls, setUnresolvedUrls] = useState([]);

  // Parse the input box into an array of seed tokens, splitting on
  // commas + whitespace + newlines so a pasted list (one per line)
  // and the legacy comma-separated form both work. Each token is then
  // classified as a URL (starts with `http://` or `https://`) or a
  // doc id. URLs survive their own commas — splitting only on `,`
  // would've broken any URL whose query string carried one — by
  // checking the protocol prefix per-token after the split.
  function parseSeedTokens(raw) {
    const tokens = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const ids = [];
    const urls = [];
    for (const t of tokens) {
      if (/^https?:\/\//i.test(t)) {
        urls.push(t);
      } else {
        ids.push(t);
      }
    }
    return { ids, urls };
  }

  async function run(rawInput, d, fan) {
    const { ids: literalIds, urls } = parseSeedTokens(rawInput);
    if (literalIds.length === 0 && urls.length === 0) {
      setError("Enter one or more document IDs or URLs (comma- or whitespace-separated)");
      setRawGraph(null);
      setUnresolvedUrls([]);
      return;
    }
    setLoading(true);
    setError(null);
    setRawGraph(null);
    setUnresolvedUrls([]);
    try {
      // URL reverse-lookup. The endpoint canonicalizes server-side, so
      // we can hand it the raw URL the user pasted — gmail forwarding,
      // utm parameters, encoded slashes all collapse to the same
      // matched doc set. Unresolved URLs are surfaced as a banner; the
      // walk still runs on whatever resolved + any literal ids the
      // user typed alongside.
      const resolved = [];
      const unresolved = [];
      if (urls.length > 0) {
        const { matches } = await lookupDocumentsByUrl(urls);
        for (const u of urls) {
          const docIds = matches?.[u] ?? [];
          if (docIds.length === 0) {
            unresolved.push(u);
          } else {
            for (const id of docIds) resolved.push(id);
          }
        }
        setUnresolvedUrls(unresolved);
      }
      // Combine literal ids + resolved-from-URLs, dedupe while
      // preserving the input order. A doc id appearing multiple times
      // (once typed, once resolved from its URL) would otherwise
      // confuse the seed walk and pad the rendered stats.
      const seen = new Set();
      const seedIds = [];
      for (const id of [...literalIds, ...resolved]) {
        if (seen.has(id)) continue;
        seen.add(id);
        seedIds.push(id);
      }
      if (seedIds.length === 0) {
        // Everything the user provided failed to resolve. The banner
        // already names every URL; the inline error explains why no
        // walk ran.
        setError("No documents matched any of the URLs you provided.");
        return;
      }
      const result = await getDocumentGraph(seedIds, d, fan);
      setRawGraph(result);
      // Mirror the resolved seed list + toggle state into the URL so
      // the page is shareable. URL tokens are normalised away — only
      // the doc ids the walk actually ran on round-trip.
      const qs = new URLSearchParams({ documentId: seedIds.join(","), depth: String(d) });
      if (fan !== DEFAULT_FANOUT_CAP) qs.set("fanoutCap", String(fan));
      if (!collapse) qs.set("collapse", "0");
      if (!showMentions) qs.set("mentions", "0");
      if (hideAttachmentPeople) qs.set("hideAttPeople", "1");
      replaceUrl(`${routePath}?${qs.toString()}`);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }

  const onSubmit = (e) => {
    e.preventDefault();
    run(docId, depth, fanoutCap);
  };

  // Hovered popover hover-bridge: enter cancels the hide, leave starts it.
  const onPopoverEnter = () => {
    if (popoverHideTimer.current) {
      clearTimeout(popoverHideTimer.current);
      popoverHideTimer.current = null;
    }
  };
  const onPopoverLeave = () => {
    popoverHideTimer.current = setTimeout(() => setPopover(null), 100);
  };

  // Re-mirror the URL whenever any client-side toggle changes
  // (without re-fetching). Uses the resolved seed ids the walk
  // actually ran on (from `rawGraph.stats.seeds`) rather than re-
  // parsing the input box — URL tokens have already collapsed into
  // doc ids by this point.
  useEffect(() => {
    if (!rawGraph) return;
    const seeds = Array.isArray(rawGraph.seeds) ? rawGraph.seeds : null;
    const ids = seeds && seeds.length > 0 ? seeds : parseSeedTokens(docId).ids;
    if (ids.length === 0) return;
    const qs = new URLSearchParams({ documentId: ids.join(","), depth: String(depth) });
    if (fanoutCap !== DEFAULT_FANOUT_CAP) qs.set("fanoutCap", String(fanoutCap));
    if (!collapse) qs.set("collapse", "0");
    if (!showMentions) qs.set("mentions", "0");
    if (hideAttachmentPeople) qs.set("hideAttPeople", "1");
    replaceUrl(`${routePath}?${qs.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapse, showMentions, hideAttachmentPeople]);

  return html`
    <div class="graph-debug-view">
      <header class="graph-debug-header">
        <h1>Graph debugger</h1>
        <p class="graph-debug-subtitle">
          Walk every inbound + outbound edge — document_links, near-duplicates, and
          document_people — around one document. Click a vertex to open it.
        </p>
      </header>

      <form class="graph-debug-controls" onSubmit=${onSubmit}>
        <label class="graph-debug-field graph-debug-field-id">
          <span class="graph-debug-field-label">Document IDs or URLs</span>
          <input
            type="text"
            class="graph-debug-input"
            placeholder="paste doc ids or source URLs — comma- or space-separated; URLs canonicalise to doc ids"
            value=${docId}
            onInput=${(e) => setDocId(e.target.value)}
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
          />
        </label>
        <label class="graph-debug-field graph-debug-field-depth">
          <span class="graph-debug-field-label">Depth (1–15)</span>
          <input
            type="number"
            class="graph-debug-input graph-debug-input-depth"
            min="1"
            max="15"
            value=${depth}
            onInput=${(e) => setDepth(clampDepth(e.target.value))}
          />
        </label>
        <label class="graph-debug-field graph-debug-field-depth">
          <span class="graph-debug-field-label">Fanout (1–500)</span>
          <input
            type="number"
            class="graph-debug-input graph-debug-input-depth"
            min="1"
            max="500"
            value=${fanoutCap}
            onInput=${(e) => setFanoutCap(clampFanout(e.target.value))}
          />
        </label>
        <button type="submit" class="graph-debug-run" disabled=${loading}>
          ${loading ? "Walking…" : "Walk graph"}
        </button>
      </form>

      <div class="graph-debug-toggles">
        <${ToggleRow}
          name="Collapse dupes"
          checked=${collapse}
          onChange=${setCollapse}
          desc="Merge duplicate-content and near-duplicate documents into a single node, so a file that arrived on several sources (or was forwarded around) shows up once instead of many times."
        />
        <${ToggleRow}
          name="Show mentions"
          checked=${showMentions}
          onChange=${setShowMentions}
          desc="Include people merely mentioned in the document body. Turn this off to keep only structural roles — senders, recipients, owners, authors, attendees, and participants."
        />
        <${ToggleRow}
          name="Hide att. people"
          checked=${hideAttachmentPeople}
          onChange=${setHideAttachmentPeople}
          desc="Hide person edges on attachment documents. An attachment inherits its people from the parent email or message, so these edges duplicate signal already shown on the parent."
        />
      </div>

      ${unresolvedUrls.length > 0
        ? html`
            <div class="graph-debug-warn" role="status">
              <strong>${
                `Couldn't resolve ${unresolvedUrls.length} URL${
                  unresolvedUrls.length === 1 ? "" : "s"
                } to any document in the index:`
              }</strong>
              <ul class="graph-debug-warn-list">
                ${unresolvedUrls.map(
                  (u) => html`<li><code>${u}</code></li>`,
                )}
              </ul>
              <span class="graph-debug-warn-hint">
                The URL may belong to an unindexed source, may have a canonicalizer mismatch, or may not actually live in your corpus yet.
              </span>
            </div>
          `
        : null}

      ${error ? html`<div class="graph-debug-error" role="alert">${error}</div>` : null}

      ${visibleGraph
        ? html`
            <div class="graph-debug-stats">
              <span><strong>${visibleGraph.vertices.length}</strong> vertices</span>
              <span><strong>${visibleGraph.edges.length}</strong> edges</span>
              <span>max depth <strong>${visibleGraph.stats.maxDepthReached}</strong></span>
              <span>${visibleGraph.stats.elapsedMs}ms</span>
              ${collapse && rawGraph && rawGraph.vertices.length !== visibleGraph.vertices.length
                ? html`<span class="graph-debug-stat-collapsed">
                    collapsed ${rawGraph.vertices.length - visibleGraph.vertices.length} duplicate vertices
                  </span>`
                : null}
              ${visibleGraph.truncated
                ? html`<span class="graph-debug-stat-warn">truncated — fanout cap hit</span>`
                : null}
            </div>
          `
        : null}

      <div class="graph-debug-body">
        <div class="graph-debug-canvas-wrap">
          <svg
            ref=${svgRef}
            class="graph-debug-canvas"
            xmlns="http://www.w3.org/2000/svg"
          ></svg>
          ${!visibleGraph && !loading && !error
            ? html`<div class="graph-debug-empty">Enter a document ID above and click <em>Walk graph</em>.</div>`
            : null}
          ${popover
            ? html`<${MergedPopover}
                popover=${popover}
                onEnter=${onPopoverEnter}
                onLeave=${onPopoverLeave}
              />`
            : null}
        </div>
      </div>
    </div>
  `;
}

// One stacked toggle row: a checkbox plus a name and a sentence
// explaining exactly what flipping it does.
function ToggleRow({ name, checked, onChange, desc }) {
  return html`
    <label class="graph-debug-toggle-row">
      <input
        type="checkbox"
        class="graph-debug-checkbox"
        checked=${checked}
        onChange=${(e) => onChange(e.target.checked)}
      />
      <span class="graph-debug-toggle-text">
        <span class="graph-debug-toggle-name">${name}</span>
        <span class="graph-debug-toggle-desc">${desc}</span>
      </span>
    </label>
  `;
}

function MergedPopover({ popover, onEnter, onLeave }) {
  const { vertex, x, y } = popover;
  const merged = vertex.mergedDocuments || [];
  return html`
    <div
      class="graph-debug-popover"
      style=${`left:${x}px;top:${y}px;`}
      role="tooltip"
      onMouseEnter=${onEnter}
      onMouseLeave=${onLeave}
    >
      <div class="graph-debug-popover-head">
        Merged from ${merged.length} duplicate ${merged.length === 1 ? "document" : "documents"}
      </div>
      <ul class="graph-debug-popover-list">
        ${merged.map(
          (m) => html`
            <li>
              <a
                class="graph-debug-popover-link"
                href=${`/portal/doc/${encodeURIComponent(m.documentId)}`}
                onClick=${(e) => {
                  e.preventDefault();
                  navigate(`/portal/doc/${encodeURIComponent(m.documentId)}`);
                }}
                title=${m.title || m.documentId}
              >
                ${m.title || m.documentId}
              </a>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

function clampDepth(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return Math.min(15, Math.max(1, n));
}

function clampFanout(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_FANOUT_CAP;
  return Math.min(500, Math.max(1, n));
}
