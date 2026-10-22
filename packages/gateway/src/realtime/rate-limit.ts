// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { UpstreamEvent } from "./backend.js";

const limitsSchema = z.object({
  rate_limits: z.array(
    z.object({
      name: z.string(),
      limit: z.number().positive().finite(),
      remaining: z.number().nonnegative().finite(),
      reset_seconds: z.number().nonnegative().finite().max(3600),
    }),
  ),
});
const usageSchema = z.object({
  response: z.object({
    usage: z
      .object({
        input_tokens: z.number().positive().finite(),
        output_tokens: z.number().nonnegative().finite(),
      })
      .nullish(),
  }),
});

/** A provider snapshot is a hint, not a local token counter or a second conversation history. */
export class RealtimeRateLimit {
  private snapshots = new Map<
    string,
    { limit: number; remaining: number; reset: number; at: number }
  >();
  private lastUsage: { tokens: number; inputBytes: number } | undefined;
  private requestBytes = 0;
  observe(event: UpstreamEvent): void {
    if (event.type === "rate_limits.updated") {
      const parsed = limitsSchema.safeParse(event);
      if (parsed.success)
        for (const entry of parsed.data.rate_limits) {
          if (entry.name !== "tokens" && entry.name !== "requests") continue;
          if (entry.remaining <= entry.limit)
            this.snapshots.set(entry.name, {
              limit: entry.limit,
              remaining: entry.remaining,
              reset: entry.reset_seconds * 1000,
              at: Date.now(),
            });
        }
    }
    if (event.type === "response.done") {
      const parsed = usageSchema.safeParse(event);
      if (parsed.success && parsed.data.response.usage)
        this.lastUsage = {
          tokens:
            parsed.data.response.usage.input_tokens + parsed.data.response.usage.output_tokens,
          inputBytes: this.requestBytes,
        };
    }
  }
  request(input: unknown[]): void {
    this.requestBytes = Buffer.byteLength(JSON.stringify(input));
  }
  delayMs(input: unknown[]): number | undefined {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    const needed = this.lastUsage
      ? this.lastUsage.tokens + Math.max(0, bytes - this.lastUsage.inputBytes)
      : undefined;
    const waits: number[] = [];
    for (const [name, snapshot] of this.snapshots) {
      const required = name === "requests" ? 1 : needed;
      if (
        required === undefined ||
        required > snapshot.limit ||
        snapshot.reset === 0 ||
        snapshot.remaining === snapshot.limit
      )
        continue;
      const refill = (snapshot.limit - snapshot.remaining) / snapshot.reset;
      const available = Math.min(
        snapshot.limit,
        snapshot.remaining + Math.max(0, Date.now() - snapshot.at) * refill,
      );
      waits.push(Math.ceil(Math.max(0, required - available) / refill));
    }
    return waits.length ? Math.max(...waits) : undefined;
  }
}
