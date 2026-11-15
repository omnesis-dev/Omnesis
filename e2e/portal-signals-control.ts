// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Page } from "@playwright/test";

/**
 * Stands in for the portal's signal stream (`GET /portal/api/signals`) so a
 * test whose lists are mocked can send what the gateway would send when one
 * of them changes. Every other EventSource is the browser's own.
 *
 * Call before the first navigation; then `sendPortalSignal(page, topic)`.
 */
export async function controlPortalSignals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = window.EventSource;
    type Listener = (event: { data: string }) => void;
    class SignalStream {
      readonly url: string;
      readyState = 1;
      private readonly listeners = new Map<string, Set<Listener>>();
      constructor(url: string) {
        this.url = url;
        const signals = window as unknown as { __portalSignal?: (topic: string) => void };
        signals.__portalSignal = (topic) => this.emit("changed", JSON.stringify({ topic }));
        setTimeout(() => this.emit("ready", "{}"), 0);
      }
      addEventListener(type: string, listener: Listener): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
      }
      removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
      }
      close(): void {
        this.readyState = 2;
      }
      private emit(type: string, data: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener({ data });
      }
    }
    window.EventSource = function (url: string | URL, init?: EventSourceInit) {
      return String(url).includes("/portal/api/signals")
        ? (new SignalStream(String(url)) as unknown as EventSource)
        : new Real(url, init);
    } as unknown as typeof EventSource;
  });
}

/** What the gateway sends once `topic`'s waiting items changed. */
export async function sendPortalSignal(page: Page, topic: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __portalSignal?: unknown }).__portalSignal === "function",
  );
  await page.evaluate((name) => {
    (window as unknown as { __portalSignal: (topic: string) => void }).__portalSignal(name);
  }, topic);
}
