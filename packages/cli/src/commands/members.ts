// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis sources members <id>` — the devices that host one source, each
 * with its own sync status. Also home to the loading and resolution helpers
 * `sources join` and `sources detach` share: the admin source row with its
 * membership, the paired device list, and the `--device` flag resolver.
 */

import { defineCommand } from "citty";
import { c, gatewayJson, withSpinner, formatTimeAgo, CliError, EXIT_USER_ERROR } from "../utils.js";
import { matchDevice } from "../device-picker.js";
import type { MultiDeviceMode, SourceNotice, SyncRemediation } from "@omnesis/types";

/** One row of `GET /admin/sources`, with the fields the membership commands read. */
export interface AdminSourceEntry {
  id: string;
  type: string;
  deviceId: string;
  enabled: boolean;
  /** Every hosting device, owner first. */
  members: string[];
  /**
   * How the source's type shares its host list. Absent from a gateway whose
   * listing predates it — read it through `sourceMode`, never directly, so a
   * listing that does not carry it fails closed instead of reading as a mode
   * that admits a second host.
   */
  multiDeviceMode?: MultiDeviceMode;
  leaseHolder: string | null;
  /** Items one member reported deleted that another still holds. Absent from an older gateway's listing. */
  disputedDeletions?: number;
  pushBased: boolean;
  /**
   * Devices that are not members and may host this source's type; empty for
   * an exclusive source. Absent from an older gateway's listing.
   */
  joinCandidates?: string[];
}

/** One row of `GET /admin/devices`. */
export interface AdminDeviceEntry {
  id: string;
  name: string;
  kind: string;
  online?: boolean;
  revokedAt?: number | null;
}

/**
 * A device an operation is aimed at. The gateway's own row when the listing
 * carries it; otherwise only what the caller knows — the id, and the id
 * standing in for a name. `kind` and `online` are then absent rather than
 * invented, so the copy that turns on them says nothing instead of something
 * false.
 */
export type TargetDevice = Pick<AdminDeviceEntry, "id" | "name"> &
  Partial<Pick<AdminDeviceEntry, "kind" | "online">>;

/**
 * A source's multi-device mode, failing closed. A listing without the field
 * predates it, and the mode that admits no second host is the only reading
 * that cannot mislead: offering a join the gateway would refuse is worse than
 * pointing the operator at `sources move`.
 */
export function sourceMode(source: Pick<AdminSourceEntry, "multiDeviceMode">): MultiDeviceMode {
  return source.multiDeviceMode ?? "exclusive";
}

/**
 * Phone-pushed source lifecycle belongs to the app that can request the OS
 * permission and stop its local schedulers. A CLI mutation would change only
 * gateway state and leave the originating device's switch lying about it.
 */
