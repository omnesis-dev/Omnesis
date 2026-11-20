// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cloudflare Worker entry point of the DNS broker. One Durable Object holds the name registry,
 * the pending challenges and the TXT lease journal, so every operation is serialized in one
 * place and survives restarts. `deploy/dns-broker/wrangler.jsonc.example` shows the bindings.
 *
 * The Workers runtime types are declared here as narrowly as the broker uses them, so the
 * package needs no Workers type dependency.
 */
import { z } from "zod";
import { registryImportSchema } from "./dns-broker-contract.js";
import { DnsBroker } from "./dns-broker-core.js";
import { cloudflareBrokerZone } from "./dns-broker-zone.js";
import { turnstileVerifier } from "./dns-broker-public-admission.js";

export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface DnsBrokerEnv {
  DNS_BROKER: DurableObjectNamespaceLike;
  /** The origin gateways reach the broker at; their signatures name it. */
  BROKER_ORIGIN: string;
  RELAY_DOMAIN: string;
  ZONE_ID: string;
  ZONE_NAME: string;
  /** Secret: a token limited to DNS edits in this zone. */
  CLOUDFLARE_API_TOKEN: string;
  /** Secret, set only for the one-time registry import and deleted afterwards. */
  REGISTRY_IMPORT_TOKEN?: string;
  /** JSON registry entries approved for new names. Omit during gateway-client migration. */
  APPROVED_NEW_OWNERS_JSON?: string;
  CAA_ACCOUNT_URI_PREFIX?: string;
  PUBLIC_ADMISSION_ENABLED?: string;
  PUBLIC_ADMISSION_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PUBLIC_ADMISSION_LIMITS_JSON?: string;
}

const CLIENT_HEADER = "x-omnesis-dns-worker-client";
const limitsSchema = z
  .object({
    networkPerHour: z.number().int().positive().optional(),
    networkPerDay: z.number().int().positive().optional(),
    ownerPerDay: z.number().int().positive().optional(),
    totalPerDay: z.number().int().positive().optional(),
    reservedRecords: z.number().int().positive().optional(),
  })
  .strict();

/** The single registry instance every request is routed to. */
export class DnsBrokerRegistry {
  private readonly broker: DnsBroker;
  private alarmAt: number | undefined;
  constructor(
    private readonly state: DurableObjectStateLike,
    env: DnsBrokerEnv,
  ) {
    const storage = state.storage;
    if (!["0", "1"].includes(env.PUBLIC_ADMISSION_ENABLED ?? ""))
      throw new Error("Choose public DNS admission or explicit migration compatibility mode");
    const publicMode = env.PUBLIC_ADMISSION_ENABLED === "1";
    if (
      publicMode &&
      (!env.PUBLIC_ADMISSION_KEY || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)
    )
      throw new Error("Public DNS admission requires its key and Turnstile configuration");
    this.broker = new DnsBroker({
      onMaintenance: () => this.requestMaintenance(),
      origin: env.BROKER_ORIGIN,
      approvedNewOwners:
        env.APPROVED_NEW_OWNERS_JSON === undefined
          ? undefined
          : registryImportSchema.parse({ entries: JSON.parse(env.APPROVED_NEW_OWNERS_JSON) })
              .entries,
      relayDomain: env.RELAY_DOMAIN,
      importToken: env.REGISTRY_IMPORT_TOKEN || undefined,
      caa: env.CAA_ACCOUNT_URI_PREFIX ? { accountUriPrefix: env.CAA_ACCOUNT_URI_PREFIX } : {},
      ...(publicMode
        ? {
            publicAdmission: {
              secret: env.PUBLIC_ADMISSION_KEY!,
              siteKey: env.TURNSTILE_SITE_KEY!,
              verify: turnstileVerifier(env.TURNSTILE_SECRET_KEY!),
              ...(env.PUBLIC_ADMISSION_LIMITS_JSON
                ? { limits: limitsSchema.parse(JSON.parse(env.PUBLIC_ADMISSION_LIMITS_JSON)) }
                : {}),
            },
          }
        : {}),
      store: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: async (key) => {
          await storage.delete(key);
        },
        list: (prefix) => storage.list({ prefix }),
      },
      zone: cloudflareBrokerZone({
        zoneId: env.ZONE_ID,
        zoneName: env.ZONE_NAME,
        relayDomain: env.RELAY_DOMAIN,
        token: env.CLOUDFLARE_API_TOKEN,
      }),
    });
    // Leases a previous instance left behind are removed before the first request is served.
    void state.blockConcurrencyWhile(() => this.schedule());
  }
  async fetch(request: Request): Promise<Response> {
    return this.broker.handle(request, {
      clientAddress: request.headers.get(CLIENT_HEADER) ?? undefined,
    });
  }
  async alarm(): Promise<void> {
    this.alarmAt = undefined;
    await this.schedule();
  }
  private async schedule(): Promise<void> {
    await this.broker.expire();
    await this.broker.updateMaintenance(async (next) => {
      this.alarmAt = next;
      if (next === undefined) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(next);
    });
  }
  private async requestMaintenance(): Promise<void> {
    // Called under the broker metadata lock, before a journal mutation can reach provider I/O.
    // Earlier alarms remain earlier; continued traffic cannot postpone a lease cleanup.
    const at = Date.now() + 60_000;
    if (this.alarmAt === undefined || at < this.alarmAt) {
      this.alarmAt = at;
      await this.state.storage.setAlarm(at);
    }
  }
}

export default {
  async fetch(request: Request, env: DnsBrokerEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/_dns/v2/"))
      return new Response(JSON.stringify({ error: "not-found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    const headers = new Headers(request.headers);
    // Cloudflare overwrites CF-Connecting-IP at this public entry point. A caller's internal
    // header is never forwarded, so only this Worker can supply the Durable Object's context.
    headers.delete(CLIENT_HEADER);
    const address = request.headers.get("cf-connecting-ip");
    headers.delete("cf-connecting-ip");
    if (address) headers.set(CLIENT_HEADER, address);
    return env.DNS_BROKER.get(env.DNS_BROKER.idFromName("registry")).fetch(
      new Request(request, { headers }),
    );
  },
};
