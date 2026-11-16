// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner's remote-access choices that belong to no single way in, kept in
 * `<config>/remote-access.json`: whether the guided setup was finished, and
 * which way in a device tries first when both the gateway's own Tailscale
 * device and the Omnesis relay can answer. Nothing is written until the owner
 * makes a choice, so a gateway that never opens the setup has no such file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync, createLogger } from "@omnesis/core";
import { z } from "zod";

const log = createLogger("gateway:remote-access");

/** Which way in comes first after the home network, when both are on. */
export const remoteAccessFirstSchema = z.enum(["tailscale", "relay"]);
export type RemoteAccessFirst = z.infer<typeof remoteAccessFirstSchema>;

const remoteAccessSettingsSchema = z
  .object({
    /** When the owner finished the guided setup, as an ISO time; null until then. */
    setupCompletedAt: z.string().datetime().nullable(),
    first: remoteAccessFirstSchema,
  })
  .strict();
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = Object.freeze({
  setupCompletedAt: null,
  // Tailscale first keeps traffic on the owner's own network.
  first: "tailscale",
});

export class RemoteAccessSettingsStore {
  private current: RemoteAccessSettings;
  private readonly path: string;

  constructor(configDir: string) {
    this.path = join(configDir, "remote-access.json");
    this.current = this.load();
  }

  get(): RemoteAccessSettings {
    return this.current;
  }

  update(patch: Partial<RemoteAccessSettings>): RemoteAccessSettings {
    const next = remoteAccessSettingsSchema.parse({ ...this.current, ...patch });
    atomicWriteFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
    this.current = next;
    return next;
  }

  private load(): RemoteAccessSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_REMOTE_ACCESS_SETTINGS };
    try {
      const parsed = remoteAccessSettingsSchema.safeParse(
        JSON.parse(readFileSync(this.path, "utf8")),
      );
      if (parsed.success) return parsed.data;
      log.warn(`Ignoring unreadable ${this.path}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    } catch (error) {
      log.warn(
        `Ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ...DEFAULT_REMOTE_ACCESS_SETTINGS };
  }
}
