// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A local clock hour on the instant's calendar day, including DST transitions. */
export function localHour(instant: number, hour: number): number {
  const date = new Date(instant);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}
