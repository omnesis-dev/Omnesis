// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function getJson(url: string, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  return res.json();
}

// ---------------------------------------------------------------------------
// WebSocket helpers (mirrors patterns from gateway/src/ws.test.ts)
// ---------------------------------------------------------------------------

export function waitForOpen(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS open")), timeout);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function waitForClose(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS close")), timeout);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function waitForMessage<T = unknown>(ws: WebSocket, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeout);
    const handler = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(ev.data as string) as T);
    };
    ws.addEventListener("message", handler);
  });
}

export function waitForMessageMatching<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for matching WS message")),
      timeout,
    );
    const handler = (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data as string) as T;
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Collect all messages for a duration. */
export function collectMessages<T = unknown>(ws: WebSocket, durationMs: number): Promise<T[]> {
  return new Promise((resolve) => {
    const messages: T[] = [];
    const handler = (ev: MessageEvent) => {
      messages.push(JSON.parse(ev.data as string) as T);
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

// ---------------------------------------------------------------------------
// Gateway-side document/sync helpers
// ---------------------------------------------------------------------------

/**
 * Get document count for a source via gateway HTTP API.
 */
export async function getDocumentCount(
  gatewayUrl: string,
  apiKey: string,
  sourceId: string,
): Promise<number> {
  const data = (await getJson(
    `${gatewayUrl}/documents/count/${encodeURIComponent(sourceId)}`,
    apiKey,
  )) as { count: number };
  return data.count;
}

/**
 * Get documents for a source via gateway HTTP API.
 */
export async function getDocuments(
  gatewayUrl: string,
  apiKey: string,
  sourceId: string,
): Promise<unknown[]> {
  // Gateway list endpoints return the canonical
  // `Page<T>` envelope: `{ items, pageInfo: { hasMore, limit, nextCursor? } }`.
  const data = (await getJson(
    `${gatewayUrl}/documents/list?sourceId=${encodeURIComponent(sourceId)}`,
    apiKey,
  )) as { items: unknown[] };
  return data.items ?? [];
}

/**
 * Get sync state for a source via gateway HTTP API.
 */
export async function getSyncState(
  gatewayUrl: string,
  apiKey: string,
  sourceId: string,
): Promise<unknown> {
  return getJson(`${gatewayUrl}/sync-state/${encodeURIComponent(sourceId)}`, apiKey);
}

/**
 * Get source stats via gateway HTTP API.
 */
export async function getSourceStats(
  gatewayUrl: string,
  apiKey: string,
  sourceId: string,
): Promise<{
  documentCount: number;
  earliestSourceDate: string | null;
  latestSourceDate: string | null;
  dataSizeBytes: number;
}> {
  return (await getJson(
    `${gatewayUrl}/documents/stats/${encodeURIComponent(sourceId)}`,
    apiKey,
  )) as {
    documentCount: number;
    earliestSourceDate: string | null;
    latestSourceDate: string | null;
    dataSizeBytes: number;
  };
}
