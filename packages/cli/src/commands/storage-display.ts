// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { formatSize } from "../utils.js";
import {
  historyJob,
  pendingStorageJob,
  type StorageJob,
  type StorageSnapshot,
} from "./storage-wire.js";

const bytes = (value: number | null | undefined) => (value == null ? "pending" : formatSize(value));
export function storageJobLine(job: StorageJob): string {
  const status =
    job.state === "failed" && pendingStorageJob(job)
      ? "retrying pending removal"
      : !historyJob(job) && job.cleanupPending
        ? "search cleanup pending"
        : historyJob(job) && job.cancelRequested && pendingStorageJob(job)
          ? "stopping after committed removal"
          : job.state;
  const progress = historyJob(job)
    ? `${job.removed} removed, ${job.scanned} scanned, ${job.protected} protected (${bytes(job.removedBytesEstimate)} estimated file data removed)`
    : `${job.deleted} deleted, ${job.examinedDocuments} examined, ${job.skippedDocuments} skipped`;
  return `${job.id}  ${historyJob(job) ? job.target : job.sourceId}  ${status}  before ${job.before}  ${progress}${job.error ? `  ${job.error}` : ""}`;
}

export function renderStorage(
  snapshot: StorageSnapshot,
  options: { source?: string; history?: boolean } = {},
): string {
  const lines = [
    `Storage pressure: ${snapshot.pressure.state}${snapshot.pressure.reasons.length ? ` (${snapshot.pressure.reasons.join(", ")})` : ""}`,
    `Gateway on disk: ${bytes(snapshot.physical?.totalBytes)}`,
    `Storage limit: ${snapshot.policy.maxBytes === null ? "no custom limit" : bytes(snapshot.policy.maxBytes)}; growth pauses at ${snapshot.policy.maxDiskUsedPercent}% disk used or below ${bytes(snapshot.policy.minFreeBytes)} free`,
  ];
  for (const volume of snapshot.pressure.volumes)
    lines.push(
      `Disk ${volume.id}: ${bytes(volume.availableBytes)} available of ${bytes(volume.totalBytes)}`,
    );
  lines.push("", `On-disk files (${snapshot.physical?.measuredAt ?? "measurement pending"}):`);
  for (const store of snapshot.physical?.stores ?? []) {
    lines.push(`  ${store.label}: ${bytes(store.bytes)}`);
    for (const part of store.components ?? [])
      lines.push(`    ${part.label}: ${bytes(part.bytes)}`);
  }
  lines.push(
    "",
    `Documents: ${snapshot.logical?.measuredAt ?? "measurement pending"}; index: ${snapshot.index?.measuredAt ?? "measurement pending"}`,
  );
  if (snapshot.accounting) {
    if (snapshot.accounting.error) lines.push(`Measurement error: ${snapshot.accounting.error}`);
    for (const key of ["logical", "index", "allocations"] as const) {
      const stage = snapshot.accounting[key];
      if (!stage) continue;
      lines.push(
        `  ${key}: ${stage.state}; last measurement ${stage.measuredAt ?? "not available"}${stage.error ? `; ${stage.error}` : ""}`,
      );
      if (key === "allocations") {
        const progress = snapshot.accounting.allocations?.progress;
        if (progress)
          lines.push(
            `    ${progress.store}: ${progress.scannedPages} pages scanned; ${progress.completedTables} tables completed`,
          );
      }
    }
  }
  const logical = new Map(snapshot.logical?.sources.map((item) => [item.sourceId, item]));
  const index = snapshot.index?.sources ?? [];
  const indexRows = new Map<string, typeof index>();
  for (const row of index) {
    const rows = indexRows.get(row.sourceId) ?? [];
    rows.push(row);
    indexRows.set(row.sourceId, rows);
  }
  lines.push(
    `Shared lexical-index structures: ${bytes(snapshot.index?.lexicalBytes)} (separate from indexed text below)`,
  );
  const ids = new Set([...logical.keys(), ...indexRows.keys()]);
  if (options.source) ids.add(options.source);
  lines.push("", "By source (measured payload, excluding shared database space and graph files):");
  for (const id of [...ids].sort()) {
    if (options.source && id !== options.source) continue;
    const doc = logical.get(id);
    const rows = indexRows.get(id) ?? [];
    const text = rows.reduce((sum, row) => sum + row.textBytes, 0);
    const vectors = snapshot.index ? rows.reduce((sum, row) => sum + row.embeddingBytes, 0) : null;
    lines.push(
      `  ${id}: ${doc?.documents ?? "pending"} documents; documents ${bytes(doc?.payloadBytes)}, vectors ${bytes(vectors)}, indexed text ${bytes(snapshot.index ? text : null)}`,
    );
    if (options.history) {
      const documentsByMonth = new Map(doc?.months.map((item) => [item.month, item]));
      const indexedByMonth = new Map<string, { textBytes: number; embeddingBytes: number }>();
      for (const row of rows) {
        const aggregate = indexedByMonth.get(row.month) ?? { textBytes: 0, embeddingBytes: 0 };
        aggregate.textBytes += row.textBytes;
        aggregate.embeddingBytes += row.embeddingBytes;
        indexedByMonth.set(row.month, aggregate);
      }
      const months = new Set([...documentsByMonth.keys(), ...indexedByMonth.keys()]);
      for (const month of [...months].sort()) {
        const docs = documentsByMonth.get(month);
        const bucket = indexedByMonth.get(month);
        lines.push(
          `    ${month}: ${docs?.documents ?? (snapshot.logical ? 0 : "pending")} documents; documents ${bytes(docs?.payloadBytes ?? (snapshot.logical ? 0 : null))}, vectors ${bytes(snapshot.index ? (bucket?.embeddingBytes ?? 0) : null)}, indexed text ${bytes(snapshot.index ? (bucket?.textBytes ?? 0) : null)}`,
        );
      }
    }
  }
  if (!snapshot.logical && !snapshot.index)
    lines.push("  Source measurements pending; unavailable values are not zero.");
  lines.push(
    "",
    "Deletion frees reusable database pages and may not immediately shrink files on disk.",
  );
  return lines.join("\n");
}
