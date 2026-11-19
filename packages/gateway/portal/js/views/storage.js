// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getStorage, setStoragePolicy, refreshStorage } from "../api.js";
import { sourceIcon, sourceLabel } from "../lib/format.js";
import { RowActionMenu } from "../components/row-action-menu.js";
import { StorageHistory } from "./storage-history.js";
import { StorageRetentionDialog } from "./storage-retention-dialog.js";
import { GIB, storageBytes, storageSources, scheduledStorageCutoff, storageTrimStatus, visibleStorageTrimJobs } from "./storage-data.js";

const PRESSURE_REASONS = {
  quota: "Omnesis reached your storage limit.",
  "disk-used": "A gateway disk is nearly full.",
  "disk-reserve": "Available space is below the safety reserve.",
  measurement: "Storage measurement could not be completed. Retry below.",
};
const COLORS = ["#58a6ff", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#c084fc", "#94a3b8"];

function UsageChart({ entries, label }) {
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const active = hover ?? focus;
  const slices = entries.filter((item) => item.bytes > 0);
  const total = slices.reduce((sum, item) => sum + item.bytes, 0);
  let offset = 0;
  return html`<div class="storage-chart-layout">
    <svg class="storage-donut" viewBox="0 0 120 120" role="img" aria-label=${`${label}: ${storageBytes(total)}`} onPointerLeave=${() => setHover(null)}>
      <circle cx="60" cy="60" r="48" class="storage-donut-track" />
      ${slices.map((item, i) => {
        const share = item.bytes / total * 100;
        const start = offset;
        offset += share;
        return html`<circle key=${item.id ?? item.label} cx="60" cy="60" r="48" pathLength="100"
          stroke=${COLORS[i % COLORS.length]} stroke-dasharray=${`${share} 100`} stroke-dashoffset=${-start}
          transform="rotate(-90 60 60)" class=${active !== null && active !== i ? "storage-donut-muted" : ""}
          onPointerEnter=${() => setHover(i)}><title>${item.label}: ${storageBytes(item.bytes)}</title></circle>`;
      })}
      <text x="60" y="60" text-anchor="middle" dominant-baseline="middle">${storageBytes(slices[active]?.bytes ?? total)}</text>
    </svg>
    <ul class="storage-legend" onPointerLeave=${() => setHover(null)}>
      ${slices.map((item, i) => html`<li key=${item.id ?? item.label}><span tabindex="0" class=${active === i ? "storage-legend-active" : ""}
        onPointerEnter=${() => setHover(i)} onFocus=${() => setFocus(i)} onBlur=${() => setFocus(null)}>
        <span class="storage-swatch" style=${`background:${COLORS[i % COLORS.length]}`}></span><span>${item.label}</span><strong>${storageBytes(item.bytes)}</strong>
      </span></li>`)}
    </ul>
  </div>`;
}

function PressureNotice({ pressure }) {
  if (pressure?.state === "normal") return null;
  const blocked = pressure?.state === "blocked";
  return html`<div class="storage-health" role="status">
    <strong>${blocked ? "Storage protection is active" : pressure?.state === "warning" ? "Storage is getting low" : "Storage measurement is unavailable"}</strong>
    ${pressure?.reasons?.map((reason) => html`<p key=${reason}>${PRESSURE_REASONS[reason] ?? reason}</p>`)}
    ${blocked && html`<p>Sync and other work that uses more space are paused. Free disk space or raise your gateway limit to resume.</p>`}
  </div>`;
}

function SourceStorageRow({ row, retentionDays, jobs = [], now, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const { sourceId } = row;
  const label = sourceLabel(sourceId);
  const partial = row.lexicalPartial || [row.documentBytes, row.vectorBytes, row.lexicalBytes].some((value) => value === null);
  function toggle() {
    setExpanded(!expanded);
  }
  return html`
    <tr class="source-row-v2 storage-source-row" tabindex="0" aria-expanded=${expanded}
      aria-label=${`Storage history for ${sourceId}`}
      onClick=${(event) => { if (!event.target.closest(".row-action-menu")) toggle(); }}
      onKeyDown=${(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        toggle();
      }}>
      <td><span aria-hidden="true" class="storage-chevron"></span></td>
      <td><div class="source-cell-name-v2">
        <span class="source-icon-wrap">${sourceIcon(sourceId)}</span>
        <div class="source-cell-name-text"><span class="source-display-name">${label}</span>
          ${label !== sourceId && html`<span class="source-id-inline"><code>${sourceId}</code></span>`}
          ${retentionDays && html`<small class="storage-note">Keeps ${retentionDays.toLocaleString()} days</small>`}
          ${visibleStorageTrimJobs(jobs).map((job) => {
            const active = ["queued", "running"].includes(job.state) || (job.state === "completed" && job.cleanupPending);
            return html`<small key=${job.id} class=${`storage-trim-status${active ? " is-active" : ""}`} role="status">${active && html`<span class="spinner storage-trim-spinner" aria-hidden="true"></span>`}${storageTrimStatus(job)}</small>`;
          })}
        </div>
      </div></td>
      <td><strong>${partial && !row.bytes ? "Not measured" : storageBytes(row.bytes)}</strong>
        ${partial && row.bytes > 0 && html`<small class="storage-note"> partial</small>`}</td>
      <td>${storageBytes(row.documentBytes)}</td><td>${storageBytes(row.vectorBytes)}</td>
      <td>${storageBytes(row.lexicalBytes)}${row.lexicalPartial && html`<small class="storage-note"> text only</small>`}</td>
      <td><${RowActionMenu} label=${`Storage actions for ${sourceId}`} items=${[
        {label: "Trim", onSelect: () => onOpen("trim", row), danger: true},
        {label: "Set rolling retention", onSelect: () => onOpen("retention", row)},
      ]} /></td>
    </tr>
    ${expanded && html`<tr class="storage-expanded"><td colspan="7"><${StorageHistory} months=${row.months} now=${new Date(now)} scheduledCutoff=${scheduledStorageCutoff(sourceId, retentionDays, jobs, now)} /></td></tr>`}
  `;
}

export function StorageView({ onChange } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");
  const [message, setMessage] = useState(null);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState(null);
  const busyRef = useRef(false);
  const snapshotRevision = useRef(0);
  const [measuring, setMeasuring] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true, timer;
    let initialized = false;
    async function poll() {
      const revision = snapshotRevision.current;
      try {
        const result = await getStorage();
        if (!active) return;
        // A read begun before a saved action must not replace its newer result.
        if (revision !== snapshotRevision.current || busyRef.current) {
          timer = setTimeout(poll, 2500);
          return;
        }
        setSnapshot(result); setNow(Date.now()); setError(null);
        if (!initialized) {
          setLimit(result.policy?.maxBytes ? String(result.policy.maxBytes / GIB) : "");
          initialized = true;
        }
        const pending = result.trimJobs?.some((job) => job.cleanupPending || ["queued", "running"].includes(job.state));
        timer = setTimeout(poll, pending ? 2500 : 30_000);
      } catch (err) {
        if (!active) return;
        if (revision === snapshotRevision.current && !busyRef.current)
          setError(err.serverMessage || err.message);
        timer = setTimeout(poll, 30_000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [retry]);

  async function action(run, { preserveMessage = false } = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    snapshotRevision.current++;
    setBusy(true);
    setError(null);
    if (!preserveMessage) setMessage(null);
    try { await run(); } catch (err) { setError(err.serverMessage || err.message); }
    finally { snapshotRevision.current++; busyRef.current = false; setBusy(false); }
  }

  async function refreshMeasurements() {
    setMeasuring(true);
    try {
      setSnapshot(await refreshStorage());
    } finally {
      setMeasuring(false);
    }
  }

  async function savePolicy(event) {
    event.preventDefault();
    const bytes = limit.trim() ? Math.round(Number(limit) * GIB) : null;
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes <= 0)) {
      setError("Enter a positive storage limit, or clear the field to use disk protection.");
      return;
    }
    await action(async () => {
      await setStoragePolicy({ maxBytes: bytes });
      setMessage("Storage limit saved.");
      setSnapshot(await getStorage());
      await onChange?.();
    });
  }

  const pressure = snapshot?.pressure;
  const filesystems = pressure?.volumes ?? [];
  const rows = snapshot ? storageSources(snapshot) : [];
  const policies = new Map(snapshot?.retention?.map((policy) => [policy.sourceId, policy.maxAgeDays]));
  return html`<section class="storage-view" aria-labelledby="storage-heading">
    <header class="storage-header"><h2 id="storage-heading">Storage</h2></header>
    ${error && html`<p class="storage-alert" role="alert">${error} ${html`<button class="btn-secondary" disabled=${busy} onClick=${() => snapshot ? action(refreshMeasurements) : setRetry((n) => n + 1)}>Try again</button>`}</p>`}
    ${snapshot?.accounting?.error && !error && html`<p class="storage-alert" role="alert">Storage measurements could not be updated: ${snapshot.accounting.error}
      <button class="btn-secondary" disabled=${busy || measuring} onClick=${() => action(refreshMeasurements)}>Try again</button>
    </p>`}
    ${message && html`<div class="toast storage-toast" role="status">
      <span>${message}${measuring ? " Updating storage charts…" : ""}</span>
      <button type="button" class="btn-tiny" aria-label="Dismiss" onClick=${() => setMessage(null)}>×</button>
    </div>`}
    ${(measuring || snapshot?.accounting?.refreshing) && !message && html`<p role="status">Updating storage charts…</p>`}
    ${!snapshot && !error && html`<p role="status">Measuring storage…</p>`}
    ${snapshot && html`
      <form class="storage-limit-form" onSubmit=${savePolicy}>
        <label for="storage-limit">Omnesis storage limit (GiB)</label>
        <div class="storage-limit-controls"><input id="storage-limit" type="number" min="0.000000001" step="any" placeholder="No custom limit"
          value=${limit} disabled=${busy} onInput=${(event) => setLimit(event.currentTarget.value)} aria-describedby="storage-disk-rule" />
        <button class="btn-primary" disabled=${busy}>Save</button></div>
        <small class="storage-note" id="storage-disk-rule">
          ${limit.trim() ? "Sync pauses when Omnesis reaches this limit. " : "No custom limit. "}
          Disk protection is always on: sync pauses at ${pressure?.policy?.maxDiskUsedPercent ?? 95}% disk usage${pressure?.policy ? ` or below ${storageBytes(pressure.policy.minFreeBytes)} free` : ""}.

        </small>
      </form>
      <${PressureNotice} pressure=${pressure} />
      <div class="storage-columns">
        <section class="storage-panel">
          <h3>Gateway disk</h3>
          ${filesystems.length === 0 && html`<p>Disk capacity is unavailable.</p>`}
          ${filesystems.map((fs, i) => html`<div key=${fs.id ?? i}>
            <p>${filesystems.length > 1 ? `Disk ${i + 1} · ` : ""}${storageBytes(fs.availableBytes)} available of ${storageBytes(fs.totalBytes)}</p>
            <${UsageChart} label=${filesystems.length > 1 ? `Disk ${i + 1} usage` : "Disk usage"} entries=${[
              {label:"Used on this disk", bytes: Math.max(0, fs.totalBytes - fs.availableBytes)},
              {label:"Available", bytes: fs.availableBytes},
            ]} /></div>`)}
        </section>
        <section class="storage-panel"><h3>On disk</h3>
          ${snapshot.physical ? html`<${UsageChart} label="Omnesis files" entries=${snapshot.physical.stores ?? []} />` : html`<p>File measurement is unavailable.</p>`}
        </section>
      </div>
      <section class="storage-panel">
        <h3>By source and time</h3>
        <p class="storage-note">Totals estimate stored documents, vector payload, indexed text and each source’s share of the lexical index. Shared database space, graph files and analytics are excluded. Measurements can lag recent changes.</p>
        ${rows.length ? html`<div class="storage-table-wrap"><table class="portal-table storage-source-table">
          <thead><tr><th aria-label="History"></th><th scope="col">Source</th><th scope="col">Estimated total</th><th scope="col">Documents</th><th scope="col">Vectors</th><th scope="col">Lexical index</th><th aria-label="Actions"></th></tr></thead>
          <tbody>${rows.map((row) => html`<${SourceStorageRow} key=${row.sourceId} row=${row}
            retentionDays=${policies.get(row.sourceId)} jobs=${(snapshot.trimJobs ?? []).filter((job) => job.sourceId === row.sourceId && job.kind !== "rolling")} now=${now}
            onOpen=${(mode, source) => {
              if (busyRef.current) return;
              setMessage(null);
              setDialog({mode, source});
            }} />`)}</tbody>
        </table></div>` : html`<p>${snapshot.logical ? "No source documents are stored." : "Source accounting is not available yet."}</p>`}
      </section>
    `}
    ${dialog && html`<${StorageRetentionDialog} mode=${dialog.mode} source=${rows.find((row) => row.sourceId === dialog.source.sourceId) ?? dialog.source}
      retentionDays=${policies.get(dialog.source.sourceId)} onClose=${() => setDialog(null)}
      onSaved=${async (status, job) => {
        snapshotRevision.current++;
        setDialog(null);
        setMessage(status);
        if (job) setSnapshot((current) => ({ ...current, trimJobs: [job, ...(current.trimJobs ?? []).filter((entry) => entry.id !== job.id)] }));
        setRetry((n) => n + 1);
        await onChange?.();
      }} />`}
  </section>`;
}
