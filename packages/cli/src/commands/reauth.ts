// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { sourceAccountOf, sourceTypeOf } from "@omnesis/types";
import {
  c,
  fetchDescriptors,
  fetchSourcesSnapshot,
  gatewayJson,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  EXIT_FAILURE,
  EXIT_GATEWAY_ERROR,
} from "../utils.js";
import { runAuthFlow } from "../auth-flow.js";
import {
  collectCredentialFields,
  fetchCredentialsStatus,
  isSameHostAsCollector,
} from "../credentials-wizard.js";
import {
  fetchUnionDescriptors,
  isInteractive,
  matchDevice,
  pickDeviceInteractively,
  type DeviceSummary,
} from "../device-picker.js";
import type { ConfiguredSourcesSnapshot, SerializedDescriptor } from "../utils.js";

/**
 * `cli reauth <provider-id>` — refresh credentials for every source under
 * the same provider+account without going through the full `cli add` wizard
 * (no config mutation and no cursor reset).
 *
 * Provider-id forms accepted:
 *   - `<providerType>:<accountId>` (e.g. `google:user@gmail.com`) — exact.
 *   - `<providerType>` alone (e.g. `google`) — auto-resolves when there's
 *     exactly one configured account for that provider.
 *   - `<sourceType>` (e.g. `gmail`) — back-compat: maps to its provider and
 *     auto-resolves when there's exactly one account.
 *   - `<sourceId>` (e.g. `gmail:user@gmail.com`) — back-compat: extracts the
 *     provider from the source.
 *
 * The flow:
 *   1. Resolve to a (providerType, accountId) pair, picking a configured
 *      source under that pair to drive the auth flow.
 *   2. Run the existing auth flow (`POST /admin/auth-flows`) — the
 *      subprocess writes fresh credentials to disk.
 *   3. Verify the resolved accountId matches what we expected.
 *   4. Call `POST /admin/sources/reauth-finalize` so the collector re-instantiates
 *      every sibling source under that provider+account, flipping them from
 *      `needs-auth` back to `idle` without a restart.
 */
