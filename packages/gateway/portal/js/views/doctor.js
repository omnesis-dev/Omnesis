// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Doctor tab — the gateway's self-diagnosis, rendered from
// `GET /admin/doctor`. The payload is the same `{ ok, summary, checks }`
// report `omnesis doctor --json` prints: the gateway folds the check inputs
// from in-process state and runs the shared evaluator in
// `@omnesis/core/doctor`, so what shows here and what the CLI prints are the
// same computation.
//
// Deliberately load-on-demand rather than polled: the security section walks
// the whole config tree in a worker, which is cheap enough to ask for but not
// cheap enough to ask for every two seconds.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getDoctorReport } from "../api.js";

const STATUS_META = {
  pass: { glyph: "✓", label: "Pass", color: "var(--success)" },
  warn: { glyph: "!", label: "Warning", color: "var(--warning)" },
  fail: { glyph: "✕", label: "Failure", color: "var(--danger)" },
  "not-applicable": { glyph: "—", label: "N/A", color: "var(--text-muted)" },
};

export function statusMeta(status) {
  return STATUS_META[status] ?? { glyph: "?", label: status, color: "var(--text-secondary)" };
}

/** Group checks by section, preserving the order the evaluator emitted. */
export function groupBySection(checks) {
  const bySection = new Map();
  for (const check of checks) {
    if (!bySection.has(check.section)) bySection.set(check.section, []);
    bySection.get(check.section).push(check);
  }
  return Array.from(bySection.entries());
}

/** Worst status in a group — drives the section's summary pill. */
export function worstStatus(checks) {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "pass")) return "pass";
  return "not-applicable";
}

function CheckRow({ check }) {
  const meta = statusMeta(check.status);
  return html`
    <li class="doctor-check doctor-check-${check.status}">
      <span class="doctor-check-glyph" style=${`color:${meta.color}`} title=${meta.label}>
        ${meta.glyph}
      </span>
      <div class="doctor-check-body">
        <div class="doctor-check-message">${check.message}</div>
        ${check.hint && html`<div class="doctor-check-hint">${check.hint}</div>`}
      </div>
      <code class="doctor-check-id">${check.id}</code>
    </li>
  `;
}

function Section({ section, checks }) {
  const meta = statusMeta(worstStatus(checks));
  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const notApplicable = checks.filter((c) => c.status === "not-applicable").length;
  const applicable = checks.length - notApplicable;
  return html`
    <section class="debug-section">
      <h2 class="debug-section-title">
        <span style=${`color:${meta.color}`}>${meta.glyph}</span>
        ${" "}${section}
        <span class="doctor-section-count">
          ${failures > 0 ? `${failures} failing · ` : ""}
          ${warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"} · ` : ""}
          ${applicable} check${applicable === 1 ? "" : "s"}
          ${notApplicable > 0 ? ` · ${notApplicable} N/A` : ""}
        </span>
      </h2>
      <ul class="doctor-checks">
        ${checks.map((check) => html`<${CheckRow} key=${check.id} check=${check} />`)}
      </ul>
    </section>
  `;
}

/**
 * One-line summary of the whole report. Failures lead; warnings only get
 * their own phrasing when nothing failed, so a report never reads as
 * healthy while something is broken.
 */
export function verdictText({ ok, summary: { errors, warnings }, checks }) {
  const applicable = checks?.filter((check) => check.status !== "not-applicable").length;
  if (applicable === 0) return "No applicable checks";
  if (!ok) {
    return (
      `${errors} failing check${errors === 1 ? "" : "s"}` +
      (warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "")
    );
  }
  return warnings > 0
    ? `No failures, ${warnings} warning${warnings === 1 ? "" : "s"}`
    : "Everything looks healthy";
}

function Verdict({ report }) {
  const applicable = report.checks.filter((check) => check.status !== "not-applicable").length;
  const notApplicable = report.checks.length - applicable;
  const status =
    applicable === 0
      ? "not-applicable"
      : report.ok
        ? report.summary.warnings > 0
          ? "warn"
          : "pass"
        : "fail";
  const meta = statusMeta(status);
  const text = verdictText(report);
  return html`
    <div class="doctor-verdict" style=${`border-color:${meta.color}`}>
      <span class="doctor-verdict-glyph" style=${`color:${meta.color}`}>${meta.glyph}</span>
      <span class="doctor-verdict-text">${text}</span>
      <span class="doctor-verdict-count">
        ${applicable} check${applicable === 1 ? "" : "s"} run${notApplicable > 0
          ? ` · ${notApplicable} N/A`
          : ""}
      </span>
    </div>
  `;
}

/** Shared report renderer for the gateway Doctor tab and device cards. */
export function DoctorReportView({ report, compact = false }) {
  const sections = groupBySection(report.checks);
  return html`
    <div class=${compact ? "doctor-report doctor-report-compact" : "doctor-report"}>
      <${Verdict} report=${report} />
      ${sections.map(
        ([section, checks]) =>
          html`<${Section} key=${section} section=${section} checks=${checks} />`,
      )}
    </div>
  `;
}

export function DoctorTab() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await getDoctorReport();
      setReport(data);
      setError(null);
    } catch (err) {
      const message = err?.message ?? String(err);
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setError(`${message}${reqId}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return html`
    <div>
      <div class="debug-header">
        <div>
          <p class="debug-sub">
            The same report <code>omnesis doctor</code> prints, for${" "}
            <strong>this gateway and the host it runs on</strong>. Each
            collector audits its own host — filesystem, keyring, service
            units, provider stores — when asked: run its health check under${" "}
            <strong>Settings → Devices</strong>, or with${" "}
            <code>omnesis doctor --device ${"<name>"}</code>.
          </p>
        </div>
        <div class="debug-controls">
          <button class="debug-refresh" onClick=${load} disabled=${loading}>
            ${loading ? "Running…" : "Run again"}
          </button>
        </div>
      </div>
      ${error && html`<div class="debug-error">⚠️ ${error}</div>`}
      ${!report && loading && html`<div class="debug-loading">Running diagnostics…</div>`}
      ${report && html`
        ${error &&
        html`<div class="doctor-stale">
          Showing the last report that completed — the run above did not.
        </div>`}
        <${DoctorReportView} report=${report} />
        <div class="debug-footer">
          Permission problems are reported, never repaired from here — a fix
          would run as the gateway's own account. Repair them with${" "}
          <code>omnesis doctor --fix-permissions</code> on this host instead.
        </div>
      `}
    </div>
  `;
}
