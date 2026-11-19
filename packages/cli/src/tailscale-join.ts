// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Joining a collector to a gateway through the owner's Tailscale network.
 *
 * The collector's own machine runs Tailscale. Its daemon lists the tailnet's
 * devices; the gateway's own device is the one named `omnesis` (or the name
 * its owner gave it) that answers as an Omnesis gateway. The gateway then
 * asks Tailscale whose machine the request comes from, and admits the
 * collector at once or after its owner approves, without a pairing code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertNever,
  execWindowsJob,
  ownedProcessCleanupReceipt,
  DEFAULT_TAILSCALE_DEVICE_NAME,
  TAILSCALE_STATUS_TIMEOUT_MS,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleJoinAnswerSchema,
  type TailscaleJoinAnswer,
} from "@omnesis/core";

/** One device in `tailscale status --json` that could be the gateway. */
export interface TailnetGatewayCandidate {
  /** The device's full tailnet name, without the trailing dot. */
  dnsName: string;
  online: boolean;
  /** Owned by the same Tailscale user as this machine. */
  sameOwner: boolean;
}

export interface LocalTailnet {
  running: boolean;
  candidates: TailnetGatewayCandidate[];
}

interface StatusPeer {
  DNSName?: string;
  HostName?: string;
  Online?: boolean;
  UserID?: number;
  Tags?: string[];
}

interface StatusJson {
  BackendState?: string;
  Self?: { UserID?: number };
  Peer?: Record<string, StatusPeer>;
}

/** The gateway's device names: the default, and the names Tailscale gives when it is taken. */
export function isGatewayDeviceName(
  firstLabel: string,
  preferred = DEFAULT_TAILSCALE_DEVICE_NAME,
): boolean {
  const escaped = preferred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(-\\d+)?$`, "i").test(firstLabel);
}

/**
 * Candidates from `tailscale status --json`, best first: the owner's own,
 * online devices whose name is the gateway's.
 */
export function gatewayCandidates(
  statusJson: string,
  preferredName = DEFAULT_TAILSCALE_DEVICE_NAME,
): LocalTailnet {
  let status: StatusJson;
  try {
    status = JSON.parse(statusJson) as StatusJson;
  } catch {
    return { running: false, candidates: [] };
  }
  if (status.BackendState !== "Running") return { running: false, candidates: [] };
  const self = status.Self?.UserID;
  const candidates = Object.values(status.Peer ?? {})
    .map((peer) => {
      const dnsName = (peer.DNSName ?? "").replace(/\.$/, "");
      const firstLabel = dnsName.split(".")[0] ?? "";
      return { peer, dnsName, firstLabel };
    })
    .filter(
      ({ dnsName, firstLabel }) =>
        dnsName.length > 0 && isGatewayDeviceName(firstLabel, preferredName),
    )
    .map(({ peer, dnsName }) => ({
      dnsName,
      online: peer.Online === true,
      sameOwner: self !== undefined && peer.UserID === self && !(peer.Tags && peer.Tags.length > 0),
    }));
  const score = (c: TailnetGatewayCandidate) => (c.sameOwner ? 2 : 0) + (c.online ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a) || a.dnsName.localeCompare(b.dnsName));
  return { running: true, candidates };
}

type TailnetStatusExecutor = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const execPosixStatus: TailnetStatusExecutor = (file, args, options) =>
  execFileAsync(file, [...args], options);

/** Read this machine's tailnet from the first Tailscale CLI that answers. */
export async function readLocalTailnet(
  preferredName = DEFAULT_TAILSCALE_DEVICE_NAME,
  dependencies: {
    platform?: NodeJS.Platform;
    candidates?: typeof tailscaleCliCandidates;
    windows?: TailnetStatusExecutor;
    posix?: TailnetStatusExecutor;
  } = {},
): Promise<LocalTailnet | null> {
  const execute =
    (dependencies.platform ?? process.platform) === "win32"
      ? (dependencies.windows ?? execWindowsJob)
      : (dependencies.posix ?? execPosixStatus);
  for (const candidate of (dependencies.candidates ?? tailscaleCliCandidates)()) {
    let output: string;
    try {
      ({ stdout: output } = await execute(candidate.file, ["status", "--json"], {
        env: tailscaleCliEnv(candidate),
        timeout: TAILSCALE_STATUS_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // An unconfirmed command owner is terminal; another candidate cannot
      // establish that the previous process and its descendants have closed.
      if (ownedProcessCleanupReceipt(error) !== undefined) throw error;
      continue;
    }
    return gatewayCandidates(output, preferredName);
  }
  return null;
}

/** What the gateway answers to a join request or a poll, as the CLI acts on it. */
export type JoinAnswer =
  | Extract<TailscaleJoinAnswer, { status: "joined" | "denied" | "gone" | "failed" }>
  | { status: "pending"; requestId: string; secret: string; expiresAt: string }
  | { status: "refused"; code?: string; error: string };

export interface JoinTransport {
  post(path: string, body: unknown): Promise<{ status: number; json: unknown }>;
}

function asAnswer(status: number, json: unknown): JoinAnswer {
  const parsed = tailscaleJoinAnswerSchema.safeParse(json);
  if (parsed.success) {
    const answer = parsed.data;
    switch (answer.status) {
      case "joined":
        if (status === 200) return answer;
        break;
      case "pending":
        if (status === 202 && answer.requestId && answer.secret) {
          return {
            status: "pending",
            requestId: answer.requestId,
            secret: answer.secret,
            expiresAt: answer.expiresAt,
          };
        }
        break;
      case "denied":
      case "gone":
      case "failed":
        return answer;
      default:
        return assertNever(answer);
    }
  }
  const body = (json ?? {}) as { code?: unknown; error?: unknown };
  return {
    status: "refused",
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    error: typeof body.error === "string" ? body.error : `The gateway answered ${status}.`,
  };
}

/**
 * Ask to join and wait for the answer. `onWaiting` runs once when the
 * request is held for the owner's approval.
 */
export async function requestJoin(input: {
  transport: JoinTransport;
  name: string;
  capabilities: Record<string, unknown>;
  onWaiting?: (expiresAt: string) => void;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  now?: () => number;
}): Promise<Exclude<JoinAnswer, { status: "pending" }>> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const asked = await input.transport.post("/tailscale/join", {
    name: input.name,
    capabilities: input.capabilities,
  });
  const first = asAnswer(asked.status, asked.json);
  if (first.status !== "pending") return first;
  input.onWaiting?.(first.expiresAt);
  const deadline = now() + (input.deadlineMs ?? 11 * 60 * 1000);
  while (now() < deadline) {
    await sleep(input.pollMs ?? 3000);
    const polled = await input.transport.post(
      `/tailscale/join/${encodeURIComponent(first.requestId)}/poll`,
      {
        secret: first.secret,
      },
    );
    // Still waiting, or checking too often: either way, wait and ask again.
    if (polled.status === 202 || polled.status === 429) continue;
    const answer = asAnswer(polled.status, polled.json);
    if (answer.status !== "pending") return answer;
  }
  return { status: "gone", error: "Nobody approved the request in time. Ask to join again." };
}
