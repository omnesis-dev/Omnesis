// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import type { ConnectionPath } from "@omnesis/core";
import type { DeviceId } from "@omnesis/types";

/** Ephemeral observations for authenticated sessions, independent of all access decisions. */
export class DevicePathTelemetry {
  private readonly active = new Map<DeviceId, Map<object, ConnectionPath | undefined>>();
  private readonly requests = new Map<DeviceId, { path: ConnectionPath; expires: number }>();
  private readonly reconnecting = new Map<DeviceId, number>();
  constructor(private readonly now: () => number = Date.now) {}
  open(socket: object, deviceId: DeviceId, path?: ConnectionPath): void {
    this.reconnecting.delete(deviceId);
    this.requests.delete(deviceId);
    let sessions = this.active.get(deviceId);
    if (!sessions) {
      sessions = new Map();
      this.active.set(deviceId, sessions);
    }
    sessions.set(socket, path);
  }
  update(socket: object, deviceId: DeviceId, path: ConnectionPath): void {
    const sessions = this.active.get(deviceId);
    if (!sessions?.has(socket)) return;
    sessions.delete(socket);
    sessions.set(socket, path);
  }
  close(socket: object, deviceId: DeviceId): void {
    const sessions = this.active.get(deviceId);
    if (!sessions?.has(socket)) return;
    const known = sessions.get(socket) !== undefined;
    sessions.delete(socket);
    if (sessions.size !== 0) return;
    this.active.delete(deviceId);
    if (known) {
      this.reconnecting.set(deviceId, this.now() + 30_000);
      if (this.reconnecting.size > 1000)
        this.reconnecting.delete(this.reconnecting.keys().next().value!);
    }
  }
  request(deviceId: DeviceId, path: ConnectionPath): void {
    this.requests.delete(deviceId);
    this.requests.set(deviceId, { path, expires: this.now() + 30_000 });
    if (this.requests.size > 1000) this.requests.delete(this.requests.keys().next().value!);
  }
  snapshot(deviceId: DeviceId): ConnectionPath | "reconnecting" | undefined {
    const sessions = this.active.get(deviceId);
    if (sessions) return [...sessions.values()].reverse().find((path) => path !== undefined);
    const expires = this.reconnecting.get(deviceId);
    if (expires === undefined) {
      const request = this.requests.get(deviceId);
      if (!request) return undefined;
      if (request.expires <= this.now()) {
        this.requests.delete(deviceId);
        return undefined;
      }
      return request.path;
    }
    if (expires <= this.now()) {
      this.reconnecting.delete(deviceId);
      return this.snapshot(deviceId);
    }
    return "reconnecting";
  }
}
