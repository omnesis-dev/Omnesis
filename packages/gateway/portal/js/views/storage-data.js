// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function storageBytes(value) {
  if (!Number.isFinite(value)) return "Not measured";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = Math.max(0, value), unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

export const GIB = 1024 ** 3;
export const DAY_MS = 86_400_000;
export const MAX_RETENTION_DAYS = 36_500;

/** Each measurement can finish or fail while another still has useful cached data. */
export function storageMeasurementStages(snapshot) {
  return ["logical", "index"].map((key) => {
    const value = snapshot[key];
    const accounting = snapshot.accounting;
    const status = accounting?.[key];
    return {
      key,
      label: key === "logical" ? "Document storage" : "Search-index storage",
      state: status?.state ?? (accounting?.error ? "failed" : accounting?.refreshing ? "refreshing" : value ? "ready" : "pending"),
      measuredAt: status?.measuredAt ?? value?.measuredAt ?? null,
      error: status?.error ?? (status ? null : accounting?.error) ?? null,
      hasData: !!value,
    };
  });
}

export function diskHeadroom(pressure) {
  const { volumes, policy } = pressure ?? {};
  if (pressure?.state === "unknown" || !volumes?.length ||
      !Number.isFinite(policy?.maxDiskUsedPercent) || !Number.isFinite(policy?.minFreeBytes)) return null;
  return Math.min(...volumes.map((disk) =>
    disk.availableBytes - Math.max(disk.totalBytes * (1 - policy.maxDiskUsedPercent / 100), policy.minFreeBytes)
  ));
}

/** Allocate measured shared FTS pages in proportion to indexed text bytes. */
export function storageSources(snapshot) {
  const sources = new Map();
  function source(id) {
    if (!sources.has(id)) sources.set(id, { sourceId: id, documentBytes: snapshot.logical ? 0 : null, months: new Map() });
    return sources.get(id);
  }
  function bucket(row, month) {
    if (!row.months.has(month)) row.months.set(month, { month, documentBytes: 0, vectorBytes: 0, textBytes: 0, trimmableDocuments: snapshot.logical ? 0 : undefined });
    return row.months.get(month);
  }
  for (const row of snapshot.logical?.sources ?? []) {
    const target = source(row.sourceId);
    target.documentBytes = row.payloadBytes;
    for (const month of row.months ?? []) {
      const cohort = bucket(target, month.month);
      cohort.documentBytes += month.payloadBytes;
      cohort.trimmableDocuments = Number.isFinite(month.trimmableDocuments) && cohort.trimmableDocuments !== undefined
        ? cohort.trimmableDocuments + month.trimmableDocuments : undefined;
    }
  }
  let indexedText = 0;
  for (const row of snapshot.index?.sources ?? []) {
    const month = bucket(source(row.sourceId), row.month);
    month.vectorBytes += row.embeddingBytes;
    month.textBytes += row.textBytes;
    indexedText += row.textBytes;
  }
  // Keep policy and job progress visible even after all measured documents are gone.
  for (const policy of snapshot.retention ?? []) source(policy.sourceId);
  for (const job of snapshot.trimJobs ?? []) source(job.sourceId);
  const allocation = snapshot.index?.lexicalBytes;
  const lexicalKnown = Number.isFinite(allocation) && allocation >= 0;
  const rows = [...sources.values()].map((row) => {
    let vector = 0, lexical = 0;
    const months = [...row.months.values()].map((month) => {
      const indexShare = lexicalKnown && indexedText ? allocation * month.textBytes / indexedText : 0;
      const lexicalBytes = month.textBytes + indexShare;
      vector += month.vectorBytes;
      lexical += lexicalBytes;
      return { month: month.month, bytes: month.documentBytes + month.vectorBytes + lexicalBytes,
        ...(month.trimmableDocuments === undefined ? {} : {trimmableDocuments: month.trimmableDocuments}) };
    });
    return {
      sourceId: row.sourceId,
      documentBytes: row.documentBytes,
      months,
      vectorBytes: snapshot.index ? vector : null,
      lexicalBytes: snapshot.index ? lexical : null,
      lexicalPartial: !!snapshot.index && !lexicalKnown,
      bytes: (row.documentBytes ?? 0) + vector + lexical,
    };
  });
  return rows.sort((a, b) => b.bytes - a.bytes || a.sourceId.localeCompare(b.sourceId));
}

export function bytesBeforeMonthCutoff(months, cutoff) {
  // A partial month has no day-level breakdown; this is an estimate only.
  return months.reduce((total, {month, bytes}) =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < cutoff.slice(0, 7) ? total + bytes : total, 0);
}

