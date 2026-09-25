// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayJson,
  gatewayFetch,
  buildCliFx,
  iconFor,
  withSpinner,
  resolvePatterns,
  CliError,
  EXIT_USER_ERROR,
} from "../utils.js";
import {
  waitForSyncCompletion,
  type SyncStatusObservation,
  type SourceWaitState,
  type WaitOutcome,
} from "./sync-wait.js";

interface AdminSource {
  id: string;
  type: string;
  accountId: string;
  deviceId: string;
  enabled: boolean;
  /** Every hosting device, owner first. */
  members: string[];
  leaseHolder: string | null;
}

interface AdminDevice {
  id: string;
  name: string;
}

/** One member's answer to a fanned-out sync (`POST /admin/sources/:id/sync`). */
interface SyncDispatchResult {
  deviceId: string;
  ok: boolean;
  triggered?: number;
  skipped?: number;
  disabled?: number;
  error?: string;
}

/**
 * The body of a successful `POST /admin/sources/:id/sync`: `results` when the
 * gateway reached every member, else the one device it sent the sync to and
 * that device's answer.
 */
export interface SyncDispatchBody {
  ok: true;
  deviceId?: string;
  result?: Pick<SyncDispatchResult, "ok" | "triggered" | "skipped" | "disabled">;
  results?: SyncDispatchResult[];
}

interface SyncStatusEntry {
  sourceId: string;
  state: SyncStatusObservation["state"];
  errorMessage?: string;
}

