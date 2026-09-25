// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Strict, bounded wire schemas for doctor reports. */

import { z } from "zod";
import type { DoctorCheck, DoctorReport } from "./types.js";

/** A report may describe many independently unhealthy sources, but is bounded on the wire. */
export const MAX_DOCTOR_CHECKS = 512;
export const MAX_DOCTOR_CHECK_ID_LENGTH = 256;
export const MAX_DOCTOR_SECTION_LENGTH = 128;
export const MAX_DOCTOR_MESSAGE_LENGTH = 1_024;
export const MAX_DOCTOR_HINT_LENGTH = 2_048;

/** Bounded, trimmed, single-line text for every remotely displayed doctor field. */
export const doctorTextSchema = (maxLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]*$/u, "must be safe single-line text");

const doctorCheckSchema: z.ZodType<DoctorCheck> = z
  .object({
    id: doctorTextSchema(MAX_DOCTOR_CHECK_ID_LENGTH),
    section: doctorTextSchema(MAX_DOCTOR_SECTION_LENGTH),
    status: z.enum(["pass", "warn", "fail", "not-applicable"]),
    message: doctorTextSchema(MAX_DOCTOR_MESSAGE_LENGTH),
    hint: doctorTextSchema(MAX_DOCTOR_HINT_LENGTH).optional(),
  })
  .strict();

export const doctorReportSchema: z.ZodType<DoctorReport> = z
  .object({
    ok: z.boolean(),
    summary: z
      .object({
        errors: z.number().int().nonnegative().max(MAX_DOCTOR_CHECKS),
        warnings: z.number().int().nonnegative().max(MAX_DOCTOR_CHECKS),
      })
      .strict(),
    checks: z.array(doctorCheckSchema).max(MAX_DOCTOR_CHECKS),
  })
  .strict()
  .superRefine((report, context) => {
    const errors = report.checks.filter((check) => check.status === "fail").length;
    const warnings = report.checks.filter((check) => check.status === "warn").length;
    if (report.summary.errors !== errors) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "errors"],
        message: "must equal the number of failed checks",
      });
    }
    if (report.summary.warnings !== warnings) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "warnings"],
        message: "must equal the number of warning checks",
      });
    }
    if (report.ok !== (errors === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ok"],
        message: "must be true exactly when the report has no failed checks",
      });
    }
  });
