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
    if (!row.months.has(month)) row.months.set(month, { month, documentBytes: 0, vectorBytes: 0, textBytes: 0 });
    return row.months.get(month);
  }
  for (const row of snapshot.logical?.sources ?? []) {
    const target = source(row.sourceId);
    target.documentBytes = row.payloadBytes;
    for (const month of row.months ?? []) bucket(target, month.month).documentBytes += month.payloadBytes;
  }
  let indexedText = 0;
  for (const row of snapshot.index?.sources ?? []) {
    const month = bucket(source(row.sourceId), row.month);
    month.vectorBytes += row.embeddingBytes;
    month.textBytes += row.textBytes;
    indexedText += row.textBytes;
  }
  // A source can still have a policy when it has no measured documents.
  for (const policy of snapshot.retention ?? []) source(policy.sourceId);
  const allocation = snapshot.index?.lexicalBytes;
  const lexicalKnown = Number.isFinite(allocation) && (indexedText > 0 || allocation === 0);
  const rows = [...sources.values()].map((row) => {
    let vector = 0, lexical = 0;
    const months = [...row.months.values()].map((month) => {
      const indexShare = lexicalKnown && indexedText ? allocation * month.textBytes / indexedText : 0;
      const lexicalBytes = month.textBytes + indexShare;
      vector += month.vectorBytes;
      lexical += lexicalBytes;
      return { month: month.month, bytes: month.documentBytes + month.vectorBytes + lexicalBytes };
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
  // A partial month has no day-level breakdown. A later preview gives the
  // exact eligible documents for the bounded trim batch.
  return months.reduce((total, {month, bytes}) =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < cutoff.slice(0, 7) ? total + bytes : total, 0);
}
