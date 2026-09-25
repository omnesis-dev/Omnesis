// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The info / warning / error icons shown beside a device on the Sources page,
 * and the popover that opens when they are clicked.
 *
 * The gateway writes every notice (`notices` on a sync status, one list per
 * member device) — this component only presents them. It never reads
 * `errorMessage`, `issues` or `coverage` itself.
 */

import { html } from "htm/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

const SEVERITIES = ["error", "warning", "info"];

const LABELS = {
  error: ["problem", "problems"],
  warning: ["warning", "warnings"],
  info: ["note", "notes"],
};

/** Room kept between the popover and the viewport edge, in px. */
const EDGE = 12;
const GAP = 6;

let nextPopoverId = 0;

/**
 * The notices that belong to one device of a source.
 *
 * A source several devices contribute to carries them per member, so a device
 * reads its own member entry and nothing else — a member the gateway does not
 * list has nothing to show yet. A source with no member breakdown carries them
 * on its own status, which belongs to the device that reported it; another
 * device shown on the row has none. With no device named — a chip that stands
 * for the whole source — every member's notices are shown, once each.
 */
export function noticesForDevice(syncStatus, deviceId) {
  if (!syncStatus) return [];
  const members = syncStatus.members;
  if (members?.length) {
    if (deviceId) return members.find((m) => m.deviceId === deviceId)?.notices ?? [];
    const seen = new Set();
    const out = [];
    for (const member of members) {
      for (const notice of member.notices ?? []) {
        const key = [notice.kind, notice.title, notice.detail ?? ""].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(notice);
      }
    }
    return out;
  }
  if (deviceId && syncStatus.deviceId && syncStatus.deviceId !== deviceId) return [];
  return syncStatus.notices ?? [];
}

/** One entry per severity present, most severe first, with its count. */
export function noticeGroups(notices) {
  return SEVERITIES.map((severity) => ({
    severity,
    count: notices.filter((n) => severityOf(n) === severity).length,
  })).filter((g) => g.count > 0);
}

/** A severity the page does not know is shown as a warning, never dropped. */
function severityOf(notice) {
  return SEVERITIES.includes(notice.severity) ? notice.severity : "warning";
}

/** What the icons say to a screen reader: every group, counted, and whose. */
export function noticesLabel(notices, deviceName) {
  const parts = noticeGroups(notices).map(({ severity, count }) => {
    const [one, many] = LABELS[severity];
    return `${count} ${count === 1 ? one : many}`;
  });
  const list =
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${list}${deviceName ? ` for ${deviceName}` : ""}`;
}

/**
 * Where the popover goes: below the icons when it fits, above when there is
 * more room there, never past the viewport, and no taller than the room it
 * has — a popover that overflows cannot be scrolled, since scrolling the page
 * closes it.
 */
export function popoverPlacement(rect, viewport) {
  const width = Math.min(380, viewport.width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(rect.left, viewport.width - width - EDGE));
  const below = viewport.height - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const up = below < 240 && above > below;
  return up
    ? { left, width, bottom: viewport.height - rect.top + GAP, maxHeight: Math.max(120, above) }
    : { left, width, top: rect.bottom + GAP, maxHeight: Math.max(120, below) };
}

function placementStyle(p) {
  const vertical = p.top !== undefined ? `top:${p.top}px` : `bottom:${p.bottom}px`;
  return `${vertical};left:${p.left}px;width:${p.width}px;max-height:${p.maxHeight}px`;
}

/**
 * The marks are holes in the shape (`evenodd`) rather than strokes painted in
 * a background colour, so they read correctly on any surface — a tinted row,
 * the popover, a hovered button, either theme.
 */
function NoticeGlyph({ severity }) {
  if (severity === "info") {
    return html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M8 1a7 7 0 1 0 0 14A7 7 0 1 0 8 1zm0 1.4a5.6 5.6 0 1 1 0 11.2A5.6 5.6 0 1 1 8 2.4zM7.3 7h1.4v4.4H7.3zM8 4a.9.9 0 1 0 0 1.8A.9.9 0 1 0 8 4z"
      />
    </svg>`;
  }
  if (severity === "error") {
    return html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M8 1a7 7 0 1 0 0 14A7 7 0 1 0 8 1zM7.25 3.8h1.5v5.4h-1.5zM8 10.45a.95.95 0 1 0 0 1.9a.95.95 0 1 0 0-1.9z"
      />
    </svg>`;
  }
  return html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M8 1.2 15.4 14.4H.6zM7.3 5.6h1.4v4.6H7.3zM8 11.1a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8z"
    />
  </svg>`;
}

