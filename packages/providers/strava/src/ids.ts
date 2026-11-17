// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Safe IDs keep their installed representation; larger IDs travel as decimal strings. */
export type StravaId = number | string;

/** Normalize API, persisted JSON and DuckDB IDs without rounding them. */
export function stravaId(value: unknown): StravaId {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return value;
  } else if (typeof value === "string" || typeof value === "bigint") {
    const text = String(value);
    if (/^[1-9][0-9]*$/.test(text)) {
      const number = Number(text);
      return Number.isSafeInteger(number) ? number : text;
    }
  }
  throw new Error("Invalid or imprecise Strava ID");
}

/**
 * Prefer Strava's id_str, including on nested athlete/activity objects. Numeric
 * references without an id_str retain their original JSON integer token using
 * Node's reviver context, before an unsafe Number can escape the boundary.
 */
export function parseStravaJson<T>(text: string): T {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      if (object.id_str !== undefined) object.id = stravaId(object.id_str);
    }
    if (
      (key === "id" || key.endsWith("_id")) &&
      typeof value === "number" &&
      !Number.isSafeInteger(value)
    ) {
      return stravaId(context?.source);
    }
    return value;
  }) as T;
}
