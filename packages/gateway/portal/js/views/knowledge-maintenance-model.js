// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function summarizeMaintenance(status, { reason = "", tier = "" } = {}) {
  const work = (status?.work ?? []).filter((row) => (!reason || row.reason === reason) && (!tier || row.tier === tier));
  const waitingGroups = work.filter((row) => row.status === "pending");
  const assignedGroups = work.filter((row) => row.status === "batched");
  const dueDates = waitingGroups.map((row) => row.nextDueAt).filter(Number.isFinite);
  return {
    waiting: waitingGroups.reduce((sum, row) => sum + row.count, 0),
    assigned: assignedGroups.reduce((sum, row) => sum + row.count, 0),
    cascades: reason || tier ? 0 : status?.cascades?.pending ?? 0,
    waitingGroups,
    assignedGroups,
    nextDueAt: dueDates.length ? Math.min(...dueDates) : null,
  };
}

export function batchStatusLabel(status) {
  return {
    pending: "Waiting to start",
    running: "In progress",
    completed: "Completed",
    abandoned: "Stopped",
  }[status] ?? String(status ?? "Unknown").replaceAll("_", " ");
}

export function maintenanceTierLabel(tier) {
  return { immediate: "Immediate", soon: "Soon", routine: "Routine" }[tier] ?? String(tier ?? "Unknown");
}

export function maintenanceReasonLabel(reason) {
  return {
    change: "Evidence changes",
    discovery: "Historical discovery",
    review: "Scheduled review",
    root: "Life overview refresh",
    upgrade: "Upgrade discovery",
  }[reason] ?? String(reason ?? "Unknown").replaceAll("_", " ");
}
