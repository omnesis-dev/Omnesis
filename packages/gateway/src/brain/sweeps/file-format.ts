// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The on-disk sweep file: a small front-matter block and a body of prose.
 *
 *     ---
 *     name: Commitments I made
 *     cadence: 7d
 *     at: "06:30"
 *     enabled: true
 *     ---
 *
 *     Look for promises the user made to someone else and has not yet
 *     discharged …
 *
 * Every front-matter key is optional. A file whose id matches a system sweep
 * layers over it, so `enabled: false` alone is a complete, meaningful file;
 * a file introducing a new id must supply a cadence and a body, because
 * nothing exists underneath to inherit them from.
 *
 * The parser is strict and hand-written rather than a YAML dependency: the
 * grammar is five scalar keys, and an unknown key is a typo the operator wants
 * reported rather than silently ignored. Every failure is returned, never
 * thrown — a malformed sweep must be loud on the surfaces that list sweeps,
 * not fatal to the gateway that loads them.
 */

import { z } from "zod";
import { assertNever, parseDuration } from "@omnesis/core";
import { parseClockTime } from "./anchor.js";

/** Ids are filename stems, so they are also a path-safety boundary. */
const SWEEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Cap on a steering prompt. Well above any sensible sweep; below a runaway paste. */
export const MAX_STEERING_PROMPT_CHARS = 8000;

/** Cap on a display name. */
const MAX_SWEEP_NAME_CHARS = 80;

/**
 * Shortest cadence a sweep may declare. A sweep has one boundary per local
 * day, so a day is the floor by construction — and a check that wants to fire
 * more often than daily is a watch, not a sweep.
 */
const MIN_CADENCE_HOURS = 24;

/** Longest cadence worth expressing. A sweep that runs less often than yearly never runs. */
const MAX_CADENCE_HOURS = 24 * 366;

/**
 * The one schema every sweep edit passes through — the HTTP body on the way
 * in, and the serializer on the way out. Sharing it is what stops a route from
 * accepting a value the file format cannot represent: a `name` carrying a
 * newline would otherwise be written straight into the front matter, where it
 * reads back as extra keys or as an early end of the block, so the file on
 * disk would mean something the caller never asked for.
 */
export const sweepFileContentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SWEEP_NAME_CHARS)
      .regex(/^[^\r\n]+$/, "name must be a single line")
      .optional(),
    cadenceHours: z.number().min(MIN_CADENCE_HOURS).max(MAX_CADENCE_HOURS).optional(),
    anchorMinutes: z.number().int().min(0).max(1439).optional(),
    enabled: z.boolean().optional(),
    temporalAnnotationPrimeDays: z.number().int().min(0).max(3650).optional(),
    steeringPrompt: z.string().max(MAX_STEERING_PROMPT_CHARS),
  })
  .strict();

/**
 * The grammar, as a closed set. Typed so the switch below is exhaustive: add a
 * key here and forget its `case` and the compiler says so, rather than the
 * value being silently dropped from every file that uses it.
 */
const KNOWN_KEYS = ["name", "cadence", "at", "enabled", "primeHorizonDays"] as const;
type SweepFileKey = (typeof KNOWN_KEYS)[number];
const KNOWN_KEY_SET: ReadonlySet<string> = new Set(KNOWN_KEYS);

/** A parsed file, before it is layered over a system sweep or stood up alone. */
export interface SweepFileContent {
  name?: string;
  cadenceHours?: number;
  anchorMinutes?: number;
  enabled?: boolean;
  temporalAnnotationPrimeDays?: number;
  /** The prose body, trimmed. Empty string when the file carries only front matter. */
  steeringPrompt: string;
}

export type SweepFileParse =
  | { ok: true; content: SweepFileContent }
  | { ok: false; message: string };

/** Whether an id is usable as both a sweep id and a filename stem. */
export function isValidSweepId(id: string): boolean {
  return SWEEP_ID_PATTERN.test(id);
}

