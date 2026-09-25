// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Human-readable rendering for `omnesis doctor`. Mirrors the
 * `status-render` style: a small pure-ish function that takes the
 * evaluated report and writes color-coded, glyph-prefixed lines grouped
 * by section. The shared evaluator in `@omnesis/core/doctor` owns all
 * classification; this file only paints.
 */

import { c } from "../utils.js";
import type { DoctorReport, CheckStatus } from "@omnesis/core/doctor";

const GLYPH: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
  "not-applicable": "—",
};

function glyphColor(status: CheckStatus): string {
  if (status === "pass") return c.green;
  if (status === "warn") return c.yellow;
  if (status === "fail") return c.red;
  return c.dim;
}

export function renderDoctor(report: DoctorReport): void {
  const { errors, warnings } = report.summary;

  console.log();
  console.log(`${c.bold}Omnesis Doctor${c.reset}`);

  // Summary header line with counts.
  const errLabel =
    errors > 0
      ? `${c.red}${errors} error${errors === 1 ? "" : "s"}${c.reset}`
      : `${c.green}0 errors${c.reset}`;
  const warnLabel =
    warnings > 0
      ? `${c.yellow}${warnings} warning${warnings === 1 ? "" : "s"}${c.reset}`
      : `${c.dim}0 warnings${c.reset}`;
  console.log(`${errLabel}, ${warnLabel}`);
  console.log();

  // Group checks by section, preserving first-seen section order.
  const sections: string[] = [];
  const bySection = new Map<string, DoctorReport["checks"]>();
  for (const ch of report.checks) {
    if (!bySection.has(ch.section)) {
      bySection.set(ch.section, []);
      sections.push(ch.section);
    }
    bySection.get(ch.section)!.push(ch);
  }

  for (const section of sections) {
    console.log(`${c.bold}${section}${c.reset}`);
    for (const ch of bySection.get(section)!) {
      const g = `${glyphColor(ch.status)}${GLYPH[ch.status]}${c.reset}`;
      console.log(`  ${g} ${ch.message}`);
      if (ch.hint) {
        console.log(`    ${c.dim}↳ ${ch.hint}${c.reset}`);
      }
    }
    console.log();
  }

  // Closing verdict.
  if (report.ok) {
    console.log(`${c.green}All clear — no blocking problems detected.${c.reset}`);
  } else {
    console.log(
      `${c.red}${errors} blocking problem${errors === 1 ? "" : "s"} found — see the ✗ lines above.${c.reset}`,
    );
  }
  console.log();
}
