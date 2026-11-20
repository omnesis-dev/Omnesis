// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Leave the final quarter of capacity for currently unrepresented client buckets.
 * These are source-address fairness slots, never proof of authentication. Deriving
 * the reserve from the configured capacity keeps small installations proportional.
 */
export function hasStreamCapacity(
  capacity: number,
  occupied: number,
  clientStreams: number,
): boolean {
  const reserve = clientStreams > 0 ? Math.floor(capacity / 4) : 0;
  return occupied < capacity - reserve;
}