/** Union of outstanding trim intents and the moving rolling window. */
export function scheduledStorageCutoff(sourceId, retentionDays, jobs = [], now = Date.now()) {
  const cutoffs = jobs.filter((job) => job.sourceId === sourceId && ["queued", "running"].includes(job.state))
    .map((job) => Date.parse(job.before)).filter(Number.isFinite);
  if (Number.isInteger(retentionDays) && retentionDays > 0 && retentionDays <= MAX_RETENTION_DAYS)
    cutoffs.push(now - retentionDays * DAY_MS);
  let latest = null;
  for (const cutoff of cutoffs) latest = latest === null ? cutoff : Math.max(latest, cutoff);
  return latest === null ? null : new Date(latest).toISOString();
}

export function storageTrimStatus(job) {
  const count = Number.isFinite(job.deleted) ? job.deleted.toLocaleString() : "0";
  if (job.state === "completed") return `${job.cleanupPending ? "Documents trimmed" : "Trim completed"} · ${count} documents removed${job.cleanupPending ? " · Search cleanup continuing" : ""}`;
  if (job.state === "cancelled") return `Trim cancelled · ${count} documents removed`;
  if (job.state === "failed") return `Trim stopped · ${count} documents removed${job.error ? ` · ${job.error}` : ""}`;
  return `${job.state === "queued" ? "Trim queued" : "Trimming"} · ${count} documents removed`;
}

/** Keep outstanding work visible without turning a source row into a history log. */
export function visibleStorageTrimJobs(jobs) {
  const active = jobs.filter((job) => ["queued", "running"].includes(job.state));
  const terminal = jobs.filter((job) => !["queued", "running"].includes(job.state))
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0))[0];
  return terminal ? [...active, terminal] : active;
}

/** Compare independently measured files and source estimates without inventing a remainder. */
export function storageReconciliation(snapshot) {
  const known = (value) => Number.isFinite(value) && value >= 0;
  const stores = snapshot.physical?.stores ?? [];
  const logical = snapshot.logical;
  const index = snapshot.index;
  const documentsKnown = !!logical && Array.isArray(logical.sources)
    && logical.sources.every((source) => known(source.payloadBytes));
  const documentsComplete = documentsKnown;
  const indexKnown = !!index && Array.isArray(index.sources)
    && index.sources.every((source) => known(source.embeddingBytes) && known(source.textBytes));
  const textBytes = indexKnown ? index.sources.reduce((sum, source) => sum + source.textBytes, 0) : 0;
  const lexicalKnown = known(index?.lexicalBytes);
  const indexComplete = indexKnown && Array.isArray(index.tables) && lexicalKnown;
  const documentBytes = documentsKnown ? logical.sources.reduce((sum, source) => sum + source.payloadBytes, 0) : null;
  // With no indexed text, no source receives a share of the empty FTS structures.
  const indexBytes = indexKnown ? index.sources.reduce((sum, source) => sum + source.embeddingBytes + source.textBytes, lexicalKnown && textBytes > 0 ? index.lexicalBytes : 0) : null;
  const rows = stores.map((store) => {
    const attributed = store.id === "documents" || store.id === "index";
    const sourceBytes = store.id === "documents" ? documentBytes : store.id === "index" ? indexBytes : 0;
    const sourceComplete = store.id === "documents" ? documentsComplete : store.id === "index" ? indexComplete : true;
    const components = Array.isArray(store.components) && store.components.every((part) => known(part.bytes))
      && store.components.reduce((sum, part) => sum + part.bytes, 0) === store.bytes ? store.components : null;
    const exceedsFiles = sourceBytes !== null && sourceBytes > store.bytes;
    const state = !known(store.bytes) || !sourceComplete ? "unavailable"
      : exceedsFiles ? "updating" : "ready";
    return { ...store, components, attributed, sourceBytes, partial: !sourceComplete,
      remainderBytes: state === "ready" ? store.bytes - sourceBytes : null, state };
  });
  const physicalBytes = known(snapshot.physical?.totalBytes) ? snapshot.physical.totalBytes : null;
  const physicalMatches = physicalBytes !== null && rows.every((row) => known(row.bytes))
    && rows.reduce((sum, row) => sum + row.bytes, 0) === physicalBytes;
  const missingAttributedFiles = (documentBytes > 0 && !rows.some((row) => row.id === "documents"))
    || (indexBytes > 0 && !rows.some((row) => row.id === "index"));
  const complete = physicalMatches && documentsComplete && indexComplete && !missingAttributedFiles && rows.every((row) => row.state === "ready");
  return { rows, physicalBytes, sourceBytes: documentsComplete && indexComplete ? documentBytes + indexBytes : null,
    remainderBytes: complete ? physicalBytes - documentBytes - indexBytes : null,
    state: complete ? "ready" : missingAttributedFiles || rows.some((row) => row.state === "updating") ? "updating" : "unavailable" };
}
