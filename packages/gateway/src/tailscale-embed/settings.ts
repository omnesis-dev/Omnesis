// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner's choices for the gateway's own tailnet device, kept in
 * `<config>/tailscale/settings.json`. Nothing is written until the owner makes
 * a choice, so a gateway that never uses the feature has no such file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFileSync,
  createLogger,
  DEFAULT_TAILSCALE_DEVICE_NAME,
  tailscaleJoinPolicySchema,
} from "@omnesis/core";
import { z } from "zod";

const log = createLogger("gateway:tailscale");

/** A Tailscale device name: one DNS label. */
export const deviceNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter a device name.")
  .max(63, "Use at most 63 characters.")
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "Use letters, digits and hyphens, starting and ending with a letter or digit.",
  );

const tailscaleSettingsSchema = z
  .object({
    /** The owner turned the gateway's own device on. */
    enabled: z.boolean(),
    deviceName: deviceNameSchema,
    /** The owner wants the public address for cloud agents. */
    publicAccess: z.boolean(),
    joinPolicy: tailscaleJoinPolicySchema,
  })
  .strict();
export type TailscaleSettings = z.infer<typeof tailscaleSettingsSchema>;

export const DEFAULT_TAILSCALE_SETTINGS: TailscaleSettings = Object.freeze({
  enabled: false,
  deviceName: DEFAULT_TAILSCALE_DEVICE_NAME,
  publicAccess: false,
  joinPolicy: "ask",
});

/** The directory every file of this feature lives under. */
export function tailscaleDir(configDir: string): string {
  return join(configDir, "tailscale");
}

export class TailscaleSettingsStore {
  private current: TailscaleSettings;
  private readonly path: string;

  constructor(configDir: string) {
    this.path = join(tailscaleDir(configDir), "settings.json");
    this.current = this.load();
  }

  get(): TailscaleSettings {
    return this.current;
  }

  update(patch: Partial<TailscaleSettings>): TailscaleSettings {
    const next = tailscaleSettingsSchema.parse({ ...this.current, ...patch });
    atomicWriteFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
    this.current = next;
    return next;
  }

  private load(): TailscaleSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_TAILSCALE_SETTINGS };
    try {
      const parsed = tailscaleSettingsSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (parsed.success) return parsed.data;
      const problems = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "file"}: ${i.message}`,
      );
      log.warn(`Ignoring unreadable Tailscale settings in ${this.path}: ${problems.join("; ")}`);
    } catch (err) {
      log.warn(
        `Ignoring unreadable Tailscale settings in ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ...DEFAULT_TAILSCALE_SETTINGS };
  }
}