export const reauthCommand = defineCommand({
  meta: {
    name: "reauth",
    description: "Refresh credentials for every source under a provider+account",
  },
  args: {
    providerId: {
      type: "positional",
      description: "Provider id (e.g. google:user@gmail.com) or provider/source type",
      required: false,
    },
    device: {
      type: "string",
      description:
        "Target collector device (name or id) — required when multiple collectors host the provider",
    },
  },
  async run(ctx) {
    const target = ctx.args.providerId;
    const deviceFlag = typeof ctx.args.device === "string" ? ctx.args.device : undefined;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: cli reauth <provider-id>${c.reset}\n` +
          `${c.dim}  Provider-id is "<providerType>:<accountId>" (e.g. google:user@gmail.com).${c.reset}\n` +
          `${c.dim}  When only one account is configured for a provider, the type alone works: cli reauth google${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const device = await resolveReauthDevice(target, deviceFlag);

    const [descSnapshot, sourcesSnapshot] = await withSpinner("Loading sources", async (spin) => {
      const descSnap = await fetchDescriptors(device.id);
      spin.message("Loading configured sources");
      const sourcesSnap = await fetchSourcesSnapshot(descSnap.deviceId);
      return [descSnap, sourcesSnap] as const;
    });

    const resolved = resolveProviderTarget(target, descSnapshot.items, sourcesSnapshot);
    if (!resolved) throw new CliError("", EXIT_USER_ERROR);

    const { providerType, providerName, accountId, driverSourceType, sources } = resolved;

    // Refuse early for providers without an auth flow. Apple sources,
    // browser-history, local Obsidian vaults, etc. have no credential flow to
    // repeat. Spelling this out is friendlier than letting the auth subprocess
    // fail with "Source apple-notes does not support auth flow" 30 seconds in.
    const driverDescriptor = descSnapshot.items.find((d) => d.id === driverSourceType);
    if (!driverDescriptor?.hasAuthFlow) {
      throw new CliError(
        `${c.red}${providerName} does not support re-authentication.${c.reset}\n` +
          `${c.dim}Reauth is for providers with replaceable credentials.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    console.log(
      `\n${c.bold}Re-authenticating ${providerName} (${accountId})${c.reset}` +
        (sources.length > 1 ? ` ${c.dim}— ${sources.length} sources${c.reset}` : ""),
    );
    for (const s of sources) {
      console.log(`  ${c.dim}• ${s}${c.reset}`);
    }
    console.log();

    const credentials = await collectReauthCredentials(driverDescriptor, descSnapshot.deviceId);

    // Run the auth flow. The subprocess writes fresh credentials to disk.
    // `accountId` rides along so the provider's authFlow knows which
    // existing account is being re-authed (and can reuse stored
    // per-account parameters); `acceptsAuthCode` gates the paste prompt.
    const newAccountId = await runAuthFlow(
      { deviceId: descSnapshot.deviceId },
      driverSourceType,
      {},
      {
        acceptsAuthCode: driverDescriptor.acceptsAuthCode,
        accountId,
        credentials,
      },
    );
    if (!newAccountId) {
      throw new CliError(`${c.red}Re-auth aborted.${c.reset}`, EXIT_FAILURE);
    }

    // Defend against the flow resolving a different account — that would write
    // credentials to a NEW account directory and leave the old (still-broken)
    // account untouched. Bail rather than silently
    // doing the wrong thing.
    if (newAccountId !== accountId) {
      throw new CliError(
        `${c.red}Auth resolved to a different account: expected ${accountId}, got ${newAccountId}.${c.reset}\n` +
          `${c.dim}Credentials were written for ${newAccountId}. The original account still needs reauth — re-run with the right account, or run \`cli add ${driverSourceType}\` to add the new account as a separate source set.${c.reset}`,
        EXIT_FAILURE,
      );
    }

    // Credentials are on disk for the right account. Tell the collector to
    // re-instantiate every sibling source under the provider+account so they
    // pick up the fresh credentials in-memory.
    let result: { sourceIds?: string[] };
    try {
      result = await withSpinner("Refreshing sources", () =>
        gatewayJson<{ sourceIds: string[] }>(`/admin/sources/reauth-finalize`, {
          method: "POST",
          body: JSON.stringify({
            deviceId: device.id,
            providerType,
            accountId,
            sourceType: driverSourceType,
          }),
        }),
      );
    } catch (err) {
      throw new CliError(
        `${c.red}Reauth finalize failed: ${err instanceof Error ? err.message : String(err)}${c.reset}\n` +
          `${c.dim}Fresh credentials are on disk. Restart the collector to pick them up — or retry \`cli reauth ${providerType}:${accountId}\`.${c.reset}`,
        EXIT_GATEWAY_ERROR,
      );
    }

    console.log(`\n${c.green}Re-authenticated ${providerName} (${accountId}).${c.reset}`);
    for (const sourceId of result.sourceIds ?? []) {
      console.log(`${c.dim}  • refreshed: ${sourceId}${c.reset}`);
    }
  },
});

interface ReauthCredentialDeps {
  fetchStatus: typeof fetchCredentialsStatus;
  sameHost: typeof isSameHostAsCollector;
  collect: typeof collectCredentialFields;
  interactive: typeof isInteractive;
  /** Ask whether to type replacement credentials; false = revalidate stored. */
  confirmReplace: () => Promise<boolean>;
}

async function promptReplaceCredentials(): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const replace = await prompts.confirm({
    message: "Enter replacement credentials? (No revalidates the stored ones)",
    initialValue: false,
  });
  return replace === true;
}

