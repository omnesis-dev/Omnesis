// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Existing cadence override contract shared by ingestion and maintenance tasks. */
export function cadenceEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}
