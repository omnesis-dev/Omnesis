// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { parseSourceKey } from "@omnesis/core";
import {
  c,
  isJSON,
  formatDateShort,
  gw,
  buildCliFx,
  iconFor,
  linkify,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";
import type { TrailEvent, TrailEventPerson, EventTrail } from "@omnesis/core";

const KIND_BADGE: Record<string, string> = {
  seed: `${c.cyan}[seed]${c.reset}`,
  duplicate: `${c.yellow}[dup]${c.reset}`,
  similar: `${c.magenta}[similar]${c.reset}`,
  document: "",
  record: `${c.green}[record]${c.reset}`,
};

const ROLE_LABELS: Record<string, string> = {
  sender: "from",
  author: "by",
  recipient: "to",
  attendee: "to",
  participant: "with",
  owner: "owner",
  contact: "contact",
  mentioned: "mentioned",
};

const DIRECTION_ARROWS: Record<string, string> = {
  out: "→",
  in: "←",
  peer: "↔",
};

function formatTrailDate(iso: string | null): string {
  if (!iso) return `${c.dim}no date${c.reset}`;
  const d = new Date(iso);
  const short = formatDateShort(iso);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${short} ${time}`;
}

function groupEventsByDate(events: TrailEvent[]): Map<string, TrailEvent[]> {
  const groups = new Map<string, TrailEvent[]>();
  for (const ev of events) {
    const key = ev.at
      ? new Date(ev.at).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "Unknown date";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }
  return groups;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Render the derived key fields of a record citation as indented lines. */
function renderRecordFields(record: NonNullable<TrailEvent["record"]>, pipe: string): void {
  for (const f of record.keyFields) {
    const value = f.value === null ? `${c.dim}—${c.reset}` : String(f.value);
    console.log(`${c.dim}${pipe}${c.reset}  ${c.dim}${f.label}:${c.reset} ${value}`);
  }
}

/**
 * Render a record-only trail event — a bound row reached from the seed
 * that binds no document, so it has no document header of its own. Source
 * icon/colour come from the source registry keyed by the record's `sourceId`,
 * never a per-source branch.
 */
function renderRecordOnly(
  ev: TrailEvent,
  fx: Awaited<ReturnType<typeof buildCliFx>>,
  connector: string,
  pipe: string,
  time: string,
): void {
  const record = ev.record!;
  const { sourceType } = parseSourceKey(record.sourceId);
  const srcIcon = iconFor(record.sourceId, fx);
  const srcIconStr = srcIcon ? `${srcIcon} ` : "";
  const badge = KIND_BADGE[ev.kind] ?? "";
  const badgeStr = badge ? ` ${badge}` : "";

  console.log(
    `${c.dim}${connector}─${c.reset} ${srcIconStr}${c.bold}${truncate(record.title, 72)}${c.reset}${badgeStr}`,
  );
  console.log(
    `${c.dim}${pipe}${c.reset}  ${time}  ${c.blue}${sourceType}${c.reset}  ${c.dim}${record.tableDisplayName}${c.reset}`,
  );
  renderRecordFields(record, pipe);
}

function renderEvent(
  ev: TrailEvent,
  fx: Awaited<ReturnType<typeof buildCliFx>>,
  isLast: boolean,
): void {
  const connector = isLast ? "└" : "├";
  const pipe = isLast ? " " : "│";
  const time = formatTrailDate(ev.at);

  // A record-only event (a bound row with no co-described document)
  // renders its derived record fields instead of a document header.
  if (!ev.doc) {
    renderRecordOnly(ev, fx, connector, pipe, time);
    if (!isLast) console.log(`${c.dim}${pipe}${c.reset}`);
    return;
  }

  const { sourceType } = parseSourceKey(ev.doc.sourceId);
  const srcIcon = iconFor(ev.doc.sourceId, fx);
  const srcIconStr = srcIcon ? `${srcIcon} ` : "";
  const badge = KIND_BADGE[ev.kind] ?? "";
  const badgeStr = badge ? ` ${badge}` : "";
  const shortId = ev.doc.documentId.slice(0, 8);
  const docType = ev.doc.documentType ? ` ${c.dim}${ev.doc.documentType}${c.reset}` : "";

  console.log(
    `${c.dim}${connector}─${c.reset} ${srcIconStr}${c.bold}${truncate(ev.doc.title, 72)}${c.reset}${badgeStr}`,
  );
  console.log(
    `${c.dim}${pipe}${c.reset}  ${time}  ${c.blue}${sourceType}${c.reset}${docType}  ${c.dim}${shortId}${c.reset}`,
  );

  // A document that deduped with its same-entity row carries the
  // record's derived key fields inline (one entity, not two).
  if (ev.record) renderRecordFields(ev.record, pipe);

  if (ev.people.length > 0) {
    const byRole = new Map<string, TrailEventPerson[]>();
    for (const p of ev.people) {
      if (!byRole.has(p.role)) byRole.set(p.role, []);
      byRole.get(p.role)!.push(p);
    }
    const parts: string[] = [];
    for (const [role, persons] of byRole) {
      const label = ROLE_LABELS[role] ?? role;
      const names = persons
        .map((p) => (p.isSelf ? `${c.green}${p.name}${c.reset}` : p.name))
        .join(", ");
      parts.push(`${c.dim}${label}:${c.reset} ${names}`);
    }
    console.log(`${c.dim}${pipe}${c.reset}  ${parts.join("  ")}`);
  }

  if (ev.doc.sourceUrl) {
    console.log(
      `${c.dim}${pipe}${c.reset}  ${c.dim}${linkify(ev.doc.sourceUrl, ev.doc.sourceUrl, fx)}${c.reset}`,
    );
  }

  if (ev.attachments.length > 0) {
    console.log(`${c.dim}${pipe}${c.reset}  ${c.dim}attachments:${c.reset}`);
    for (let i = 0; i < ev.attachments.length; i++) {
      const att = ev.attachments[i]!;
      // Only document events ever nest as attachments; a record event never
      // does. Skip defensively so the optional `doc` narrows.
      if (!att.doc) continue;
      const attIcon = iconFor(att.doc.sourceId, fx);
      const attIconStr = attIcon ? `${attIcon} ` : "";
      const last = i === ev.attachments.length - 1;
      const attConn = last ? "└" : "├";
      console.log(
        `${c.dim}${pipe}${c.reset}  ${c.dim}  ${attConn}─${c.reset} ${attIconStr}${truncate(att.doc.title, 60)}  ${c.dim}${att.doc.documentId.slice(0, 8)}${c.reset}`,
      );
    }
  }

  if (ev.related.length > 0) {
    console.log(`${c.dim}${pipe}${c.reset}  ${c.dim}related:${c.reset}`);
    for (let i = 0; i < ev.related.length; i++) {
      const rel = ev.related[i]!;
      const arrow = DIRECTION_ARROWS[rel.direction] ?? "↔";
      const last = i === ev.related.length - 1;
      const relConn = last ? "└" : "├";
      console.log(
        `${c.dim}${pipe}${c.reset}  ${c.dim}  ${relConn}─ ${arrow} ${c.reset}${truncate(rel.title, 55)}  ${c.dim}${rel.linkType}  ${rel.documentId.slice(0, 8)}${c.reset}`,
      );
    }
  }

  if (!isLast) {
    console.log(`${c.dim}${pipe}${c.reset}`);
  }
}

export const trailCommand = defineCommand({
  meta: {
    name: "trail",
    description: "Build a chronological event trail around one or more documents",
  },
  args: {
    id: {
      type: "positional",
      description: "seed document ID (or unambiguous prefix)",
      required: true,
    },
    seeds: {
      type: "string",
      description: "Additional seed IDs (comma-separated)",
    },
    depth: {
      type: "string",
      description: "Max BFS depth (1-10, default 4)",
    },
    "fanout-cap": {
      type: "string",
      description: "Per-vertex per-category fanout cap (1-100, default 25)",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const id = args.id;
    if (!id) {
      throw new CliError(
        `${c.red}Usage: omnesis trail <id> [--seeds id2,id3] [--depth N] [--fanout-cap N]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const params = new URLSearchParams();
    if (args.seeds) params.set("seeds", args.seeds);
    if (args.depth) {
      const n = parseInt(args.depth, 10);
      if (Number.isNaN(n) || n < 1 || n > 10) {
        throw new CliError(
          `${c.red}--depth must be an integer between 1 and 10${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      params.set("depth", String(n));
    }
    if (args["fanout-cap"]) {
      const n = parseInt(args["fanout-cap"], 10);
      if (Number.isNaN(n) || n < 1 || n > 100) {
        throw new CliError(
          `${c.red}--fanout-cap must be an integer between 1 and 100${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      params.set("fanoutCap", String(n));
    }

    const qs = params.toString();
    const url = `/documents/${encodeURIComponent(id)}/trail${qs ? `?${qs}` : ""}`;

    const res = await withSpinner(`Building event trail from ${id.slice(0, 8)}`, () => gw(url));
    const data = (await res.json()) as EventTrail | { error?: string; matches?: string[] };

    if (!res.ok) {
      const err = data as { error?: string; matches?: string[] };
      if (err.matches) {
        throw new CliError(
          `${c.red}Ambiguous ID prefix. Matches: ${err.matches.join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const code =
        res.status === 401 || res.status === 403
          ? EXIT_AUTH
          : res.status === 404
            ? EXIT_USER_ERROR
            : res.status >= 500
              ? EXIT_GATEWAY_ERROR
              : EXIT_FAILURE;
      throw new CliError(
        `${c.red}${String(err.error ?? `Request returned ${res.status}`)}${c.reset}`,
        code,
      );
    }

    const trail = data as EventTrail;

    if (isJSON) {
      console.log(JSON.stringify(trail, null, 2));
      return;
    }

    if (trail.events.length === 0) {
      console.log(`${c.dim}No events found for seed(s).${c.reset}`);
      return;
    }

    const fx = await buildCliFx();

    // Header
    const seedLabels = trail.seeds.map((s) => s.slice(0, 8)).join(", ");
    console.log(`\n${c.bold}Event Trail${c.reset}  ${c.dim}seeds: ${seedLabels}${c.reset}`);
    if (trail.truncated) {
      console.log(
        `${c.yellow}  (trail truncated — increase --depth or --fanout-cap for more)${c.reset}`,
      );
    }
    console.log();

    // Render events grouped by date
    const grouped = groupEventsByDate(trail.events);

    for (const [dateLabel, events] of grouped) {
      console.log(`${c.bold}${dateLabel}${c.reset}`);
      console.log();
      for (let i = 0; i < events.length; i++) {
        renderEvent(events[i]!, fx, i === events.length - 1);
      }
      console.log();
    }

    // Footer stats
    const parts: string[] = [
      `${trail.events.length} events`,
      `${trail.stats.visited} nodes visited`,
      `depth ${trail.stats.maxDepthReached}`,
      `${trail.stats.elapsedMs}ms`,
    ];
    console.log(`${c.dim}${parts.join("  ·  ")}${c.reset}`);
  },
});
