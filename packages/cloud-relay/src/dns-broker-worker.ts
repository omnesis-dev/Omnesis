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
import { DnsBroker } from "./dns-broker-core.js";
import { cloudflareBrokerZone } from "./dns-broker-zone.js";

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
  CAA_ACCOUNT_URI_PREFIX?: string;
}

/** The single registry instance every request is routed to. */
export class DnsBrokerRegistry {
  private readonly broker: DnsBroker;
  constructor(
    private readonly state: DurableObjectStateLike,
    env: DnsBrokerEnv,
  ) {
    const storage = state.storage;
    this.broker = new DnsBroker({
      origin: env.BROKER_ORIGIN,
      relayDomain: env.RELAY_DOMAIN,
      importToken: env.REGISTRY_IMPORT_TOKEN || undefined,
      caa: env.CAA_ACCOUNT_URI_PREFIX ? { accountUriPrefix: env.CAA_ACCOUNT_URI_PREFIX } : {},
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
    const response = await this.broker.handle(request);
    await this.schedule();
    return response;
  }
  async alarm(): Promise<void> {
    await this.schedule();
  }
  private async schedule(): Promise<void> {
    const next = await this.broker.expire();
    if (next === undefined) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(next);
  }
}

export default {
  async fetch(request: Request, env: DnsBrokerEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/_dns/v2/"))
      return new Response(JSON.stringify({ error: "not-found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    return env.DNS_BROKER.get(env.DNS_BROKER.idFromName("registry")).fetch(request);
  },
};
