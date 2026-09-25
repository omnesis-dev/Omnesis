// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Document body renderer. Takes a SummaryActivity and an optional
 * DetailedActivity overlay (description, splits, best efforts, etc.).
 * Detail-tier ingestion calls this with both arguments so the searchable
 * markdown reflects everything we know.
 *
 * Comments and gear-name are passed in separately because they come from
 * different endpoints than DetailedActivity itself.
 */

import type { StravaSummaryActivity, StravaDetailedActivity, StravaComment } from "./types.js";

export interface MarkdownContext {
  /** Resolved gear display name (e.g. "Felt FR3") if known. */
  gearName?: string;
  /** Comments on the activity (already fetched). */
  comments?: StravaComment[];
  /** Names of kudoers (already fetched). */
  kudoers?: Array<{ firstname?: string; lastname?: string }>;
}

/** Markdown body for an activity document. */
export function renderActivityMarkdown(
  a: StravaSummaryActivity,
  detail?: StravaDetailedActivity,
  ctx: MarkdownContext = {},
): string {
  const lines: string[] = [];
  const sport = a.sport_type || a.type || "Activity";

  lines.push(`**Sport:** ${sport}`);
  lines.push(`**Distance:** ${formatDistance(a.distance)} (${formatDistanceMiles(a.distance)})`);
  lines.push(
    `**Moving time:** ${formatDuration(a.moving_time)}  •  **Elapsed:** ${formatDuration(a.elapsed_time)}`,
  );

  const pace = formatPace(a, sport);
  if (pace) lines.push(`**Pace:** ${pace}`);

  if (a.total_elevation_gain && a.total_elevation_gain > 0) {
    lines.push(`**Elevation gain:** ${Math.round(a.total_elevation_gain)} m`);
  }

  if (a.average_heartrate) {
    const max = a.max_heartrate ? ` (max ${Math.round(a.max_heartrate)})` : "";
    lines.push(`**Heart rate:** ${Math.round(a.average_heartrate)} bpm${max}`);
  }

  if (a.average_watts) {
    const max = a.max_watts ? ` (max ${Math.round(a.max_watts)})` : "";
    const norm = a.weighted_average_watts ? ` · NP ${Math.round(a.weighted_average_watts)}` : "";
    lines.push(`**Power:** ${Math.round(a.average_watts)} W${max}${norm}`);
  }

  if (a.average_cadence) {
    lines.push(`**Cadence:** ${Math.round(a.average_cadence)}`);
  }

  if (detail?.calories) {
    lines.push(`**Calories:** ${Math.round(detail.calories)}`);
  }

  if (detail?.perceived_exertion !== undefined && detail?.perceived_exertion !== null) {
    lines.push(`**Perceived exertion:** ${detail.perceived_exertion}/10`);
  }

  if (ctx.gearName) {
    lines.push(`**Gear:** ${ctx.gearName}`);
  } else if (a.gear_id) {
    lines.push(`**Gear ID:** ${a.gear_id}`);
  }

  if (detail?.device_name) {
    lines.push(`**Device:** ${detail.device_name}`);
  }

  const location = [a.location_city, a.location_state, a.location_country]
    .filter(Boolean)
    .join(", ");
  if (location) lines.push(`**Location:** ${location}`);

  lines.push(`**Started:** ${formatStartedAt(a)}`);

  const flags: string[] = [];
  if (a.trainer) flags.push("indoor trainer");
  if (a.commute) flags.push("commute");
  if (a.manual) flags.push("manually logged");
  if (a.private) flags.push("private");
  if (a.flagged) flags.push("flagged");
  if (flags.length) lines.push(`**Flags:** ${flags.join(", ")}`);

  // ── Description (DetailedActivity) ─────────────────────────────
  const description = detail?.description?.trim();
  if (description) {
    lines.push("");
    for (const para of description.split(/\n+/)) {
      lines.push(`> ${para}`);
    }
  }

  // ── Best efforts ───────────────────────────────────────────────
  if (detail?.best_efforts && detail.best_efforts.length > 0) {
    lines.push("");
    lines.push("**Top results:**");
    for (const be of detail.best_efforts) {
      const time = formatDuration(be.elapsed_time);
      const pr = be.pr_rank === 1 ? " (PR)" : be.pr_rank ? ` (#${be.pr_rank})` : "";
      lines.push(`- ${be.name}: ${time}${pr}`);
    }
  }

  // ── Photo caption ──────────────────────────────────────────────
  const caption = detail?.photos?.primary?.caption?.trim();
  if (caption) {
    lines.push("");
    lines.push(`_Photo:_ ${caption}`);
  }

  // ── Comments ───────────────────────────────────────────────────
  if (ctx.comments && ctx.comments.length > 0) {
    lines.push("");
    lines.push(`**Comments (${ctx.comments.length}):**`);
    for (const c of ctx.comments) {
      const who =
        [c.athlete?.firstname, c.athlete?.lastname].filter(Boolean).join(" ") || "Anonymous";
      lines.push(`> **${who}:** ${c.text}`);
    }
  }

  // ── Social roundup ─────────────────────────────────────────────
  const social: string[] = [];
  if (a.kudos_count) social.push(`${a.kudos_count} kudos`);
  if (a.comment_count) social.push(`${a.comment_count} comment${a.comment_count === 1 ? "" : "s"}`);
  if (a.athlete_count && a.athlete_count > 1) social.push(`${a.athlete_count} athletes`);
  if (a.pr_count) social.push(`${a.pr_count} PR${a.pr_count === 1 ? "" : "s"}`);
  if (a.achievement_count)
    social.push(`${a.achievement_count} achievement${a.achievement_count === 1 ? "" : "s"}`);
  if (social.length) {
    lines.push("");
    lines.push(`_${social.join(" · ")}_`);
  }

  // ── Kudoer names (low-volume only) ─────────────────────────────
  if (ctx.kudoers && ctx.kudoers.length > 0 && ctx.kudoers.length <= 5) {
    const names = ctx.kudoers
      .map((k) => [k.firstname, k.lastname].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", ");
    if (names) lines.push(`_Kudos from: ${names}_`);
  }

  return lines.join("\n");
}

// ── Formatters ─────────────────────────────────────────────────────

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatDistanceMiles(meters: number): string {
  const miles = meters / 1609.344;
  return `${miles.toFixed(2)} mi`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const FOOT_SPORTS = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);

function formatPace(a: StravaSummaryActivity, sport: string): string | null {
  if (!a.distance || !a.moving_time) return null;
  if (FOOT_SPORTS.has(sport)) {
    // min:sec per km
    const secPerKm = a.moving_time / (a.distance / 1000);
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s} /km`;
  }
  // km/h for everything else (Ride, Swim, etc.)
  const kmh = a.distance / 1000 / (a.moving_time / 3600);
  return `${kmh.toFixed(1)} km/h`;
}

function formatStartedAt(a: StravaSummaryActivity): string {
  const isoLocal = a.start_date_local ?? a.start_date;
  return isoLocal.replace("T", " ").replace(/Z$/, "");
}
