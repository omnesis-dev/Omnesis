// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
interface Retirement {
  device_id: string;
  name: string;
  kind: string;
  forgotten_at: number;
}
interface Archive {
  source_id: string;
  device_id: string;
  archived_at: number;
}

/** Retirement is target authority; imported archive labels cannot retire a current device. */
export function reconcileRestoredRetirements(
  source: EncryptedSqliteDatabase,
  target: EncryptedSqliteDatabase,
  output: EncryptedSqliteDatabase,
): void {
  const current = new Set(
    target
      .prepare<[], { id: string }>("SELECT id FROM devices")
      .all()
      .map((row) => row.id),
  );
  const targetRetirements = target
    .prepare<[], Retirement>("SELECT device_id,name,kind,forgotten_at FROM forgotten_devices")
    .all();
  const forgotten = new Set(targetRetirements.map((row) => row.device_id));
  const sourceRetirements = source
    .prepare<[], Retirement>("SELECT device_id,name,kind,forgotten_at FROM forgotten_devices")
    .all();
  if (sourceRetirements.some((row) => current.has(row.device_id) && !forgotten.has(row.device_id)))
    throw new Error(
      "The backup retirement history conflicts with this Mac's current device authority",
    );
  const addRetirement = output.prepare(
    "INSERT INTO forgotten_devices(device_id,name,kind,forgotten_at) VALUES(?,?,?,?)",
  );
  for (const row of targetRetirements)
    addRetirement.run(row.device_id, row.name, row.kind, row.forgotten_at);
  const imported = new Set<string>();
  for (const row of sourceRetirements) {
    if (current.has(row.device_id)) continue;
    addRetirement.run(row.device_id, row.name, row.kind, row.forgotten_at);
    imported.add(row.device_id);
  }
  // Restoring an older active membership cannot undo this installation's later retirement.
  // Source-lifetime config contracts remain attached to sources, not retired memberships.
  output.exec(
    "DELETE FROM source_devices WHERE device_id IN (SELECT device_id FROM forgotten_devices)",
  );
  const addArchive = output.prepare(
    "INSERT INTO source_device_archives(source_id,device_id,archived_at) VALUES(?,?,?)",
  );
  const matchingTargetSource = output.prepare<[string, string, string, number], { id: string }>(
    "SELECT id FROM sources WHERE id=? AND type=? AND account_id=? AND created_at=?",
  );
  const targetSource = target.prepare<
    [string],
    { id: string; type: string; account_id: string; created_at: number }
  >("SELECT id,type,account_id,created_at FROM sources WHERE id=?");
  for (const row of target
    .prepare<[], Archive>("SELECT source_id,device_id,archived_at FROM source_device_archives")
    .all()) {
    const original = targetSource.get(row.source_id);
    if (
      original &&
      matchingTargetSource.get(original.id, original.type, original.account_id, original.created_at)
    )
      addArchive.run(row.source_id, row.device_id, row.archived_at);
  }
  for (const row of source
    .prepare<[], Archive>("SELECT source_id,device_id,archived_at FROM source_device_archives")
    .all()) {
    // Missing target archive edges are deliberate too: a backup's keep choice cannot undo discard.
    if (imported.has(row.device_id)) addArchive.run(row.source_id, row.device_id, row.archived_at);
  }
}