export function assertCliManagedSource(source: Pick<AdminSourceEntry, "id" | "pushBased">): void {
  if (!source.pushBased) return;
  throw new CliError(
    `${c.red}${source.id} is managed by the phone or browser that contributes it. ` +
      `Use Omnesis on that device to change which devices contribute.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

/** One row of `GET /admin/sync/status`; `members` carries each device's own row when several contribute. */
export interface MemberSyncStatus {
  sourceId: string;
  deviceId?: string;
  state: string;
  lastSyncAt?: string | null;
  errorMessage?: string;
  /** The structured remedy behind an `error`, when the failure named one. */
  remediation?: SyncRemediation;
  members?: MemberSyncStatus[];
  /** Items this device's replica still holds that another member reported deleted. */
  restoredClaims?: number;
  /** The gateway's person-facing notices for this device. */
  notices?: SourceNotice[];
}

interface SourceContext {
  source: AdminSourceEntry;
  devices: AdminDeviceEntry[];
}

/** Fetch every admin source row and the device list in one round. */
export async function loadSourcesAndDevices(): Promise<{
  sources: AdminSourceEntry[];
  devices: AdminDeviceEntry[];
}> {
  const [{ items: sources }, { items: devices }] = await withSpinner(
    "Loading sources and devices",
    () =>
      Promise.all([
        gatewayJson<{ items: AdminSourceEntry[] }>("/admin/sources"),
        gatewayJson<{ items: AdminDeviceEntry[] }>("/admin/devices"),
      ]),
  );
  return { sources, devices };
}

/**
 * Fetch the source row and the device list in one round. A missing source is
 * a user error: the id is what the operator typed.
 */
export async function loadSourceContext(sourceId: string): Promise<SourceContext> {
  const { sources, devices } = await loadSourcesAndDevices();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    throw new CliError(`${c.red}No source with id: ${sourceId}${c.reset}`, EXIT_USER_ERROR);
  }
  return { source, devices };
}

/** The gateway's error envelope on a failed response; the HTTP status stands in for a body that is not one. */
interface GatewayErrorBody {
  error: string;
  code?: string;
  detail?: unknown;
}

export async function readGatewayError(res: Response): Promise<GatewayErrorBody> {
  const body = (await res.json().catch(() => ({}))) as Partial<GatewayErrorBody>;
  return {
    error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
    code: body.code,
    detail: body.detail,
  };
}

/** The display name of a device id; the id itself when the device is unknown. */
export function deviceLabel(devices: readonly AdminDeviceEntry[], deviceId: string): string {
  return devices.find((d) => d.id === deviceId)?.name ?? deviceId;
}

/** Read the required `--device` flag, resolving it or failing as a user error. */
export function requireMemberDevice(
  devices: readonly AdminDeviceEntry[],
  deviceFlag: unknown,
  usage: string,
): AdminDeviceEntry {
  if (typeof deviceFlag !== "string") {
    throw new CliError(`${c.red}${usage}${c.reset}`, EXIT_USER_ERROR);
  }
  const resolved = matchDevice(devices, deviceFlag);
  if ("error" in resolved) {
    throw new CliError(`${c.red}${resolved.error}${c.reset}`, EXIT_USER_ERROR);
  }
  return resolved.device;
}

/**
 * Each member's own sync status. A source several devices contribute to
 * carries one row per member; otherwise the source's single row belongs to
 * the device it names, or to the owner when it names none. A member with no
 * row has never synced the source.
 */
export function statusByMember(
  source: Pick<AdminSourceEntry, "members">,
  status: MemberSyncStatus | undefined,
): Map<string, MemberSyncStatus | undefined> {
  const byMember = new Map<string, MemberSyncStatus | undefined>();
  for (const deviceId of source.members) byMember.set(deviceId, undefined);
  if (!status) return byMember;
  if (status.members) {
    for (const row of status.members) {
      if (row.deviceId && byMember.has(row.deviceId)) byMember.set(row.deviceId, row);
    }
    return byMember;
  }
  const holder =
    status.deviceId && byMember.has(status.deviceId) ? status.deviceId : source.members[0];
  if (holder) byMember.set(holder, status);
  return byMember;
}

/** What a member's status phrase depends on besides its own sync row. */
export interface MemberSituation {
  /** The device is connected to the gateway. */
  online: boolean;
  /** A handoff member that is not the current lease holder: it waits its turn. */
  standby: boolean;
}

/**
 * A member's status as one short phrase, in the words the portal's member
 * lines use and in the same order of precedence: what the device is doing
 * now, then when it last synced, then why it has nothing to say.
 */
export function describeMemberState(
  status: MemberSyncStatus | undefined,
  member: MemberSituation,
): string {
  if (status?.state === "syncing") return "syncing now";
  if (status?.state === "needs-auth") return "needs sign-in";
  if (status?.state === "error" && status.remediation) {
    return `needs access: ${status.remediation.summary}`;
  }
  if (status?.state === "error") return `error: ${status.errorMessage ?? "unknown"}`;
  // The gateway names the device that deleted; a gateway that predates
  // notices still reports the count.
  const dispute = status?.notices?.find((notice) => notice.kind === "replica-dispute");
  if (dispute) return dispute.title.charAt(0).toLowerCase() + dispute.title.slice(1);
  if (status?.restoredClaims) {
    return `keeping ${status.restoredClaims} item${status.restoredClaims === 1 ? "" : "s"} another device no longer has`;
  }
  if (status?.lastSyncAt) return `synced ${formatTimeAgo(status.lastSyncAt)}`;
  if (status?.state === "synced") return "synced";
  if (!member.online) return "offline";
  if (member.standby) return "standby";
  return "idle";
}

/**
 * The phrase for a source that needs the operator, or undefined when it does
 * not. A listing that shows only enabled-versus-paused reads a source nothing
 * is running as healthy; this is what it shows in place of the green dot.
 */
/**
 * The states that need the operator, as distinct from the ones a source works
 * its own way out of.
 *
 * Listing only the two loudest showed four others as green — a consent about
 * to lapse, a feed whose program stopped, a missing permission, and a source
 * whose data is out of reach. None of those clears on its own, and the status
 * command already renders all of them; this listing said they were fine.
 *
 * `rate-limited` stays out deliberately: it self-heals when the back-off
 * elapses, and asking the operator to act on it would be asking them to wait.
 */
const NEEDS_ATTENTION = new Set([
  "error",
  "needs-auth",
  "auth-expiring",
  "permission-degraded",
  "background-access-missing",
  "unavailable",
  "stale",
]);

export function attentionPhrase(status: MemberSyncStatus | undefined): string | undefined {
  if (!status || !NEEDS_ATTENTION.has(status.state)) return undefined;
  return describeMemberState(status, { online: true, standby: false });
}

interface MemberView {
  deviceId: string;
  name: string;
  kind: string;
  online: boolean;
  state: string;
  lastSyncAt: string | null;
}

/** One entry per member, owner first, joined with its device, status and phrase. */
function buildMemberViews(
  source: Pick<AdminSourceEntry, "members" | "multiDeviceMode" | "leaseHolder">,
  devices: readonly AdminDeviceEntry[],
  status: MemberSyncStatus | undefined,
): Array<MemberView & { phrase: string }> {
  const statuses = statusByMember(source, status);
  const handoff = sourceMode(source) === "handoff";
  return source.members.map((deviceId) => {
    const device = devices.find((d) => d.id === deviceId);
    const memberStatus = statuses.get(deviceId);
    const online = device?.online === true;
    const standby = handoff && source.leaseHolder !== null && source.leaseHolder !== deviceId;
    return {
      deviceId,
      name: device?.name ?? deviceId,
      kind: device?.kind ?? "unknown",
      online,
      state: memberStatus?.state ?? "idle",
      lastSyncAt: memberStatus?.lastSyncAt ?? null,
      phrase: describeMemberState(memberStatus, { online, standby }),
    };
  });
}

/** The human-readable listing: the source's mode, then one line per member. */
export function renderMembers(
  source: Pick<
    AdminSourceEntry,
    "id" | "members" | "multiDeviceMode" | "leaseHolder" | "disputedDeletions"
  >,
  devices: readonly AdminDeviceEntry[],
  status: MemberSyncStatus | undefined,
): string[] {
  const lines: string[] = [];
  const lease = source.leaseHolder
    ? ` ${c.dim}· lease held by ${deviceLabel(devices, source.leaseHolder)}${c.reset}`
    : "";
  const disputed = source.disputedDeletions
    ? ` ${c.yellow}· ${source.disputedDeletions} deletion${source.disputedDeletions === 1 ? "" : "s"} in dispute${c.reset}`
    : "";
  lines.push(
    `${c.bold}${source.id}${c.reset} ${c.dim}(${sourceMode(source)})${c.reset}${lease}${disputed}`,
  );
  const views = buildMemberViews(source, devices, status);
  const nameW = Math.max(...views.map((v) => v.name.length));
  for (const [i, v] of views.entries()) {
    const dot = v.online ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
    const presence = v.online ? "online" : "offline";
    const owner = i === 0 && views.length > 1 ? ` ${c.dim}owner${c.reset}` : "";
    lines.push(
      `  ${dot} ${c.cyan}${v.name.padEnd(nameW)}${c.reset}  ${c.dim}${v.kind}, ${presence}${c.reset}  ` +
        `${v.phrase}${owner}`,
    );
  }
  return lines;
}

export const membersCommand = defineCommand({
  meta: {
    name: "members",
    description: "List the devices hosting a source, with each one's sync status",
  },
  args: {
    id: { type: "positional", description: "Source id", required: true },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const sourceId = String(ctx.args.id);
    const { source, devices } = await loadSourceContext(sourceId);
    const { items: statuses } = await withSpinner("Loading sync status", () =>
      gatewayJson<{ items: MemberSyncStatus[] }>("/admin/sync/status"),
    );
    const status = statuses.find((s) => s.sourceId === source.id);

    if (ctx.args.json === true) {
      const members = buildMemberViews(source, devices, status).map(
        ({ deviceId, name, kind, online, state, lastSyncAt }) => ({
          deviceId,
          name,
          kind,
          online,
          state,
          lastSyncAt,
        }),
      );
      console.log(
        JSON.stringify({
          sourceId: source.id,
          multiDeviceMode: sourceMode(source),
          leaseHolder: source.leaseHolder,
          members,
        }),
      );
      return;
    }
    for (const line of renderMembers(source, devices, status)) console.log(line);
  },
});