export async function collectReauthCredentials(
  descriptor: SerializedDescriptor,
  deviceId: string,
  deps: ReauthCredentialDeps = {
    fetchStatus: fetchCredentialsStatus,
    sameHost: isSameHostAsCollector,
    collect: collectCredentialFields,
    interactive: isInteractive,
    confirmReplace: promptReplaceCredentials,
  },
): Promise<Record<string, string> | undefined> {
  if (!descriptor.credentials?.perAccount) return undefined;
  // Stored credentials are the default: every per-account auth flow
  // revalidates them when no replacement fields are supplied, which keeps
  // `sources reauth` zero-prompt — and usable non-interactively — while the
  // secret is still valid. The wizard exists for the rotated-secret case,
  // so it is offered, never forced, and only where a prompt can be answered.
  if (!deps.interactive() || !(await deps.confirmReplace())) return undefined;
  const status = await deps.fetchStatus(deviceId);
  const entry = status.items.find((item) => item.fileKey === descriptor.credentials?.fileKey);
  if (!entry) {
    throw new CliError(
      `${c.red}Credentials spec not found for ${descriptor.credentials.fileKey}.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const fields = await deps.collect(entry, {
    sameHost: deps.sameHost(status.hostname),
    perAccount: true,
  });
  if (!fields) {
    throw new CliError(`${c.red}Re-authentication cancelled.${c.reset}`, EXIT_USER_ERROR);
  }
  return fields;
}

interface ResolvedTarget {
  providerType: string;
  providerName: string;
  accountId: string;
  /** The source-type used to drive the auth flow (any configured source under the provider works). */
  driverSourceType: string;
  /** Configured source-ids under (providerType, accountId) — for the user-facing summary. */
  sources: string[];
}

export function resolveProviderTarget(
  target: string,
  descriptors: SerializedDescriptor[],
  snapshot: ConfiguredSourcesSnapshot,
): ResolvedTarget | undefined {
  const sourceToProvider = new Map<string, { providerId: string; providerName: string }>();
  for (const d of descriptors) {
    sourceToProvider.set(d.id, { providerId: d.provider.id, providerName: d.provider.name });
  }
  const providerNames = new Map<string, string>();
  for (const d of descriptors) {
    providerNames.set(d.provider.id, d.provider.name);
  }

  const colonIdx = target.indexOf(":");
  let providerType: string | undefined;
  let accountId: string | undefined;

  if (colonIdx !== -1) {
    const head = target.slice(0, colonIdx);
    const tail = target.slice(colonIdx + 1);
    // Provider-form: "google:user@gmail.com". Validate against descriptors.
    if (providerNames.has(head)) {
      providerType = head;
      accountId = tail;
    } else if (sourceToProvider.has(head)) {
      // Source-id form: "gmail:user@gmail.com" — collapse to the provider.
      const info = sourceToProvider.get(head)!;
      providerType = info.providerId;
      accountId = tail;
    } else {
      console.error(`${c.red}Unknown provider or source: ${head}${c.reset}`);
      console.error(`${c.dim}Known providers: ${[...providerNames.keys()].join(", ")}${c.reset}`);
      return undefined;
    }
  } else {
    if (providerNames.has(target)) {
      providerType = target;
    } else if (sourceToProvider.has(target)) {
      providerType = sourceToProvider.get(target)!.providerId;
    } else {
      console.error(`${c.red}Unknown provider or source: ${target}${c.reset}`);
      console.error(`${c.dim}Known providers: ${[...providerNames.keys()].join(", ")}${c.reset}`);
      return undefined;
    }
  }

  // Collect configured sources for the provider — group by accountId so we
  // can either auto-pick (single account) or report the candidates (multi).
  const byAccount = new Map<string, string[]>();
  for (const [key, cfg] of Object.entries(snapshot.configured)) {
    if (!cfg.enabled) continue;
    const sourceType = sourceTypeOf(key);
    const acct = sourceAccountOf(key) || "local";
    const info = sourceToProvider.get(sourceType);
    if (!info || info.providerId !== providerType) continue;
    const list = byAccount.get(acct) ?? [];
    list.push(key);
    byAccount.set(acct, list);
  }

  if (byAccount.size === 0) {
    console.error(`${c.red}No configured sources found for provider ${providerType}.${c.reset}`);
    console.error(`${c.dim}Run \`cli add\` first.${c.reset}`);
    return undefined;
  }

  if (accountId) {
    const sources = byAccount.get(accountId);
    if (!sources) {
      console.error(
        `${c.red}No configured sources found for ${providerType}:${accountId}.${c.reset}`,
      );
      console.error(`${c.dim}Configured accounts: ${[...byAccount.keys()].join(", ")}${c.reset}`);
      return undefined;
    }
    return {
      providerType,
      providerName: providerNames.get(providerType) ?? providerType,
      accountId,
      driverSourceType: pickDriverSourceType(sources),
      sources,
    };
  }

  // No account specified — only allow when exactly one account is configured
  // under this provider. Multiple accounts would need disambiguation; we
  // refuse rather than guess (authenticating the wrong account is worse
  // than asking the user to be explicit).
  if (byAccount.size > 1) {
    console.error(
      `${c.red}Multiple accounts configured for ${providerType}: ${[...byAccount.keys()].join(", ")}.${c.reset}`,
    );
    console.error(`${c.dim}Specify which one: cli reauth ${providerType}:<accountId>${c.reset}`);
    return undefined;
  }
  const [singleAccount, sources] = [...byAccount.entries()][0];
  return {
    providerType,
    providerName: providerNames.get(providerType) ?? providerType,
    accountId: singleAccount,
    driverSourceType: pickDriverSourceType(sources),
    sources,
  };
}

