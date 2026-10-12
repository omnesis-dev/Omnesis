// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The next moment the morning brief is composed, in the gateway's local time:
 * today at `hour` when that is still ahead, otherwise tomorrow at `hour`.
 * Every day counts, weekends included.
 */
export function nextMorningBriefAt(now: number, hour: number): number {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
