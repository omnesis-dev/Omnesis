// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Multi-collector device disambiguation helpers shared by `sources add`,
 * `sources reauth` and the membership commands. Entry points:
 *
 *   - `matchDevice(devices, input)` — the one rule for reading a --device
 *     value (id or human name) against a device list.
 *   - `resolveDeviceFlag(input)` — fetch the paired devices and apply
 *     `matchDevice`, returning the {id, name} pair or a user error.
 *   - `pickDeviceInteractively(devices, message)` — render a @clack/prompts
 *     select picker over the supplied list.
 *   - `pickDeviceForDescriptor(descriptor)` — auto-pick when one device
 *     hosts, otherwise picker (TTY) or structured error (non-TTY).
 *
 * Plus `fetchUnionDescriptors` for callers that need the
 * cross-collector descriptor list (`GET /admin/source-descriptors`).
 */

import { c, CliError, EXIT_CANCELLED, EXIT_USER_ERROR, gatewayJson } from "./utils.js";

export interface DeviceSummary {
  id: string;
  name: string;
}

interface DeviceListResponse {
  items: Array<{
    id: string;
    name: string;
    kind: string;
    online: boolean;
    revokedAt?: number | null;
    capabilities?: { hostname?: string };
  }>;
}

/** The fields `matchDevice` reads; any richer device record qualifies. */
export interface MatchableDevice {
  id: string;
  name: string;
  revokedAt?: number | null;
}

/**
 * Resolve a `--device <name|id>` value against `devices`: an exact id or
 * name match among the devices that are not revoked. A miss lists the names
 * that exist so the flag can be corrected without another round-trip.
 * `devices.name` is `UNIQUE NOT NULL` in the gateway schema, so the
 * multi-match refusal only fires if that constraint ever drifts — it
 * surfaces the regression instead of picking one silently.
 */
export function matchDevice<D extends MatchableDevice>(
  devices: readonly D[],
  input: string,
): { device: D } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "--device cannot be empty" };
  const live = devices.filter((d) => !d.revokedAt);
  const matches = live.filter((d) => d.id === trimmed || d.name === trimmed);
  if (matches.length === 0) {
    const names = live.map((d) => d.name).join(", ") || "(none)";
    return { error: `No device named or ided "${trimmed}" — paired devices: ${names}` };
  }
  if (matches.length > 1) {
    return {
      error: `Multiple devices match "${trimmed}" — pass the device id instead of the name`,
    };
  }
  return { device: matches[0]! };
}

/** Fetch the paired devices and resolve `--device <name-or-id>` among them. */
export async function resolveDeviceFlag(input: string): Promise<DeviceSummary> {
  const { items } = await gatewayJson<DeviceListResponse>("/admin/devices");
  const resolved = matchDevice(items, input);
  if ("error" in resolved) {
    throw new CliError(`${c.red}${resolved.error}${c.reset}`, EXIT_USER_ERROR);
  }
  return { id: resolved.device.id, name: resolved.device.name };
}

/**
 * Interactive @clack/prompts picker over the supplied devices. Caller is
 * responsible for the TTY check via `isInteractive()` — in non-interactive
 * contexts a structured `CliError` should be thrown instead so scripts
 * get a stable exit code + error text.
 */
export async function pickDeviceInteractively(
  devices: DeviceSummary[],
  message = "Which device should host this?",
): Promise<DeviceSummary> {
  if (devices.length === 0) {
    throw new CliError(`${c.red}No devices to pick from.${c.reset}`, EXIT_USER_ERROR);
  }
  if (devices.length === 1) return devices[0];
  const prompts = await import("@clack/prompts");
  const selected = await prompts.select({
    message,
    options: devices.map((d) => ({ value: d.id, label: d.name, hint: d.id })),
  });
  if (prompts.isCancel(selected)) {
    prompts.cancel("Cancelled.");
    throw new CliError("", EXIT_CANCELLED);
  }
  const pick = devices.find((d) => d.id === selected);
  if (!pick) throw new CliError(`${c.red}Picker returned unknown id.${c.reset}`, EXIT_USER_ERROR);
  return pick;
}

/** True when both stdin and stdout are TTYs — execFile children fail both. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/**
 * Descriptor enriched with the list of devices that advertise it.
 * Shape of items returned by `GET /admin/source-descriptors` (union
 * across all online collectors).
 */
export interface UnionDescriptor extends Record<string, unknown> {
  id: string;
  devices: DeviceSummary[];
}

interface UnionDescriptorsResponse {
  items: UnionDescriptor[];
  pageInfo: { hasMore: boolean; limit: number };
}

export async function fetchUnionDescriptors(): Promise<UnionDescriptor[]> {
  const { items } = await gatewayJson<UnionDescriptorsResponse>("/admin/source-descriptors");
  return items;
}

/**
 * Resolve which device should host a given descriptor. Auto-picks when one
 * device qualifies, otherwise prompts (TTY) or throws (non-TTY). Callers
 * who handled `--device` upfront via `resolveDeviceFlag` skip this.
 */
export async function pickDeviceForDescriptor(descriptor: UnionDescriptor): Promise<DeviceSummary> {
  if (descriptor.devices.length === 0) {
    throw new CliError(
      `${c.red}No online collector hosts "${descriptor.id}".${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (descriptor.devices.length === 1) return descriptor.devices[0];
  if (!isInteractive()) {
    throw new CliError(
      `${c.red}Multiple collectors host "${descriptor.id}".${c.reset}\n` +
        `Re-run with --device <name>. Options: ${descriptor.devices.map((d) => d.name).join(", ")}`,
      EXIT_USER_ERROR,
    );
  }
  return pickDeviceInteractively(
    descriptor.devices,
    `Which collector should host ${descriptor.id}?`,
  );
}
