// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The DNS broker's writes to one Cloudflare zone. Runs in a Worker as well as on Node: zod and
 * `fetch` only. Callers choose a gateway hostname the broker already authorized; the record
 * types, names and API origin are fixed here.
 */
import { z } from "zod";
import { brokerHostnameSchema, relayDomainSchema } from "./dns-broker-contract.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const RECORD_TTL = 300;
export const BROKER_RECORD_TAG = "omnesis-dns-broker-v2";

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const recordSchema = z.object({
  id: idSchema,
  type: z.string(),
  name: z.string(),
  content: z.string().optional(),
  comment: z.string().nullable().optional(),
  data: z.object({ flags: z.number(), tag: z.string(), value: z.string() }).partial().optional(),
});
type DnsRecord = z.infer<typeof recordSchema>;

export interface TxtLease {
  id: string;
  hostname: string;
  value: string;
  expiresAt: number;
}

/** What the broker core needs from DNS; Cloudflare's API is one implementation. */
export interface BrokerZone {
  createTxt(lease: TxtLease, signal: AbortSignal): Promise<void>;
  removeTxt(lease: TxtLease, signal: AbortSignal): Promise<void>;
  /** CAA bound to one ACME account, and the relay's addresses, at exactly this name. */
  publishName(hostname: string, caaValue: string, signal: AbortSignal): Promise<void>;
  /** Every CAA and address record at exactly this name; the relay's wildcard answers again. */
  removeName(hostname: string, signal: AbortSignal): Promise<void>;
}

async function boundedJson(response: Response, limit = 262_144): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader?.read();
    if (!part || part.done) break;
    size += part.value.length;
    if (size > limit) {
      await reader!.cancel();
      throw new Error("DNS provider response is too large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function cloudflareBrokerZone(options: {
  zoneId: string;
  zoneName: string;
  relayDomain: string;
  token: string;
  fetch?: typeof fetch;
  /** Only a loopback stand-in for Cloudflare, in tests. */
  apiUrl?: string;
}): BrokerZone {
  const zoneId = idSchema.parse(options.zoneId);
  const zoneName = relayDomainSchema.parse(options.zoneName);
  const relayDomain = relayDomainSchema.parse(options.relayDomain);
  const token = z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\s]+$/)
    .parse(options.token);
  if (relayDomain !== zoneName && !relayDomain.endsWith(`.${zoneName}`))
    throw new Error("The relay domain is outside the configured zone");
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const api = async (
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<{ result: unknown; total_pages?: number }> => {
    const response = await transport(
      `${options.apiUrl ?? CLOUDFLARE_API}/zones/${zoneId}/dns_records${path}`,
      {
        method,
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("DNS provider request refused");
    }
    const envelope = z
      .object({
        success: z.literal(true),
        result: z.unknown(),
        result_info: z.object({ total_pages: z.number().int().nonnegative() }).optional(),
      })
      .parse(await boundedJson(response));
    return { result: envelope.result, total_pages: envelope.result_info?.total_pages };
  };
  const scoped = (hostname: string): string => {
    brokerHostnameSchema.parse(hostname);
    if (
      !hostname.endsWith(`.${relayDomain}`) ||
      hostname.split(".").length !== relayDomain.split(".").length + 1
    )
      throw new Error("DNS name is not a gateway name under the relay domain");
    return hostname;
  };
  const list = async (type: string, name: string, signal: AbortSignal): Promise<DnsRecord[]> => {
    const page = await api(
      `?type=${type}&name=${encodeURIComponent(name)}&per_page=100`,
      "GET",
      signal,
    );
    if ((page.total_pages ?? 1) > 1) throw new Error("DNS record limit exceeded");
    return z
      .array(recordSchema)
      .max(100)
      .parse(page.result)
      .filter((record) => record.type === type && record.name === name);
  };
  const create = async (body: Record<string, unknown>, signal: AbortSignal): Promise<DnsRecord> => {
    const record = recordSchema.parse((await api("", "POST", signal, body)).result);
    if (record.type !== body.type || record.name !== body.name)
      throw new Error("DNS provider returned a different record");
    return record;
  };
  const remove = (record: DnsRecord, signal: AbortSignal) => api(`/${record.id}`, "DELETE", signal);
  const txtFields = (lease: TxtLease) => ({
    type: "TXT",
    name: `_acme-challenge.${scoped(lease.hostname)}`,
    content: lease.value,
    ttl: 120,
    comment: `${BROKER_RECORD_TAG}:${lease.id}:${lease.expiresAt}`,
  });
  return {
    async createTxt(lease, signal) {
      const expected = txtFields(lease);
      const record = await create(expected, signal);
      if (record.content !== expected.content || record.comment !== expected.comment)
        throw new Error("DNS provider returned a different record");
    },
    async removeTxt(lease, signal) {
      const expected = txtFields(lease);
      for (const record of await list("TXT", expected.name, signal))
        if (record.content === expected.content && record.comment === expected.comment)
          await remove(record, signal);
    },
    async publishName(hostname, caaValue, signal) {
      const name = scoped(hostname);
      // A record at the name stops the relay's wildcard from answering for it, so the name gets
      // the wildcard's own addresses, unproxied: gateway traffic never passes through the CDN.
      const addresses = new Map<"A" | "AAAA", Set<string>>();
      for (const type of ["A", "AAAA"] as const)
        addresses.set(
          type,
          new Set((await list(type, `*.${relayDomain}`, signal)).map((record) => record.content!)),
        );
      if (addresses.get("A")!.size + addresses.get("AAAA")!.size === 0)
        throw new Error("The relay domain has no wildcard address to copy");
      for (const [type, wanted] of addresses) {
        const current = await list(type, name, signal);
        for (const content of wanted)
          if (!current.some((record) => record.content === content))
            await create(
              { type, name, content, ttl: RECORD_TTL, proxied: false, comment: BROKER_RECORD_TAG },
              signal,
            );
        for (const record of current)
          if (!wanted.has(record.content!)) await remove(record, signal);
      }
      const current = await list("CAA", name, signal);
      const matches = (record: DnsRecord) =>
        record.data?.flags === 0 && record.data.tag === "issue" && record.data.value === caaValue;
      if (!current.some(matches)) {
        const record = await create(
          {
            type: "CAA",
            name,
            data: { flags: 0, tag: "issue", value: caaValue },
            ttl: RECORD_TTL,
            comment: BROKER_RECORD_TAG,
          },
          signal,
        );
        if (!matches(record)) throw new Error("DNS provider returned a different record");
      }
      // Only the new record remains: any other CAA record at the name would widen who may issue.
      let kept = false;
      for (const record of current)
        if (matches(record) && !kept) kept = true;
        else await remove(record, signal);
    },
    async removeName(hostname, signal) {
      const name = scoped(hostname);
      for (const type of ["CAA", "A", "AAAA"])
        for (const record of await list(type, name, signal)) await remove(record, signal);
    },
  };
}
