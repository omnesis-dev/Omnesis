// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DurableStore, FetchLike, FetchLikeResponse } from "./index.js";

/**
 * Test doubles shared across the push unit suites. These are the same kind of
 * adapters the spawned-gateway E2E will inject (Node `fetch` + an in-memory
 * store) — proving the push module is genuinely environment-agnostic.
 */

/** In-memory {@link DurableStore} that persists across "restart" simulations. */
export class MemoryStore implements DurableStore {
  private data = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  /** Snapshot of the raw backing map — lets a test assert nothing was lost. */
  snapshot(): Map<string, string> {
    return new Map(this.data);
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect?: "error";
}

/** A scripted response the fake fetch returns for a matching request. */
export type ResponseScript = (req: RecordedRequest) => FetchLikeResponse | "network-error";

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/**
 * A fetch fake that records every request and answers from a script. The
 * script may return a {@link FetchLikeResponse} or `"network-error"` to
 * simulate an unreachable gateway (the client treats that as a retry).
 */
export class FakeFetch {
  readonly requests: RecordedRequest[] = [];

  constructor(private script: ResponseScript) {}

  setScript(script: ResponseScript): void {
    this.script = script;
  }

  readonly fetch: FetchLike = (url, init) => {
    const req: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: safeParse(init.body),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    };
    this.requests.push(req);
    const result = this.script(req);
    if (result === "network-error") return Promise.reject(new Error("network error"));
    return Promise.resolve(result);
  };
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