/**
 * The auth flow needs a sourceType to start (the descriptor it dispatches to).
 * Any configured source under the provider works — they all share the
 * provider credential. Prefer alphabetical for stability.
 */
function pickDriverSourceType(sourceKeys: string[]): string {
  const types = sourceKeys.map(sourceTypeOf).sort();
  return types[0];
}

interface DeviceListItem {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  revokedAt?: number | null;
}

interface AdminSourceRow {
  id: string;
  type: string;
  accountId: string;
  deviceId: string;
  /** Absent from gateway versions that predate multi-device membership. */
  members?: string[];
}

/**
 * Resolve which device's collector should drive the reauth flow.
 *
 * The candidate set is the union of every matching source's members, not only
 * the source's owner. `--device` selects inside that set; without it, one
 * candidate is automatic and several require an interactive pick (or fail
 * explicitly in a non-TTY). Membership is checked before the auth subprocess
 * writes credentials to the selected collector's local disk.
 *
 * Keeps the gateway-side reauth resolver as the second line of defence —
 * the CLI's upfront pick covers the descriptor + auth-flow calls that
 * happen before the reauth-finalize POST.
 */
async function resolveReauthDevice(
  target: string,
  deviceFlag: string | undefined,
): Promise<DeviceSummary> {
  const { items: devices } = await gatewayJson<{ items: DeviceListItem[] }>("/admin/devices");
  const onlineCollectors = devices.filter((d) => d.kind === "collector" && d.online);
  if (onlineCollectors.length === 0) {
    throw new CliError(
      `${c.red}No online collector. Start one (or pair one) before reauthing.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  // Figure out which member device(s) host sources matching the target. The
  // target is either `<providerType>:<accountId>`,
  // `<providerType>`, `<sourceType>`, or `<sourceType>:<accountId>`. We need
  // the union of descriptors to know which sourceTypes belong to which
  // provider.
  const union = await fetchUnionDescriptors();
  const sourceTypeToProvider = new Map<string, string>();
  for (const d of union) {
    const provider = (d.provider ?? null) as { id?: string } | null;
    if (provider?.id) sourceTypeToProvider.set(d.id, provider.id);
  }
  const head = sourceTypeOf(target);
  const accountId = sourceAccountOf(target) || null;
  // Normalise: if head is a sourceType, map to its provider; otherwise
  // treat as a providerType directly (no map lookup needed).
  const providerType = sourceTypeToProvider.get(head) ?? head;

  const { items: allSources } = await gatewayJson<{ items: AdminSourceRow[] }>("/admin/sources");
  const matching = allSources.filter((s) => {
    const sProvider = sourceTypeToProvider.get(s.type);
    if (sProvider !== providerType) return false;
    if (accountId && s.accountId !== accountId) return false;
    return true;
  });
  const deviceIds = Array.from(
    new Set(
      matching.flatMap((s) => [
        s.deviceId,
        ...(s.members ?? []).filter((deviceId) => deviceId !== s.deviceId),
      ]),
    ),
  );
  const candidates = onlineCollectors
    .filter((d) => deviceIds.includes(d.id))
    .map((d) => ({ id: d.id, name: d.name }));

  if (deviceFlag) {
    const resolved = matchDevice(devices, deviceFlag);
    if ("error" in resolved) {
      throw new CliError(`${c.red}${resolved.error}${c.reset}`, EXIT_USER_ERROR);
    }
    const selected = resolved.device;
    if (!candidates.some((candidate) => candidate.id === selected.id)) {
      throw new CliError(
        `${c.red}${selected.name} does not host sources for ${target} on an online collector.${c.reset}\n` +
          `${c.dim}Choose a member shown by 'omnesis sources' or 'omnesis sources members <id>'.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    return { id: selected.id, name: selected.name };
  }

  if (candidates.length === 0) {
    throw new CliError(
      `${c.red}No online collector hosts sources for ${target}.${c.reset}\n` +
        `${c.dim}Either add the source first (omnesis sources add), or pass --device <name>.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (!isInteractive()) {
    throw new CliError(
      `${c.red}Multiple devices host sources for ${target}: ${candidates.map((d) => d.name).join(", ")}.${c.reset}\n` +
        `${c.dim}Re-run with --device <name>.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return pickDeviceInteractively(candidates, `Multiple collectors host ${target}. Which one?`);
}