function fmtSince(iso) {
  const ms = Date.parse(iso ?? "");
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The icons for one device, as one button, and the popover listing that
 * device's notices. Renders nothing when there are none.
 */
export function SourceNoticeIcons({ notices, deviceName }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState("");
  const [popoverId] = useState(() => `source-notices-${++nextPopoverId}`);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const count = notices?.length ?? 0;

  const close = (refocus) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // A refresh that leaves the device nothing to say closes the popover rather
  // than leaving it to reopen by itself when a notice comes back.
  useEffect(() => {
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  // Placed on every render while open, so a banner appearing above the table
  // or a longer list after a refresh moves the popover with its icons.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const next = placementStyle(
      popoverPlacement(triggerRef.current.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
    if (next !== style) setStyle(next);
  });

  useEffect(() => {
    if (!open) return undefined;
    popRef.current?.focus();
    const inside = (target) =>
      target instanceof Node &&
      (popRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointer = (e) => {
      if (!inside(e.target)) close(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(true);
    };
    // A resize targets the window, which is not a node; only a scroll inside
    // the popover itself keeps it open.
    const onScroll = (e) => {
      if (!(e.target instanceof Node && popRef.current?.contains(e.target))) close(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  if (count === 0) return null;
  const groups = noticeGroups(notices);
  const sorted = [...notices].sort(
    (a, b) => SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)),
  );
  const label = noticesLabel(notices, deviceName);

  return html`
    <span class="source-notice-icons">
      <button
        ref=${triggerRef}
        type="button"
        class="source-notice-trigger"
        title=${label}
        aria-label=${label}
        aria-haspopup="dialog"
        aria-expanded=${open}
        aria-controls=${open ? popoverId : undefined}
        onClick=${() => (open ? close(false) : setOpen(true))}
      >
        ${groups.map(
          (g) => html`
            <span class=${`source-notice-icon sev-${g.severity}`}>
              <${NoticeGlyph} severity=${g.severity} />
              ${g.count > 1 && html`<span class="source-notice-count">${g.count}</span>`}
            </span>
          `,
        )}
      </button>
      ${open &&
      html`
        <div
          ref=${popRef}
          id=${popoverId}
          class="source-notice-popover"
          role="dialog"
          aria-modal="false"
          aria-label=${deviceName ? `Notes for ${deviceName}` : "Notes"}
          tabindex="-1"
          style=${style}
        >
          ${deviceName && html`<div class="source-notice-popover-device">${deviceName}</div>`}
          ${sorted.map((n) => {
            const since = fmtSince(n.since);
            return html`
              <div class=${`source-notice-entry sev-${severityOf(n)}`}>
                <div class="source-notice-entry-head">
                  <span class=${`source-notice-entry-glyph sev-${severityOf(n)}`}>
                    <${NoticeGlyph} severity=${severityOf(n)} />
                  </span>
                  <span class="source-notice-entry-title">${n.title}</span>
                </div>
                ${n.detail && html`<p class="source-notice-entry-detail">${n.detail}</p>`}
                ${n.steps?.length > 0 &&
                html`<ol class="source-notice-entry-steps">
                  ${n.steps.map((step) => html`<li>${step}</li>`)}
                </ol>`}
                ${since && html`<div class="source-notice-entry-since">Since ${since}</div>`}
              </div>
            `;
          })}
        </div>
      `}
    </span>
  `;
}
