// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { CloudRelayMetrics } from "./metrics.js";

import { readBoundedJson } from "./google-credentials.js";
import type { DnsChallengeLease, DnsChallengeProvider } from "./acme-dns.js";

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const recordSchema = z.object({
  id: idSchema,
  type: z.string(),
  name: z.string(),
  content: z.string(),
  comment: z.string().optional(),
});
/** Credentials stay in the relay process; callers cannot select a zone, API origin, record type or arbitrary name. */
export function cloudflareDnsProvider(options: {
  zoneId: string;
  zoneName: string;
  token: string;
  fetch?: typeof fetch;
  metrics?: CloudRelayMetrics;
}): DnsChallengeProvider {
  const metrics = options.metrics ?? new CloudRelayMetrics();
  const zoneId = idSchema.parse(options.zoneId);
  const zoneName = z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/)
    .parse(options.zoneName);
  const token = z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\s]+$/)
    .parse(options.token);
  const request = async (path: string, method: string, signal: AbortSignal, body?: unknown) => {
    const response = await (options.fetch ?? fetch)(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records${path}`,
      {
        method,
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error("DNS provider request refused");
    const envelope = z
      .object({
        success: z.literal(true),
        result: z.unknown(),
        result_info: z.object({ total_pages: z.number().int().nonnegative() }).optional(),
      })
      .parse(await readBoundedJson(response));
    return envelope;
  };
  const fields = (lease: DnsChallengeLease) => {
    if (lease.hostname !== zoneName && !lease.hostname.endsWith(`.${zoneName}`))
      throw new Error("DNS name is outside the configured provider zone");
    return {
      type: "TXT",
      name: `_acme-challenge.${lease.hostname}`,
      content: lease.value,
      ttl: 120,
      comment: `omnesis-acme-v1:${lease.id}:${lease.expiresAt}`,
    };
  };
  const provider: DnsChallengeProvider = {
    async create(lease, signal) {
      const expected = fields(lease);
      const response = await request("", "POST", signal, expected);
      const record = recordSchema.parse(response.result);
      if (
        record.type !== expected.type ||
        record.name !== expected.name ||
        record.content !== expected.content ||
        record.comment !== expected.comment
      )
        throw new Error("DNS provider returned a different record");
    },
    async remove(lease, signal) {
      const expected = fields(lease);
      const response = await request(
        `?type=TXT&name=${encodeURIComponent(expected.name)}&per_page=100`,
        "GET",
        signal,
      );
      if ((response.result_info?.total_pages ?? 1) > 1)
        throw new Error("DNS challenge record limit exceeded");
      const records = z.array(recordSchema).max(100).parse(response.result);
      for (const record of records) {
        if (
          record.type === "TXT" &&
          record.name === expected.name &&
          record.content === expected.content &&
          record.comment === expected.comment
        )
          await request(`/${record.id}`, "DELETE", signal);
      }
    },
  };
  const observe = async (
    operation: "publish" | "remove",
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
      metrics.dns(`${operation}_success`);
    } catch (error) {
      metrics.dns(`${operation}_failure`);
      throw error;
    }
  };
  return {
    create: (lease, signal) => observe("publish", () => provider.create(lease, signal)),
    remove: (lease, signal) => observe("remove", () => provider.remove(lease, signal)),
  };
}
