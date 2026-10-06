// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { lazy } from "../lib/lazy.js";
import { getCognitionLoop } from "../api.js";
const LoopDetail = lazy(() => import("./cognition.js").then((module) => module.LoopDetail));
export const loopLibraryPath = (id) =>
  `/portal/debug/cognition/knowledge${id ? `/${encodeURIComponent(id)}` : ""}?kind=loop`;
export function loopDeadline(deadline) {
  if (!deadline) return null;
  const value =
    typeof deadline === "string" ? deadline : (deadline.date ?? deadline.at ?? deadline.end);
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
export function loopDeadlineLabel(deadline) {
  if (!deadline) return "Not set";
  const type = deadline.type ?? deadline.kind;
  if (type === "any_time") return "Any time";
  const date = loopDeadline(deadline);
  const prefix =
    type === "approximate" ? "Around " : type === "on_day" ? "On " : type === "by" ? "By " : "";
  return (
    [date ? `${prefix}${date}` : null, deadline.note].filter(Boolean).join(" · ") ||
    "See outcome details"
  );
}
export function loopLibraryNode(loop) {
  return {
    id: loop.id,
    kind: "loop",
    title: loop.title || "Untitled outcome",
    plainText: loop.description ?? "",
    updatedAt: loop.lastUpdate,
    canonicalFields: { state: loop.state, importance: loop.importance, deadline: loop.deadline },
    canonicalLoop: true,
  };
}
export function sortLibraryLoops(nodes, order) {
  return [...nodes].sort((a, b) => {
    if (order === "importance")
      return (b.canonicalFields?.importance ?? 0) - (a.canonicalFields?.importance ?? 0);
    if (order === "deadline")
      return (
        (loopDeadline(a.canonicalFields?.deadline)
          ? Date.parse(loopDeadline(a.canonicalFields.deadline))
          : Infinity) -
        (loopDeadline(b.canonicalFields?.deadline)
          ? Date.parse(loopDeadline(b.canonicalFields.deadline))
          : Infinity)
      );
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });
}
export function LoopContext({ id, refresh = 0, onReady, synthesisText = null }) {
  const [state, setState] = useState({ loading: true });
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    onReady?.(null);
    getCognitionLoop(id, { includeChildren: false })
      .then((data) => {
        if (alive) {
          setState({ data });
          onReady?.(id);
        }
      })
      .catch((error) => {
        if (alive) setState({ error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [id, refresh, onReady]);
  if (state.loading)
    return html`<section class="kn-loop-context" role="status">Loading outcome…</section>`;
  if (state.error)
    return html`<section class="kn-loop-context" role="alert">
      Outcome details could not be loaded. ${state.error}
    </section>`;
  const loop = state.data.loop;
  return html`<section class="kn-loop-context" aria-label="Tracked outcome">
    <div class="kn-loop-summary">
      <span class="kn-eyebrow">Tracked outcome</span>
      <h2>${loop.title || "Untitled outcome"}</h2>
    </div>
    <dl>
      <div>
        <dt>Status</dt>
        <dd>${loop.state}</dd>
      </div>
      <div>
        <dt>Deadline</dt>
        <dd>${loopDeadlineLabel(loop.deadline)}</dd>
      </div>
      <div>
        <dt>Importance</dt>
        <dd>
          ${typeof loop.importance === "number"
            ? `${Math.round(loop.importance * 100)}%`
            : "Not set"}
        </dd>
      </div>
    </dl>
    <details class="kn-loop-activity" onToggle=${(event) => setExpanded(event.currentTarget.open)}>
      <summary>Outcome details and activity</summary>
      <div class="debug-operations">
        ${expanded && html`<${LoopDetail} key=${`${id}:${refresh}`} id=${id} embedded synthesisText=${synthesisText} />`}
      </div>
    </details>
  </section>`;
}
