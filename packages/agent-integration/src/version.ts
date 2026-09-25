// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Product version of this integration build, read from the nearest
 * `package.json` above this module — the same walk under `src/*.ts` in
 * development and `dist/*.js` once published, since both live under the
 * package root.
 *
 * `@omnesis/core` carries the same helper, but this package deliberately
 * depends on nothing in the workspace at runtime: it is installed on a
 * harness machine that has no Omnesis checkout, so the handful of lines
 * below is the price of that isolation.
 *
 * A layout that hides the manifest yields `"0.0.0"` rather than throwing.
 * The version is something the gateway displays, and a plugin that refuses
 * to start because it cannot introspect its own metadata would be a far
 * worse failure than one reported as an implausible version.
 */
function readOwnManifest(): { version?: string; omnesisSourceCommit?: string } | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      return JSON.parse(raw) as { version?: string; omnesisSourceCommit?: string };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * The version announced in every device hello — the same number for the
 * OpenClaw and Hermes plugins, which are two harness bindings of one
 * package. It is what lets the gateway's version ledger see a plugin left
 * behind on a harness host the operator has not updated.
 */
const OWN_MANIFEST = readOwnManifest();
const OWN_VERSION = OWN_MANIFEST?.version;
const OWN_SOURCE_COMMIT = OWN_MANIFEST?.omnesisSourceCommit;

export const INTEGRATION_VERSION = OWN_VERSION ?? "0.0.0";

/** Exact clean source checkout from which this installed plugin was packed. */
export const INTEGRATION_SOURCE_COMMIT = /^[0-9a-f]{40}$/u.test(OWN_SOURCE_COMMIT ?? "")
  ? OWN_SOURCE_COMMIT
  : undefined;

/**
 * The same reading, for the callers that must distinguish "unknown" from a
 * version. The hello wants a string it can always send, so an unreadable
 * manifest becomes an implausible `0.0.0` there; drift detection wants the
 * opposite, because comparing an invented version against the gateway would
 * warn about a mismatch that does not exist. One read, two honest answers.
 */
export function agentIntegrationVersion(): string | undefined {
  return OWN_VERSION;
}

type VersionDrift = "aligned" | "plugin-behind" | "plugin-ahead" | "unknown";

interface VersionDriftReport {
  drift: VersionDrift;
  /** What the operator should do about it, or undefined when nothing is wrong. */
  warning?: string;
}

function parseVersion(value: string | undefined): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

/**
 * Tell a harness host that its plugin and its gateway disagree.
 *
 * The plugin is packed from whichever `@omnesis/agent-integration` sits beside
 * the CLI on the harness machine, and that machine upgrades on its own
 * schedule — usually not the gateway's. Nothing about a stale plugin looks
 * broken: it connects, it ingests, and then some newer wire field is quietly
 * absent. Omnesis versions in lockstep, so the two numbers should match, and
 * saying so the moment they do not is cheaper than diagnosing the symptom
 * later.
 *
 * A warning, never a refusal: the protocol version, negotiated separately, is
 * the only thing allowed to reject a connection. And a version either side
 * cannot parse is `unknown` and says nothing — an unrecognised string is far
 * more likely to be a development build than a real mismatch, and a warning
 * nobody can act on is noise.
 */
export function describeVersionDrift(
  pluginVersion: string | undefined,
  gatewayVersion: string | undefined,
  harness: string,
): VersionDriftReport {
  const plugin = parseVersion(pluginVersion);
  const gateway = parseVersion(gatewayVersion);
  if (!plugin || !gateway) return { drift: "unknown" };
  const order = compare(plugin, gateway);
  if (order === 0) return { drift: "aligned" };
  if (order < 0) {
    return {
      drift: "plugin-behind",
      warning:
        `The installed Omnesis ${harness} plugin is version ${pluginVersion}, older than the ` +
        `gateway's ${gatewayVersion}. Update Omnesis on this machine, then run ` +
        `\`omnesis connect ${harness} --refresh\`.`,
    };
  }
  return {
    drift: "plugin-ahead",
    warning:
      `The installed Omnesis ${harness} plugin is version ${pluginVersion}, newer than the ` +
      `gateway's ${gatewayVersion}. Upgrade the gateway first — it serves the wire contracts ` +
      `this plugin expects.`,
  };
}
