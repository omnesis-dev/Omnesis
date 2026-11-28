// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { readDesktopRestoreIntent } from "./restore-intent.js";
import { readDesktopActiveRuntime } from "./update-active.js";
import { readDesktopUpdateState } from "./update-state.js";
import { verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import { readDesktopSnapshotOwner } from "./snapshot-owner.js";
import {
  desktopSnapshotDisposition,
  readDesktopSnapshotRetention,
  writeDesktopSnapshotRetention,
  type DesktopSnapshotCleanupReceipt,
  type DesktopSnapshotRetentionRecord,
} from "./snapshot-retention-record.js";
import {
  assertDesktopSnapshotWitness,
  captureDesktopSnapshotWitness,
  snapshotWitnessPath,
} from "./snapshot-retention-witness.js";
import type { DesktopProfile } from "./environment.js";

async function context(profile: DesktopProfile, currentEpoch: string) {
  const update = await readDesktopUpdateState(profile),
    restore = await readDesktopRestoreIntent(profile),
    active = await readDesktopActiveRuntime(profile),
    root = await desktopRootIdentity(profile);
  if (
    (await readDesktopRetirement(profile)) ||
    (update && !["complete", "resumed", "verified"].includes(update.phase)) ||
    (restore && !["complete", "rolled-back"].includes(restore.phase))
  )
    throw new Error("Finish removal, update or backup restore before recovery cleanup");
  if (
    !root ||
    active?.epoch !== currentEpoch ||
    (update &&
      (!sameDesktopRoot(root, update.root) ||
        currentEpoch !==
          (update.phase === "complete" ? update.candidateEpoch : update.oldEpoch))) ||
    (restore && !sameDesktopRoot(root, restore.root))
  )
    throw new Error("The current application and library must be verified before recovery cleanup");
  const ledger =
    (await readDesktopSnapshotRetention(profile)) ??
    ({
      format: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      root,
      sequence: 0,
      records: [],
      pending: null,
    } satisfies DesktopSnapshotRetentionRecord);
  if (!sameDesktopRoot(root, ledger.root))
    throw new Error("The recovery copies belong to another library folder");
  return {
    update,
    restore,
    root,
    ledger,
    journals: { updateId: update?.operationId ?? null, restoreId: restore?.operationId ?? null },
  };
}
/** Includes both current protective copies and the newest retained copy, without duplicate payload passes. */
function verifier(profile: DesktopProfile, signal: AbortSignal) {
  const checked = new Map<string, string>();
  return async (operationId: string, manifestSha256: string) => {
    const prior = checked.get(operationId);
    if (prior && prior !== manifestSha256)
      throw new Error("Recovery journals disagree about their copy");
    if (prior) return;
    await verifyDesktopUpdateSnapshot(profile, { operationId, manifestSha256, signal });
    checked.set(operationId, manifestSha256);
  };
}
async function verifyProtected(
  profile: DesktopProfile,
  state: Awaited<ReturnType<typeof context>>,
  signal: AbortSignal,
) {
  const verify = verifier(profile, signal);
  for (const journal of [state.update, state.restore])
    if (journal?.backup) await verify(journal.operationId, journal.backup.manifestSha256);
  const latest = state.ledger.records.reduce<(typeof state.ledger.records)[number] | undefined>(
    (previous, row) => (!previous || row.order > previous.order ? row : previous),
    undefined,
  );
  if (latest) await verify(latest.operationId, latest.manifestSha256);
  return verify;
}
/** Caller holds the install lease and has observed fresh ready/protected status. Not deletion authority. */
export async function prepareDesktopSnapshotCleanupLocked(
  profile: DesktopProfile,
  input: { snapshotId: string; currentEpoch: string; incompleteStaging?: boolean },
  signal: AbortSignal,
): Promise<{ ledger: DesktopSnapshotRetentionRecord; receipt: DesktopSnapshotCleanupReceipt }> {
  signal.throwIfAborted();
  const current = await context(profile, input.currentEpoch),
    { ledger, journals } = current;
  if (ledger.pending) throw new Error("An earlier recovery cleanup is pending");
  const verify = await verifyProtected(profile, current, signal);
  const incomplete = [current.update, current.restore].find(
    (journal) =>
      journal?.operationId === input.snapshotId &&
      (!journal.backup || input.incompleteStaging === true),
  );
  let receipt: DesktopSnapshotCleanupReceipt;
  if (incomplete) {
    const staging = input.incompleteStaging ?? true;
    const path = snapshotWitnessPath(profile, { operationId: input.snapshotId, staging });
    await readDesktopSnapshotOwner(profile, input.snapshotId, path);
    const target = await captureDesktopSnapshotWitness(
      profile,
      input.snapshotId,
      staging,
      "owner",
      signal,
    );
    const oldEpoch =
      "oldEpoch" in incomplete
        ? incomplete.oldEpoch
        : (incomplete.backupRuntime?.epoch ?? input.currentEpoch);
    receipt = {
      operationId: randomUUID(),
      snapshotId: input.snapshotId,
      journals,
      currentEpoch: input.currentEpoch,
      oldEpoch,
      mode: "incomplete-owned",
      phase: "planned",
      target,
      keeper: null,
    };
  } else {
    const protectedIds = new Set(
      [journals.updateId, journals.restoreId].filter((id): id is string => id !== null),
    );
    const disposition = desktopSnapshotDisposition(ledger, input.snapshotId, protectedIds);
    if (disposition.kind === "keep")
      throw new Error("Keep the current, newest or pinned recovery copy");
    const row = ledger.records.find((entry) => entry.operationId === input.snapshotId)!;
    const target = await captureDesktopSnapshotWitness(
      profile,
      row.operationId,
      false,
      "manifest",
      signal,
    );
    if (
      !sameDesktopRoot(row.directory, target.directory) ||
      row.manifestSha256 !== target.inventory.sha256
    )
      throw new Error("The selected recovery copy changed");
    await verify(row.operationId, row.manifestSha256);
    let keeper: DesktopSnapshotCleanupReceipt["keeper"] = null;
    if (disposition.kind === "redundant-snapshot") {
      const retained = disposition.keeper;
      keeper = await captureDesktopSnapshotWitness(
        profile,
        retained.operationId,
        false,
        "manifest",
        signal,
      );
      if (
        !sameDesktopRoot(retained.directory, keeper.directory) ||
        retained.manifestSha256 !== keeper.inventory.sha256
      )
        throw new Error("The newer retained recovery copy changed");
      await verify(retained.operationId, retained.manifestSha256);
    }
    receipt = {
      operationId: randomUUID(),
      snapshotId: row.operationId,
      journals,
      currentEpoch: input.currentEpoch,
      oldEpoch: row.oldEpoch,
      mode: disposition.kind,
      phase: "planned",
      target,
      keeper,
    };
  }
  signal.throwIfAborted();
  if (!sameDesktopRoot(current.root, await desktopRootIdentity(profile)))
    throw new Error("The library changed during cleanup review");
  return { ledger, receipt };
}
/** Only after explicit consent, while the same install lease remains held. */
export async function stageDesktopSnapshotCleanupLocked(
  profile: DesktopProfile,
  prepared: Awaited<ReturnType<typeof prepareDesktopSnapshotCleanupLocked>>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const state = await context(profile, prepared.receipt.currentEpoch);
  if (
    JSON.stringify(state.ledger) !== JSON.stringify(prepared.ledger) ||
    JSON.stringify(state.journals) !== JSON.stringify(prepared.receipt.journals)
  )
    throw new Error("The recovery copies changed after cleanup review");
  await assertDesktopSnapshotWitness(profile, prepared.receipt.target, signal);
  if (prepared.receipt.keeper)
    await assertDesktopSnapshotWitness(profile, prepared.receipt.keeper, signal);
  await writeDesktopSnapshotRetention(profile, { ...prepared.ledger, pending: prepared.receipt });
}
/** Resume an existing deletion identity, never a newly selected directory. */
export async function resumeDesktopSnapshotCleanupLocked(
  profile: DesktopProfile,
  operationId: string,
  currentEpoch: string,
  signal: AbortSignal,
): Promise<{ ledger: DesktopSnapshotRetentionRecord; receipt: DesktopSnapshotCleanupReceipt }> {
  const state = await context(profile, currentEpoch),
    { ledger } = state,
    receipt = ledger.pending;
  if (
    !receipt ||
    receipt.operationId !== operationId ||
    receipt.currentEpoch !== currentEpoch ||
    JSON.stringify(receipt.journals) !== JSON.stringify(state.journals)
  )
    throw new Error("The pending cleanup belongs to a different application or library");
  const verify = await verifyProtected(profile, state, signal);
  if (receipt.keeper) {
    await assertDesktopSnapshotWitness(profile, receipt.keeper, signal);
    await verify(receipt.keeper.operationId, receipt.keeper.inventory.sha256);
  }
  if (receipt.phase === "planned") {
    await assertDesktopSnapshotWitness(profile, receipt.target, signal);
    if (receipt.mode !== "incomplete-owned")
      await verify(receipt.target.operationId, receipt.target.inventory.sha256);
    else
      await readDesktopSnapshotOwner(
        profile,
        receipt.target.operationId,
        snapshotWitnessPath(profile, receipt.target),
      );
  }
  signal.throwIfAborted();
  return { ledger, receipt };
}
