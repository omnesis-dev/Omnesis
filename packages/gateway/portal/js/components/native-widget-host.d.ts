// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Untrusted renderer configuration is validated by the isolated host at runtime. */
export function widgetOrigin(value: unknown, websocket?: boolean): string | null;
export function widgetPolicy(origins?: Record<string, unknown>): string;
export function rendererPath(kind: unknown, renderers: Record<string, unknown>): string;

interface HostMeta {
  httpEquiv?: string;
  content?: string;
}
export interface WidgetHostDependencies {
  document: {
    createElement(name: string): HostMeta;
    head: { appendChild(element: HostMeta): unknown };
    getElementById(id: string): { textContent: string | null } | null;
  };
  fetch(
    path: string,
    options: { credentials: "omit"; cache: "no-store"; redirect: "error" },
  ): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  load(path: string): Promise<{ open?: unknown }>;
  send(message: Record<string, unknown>): void;
}
export function createWidgetHost(dependencies: WidgetHostDependencies): {
  stop(): void;
  start(configuration: unknown): Promise<void>;
};
