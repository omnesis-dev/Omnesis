// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  CliError,
  EXIT_AUTH,
  EXIT_GATEWAY_ERROR,
  EXIT_USER_ERROR,
  gw,
  isJSON,
  withSpinner,
} from "../utils.js";

interface NoteEntry {
  id: string;
  day: string;
  capturedAt: string;
  updatedAt: string;
  capturedTimeZoneId: string | null;
  capturedUtcOffsetSeconds: number | null;
  text: string;
  surface: string | null;
  deviceId: string | null;
}

interface NotesDayResponse {
  day: string;
  entries: NoteEntry[];
}

/**
 * Older gateways may not expose /notes (404), while current gateways require
 * a notes write scope (403 without one).
 * Translate those statuses into actionable messages instead of bare codes.
 */
function throwOnErrorStatus(status: number): never {
  if (status === 401) {
    throw new CliError(
      "Unauthorized — no valid token. Set OMNESIS_TOKEN or pair a device.",
      EXIT_AUTH,
    );
  }
  if (status === 403) {
    throw new CliError(
      "Forbidden — this token lacks a write scope for notes " +
        "(write:omnesis-notes or a broader write scope).",
      EXIT_AUTH,
    );
  }
  if (status === 404) {
    throw new CliError(
      "This gateway version does not support notes capture. Update the gateway and try again.",
      EXIT_GATEWAY_ERROR,
    );
  }
  throw new CliError(`Gateway returned ${status}`, EXIT_GATEWAY_ERROR);
}

/** Render the wall clock frozen at capture, even after the CLI host travels. */
export function formatNoteTime(
  iso: string,
  capturedUtcOffsetSeconds?: number | null,
  locales?: string | string[],
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (capturedUtcOffsetSeconds === undefined || capturedUtcOffsetSeconds === null) {
    return d.toLocaleTimeString(locales, { hour: "2-digit", minute: "2-digit" });
  }
  const frozenWallClock = new Date(d.getTime() + capturedUtcOffsetSeconds * 1_000);
  return frozenWallClock.toLocaleTimeString(locales, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Calendar day at the CLI's observed offset, independent of the gateway host. */
export function noteLocalDay(
  at: Date = new Date(),
  utcOffsetSeconds: number = -at.getTimezoneOffset() * 60,
): string {
  const local = new Date(at.getTime() + utcOffsetSeconds * 1_000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Always address an explicit day so a remote gateway cannot choose its own local date. */
export function notesDayPath(
  day: string | undefined,
  now: Date = new Date(),
  utcOffsetSeconds: number = -now.getTimezoneOffset() * 60,
): string {
  return `/notes?day=${day ?? noteLocalDay(now, utcOffsetSeconds)}`;
}

export const noteCommand = defineCommand({
  meta: {
    name: "note",
    description: "Capture a quick note addressed to your Omnesis brain",
  },
  args: {
    text: {
      type: "positional",
      description: "the note text (omit with --list to show a day's notes)",
      required: false,
    },
    list: {
      type: "boolean",
      alias: "l",
      description: "List captured notes instead of creating one",
    },
    day: {
      type: "string",
      description: "Day to list (YYYY-MM-DD, defaults to today; implies --list)",
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const listing = args.list === true || typeof args.day === "string";

    if (listing) {
      if (text) {
        throw new CliError("Pass either note text or --list/--day, not both.", EXIT_USER_ERROR);
      }
      await listNotes(typeof args.day === "string" ? args.day : undefined);
      return;
    }

    if (!text) {
      throw new CliError(
        `Nothing to capture. Usage: ${c.bold}omnesis note "remind me to renew the domain"${c.reset} (or --list).`,
        EXIT_USER_ERROR,
      );
    }

    const capturedAt = new Date();
    const capturedTimeZoneId = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const capturedUtcOffsetSeconds = -capturedAt.getTimezoneOffset() * 60;
    const res = await withSpinner("Capturing note", () =>
      gw("/notes", {
        method: "POST",
        body: JSON.stringify({
          text,
          surface: "cli",
          capturedAt: capturedAt.toISOString(),
          capturedTimeZoneId,
          capturedUtcOffsetSeconds,
        }),
      }),
    );
    if (!res.ok) throwOnErrorStatus(res.status);
    const entry = (await res.json()) as NoteEntry;

    if (isJSON || args.json) {
      console.log(JSON.stringify(entry, null, 2));
      return;
    }
    console.log(
      `\n${c.green}Noted.${c.reset} ${c.dim}${entry.day} ${formatNoteTime(entry.capturedAt, entry.capturedUtcOffsetSeconds)} · id ${entry.id}${c.reset}\n`,
    );
  },
});

async function listNotes(day: string | undefined): Promise<void> {
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new CliError(`Invalid --day '${day}' — expected YYYY-MM-DD.`, EXIT_USER_ERROR);
  }
  const res = await withSpinner("Loading notes", () => gw(notesDayPath(day)));
  if (!res.ok) throwOnErrorStatus(res.status);
  const data = (await res.json()) as NotesDayResponse;

  if (isJSON) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.entries.length === 0) {
    console.log(`\n${c.dim}No notes captured on ${data.day}.${c.reset}\n`);
    return;
  }
  console.log(`\n${c.bold}Notes — ${data.day}${c.reset}\n`);
  for (const entry of data.entries) {
    const surface = entry.surface ? ` ${c.dim}· ${entry.surface}${c.reset}` : "";
    console.log(
      `  ${c.dim}${formatNoteTime(entry.capturedAt, entry.capturedUtcOffsetSeconds)}${c.reset}${surface}`,
    );
    console.log(`  ${entry.text.replace(/\n/g, "\n  ")}`);
    console.log();
  }
}