export function parseSweepFile(text: string): SweepFileParse {
  const normalized = text.replace(/\r\n/g, "\n");
  let frontMatter = "";
  let body = normalized;

  if (normalized.startsWith("---\n") || normalized === "---") {
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) {
      return { ok: false, message: "front matter opened with `---` but never closed" };
    }
    frontMatter = normalized.slice(4, end);
    // Skip the closing fence and the rest of its line.
    const afterFence = normalized.indexOf("\n", end + 1);
    body = afterFence === -1 ? "" : normalized.slice(afterFence + 1);
  }

  const content: SweepFileContent = { steeringPrompt: body.trim() };

  if (content.steeringPrompt.length > MAX_STEERING_PROMPT_CHARS) {
    return {
      ok: false,
      message: `steering prose is ${content.steeringPrompt.length} characters; the limit is ${MAX_STEERING_PROMPT_CHARS}`,
    };
  }

  const seen = new Set<string>();
  for (const raw of frontMatter.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1)
      return { ok: false, message: `front-matter line is not \`key: value\`: ${line}` };
    const key = line.slice(0, sep).trim();
    const value = unquote(line.slice(sep + 1).trim());
    if (!KNOWN_KEY_SET.has(key)) {
      return {
        ok: false,
        message: `unknown front-matter key \`${key}\` (known: ${KNOWN_KEYS.join(", ")})`,
      };
    }
    if (seen.has(key)) return { ok: false, message: `front-matter key \`${key}\` appears twice` };
    seen.add(key);

    switch (key as SweepFileKey) {
      case "name": {
        if (value === "") return { ok: false, message: "`name` is empty" };
        if (value.length > MAX_SWEEP_NAME_CHARS) {
          return {
            ok: false,
            message: `\`name\` is longer than ${MAX_SWEEP_NAME_CHARS} characters`,
          };
        }
        content.name = value;
        break;
      }
      case "cadence": {
        // `parseDuration` throws on anything it cannot read; a bad cadence is
        // a reportable issue with one file, never an exception that takes the
        // whole sweep listing down.
        let ms: number;
        try {
          ms = parseDuration(value);
        } catch {
          return {
            ok: false,
            message: `\`cadence\` is not a duration (try 7d, 24h, 30d): ${value}`,
          };
        }
        const hours = ms / 3_600_000;
        if (hours < MIN_CADENCE_HOURS) {
          return {
            ok: false,
            message: `\`cadence\` must be at least ${MIN_CADENCE_HOURS}h (a day); a denser check belongs in a watch`,
          };
        }
        if (hours > MAX_CADENCE_HOURS) {
          return {
            ok: false,
            message: `\`cadence\` must be at most a year; anything longer never comes round`,
          };
        }
        content.cadenceHours = hours;
        break;
      }
      case "at": {
        const minutes = parseClockTime(value);
        if (minutes === null) {
          return { ok: false, message: `\`at\` is not a 24-hour local time like 06:30: ${value}` };
        }
        content.anchorMinutes = minutes;
        break;
      }
      case "enabled": {
        if (value !== "true" && value !== "false") {
          return { ok: false, message: `\`enabled\` must be true or false: ${value}` };
        }
        content.enabled = value === "true";
        break;
      }
      case "primeHorizonDays": {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 0) {
          return {
            ok: false,
            message: `\`primeHorizonDays\` must be a whole number of days: ${value}`,
          };
        }
        content.temporalAnnotationPrimeDays = days;
        break;
      }
      default:
        return assertNever(key as never);
    }
  }

  return { ok: true, content };
}

/**
 * Render a sweep file. Written by the portal editor, and by "fork this sweep",
 * so the file a person later opens in an editor looks like one a person wrote.
 *
 * Validates first: a value the front matter cannot represent must fail here,
 * loudly, rather than be written to disk and rejected on the next read — a
 * sweep that silently stops running is the failure mode this whole surface is
 * built to avoid.
 */
export function serializeSweepFile(input: SweepFileContent): string {
  const parsed = sweepFileContentSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Cannot write sweep file: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const content = parsed.data;
  const lines: string[] = ["---"];
  if (content.name !== undefined) lines.push(`name: ${content.name}`);
  if (content.cadenceHours !== undefined)
    lines.push(`cadence: ${renderCadence(content.cadenceHours)}`);
  if (content.anchorMinutes !== undefined) {
    const h = Math.floor(content.anchorMinutes / 60);
    const m = content.anchorMinutes % 60;
    lines.push(`at: "${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}"`);
  }
  if (content.enabled !== undefined) lines.push(`enabled: ${content.enabled}`);
  if (content.temporalAnnotationPrimeDays !== undefined) {
    lines.push(`primeHorizonDays: ${content.temporalAnnotationPrimeDays}`);
  }
  lines.push("---", "");
  if (content.steeringPrompt.trim() !== "") lines.push(content.steeringPrompt.trim(), "");
  return lines.join("\n");
}

/** Whole days / whole hours read better than a raw hour count in a hand-edited file. */
function renderCadence(hours: number): string {
  if (Number.isInteger(hours) && hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
