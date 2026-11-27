// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/** No extension fields: this endpoint is deliberately not an analytics event API. */
export const heartbeatSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.string().regex(/^[a-f0-9]{64}$/),
  gatewayVersion: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  gitCommit: z.string().regex(/^(?:[a-f0-9]{40}|custom)$/),
  os: z.enum(["linux", "darwin", "win32", "other"]),
  arch: z.enum(["x64", "arm64", "arm", "ia32", "other"]),
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** A UTC Monday week is split at the identifier's month boundary. */
export function weekSegment(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return [date.toISOString().slice(0, 10), `${day.slice(0, 7)}-01`].sort()[1];
}