interface SourceStatsRow {
  documentCount: number;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 1_000;

/** Fetch per-source document counts for the given ids (`POST /documents/stats`). */
async function fetchDocCounts(ids: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const { stats } = await gatewayJson<{ stats: Record<string, SourceStatsRow> }>(
    "/documents/stats",
    { method: "POST", body: JSON.stringify({ sourceIds: ids }) },
  );
  for (const id of ids) counts.set(id, stats[id]?.documentCount ?? 0);
  return counts;
}

/**
 * Render where a sync went. A single target is named on the line, with what
 * it did: a device that accepted the command but started nothing — the
 * source was already syncing or is paused there — skipped it. A fan-out
 * lists every member — the ones the gateway reached with their answer, the
 * ones it did not as offline.
 */
export function renderSyncDispatch(
  body: SyncDispatchBody,
  source: Pick<AdminSource, "deviceId" | "members" | "leaseHolder">,
  deviceName: (id: string) => string,
  idLabel: string,
): string[] {
  if (!body.results) {
    const target = deviceName(body.deviceId ?? source.leaseHolder ?? source.deviceId);
    if (body.result?.triggered === 0) {
      const reason =
        (body.result.disabled ?? 0) > 0
          ? `the source is paused on ${target}`
          : `${target} was already syncing`;
      return [`${c.yellow}Sync skipped; ${reason}:${c.reset} ${idLabel}`];
    }
    return [`${c.green}Sync sent to ${target}:${c.reset} ${idLabel}`];
  }
  const lines = [`${c.green}Sync sent:${c.reset} ${idLabel}`];
  for (const r of body.results) {
    const name = deviceName(r.deviceId);
    if (!r.ok) {
      lines.push(`  ${c.red}✗${c.reset} ${name}: ${r.error ?? "collector rejected the sync"}`);
    } else if ((r.triggered ?? 0) > 0) {
      lines.push(`  ${c.green}✓${c.reset} ${name}`);
    } else {
      lines.push(`  ${c.dim}– ${name} skipped${c.reset}`);
    }
  }
  const reached = new Set(body.results.map((r) => r.deviceId));
  for (const member of source.members) {
    if (!reached.has(member)) lines.push(`  ${c.dim}– ${deviceName(member)} offline${c.reset}`);
  }
  return lines;
}

/** Render one source's terminal outcome line. */
function outcomeLine(
  st: SourceWaitState,
  iconPrefix: string,
  before: number,
  after: number,
): string {
  const id = `${iconPrefix}${c.bold}${st.sourceId}${c.reset}`;
  const delta = after - before;
  const deltaStr =
    delta > 0
      ? `${c.green}+${delta}${c.reset}`
      : delta < 0
        ? `${c.red}${delta}${c.reset}`
        : `${c.dim}±0${c.reset}`;
  const docs = `${c.dim}(${after} docs, ${deltaStr})${c.reset}`;
  const msg = st.message ? ` ${c.dim}— ${st.message}${c.reset}` : "";
  switch (st.outcome) {
    case "success":
      return `${c.green}Synced:${c.reset} ${id} ${docs}`;
    case "needs-auth":
      return `${c.red}Needs auth:${c.reset} ${id} ${docs} — run ${c.cyan}omnesis sources reauth ${st.sourceId}${c.reset}`;
    case "rate-limited":
      return `${c.yellow}Rate-limited:${c.reset} ${id} ${docs} — will retry on next deferred tick${msg}`;
    case "permission-degraded":
      return `${c.yellow}Permission degraded:${c.reset} ${id} ${docs} — repair access in the mobile app${msg}`;
    case "background-access-missing":
      return `${c.yellow}Background access missing:${c.reset} ${id} ${docs} — repair access in the mobile app${msg}`;
    case "unavailable":
      return `${c.red}Permission unavailable:${c.reset} ${id} ${docs} — review the source on its mobile device${msg}`;
    case "paused":
      return `${c.red}Paused mid-wait:${c.reset} ${id} ${docs}${msg}`;
    case "error":
      return `${c.red}Error:${c.reset} ${id} ${docs}${msg}`;
    case "timeout":
      return (
        `${c.red}Timed out:${c.reset} ${id} ${docs} — last state ` +
        `${c.dim}${st.lastObserved ?? "unknown"}${c.reset}` +
        (st.observedSyncing ? "" : ` ${c.dim}(never observed syncing)${c.reset}`)
      );
    default:
      return `${c.dim}Unknown outcome:${c.reset} ${id} ${docs}`;
  }
}

const SUCCESS_OUTCOMES = new Set<WaitOutcome>(["success"]);

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Trigger an incremental sync for one or more sources",
  },
  args: {
    wait: {
      type: "boolean",
      description: "Block until each triggered source reaches a terminal state",
      default: false,
    },
    timeout: {
      type: "string",
      description: `With --wait, max seconds to wait per run (default ${DEFAULT_TIMEOUT_SECONDS})`,
      default: String(DEFAULT_TIMEOUT_SECONDS),
    },
  },
  async run(ctx) {
    const patterns = (ctx.args._ as string[]) ?? [];
    if (patterns.length === 0) {
      throw new CliError(
        `${c.red}Usage: omnesis sources sync <pattern> [pattern...] [--wait] [--timeout <seconds>]${c.reset}\n\n` +
          `Examples:\n` +
          `  ${c.cyan}omnesis sources sync all${c.reset}                       Sync all sources\n` +
          `  ${c.cyan}omnesis sources sync gmail:${c.reset}                    Sync all Gmail accounts\n` +
          `  ${c.cyan}omnesis sources sync gmail:user@gmail.com${c.reset}      Sync a specific source\n` +
          `  ${c.cyan}omnesis sources sync apple: chrome:${c.reset}            Sync multiple types\n` +
          `  ${c.cyan}omnesis sources sync all --wait${c.reset}                Sync all and block until done\n` +
          `  ${c.cyan}omnesis sources sync gmail: --wait --timeout 120${c.reset}  Wait up to 120s\n\n` +
          `Run ${c.cyan}omnesis sources${c.reset} to see available source IDs.`,
        EXIT_USER_ERROR,
      );
    }

    const wait = ctx.args.wait === true;
    const timeoutSeconds = Number(ctx.args.timeout);
    if (wait && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
      throw new CliError(
        `${c.red}--timeout must be a positive number of seconds (got "${ctx.args.timeout}")${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const [{ items: sources }, { items: devices }] = await withSpinner(
      "Loading sources and devices",
      () =>
        Promise.all([
          gatewayJson<{ items: AdminSource[] }>("/admin/sources"),
          gatewayJson<{ items: AdminDevice[] }>("/admin/devices"),
        ]),
    );
    if (sources.length === 0) {
      console.log(`${c.dim}No sources registered with the gateway.${c.reset}`);
      return;
    }
    const deviceName = (id: string): string => devices.find((d) => d.id === id)?.name ?? id;

    // Reuse the existing pattern matcher. providerId here is the source type
    // (we don't track providerId on /admin/sources rows yet).
    const entries = sources.map((s) => ({ id: s.id, providerId: s.type }));
    const ids = resolvePatterns(patterns, entries);

    if (ids.length === 0) {
      throw new CliError(
        `${c.red}No sources matched: ${patterns.join(", ")}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const fx = await buildCliFx();
    const iconPrefixFor = (id: string): string => {
      const icon = iconFor(id, fx);
      return icon ? `${icon} ` : "";
    };

    // Capture pre-sync doc counts up front so a --wait run can report a delta
    // even if the sync deletes documents (delta can be negative).
    const docsBefore = wait ? await fetchDocCounts(ids) : new Map<string, number>();

    const triggered: string[] = [];
    for (const id of ids) {
      const iconPrefix = iconPrefixFor(id);
      const source = sources.find((s) => s.id === id);
      if (!source) continue;
      if (!source.enabled) {
        console.log(
          `${c.red}Paused:${c.reset} ${iconPrefix}${c.dim}${id}${c.reset} — run ${c.cyan}omnesis sources resume ${id}${c.reset} first`,
        );
        continue;
      }

      const res = await withSpinner(`Triggering sync: ${id}`, () =>
        gatewayFetch(`/admin/sources/${encodeURIComponent(id)}/sync`, { method: "POST" }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(`${c.red}Failed: ${iconPrefix}${id} — ${body.error ?? res.status}${c.reset}`);
        continue;
      }
      const body = (await res.json()) as SyncDispatchBody;
      const idLabel = `${iconPrefix}${c.bold}${id}${c.reset}`;
      for (const line of renderSyncDispatch(body, source, deviceName, idLabel)) {
        console.log(line);
      }
      triggered.push(id);
    }

    if (!wait || triggered.length === 0) return;

    console.log(
      `\n${c.dim}Waiting for ${triggered.length} source(s) to finish (timeout ${timeoutSeconds}s)…${c.reset}`,
    );

    const states = await withSpinner("Waiting for sync to complete", () =>
      waitForSyncCompletion(
        {
          sourceIds: triggered,
          timeoutMs: timeoutSeconds * 1_000,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        {
          fetchStatus: async () => {
            const { items } = await gatewayJson<{ items: SyncStatusEntry[] }>("/admin/sync/status");
            return items
              .filter((i) => triggered.includes(i.sourceId))
              .map((i) => ({
                sourceId: i.sourceId,
                state: i.state,
                errorMessage: i.errorMessage,
              }));
          },
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      ),
    );

    const docsAfter = await fetchDocCounts(triggered);

    console.log();
    for (const id of triggered) {
      const st = states.get(id)!;
      console.log(
        outcomeLine(st, iconPrefixFor(id), docsBefore.get(id) ?? 0, docsAfter.get(id) ?? 0),
      );
    }

    const failed = triggered.filter((id) => !SUCCESS_OUTCOMES.has(states.get(id)!.outcome!));
    if (failed.length > 0) {
      // Fail loud: a non-success terminal (error/needs-auth/rate-limited/paused)
      // or a timeout exits non-zero so a script driving `--wait` can branch on it.
      throw new CliError(
        `${c.red}${failed.length} of ${triggered.length} source(s) did not sync successfully: ${failed.join(", ")}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
  },
});
