// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for routes mounted in `routes/notes.ts` — the
 * quick-capture "tell the brain" surface over the omnesis-notes ledger.
 */
import { z } from "zod";

import { MAX_TIME_ZONE_LENGTH, normalizeTimeZone } from "@omnesis/core";

// The ceiling is mirrored client-side by the portal's capture page
// (`portal/js/views/capture.js`, MAX_NOTE_LENGTH) and the mobile apps.
const noteText = z
  .string()
  .min(1)
  .max(8192)
  .refine((s) => s.trim().length > 0, "must not be blank");

const isoDateTime = z
  .string()
  .max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time");

const captureTimeZone = z
  .string()
  .min(1)
  .max(MAX_TIME_ZONE_LENGTH)
  .transform((value, ctx) => {
    const normalized = normalizeTimeZone(value);
    if (normalized) return normalized;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an IANA time zone" });
    return z.NEVER;
  });

/** Capture surface slug, e.g. "cli", "portal", "ios-app", "ios-siri". */
const surfaceSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug (a-z, 0-9, hyphens)");

// POST /notes
export const createNoteBody = z
  .object({
    /**
     * Client-supplied idempotency key. A retried capture (e.g. the
     * first attempt timed out after the gateway committed) re-sends
     * the same id and gets the stored entry back instead of creating
     * a duplicate.
     */
    id: z.string().uuid().optional(),
    text: noteText,
    capturedAt: isoDateTime.optional(),
    capturedTimeZoneId: captureTimeZone.optional(),
    capturedUtcOffsetSeconds: z.number().int().min(-64_800).max(64_800).optional(),
    surface: surfaceSlug.optional(),
    deviceId: z.string().max(128).optional(),
    /**
     * WGS-84 capture location. The device attaches it best-effort when
     * location permission is granted and a fix is available (photo
     * parity); every field is optional so a fix-less capture just omits
     * them. `latitude`/`longitude` travel as a pair — the refine below
     * rejects one without the other.
     */
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /**
     * Reverse-geocoded place name (device-side), e.g. "Paris". Newlines
     * and runs of whitespace are collapsed to single spaces: the place
     * name is folded into the day document's `## HH:MM · …` heading
     * (`render.ts`), which is the structural, deterministic part of the
     * projection — a stray newline would split the heading line.
     */
    placeName: z
      .string()
      .max(200)
      .transform((s) => s.replace(/\s+/g, " ").trim())
      .optional(),
  })
  .strict()
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  })
  .refine(
    (b) => (b.capturedTimeZoneId === undefined) === (b.capturedUtcOffsetSeconds === undefined),
    {
      message: "capturedTimeZoneId and capturedUtcOffsetSeconds must be provided together",
      path: ["capturedTimeZoneId"],
    },
  )
  // A place name is derived from the coordinate on-device, so it never
  // arrives on its own — reject a placeName with no fix.
  .refine((b) => b.placeName === undefined || b.placeName === "" || b.latitude !== undefined, {
    message: "placeName requires latitude and longitude",
    path: ["placeName"],
  });
export type CreateNoteBody = z.infer<typeof createNoteBody>;

// PATCH /notes/:id
export const patchNoteBody = z
  .object({
    text: noteText,
  })
  .strict();
export type PatchNoteBody = z.infer<typeof patchNoteBody>;
