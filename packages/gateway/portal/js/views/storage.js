// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { applyStorageTrim, getStorage, previewStorageTrim, setStoragePolicy, setStorageRetention, refreshStorage } from "../api.js";
import { navigate } from "../lib/router.js";

export function storageBytes(value) {
  if (!Number.isFinite(value)) return "Not measured";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = Math.max(0, value), unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

function accountingAge(measuredAt) {
  if (!measuredAt || !Number.isFinite(Date.parse(measuredAt))) return "Not measured";
  return `${new Date(measuredAt).toLocaleString()}${Date.now() - Date.parse(measuredAt) > 10 * 60_000 ? " · Out of date" : ""}`;
}

const PRESSURE_REASONS = { quota: "Omnesis reached your storage limit.", "disk-used": "The gateway disk is nearly full.", "disk-reserve": "Available space is below the safety reserve.", measurement: "A current storage measurement could not be obtained. Refresh measurements to retry." };

const COLORS = ["#58a6ff", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#c084fc", "#94a3b8"];

function UsageChart({ entries, label }) {
  const total = entries.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
  let angle = 0;
  const stops = entries.filter((entry) => entry.bytes > 0).map((entry, index) => {
    const start = angle; angle += entry.bytes / total * 360;
    return `${COLORS[index % COLORS.length]} ${start}deg ${angle}deg`;
  });
  return html`<div class="storage-chart-layout">
    <div class="storage-donut" role="img" aria-label=${`${label}: ${storageBytes(total)}`} style=${`background: ${stops.length ? `conic-gradient(${stops.join(",")})` : "var(--bg-tertiary)"}`}><span>${storageBytes(total)}</span></div>
    <ul class="storage-legend">${entries.filter((entry) => entry.bytes > 0).map((entry, index) => html`<li key=${entry.id || entry.label}><span class="storage-swatch" style=${`background:${COLORS[index % COLORS.length]}`}></span><span>${entry.label}</span><strong>${storageBytes(entry.bytes)}</strong></li>`)}</ul>
  </div>`;
}

export function StorageView({ onChange } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [before, setBefore] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [retentionConfirmed, setRetentionConfirmed] = useState(false);
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [retry, setRetry] = useState(0);
  const previewGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    setError(null);
    getStorage().then((result) => {
      if (!active) return;
      setSnapshot(result);
      setLimit(result.policy?.maxBytes ? String(result.policy.maxBytes / 1024 ** 3) : "");
    }).catch((err) => { if (active) setError(err.serverMessage || err.message); });
    return () => { active = false; previewGeneration.current++; };
  }, [retry]);

  async function action(run) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { await run(); } catch (err) { setError(err.serverMessage || err.message); }
    finally { setBusy(false); }
  }
  function clearPreview() { previewGeneration.current++; setPreview(null); setConfirmed(false); }
  async function refreshMeasurements() {
    clearPreview();
    await action(async () => { setSnapshot(await refreshStorage()); await onChange?.(); });
  }
  async function savePolicy(event) {
    event.preventDefault();
    const bytes = limit.trim() ? Number(limit) * 1024 ** 3 : null;
    if (bytes !== null && (!Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(Math.round(bytes)))) {
      setError("Enter a positive storage limit, or leave it empty for automatic protection."); return;
    }
    await action(async () => {
      await setStoragePolicy({ maxBytes: bytes === null ? null : Math.round(bytes) });
      setMessage("Storage limit saved.");
      setSnapshot(await getStorage()); await onChange?.();
    });
  }
  async function prepareTrim(event) {
    event.preventDefault(); clearPreview();
    const timestamp = new Date(`${before}T00:00:00.000Z`);
    if (!sourceId || !before || !Number.isFinite(timestamp.getTime())) { setError("Choose a source and a valid cutoff date."); return; }
    const generation = previewGeneration.current;
    await action(async () => {
      const result = await previewStorageTrim(sourceId, timestamp.toISOString());
      if (generation === previewGeneration.current) setPreview(result);
    });
  }
  async function trim() {
    if (!preview || !confirmed) return;
    const token = preview.token;
    clearPreview();
    await action(async () => {
      const result = await applyStorageTrim(token);
      setMessage(`Trim completed. ${result.deleted} documents removed from Omnesis.${result.hasMore ? " More older documents remain; preview another batch to continue." : ""}${result.cleanupPending ? " Index cleanup is scheduled; storage measurements may still include the removed data." : ""}`);
      setSnapshot(await getStorage()); await onChange?.();
    });
  }

  async function saveRetention(event) {
    event.preventDefault();
    const days = retentionDays.trim() ? Number(retentionDays) : null;
    if (!sourceId || (days !== null && (!Number.isSafeInteger(days) || days <= 0))) { setError("Choose a source and a positive whole number of days, or leave empty to disable rolling retention."); return; }
    if (days !== null && !retentionConfirmed) { setError("Confirm automatic removal before saving rolling retention."); return; }
    await action(async () => {
      await setStorageRetention(sourceId, days);
      setRetentionConfirmed(false);
      clearPreview(); setMessage(days === null ? "Rolling retention disabled." : "Rolling retention saved. Eligible older data will be removed automatically.");
      setSnapshot(await getStorage()); await onChange?.();
    });
  }

  const pressure = snapshot?.pressure;
  const measuredSources = snapshot?.logical?.sources ?? [];
  const sources = [...measuredSources, ...(snapshot?.retention ?? []).filter((policy) => !measuredSources.some((source) => source.sourceId === policy.sourceId)).map((policy) => ({ sourceId: policy.sourceId, documents: 0, payloadBytes: 0, months: [] }))];
  const filesystems = pressure?.volumes ?? [];
  return html`<section class="storage-view" aria-labelledby="storage-heading">
    <header class="storage-header"><div><h2 id="storage-heading">Storage</h2><p>See what uses space and choose what Omnesis keeps.</p></div><button class="btn-secondary" disabled=${busy} onClick=${refreshMeasurements}>Refresh measurements</button></header>
    ${error && html`<p class="storage-alert" role="alert">${error} ${!snapshot && html`<button class="btn-secondary" onClick=${() => setRetry((n) => n + 1)}>Try again</button>`}</p>`}
    ${message && html`<p role="status">${message}</p>`}
    ${!snapshot && !error && html`<p role="status">Measuring storage…</p>`}
    ${snapshot && html`
      <div class=${`storage-health storage-health-${pressure?.state ?? "unknown"}`} role="status"><strong>${pressure?.state === "blocked" ? "Storage protection is active" : pressure?.state === "warning" ? "Storage is getting low" : pressure?.state === "normal" ? "Storage is healthy" : "Storage measurement is unavailable"}</strong><p>${pressure?.state === "blocked" ? "Space-growing work is paused. Free disk space or raise your Omnesis limit to resume. Trimming documents makes database pages reusable and may not clear a physical storage limit." : "Omnesis checks available space and protects the gateway when capacity is low."}</p>${pressure?.reasons?.map((reason) => html`<p key=${reason}>${PRESSURE_REASONS[reason] ?? reason}</p>`)}</div>
      ${filesystems.map((fs, index) => html`<article class="storage-panel" key=${index}><h3>Gateway disk ${filesystems.length > 1 ? index + 1 : ""}</h3><p>${storageBytes(fs.availableBytes)} available of ${storageBytes(fs.totalBytes)}</p><${UsageChart} label="Disk usage" entries=${[{ label: "Used on this disk", bytes: Math.max(0, fs.totalBytes - fs.availableBytes) }, { label: "Available", bytes: fs.availableBytes }]} /></article>`)}
      <div class="storage-columns"><article class="storage-panel"><h3>On disk</h3><p>Measured files, including database journals and indexes.</p>${snapshot.physical ? html`<${UsageChart} label="Omnesis files" entries=${snapshot.physical.stores ?? []} /><p class="storage-note">Measured ${snapshot.physical.measuredAt ? new Date(snapshot.physical.measuredAt).toLocaleString() : "at the last completed scan"}.</p>` : html`<p>File measurement is not available yet.</p>`}</article>
      <article class="storage-panel"><h3>Storage limit</h3><p>Pause space-growing work when Omnesis reaches this limit. Automatic disk protection also applies.</p><form onSubmit=${savePolicy}><label for="storage-limit">Maximum Omnesis storage (GiB)</label><input id="storage-limit" type="number" min="0.001" step="any" placeholder="Automatic" value=${limit} disabled=${busy} onInput=${(event) => setLimit(event.currentTarget.value)} /><p class="storage-note">Leave empty to use automatic protection based on available disk space.</p><button class="btn-primary" disabled=${busy}>Save limit</button></form></article></div>
      ${snapshot.index && html`<article class="storage-panel"><h3>Search indexes</h3><p>Lexical index allocation: <strong>${storageBytes(snapshot.index.lexicalBytes)}</strong>. Vector embedding payload: <strong>${storageBytes(snapshot.index.embeddingBytes)}</strong>.</p><p>Vector payload counts stored embedding values. The shared search graph, database overhead and journals remain part of the measured Search index files; these figures do not add to that physical total.</p><p class="storage-note">Index accounting: ${accountingAge(snapshot.index.measuredAt)}. Cached measurements can lag ingestion and deletion by up to 10 minutes. Refresh measurements for a current inventory.</p>${snapshot.index.sources?.length > 0 && html`<details><summary>Embedding payload by source and month</summary><div class="storage-table-wrap"><table class="portal-table"><thead><tr><th>Source</th><th>Month</th><th>Chunks</th><th>Embedding payload</th></tr></thead><tbody>${snapshot.index.sources.map((source) => html`<tr key=${`${source.sourceId}:${source.month}`}><td>${source.sourceId}</td><td>${source.month}</td><td>${source.chunkCount}</td><td>${storageBytes(source.embeddingBytes)}</td></tr>`)}</tbody></table></div></details>`}</article>`}
      <article class="storage-panel"><h3>By source and time</h3><p>Document payload estimates help compare sources and date ranges. They exclude shared indexes, analytics, database overhead, and free pages; they do not add up to the file sizes above.</p><p class="storage-note">Source accounting: ${accountingAge(snapshot.logical?.measuredAt)}. Cached measurements can lag changes by up to 10 minutes.</p>${measuredSources.length ? html`<div class="storage-table-wrap"><table class="portal-table"><thead><tr><th>Source</th><th>Documents</th><th>Document payload</th><th>Monthly history</th></tr></thead><tbody>${measuredSources.map((source) => html`<tr key=${source.sourceId}><td>${source.sourceId}</td><td>${source.documents.toLocaleString()}</td><td>${storageBytes(source.payloadBytes)}</td><td><details><summary>${source.months?.length ?? 0} ${source.months?.length === 1 ? "month" : "months"}</summary><ul>${source.months?.map((month) => html`<li key=${month.month}>${month.month}: ${storageBytes(month.payloadBytes)} · ${month.documents} documents</li>`)}</ul></details></td></tr>`)}</tbody></table></div>` : html`<p>${snapshot.logical ? "No source documents are stored." : "Source accounting is not available yet. Refresh measurements to retry."}</p>`}</article>
      ${snapshot.logical?.database?.tables?.length > 0 && html`<article class="storage-panel"><h3>Database allocation</h3><p>Allocated SQLite pages by table and index, where the database supports measurement.</p><div class="storage-table-wrap"><table class="portal-table"><thead><tr><th>Table or index</th><th>Allocated</th></tr></thead><tbody>${snapshot.logical.database.tables.map((table) => html`<tr key=${table.name}><td>${table.name}</td><td>${storageBytes(table.bytes)}</td></tr>`)}</tbody></table></div></article>`}
      <article class="storage-panel"><h3>Free disk space</h3><p>Removing unused downloaded models releases their files. Review models before removing one that an active capability needs.</p><p><a href="/portal/settings/models" onClick=${(event) => { event.preventDefault(); navigate("/portal/settings/models"); }}>Review downloaded models →</a></p><p>Retained backups also occupy real files. Review saved backup locations on the gateway before moving copies to another disk; keep a verified recovery copy.</p><p><a href="https://omnesis.dev/docs/updating#backup" target="_blank" rel="noopener noreferrer">Read the backup guide →</a></p><p class="storage-note">Deleting source documents frees reusable pages inside databases. Their files may keep the same size, so trimming alone may leave this gateway above its physical size limit. Full database compaction is not run automatically when space is low.</p></article>
      <article class="storage-panel"><h3>Trim stored history</h3><p>Preview a cutoff before removing data from Omnesis. Originals in your connected source are unaffected. Deleting documents makes database pages reusable; it does not guarantee a smaller database file immediately.</p><form onSubmit=${prepareTrim} class="storage-trim-form"><div><label for="storage-source">Source</label><select id="storage-source" value=${sourceId} disabled=${busy} onChange=${(event) => { const next = event.currentTarget.value; setSourceId(next); setRetentionDays(String(snapshot.retention?.find((policy) => policy.sourceId === next)?.maxAgeDays ?? "")); setRetentionConfirmed(false); clearPreview(); }}><option value="">Choose a source</option>${sources.map((source) => html`<option key=${source.sourceId} value=${source.sourceId}>${source.sourceId}</option>`)}</select></div><div><label for="storage-before">Remove documents dated before (UTC)</label><input id="storage-before" type="date" required value=${before} disabled=${busy} onInput=${(event) => { setBefore(event.currentTarget.value); clearPreview(); }} /></div><button class="btn-secondary" disabled=${busy || !sourceId || !before}>Preview trim</button></form>
      ${preview && html`<div class="storage-trim-preview"><h4>Review before deleting</h4><p>${preview.documents} documents · ${storageBytes(preview.payloadBytes)} of document payload in this batch.</p>${preview.hasMore && html`<p>More older documents remain. Each confirmation removes only this bounded batch; preview again to continue.</p>`}<p>Source: ${preview.sourceId ?? sourceId}. Before ${new Date(preview.before ?? `${before}T00:00:00Z`).toLocaleString()}.</p><label><input type="checkbox" checked=${confirmed} onChange=${(event) => setConfirmed(event.currentTarget.checked)} /> I understand this removes the previewed data from Omnesis.</label><button type="button" class="btn-primary danger" disabled=${busy || !confirmed || !preview.token || preview.documents === 0} onClick=${trim}>Delete previewed data</button><button type="button" class="btn-secondary" disabled=${busy} onClick=${clearPreview}>Cancel</button></div>`}
      <div class="storage-retention"><h3>Rolling retention</h3><p>Keep only a rolling window for the selected source. Saving a window authorizes automatic removal of older data from Omnesis, including data already stored. Leave empty to stop automatic trimming.</p><form onSubmit=${saveRetention}><label for="storage-retention-days">Days to keep</label><input id="storage-retention-days" type="number" min="1" step="1" value=${retentionDays} disabled=${busy} placeholder="Keep all dates" onInput=${(event) => { setRetentionDays(event.currentTarget.value); setRetentionConfirmed(false); }} />${retentionDays.trim() && html`<label><input id="storage-retention-confirm" type="checkbox" checked=${retentionConfirmed} disabled=${busy} onChange=${(event) => setRetentionConfirmed(event.currentTarget.checked)} /> Automatically remove data older than this window from Omnesis.</label>`}<button class="btn-secondary" disabled=${busy || !sourceId || (retentionDays.trim() !== "" && !retentionConfirmed)}>Save rolling retention</button></form></div>
      <p><a href="/portal/sources" onClick=${(event) => { event.preventDefault(); navigate("/portal/sources"); }}>Manage or remove connected sources →</a></p></article>
    `}
  </section>`;
}
