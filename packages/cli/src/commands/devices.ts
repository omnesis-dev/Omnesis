// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  discoverGatewayViaMdns,
  ensureGatewayTrust,
  isTlsCertError,
  localDeviceUpdateCommands,
  tlsErrorCode,
  normalizeCertFingerprint,
  normalizeEmail,
  normalizePhone,
  readPackageVersion,
  writeSecretTextFileSync,
  type ClientVersionState,
  type DiscoveredGateway,
} from "@omnesis/core";
import {
  DEVICE_KINDS,
  isDeviceKind,
  tryDeviceId,
  tryScope,
  tryTokenId,
  type DeviceKind,
  type DeviceId,
  type DeviceRecord,
  type Scope,
  type TokenId,
} from "@omnesis/types";
import { isFetchConnectionError } from "@omnesis/cli-shared";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
  IntegrationHttpError,
  PinnedGatewayHttpClient,
  type TlsTrust,
} from "@omnesis/agent-integration";
import {
  c,
  formatTimeAgoMs,
  gatewayJson,
  GATEWAY_URL,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_DOWN,
  EXIT_GATEWAY_ERROR,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import { showPhonePairing } from "./phone-pairing.js";

export interface DeviceCorpusCredential {
  credentialLabel?: string;
  principalName: string;
  grantName: string;
}

export interface DeviceCorpusCredentialImpact {
  credentials: DeviceCorpusCredential[];
  complete: boolean;
  fingerprint?: string;
}

interface DeviceListItem extends DeviceRecord {
  online: boolean;
  /**
   * The gateway's verdict on the device's build. Absent from a gateway that
   * predates the version ledger; rendered as `unknown` in that case, which
   * is what an absent reading means either way.
   */
  versionState?: ClientVersionState;
  /** Revoked, yet still holding sources a re-pair would bring back. */
  needsPairing?: boolean;
  /**
   * Present only on agent devices. A managed harness's corpus access can
   * lapse — its OAuth ticket expires from disuse, or the operator revokes the
   * grant — while its pairing stays perfectly healthy, so nothing else in
   * this row would say so.
   */
  agentAuthorization?:
    | { status: "authorized" }
    | { status: "needs-reauthorization"; remedy: string };
  /** Agent connections whose sign-in this device revoke would end. */
  revocationImpact?: {
    fingerprint?: string;
    /** Added after corpusAccess; absent when talking to an older gateway. */
    corpusCredentials?: DeviceCorpusCredential[];
    corpusAccess: DeviceCorpusCredential[];
  };
}

/** Product version of this CLI build, stamped on devices it pairs. */
const CLI_VERSION = readPackageVersion(import.meta.url);

const VALID_SCOPE_HINTS = [
  "answer",
  "read",
  "read:bulk",
  "admin",
  "write:*",
  "write:<source-type>",
];

const fmtTime = (ms: number | null): string => formatTimeAgoMs(ms, { longFormat: "iso-date" });

/** The `--scopes` list as validated scopes; a typo or an empty list is a user error. */
export function parsePairingScopes(raw: string): Scope[] {
  const scopes: Scope[] = [];
  for (const item of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const scope = tryScope(item);
    if (!scope) throw new CliError(`${c.red}Invalid scope: ${item}${c.reset}`, EXIT_USER_ERROR);
    scopes.push(scope);
  }
  if (scopes.length === 0) {
    throw new CliError(
      `${c.red}--scopes needs at least one scope (${VALID_SCOPE_HINTS.join(", ")}).${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return scopes;
}

/** `online` is device-WebSocket presence, not general device health. */
export const deviceLiveLabel = (online: boolean): "yes" | "no" => (online ? "yes" : "no");

/**
 * A device's one-word state. A revoked device keeps its row but has no
 * access; `needs-pairing` narrows that to the revoked rows that still hold
 * sources — a machine waiting on a repair code rather than one retired on
 * purpose.
 */
export const deviceStatusLabel = (d: {
  revokedAt?: number | null;
  needsPairing?: boolean;
}): "paired" | "revoked" | "needs-pairing" => {
  if (!d.revokedAt) return "paired";
  return d.needsPairing ? "needs-pairing" : "revoked";
};

/**
 * Whether revoking this device will not keep it down.
 *
 * A collector registers itself through `POST /admin/devices` under a fixed
 * name, and that route adopts a revoked row of the same name and kind. So a
 * collector sharing a config directory with the gateway's bootstrap admin
 * token re-registers on its next tick and comes straight back — correct, and
 * surprising if you typed revoke expecting the device to stay gone.
 *
 * The signal is the device reporting this machine's hostname while an admin
 * token sits in this config directory: that is the collector-beside-the-
 * gateway case exactly. Revoking from somewhere else cannot see either fact,
 * so it says nothing rather than guessing.
 */
export function revokedCollectorReRegisters(input: {
  kind: DeviceKind;
  deviceHostname?: string;
  localHostname: string;
  hasLocalAdminToken: boolean;
}): boolean {
  if (input.kind !== "collector" || !input.hasLocalAdminToken) return false;
  return Boolean(input.deviceHostname) && input.deviceHostname === input.localHostname;
}

/** Whether this invocation needs an explicit answer before corpus authority is removed. */
export function deviceRevocationNeedsConfirmation(input: {
  forget: boolean;
  yes: boolean;
  corpusCredentialCount: number;
  corpusImpactComplete: boolean;
}): boolean {
  return (
    !input.forget && !input.yes && (input.corpusCredentialCount > 0 || !input.corpusImpactComplete)
  );
}

/**
 * The corpus credentials this device revoke actually removes.
 *
 * The kind check keeps malformed or future response data from making an
 * ordinary collector look like it holds an agent connection. `corpusAccess` is a
 * compatibility fallback for gateways from before bound and currently-live
 * authority were reported separately.
 */
export function deviceCorpusCredentialImpact(input: {
  kind: DeviceKind;
  revocationImpact?: {
    fingerprint?: string;
    corpusCredentials?: DeviceCorpusCredential[];
    corpusAccess?: DeviceCorpusCredential[];
  };
}): DeviceCorpusCredentialImpact {
  if (input.kind !== "agent") return { credentials: [], complete: true };
  const current = input.revocationImpact;
  if (
    current?.corpusCredentials !== undefined &&
    typeof current.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(current.fingerprint)
  ) {
    return {
      credentials: current.corpusCredentials,
      complete: true,
      ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}),
    };
  }
  return { credentials: current?.corpusAccess ?? [], complete: false };
}

/**
 * How one bound corpus credential reads to the operator: its connection's
 * name, followed by the sign-in's own label only when that label says
 * something the connection name does not.
 */
export function deviceCorpusCredentialLabel(credential: DeviceCorpusCredential): string {
  const connection = terminalSafeDeviceRevocationLabel(credential.principalName);
  const signIn = credential.credentialLabel
    ? terminalSafeDeviceRevocationLabel(credential.credentialLabel)
    : "";
  return signIn && signIn !== connection ? `${connection} (${signIn})` : connection;
}

/** The destructive prompt names the exact delegated authority being removed. */
export function deviceRevocationConfirmationMessage(
  deviceName: string,
  impact: DeviceCorpusCredentialImpact,
): string {
  const safeName = terminalSafeDeviceRevocationLabel(deviceName);
  const connections = impact.credentials.map(deviceCorpusCredentialLabel).join(", ");
  if (!impact.complete) {
    const known = connections ? ` Known live access: ${connections}.` : "";
    return `Revoke ${safeName}? This gateway cannot report every connection sign-in this revoke may remove.${known}`;
  }
  const single = impact.credentials.length === 1;
  const signIns = single ? "sign-in" : "sign-ins";
  const noun = single ? "connection" : "connections";
  return `Revoke ${safeName} and its ${signIns} on the ${noun} ${connections}?`;
}

const UNSAFE_TERMINAL_LABEL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function terminalSafeDeviceRevocationLabel(value: string): string {
  return value.replace(UNSAFE_TERMINAL_LABEL, " ");
}

/**
 * The version a row shows: what the device reported, or an em dash when it
 * never has. A client built before the version ledger reports nothing, and
 * that is a supported state rather than a fault.
 */
export const deviceVersionLabel = (d: { version?: string | null }): string => d.version || "—";

/**
 * The state cell, coloured by how much it should worry the reader.
 * `unsupported` is the only one that warrants attention; `behind` is a normal
 * steady state for an app whose store release trails the tag, and `unknown`
 * is an absence of information rather than a problem.
 *
 * A revoked device reports no state at all. Its last reading is still on the
 * row, but nothing runs on that device any more, so calling its stale version
 * unsupported would send the operator after a machine that is already out of
 * the fleet — and the portal, `omnesis status` and the doctor all leave
 * revoked rows out for the same reason.
 */
export function deviceVersionStateCell(d: {
  versionState?: ClientVersionState;
  revokedAt?: number | null;
}): { text: string; colored: string } {
  if (d.revokedAt) return { text: "—", colored: `${c.gray}—${c.reset}` };
  const text = d.versionState ?? "unknown";
  const color =
    text === "unsupported"
      ? c.red
      : text === "behind"
        ? c.yellow
        : text === "unknown"
          ? c.gray
          : "";
  return { text, colored: color ? `${color}${text}${c.reset}` : text };
}

/**
 * Pad a cell that may carry ANSI colour codes to `width` visible characters.
 * The escape sequences occupy no columns, so their length is added on top of
 * the intended width — without this every coloured cell short-changes the
 * column by however many bytes its colour cost.
 */
/** Width of the STATUS column — sized for its longest value, `needs-pairing`. */
const STATUS_WIDTH = 13;

/**
 * The STATUS cell: `paired`, `revoked`, or the `needs-pairing` that separates
 * a revoked device still holding sources from one that was retired. Returned
 * as text plus colouring so `padCell` can align on the visible width.
 */
export function deviceStatusCell(d: { revokedAt?: number | null; needsPairing?: boolean }): {
  text: string;
  colored: string;
} {
  const text = deviceStatusLabel(d);
  const color = text === "needs-pairing" ? c.red : text === "revoked" ? c.yellow : "";
  return { text, colored: color ? `${color}${text}${c.reset}` : text };
}

/**
 * The line printed under an integration: the access level whose Answer rule
 * its `/answer` requests use, or — when it is on none, or on one that is gone
 * or can no longer answer — that its questions are refused. A revoked
 * integration answers nothing and cannot be put on a level; it keeps the one
 * it had for a repair, so its line names that level and nothing to choose.
 * Null for the operator's own devices, which no access level governs, and
 * for a revoked integration on no level.
 */
export function deviceAccessLevelLine(
  d: { kind: string; accessLevelId?: string | null; revokedAt?: number | null },
  levelNames: ReadonlyMap<string, string> | null,
): { text: string; refused: boolean } | null {
  if (d.kind !== "integration") return null;
  const name = d.accessLevelId ? levelNames?.get(d.accessLevelId) : undefined;
  if (d.revokedAt != null) {
    if (!d.accessLevelId) return null;
    if (levelNames === null || name) {
      return {
        text: `a repair restores it on access level “${name ?? d.accessLevelId}”`,
        refused: false,
      };
    }
    return { text: "its access level is no longer available", refused: false };
  }
  if (!d.accessLevelId) {
    return {
      text: "no access level — questions refused; choose one on the portal's Devices page",
      refused: true,
    };
  }
  // The levels could not be read: say which level without judging it.
  if (levelNames === null) return { text: `on access level ${d.accessLevelId}`, refused: false };
  return name
    ? { text: `answers under access level “${name}”`, refused: false }
    : {
        text: "access level unavailable — questions refused; choose another on the portal's Devices page",
        refused: true,
      };
}

/**
 * The line printed under a device whose last update result still stands: a
 * failure, a build installed that the device has not loaded, or a build that
 * cannot take the update command and has to be updated by hand. Null when
 * nothing is owed or the update is still in flight, which the row's version
 * column already conveys.
 */
export function deviceUpdateNoticeLine(d: {
  version?: string | null;
  desiredVersion?: string | null;
  updateState?: string | null;
  updateDetail?: string | null;
  capabilities?: { agentIntegration?: { harness?: string } };
}): string | null {
  const running = d.version ?? "an unknown version";
  const harness = d.capabilities?.agentIntegration?.harness;
  // The detail is text the device wrote; it must not steer the terminal.
  const detail = d.updateDetail ? withoutTerminalControl(d.updateDetail) : null;
  if (d.updateState === "failed") {
    const fix = harness
      ? `On that machine run: omnesis connect ${harness} --refresh, then ${harness} gateway restart`
      : "On that machine run: omnesis update";
    return `update failed — still runs ${running}${d.desiredVersion ? ` instead of ${d.desiredVersion}` : ""}${detail ? ` (${detail})` : ""}. ${fix}`;
  }
  if (d.updateState === "restart-pending") {
    return `restart owed — runs ${running}${d.desiredVersion ? ` with ${d.desiredVersion} installed` : ""}${detail ? `. ${detail}` : ""}`;
  }
  if (d.updateState === "unsupported") {
    return `cannot be updated remotely — this build (${running}) does not accept update commands. Update it on that machine: ${localDeviceUpdateCommands(harness).join(", then ")}`;
  }
  return null;
}

function padCell(cell: { text: string; colored: string }, width: number): string {
  return cell.colored.padEnd(width + (cell.colored.length - cell.text.length));
}

/** The DELETE path for one device: revoke by default, hard-delete on `forget`. */
export const deviceRevokePath = (
  id: string,
  forget: boolean,
  impactFingerprint?: string,
): string => {
  const query = forget
    ? "?forget=true"
    : impactFingerprint
      ? `?impactFingerprint=${encodeURIComponent(impactFingerprint)}`
      : "";
  return `/admin/devices/${encodeURIComponent(id)}${query}`;
};

interface AnswerLevelsOverview {
  policyFamilies: { id: string }[];
  levels: {
    id: string;
    name: string;
    rules: { capability: string; release?: { mode: string; policyFamilyId?: string } }[];
  }[];
}

/**
 * The live access levels that can answer, by id, for naming a device's level.
 * A level without Answer, or whose Answer is reviewed under a policy that is
 * gone, is left out: the gateway refuses a device on it, which is what the
 * list then says.
 */
export function answerLevelNames(overview: AnswerLevelsOverview): Map<string, string> {
  const policies = new Set(overview.policyFamilies.map((policy) => policy.id));
  const answers = (rule: AnswerLevelsOverview["levels"][number]["rules"][number]) =>
    rule.capability === "answer" &&
    (rule.release?.mode !== "reviewed" || policies.has(rule.release.policyFamilyId ?? ""));
  return new Map(
    overview.levels
      .filter((level) => level.rules.some(answers))
      .map((level) => [level.id, level.name]),
  );
}

/** Best effort: a gateway whose access overview cannot be read still lists its devices. */
async function readAnswerLevelNames(): Promise<Map<string, string> | null> {
  try {
    return answerLevelNames(await gatewayJson<AnswerLevelsOverview>("/admin/access"));
  } catch {
    return null;
  }
}

const devicesListCommand = defineCommand({
  meta: { name: "list", description: "List paired devices" },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON: {items: [{id, name, kind, revokedAt, online, …}]}",
    },
  },
  async run(ctx) {
    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: DeviceListItem[] }>("/admin/devices"),
    );
    // The installer reads this to name the machines a gateway port move
    // leaves behind, so the row is the gateway's own, unshaped.
    if (ctx.args.json) {
      console.log(JSON.stringify({ items: devices }));
      return;
    }
    if (devices.length === 0) {
      console.log("No devices paired.");
      return;
    }
    const levelNames = devices.some((d) => d.kind === "integration" && d.accessLevelId)
      ? await readAnswerLevelNames()
      : null;
    console.log();
    console.log(
      `${c.bold}${"NAME".padEnd(28)} ${"KIND".padEnd(10)} ${"HOSTNAME".padEnd(20)} ${"VERSION".padEnd(9)} ${"STATE".padEnd(11)} ${"ID".padEnd(38)} ${"STATUS".padEnd(STATUS_WIDTH)} ${"LIVE".padEnd(8)} LAST ACTIVITY${c.reset}`,
    );
    let needsPairing = 0;
    for (const d of devices) {
      const live = {
        text: deviceLiveLabel(d.online),
        colored: `${d.online ? c.green : c.gray}${deviceLiveLabel(d.online)}${c.reset}`,
      };
      const status = deviceStatusCell(d);
      if (status.text === "needs-pairing") needsPairing += 1;
      const host = d.capabilities?.hostname ?? "";
      const version = deviceVersionLabel(d);
      console.log(
        `${d.name.padEnd(28)} ${d.kind.padEnd(10)} ${host.padEnd(20)} ${version.padEnd(9)} ${padCell(deviceVersionStateCell(d), 11)} ${d.id.padEnd(38)} ${padCell(status, STATUS_WIDTH)} ${padCell(live, 8)} ${fmtTime(d.lastSeenAt)}`,
      );
      // Printed under the row rather than as a column, because it carries the
      // command that fixes it and a column cannot.
      if (d.agentAuthorization?.status === "needs-reauthorization") {
        console.log(
          `${" ".repeat(2)}${c.yellow}needs re-authorization${c.reset} — corpus access has lapsed. ` +
            `On that machine run: ${c.bold}${d.agentAuthorization.remedy}${c.reset}`,
        );
      }
      const updateNotice = deviceUpdateNoticeLine(d);
      if (updateNotice) console.log(`${" ".repeat(2)}${c.yellow}${updateNotice}${c.reset}`);
      const levelLine = deviceAccessLevelLine(d, levelNames);
      if (levelLine) {
        console.log(
          `${" ".repeat(2)}${levelLine.refused ? c.yellow : c.dim}${levelLine.text}${c.reset}`,
        );
      }
    }
    console.log();
    if (needsPairing > 0) {
      console.log(
        `${c.dim}${needsPairing} device(s) are revoked but still host sources. Bring one back with \`omnesis devices repair <device>\`.${c.reset}`,
      );
      console.log();
    }
  },
});

const devicesPairCommand = defineCommand({
  meta: { name: "pair", description: "Create a pairing code for a new device" },
  args: {
    "repair-device": {
      type: "string",
      description: "Exact existing agent device ID to repair in place",
    },
    kind: {
      type: "string",
      description: `Device kind (one of: ${DEVICE_KINDS.join(", ")})`,
    },
    name: {
      type: "string",
      description:
        "Name for the paired device; required for an integration, named for what it does",
    },
    scopes: {
      type: "string",
      description: `Comma-separated scopes to grant instead of the kind's defaults (${VALID_SCOPE_HINTS.join(", ")})`,
    },
    "gateway-url": {
      type: "string",
      description:
        "Gateway URL to embed in the pairing QR instead of the recommended one (only used when --kind is ios or android; refused when that phone can't use it)",
    },
    "self-email": {
      type: "string",
      description:
        "Legacy: annotate the device with a self email (repeatable). Prefer `omnesis self` — the install-level home for who you are.",
    },
    "self-phone": {
      type: "string",
      description:
        "Legacy: annotate the device with a self phone, E.164 (repeatable). Prefer `omnesis self`.",
    },
  },
  async run(ctx) {
    const prompts = await import("@clack/prompts");

    // Validate all provided flags up front, before any prompts, so a typo
    // like `--kind=bogus` fails immediately.
    const kindFlag = typeof ctx.args.kind === "string" ? ctx.args.kind : undefined;
    const repairDeviceFlag =
      typeof ctx.args["repair-device"] === "string" ? ctx.args["repair-device"] : undefined;
    const repairDeviceId = repairDeviceFlag ? tryDeviceId(repairDeviceFlag) : null;
    if (repairDeviceFlag && !repairDeviceId) {
      throw new CliError(`${c.red}Invalid --repair-device UUID.${c.reset}`, EXIT_USER_ERROR);
    }
    if (kindFlag !== undefined && !isDeviceKind(kindFlag)) {
      throw new CliError(
        `${c.red}Invalid --kind '${kindFlag}'. Expected one of: ${DEVICE_KINDS.join(", ")}.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (repairDeviceId && kindFlag !== undefined && kindFlag !== "agent") {
      throw new CliError(
        `${c.red}--repair-device can only be used with --kind agent.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    let kind: DeviceKind;
    if (kindFlag !== undefined) {
      kind = kindFlag as DeviceKind;
    } else if (repairDeviceId) {
      kind = "agent";
    } else {
      const picked = (await prompts.select({
        message: "Device kind",
        options: DEVICE_KINDS.map((k) => ({ value: k, label: k })),
      })) as DeviceKind;
      if (prompts.isCancel(picked)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      kind = picked;
    }

    // Most devices name themselves at redeem after their host. An integration
    // is named for what it is — several can run on one host, beside that
    // host's own CLI — so the operator names it here.
    let name = typeof ctx.args.name === "string" ? ctx.args.name.trim() : "";
    if (kind === "integration" && !name) {
      // A prompt needs a terminal to answer it; a script says the name instead.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError(
          `${c.red}Name the integration with --name when pairing it without a terminal.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const typed = await prompts.text({
        message: "Integration name",
        validate: (value) => (value?.trim() ? undefined : "Name the integration"),
      });
      if (prompts.isCancel(typed)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      name = String(typed).trim();
    }

    // Omitted, the pairing carries the kind's canonical grant. `--scopes`
    // states a different one, validated here so a typo is a typed user error
    // rather than a gateway 400.
    const scopes =
      typeof ctx.args.scopes === "string" ? parsePairingScopes(ctx.args.scopes) : undefined;

    // Optional self annotation (legacy): staged on the pairing code and applied
    // to the device at redeem when `--self-email` / `--self-phone` is supplied.
    // Identity lives in `omnesis self` / `config.self`; these flags only stage a
    // per-device annotation.
    const { selfEmails, selfPhones } = collectSelfInfo(ctx);

    const result = await withSpinner("Creating pairing code", () =>
      gatewayJson<{
        pairingCode: string;
        scopes: Scope[];
        expiresAt: number;
        tlsFingerprint?: string;
      }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({
          ...(repairDeviceId ? { repairDeviceId } : {}),
          kind,
          ...(name ? { name } : {}),
          ...(scopes ? { scopes } : {}),
          // Omit empty selfEmails/selfPhones so the request carries no self
          // annotation when none was supplied.
          ...(selfEmails.length > 0 ? { selfEmails } : {}),
          ...(selfPhones.length > 0 ? { selfPhones } : {}),
        }),
      }),
    );
    if (selfEmails.length > 0 || selfPhones.length > 0) {
      console.log(
        `${c.dim}Will annotate the paired device with ${selfEmails.length} email(s) + ${selfPhones.length} phone(s).${c.reset}`,
      );
    }
    const ttlSec = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000));
    console.log();
    // A phone takes the code from its QR code (or the pasteable payload), so
    // the code is printed on its own only for the kinds that type it in.
    if (kind !== "ios" && kind !== "android") {
      console.log(`${c.bold}Pairing code:${c.reset} ${c.cyan}${result.pairingCode}${c.reset}`);
    }
    console.log(`${c.dim}Expires in ${ttlSec}s. Scopes: ${result.scopes.join(", ")}${c.reset}`);

    // A phone scans a QR code instead. The gateway judges each address for
    // this phone and encodes the chosen one, so the CLI and the portal offer
    // the same addresses and say the same things about them.
    if (kind === "ios" || kind === "android") {
      await showPhonePairing({
        platform: kind,
        pairingCode: result.pairingCode,
        gatewayUrlFlag:
          typeof ctx.args["gateway-url"] === "string" ? ctx.args["gateway-url"] : undefined,
      });
    } else {
      // Every non-QR kind gets
      // guidance tailored to how that kind actually redeems the code.
      for (const line of pairInstructionLines(kind, result.pairingCode, GATEWAY_URL)) {
        console.log(line);
      }
    }
    console.log();
  },
});

export interface RedeemedPairing {
  device: { id: DeviceId; name: string; kind: DeviceKind };
  tokenId: TokenId;
  token: string;
  scopes: Scope[];
}

export interface RedeemedAgentIntegrationCredential {
  tokenId: TokenId;
  token: string;
  scopes: Scope[];
}

export interface RedeemedAgentIntegrationPairing {
  device: { id: DeviceId; name: string; kind: "agent" };
  /** The pairing landed on the device this host was already connected as. */
  reconnected: boolean;
  credentials: {
    delivery: RedeemedAgentIntegrationCredential;
    ingestion: RedeemedAgentIntegrationCredential;
    management: RedeemedAgentIntegrationCredential;
  };
}

const DEVICE_TOKEN_RE = /^omn_[0-9a-f]{32}$/;
const MAX_DEVICE_NAME_LENGTH = 256;

/**
 * What a pairing redemption says when its TLS handshake fails. A certificate
 * that does not name the address used is a different failure from an
 * untrusted one: trusting its fingerprint changes nothing, and the remedy is
 * an address the certificate covers.
 */
export function pairingTlsFailure(gatewayUrl: string, err: unknown, trustRemedy: string): string {
  if (tlsErrorCode(err) === "ERR_TLS_CERT_ALTNAME_INVALID") {
    let host = gatewayUrl;
    try {
      host = new URL(gatewayUrl).hostname;
    } catch {
      // Keep the URL as given.
    }
    return (
      `The gateway's certificate does not name ${host}, so ${gatewayUrl} cannot be verified, ` +
      `even with its fingerprint. Use an address the certificate covers (on the gateway's ` +
      `machine, \`omnesis tls status\` lists them) and retry.`
    );
  }
  return `TLS certificate of ${gatewayUrl} is not trusted on this machine. ${trustRemedy}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutTerminalControl(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("");
}

function hasTerminalControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

/**
 * Whether an error is the certificate pin refusing, rather than a transport
 * failure on the way to it. Matched on the message because the refusal is
 * raised from two layers — `ensureGatewayTrust`'s own probe, and the pinned
 * TLS handshake underneath the redeem — that share no error class.
 */
function isCertificatePinFailure(err: Error): boolean {
  return (
    /fingerprint mismatch/i.test(err.message) ||
    /not a SHA-256 certificate fingerprint/i.test(err.message) ||
    /must be addressed over https/i.test(err.message)
  );
}

/** Validate the untrusted JSON returned by the public pairing endpoint. */
export function parseRedeemedPairing(value: unknown): RedeemedPairing {
  if (!isRecord(value) || !isRecord(value.device)) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  const deviceId = tryDeviceId(value.device.id);
  const tokenId = tryTokenId(value.tokenId);
  const name = value.device.name;
  const kind = value.device.kind;
  const token = value.token;
  const rawScopes = value.scopes;
  const scopes = Array.isArray(rawScopes) ? rawScopes.map(tryScope) : [];
  if (
    deviceId === null ||
    tokenId === null ||
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > MAX_DEVICE_NAME_LENGTH ||
    hasTerminalControl(name) ||
    typeof kind !== "string" ||
    !isDeviceKind(kind) ||
    typeof token !== "string" ||
    !DEVICE_TOKEN_RE.test(token) ||
    !Array.isArray(rawScopes) ||
    rawScopes.length === 0 ||
    scopes.some((scope) => scope === null)
  ) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  return {
    device: { id: deviceId, name, kind },
    tokenId,
    token,
    scopes: scopes as Scope[],
  };
}

function parseAgentCredential(
  value: unknown,
  expectedScopes: readonly string[],
): RedeemedAgentIntegrationCredential {
  if (!isRecord(value)) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  const tokenId = tryTokenId(value.tokenId);
  const rawScopes = value.scopes;
  const scopes = Array.isArray(rawScopes) ? rawScopes.map(tryScope) : [];
  if (
    tokenId === null ||
    typeof value.token !== "string" ||
    !DEVICE_TOKEN_RE.test(value.token) ||
    !Array.isArray(rawScopes) ||
    scopes.length !== expectedScopes.length ||
    scopes.some((scope, index) => scope !== expectedScopes[index])
  ) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  return { tokenId, token: value.token, scopes: scopes as Scope[] };
}

/** Validate the separated least-privilege agent-integration pairing bundle. */
export function parseRedeemedAgentIntegrationPairing(
  value: unknown,
  harness: "openclaw" | "hermes",
): RedeemedAgentIntegrationPairing {
  if (!isRecord(value) || !isRecord(value.device) || !isRecord(value.credentials)) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  const id = tryDeviceId(value.device.id);
  const name = value.device.name;
  if (
    id === null ||
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > MAX_DEVICE_NAME_LENGTH ||
    hasTerminalControl(name) ||
    value.device.kind !== "agent"
  ) {
    throw new CliError("Gateway returned a malformed pairing response.", EXIT_GATEWAY_ERROR);
  }
  return {
    device: { id, name, kind: "agent" },
    reconnected: value.reconnected === true,
    credentials: {
      delivery: parseAgentCredential(value.credentials.delivery, ["subscriptions:receive"]),
      ingestion: parseAgentCredential(value.credentials.ingestion, [`write:${harness}`]),
      management: parseAgentCredential(value.credentials.management, ["subscriptions:manage"]),
    },
  };
}

/**
 * Redeem a pairing code against a gateway's public `/devices/pair` endpoint
 * and return the minted device + token. Establishes trust in the target
 * gateway's TLS identity first (the redeem may target a gateway this machine
 * has never trusted). Throws `CliError` with a user-actionable message on
 * failure. Shared by `omnesis pair` and `omnesis devices redeem`.
 *
 * With `expectedFingerprint`, trust becomes a pin: the certificate is verified
 * against it, and the redeem below then runs over a connection that accepts
 * that certificate and nothing else — not the process CA store plus it — so a
 * second connection cannot land somewhere the first one would have been
 * refused.
 */
export async function redeemPairingCode(
  gatewayUrl: string,
  code: string,
  trustConfigDir = DEFAULT_CONFIG_DIR,
  expectedFingerprint?: string,
): Promise<RedeemedPairing> {
  // Trust is the join's FIRST network touch, and it sits outside the redeem's
  // own catch below. A connection that dies here therefore escaped this command
  // entirely and reached the runner, whose generic hint names
  // GATEWAY_REQUEST_URL — this machine's own gateway, which during a join is
  // precisely the address that is not being dialled. Pairing holds the real
  // one, so it says that instead, exactly as the redeem below does.
  let trust: Awaited<ReturnType<typeof ensureGatewayTrust>>;
  try {
    trust = await ensureGatewayTrust({
      gatewayUrl,
      configDir: trustConfigDir,
      expectedFingerprint,
    });
  } catch (err) {
    if (isFetchConnectionError(err)) {
      throw new CliError(
        `${c.red}Cannot reach the gateway at ${gatewayUrl}. Check that it is running, and ` +
          `that its port is reachable from here — a firewall on the gateway host is the ` +
          `usual cause.${c.reset}`,
        EXIT_GATEWAY_DOWN,
      );
    }
    throw err;
  }
  // `trust` only carries a certificate when it verified one against the pin,
  // so reaching here with both means the pin held.
  const pinnedFingerprint = normalizeCertFingerprint(expectedFingerprint);
  const pinned =
    pinnedFingerprint && trust.action === "trusted-in-process" && trust.certPem
      ? { caPem: trust.certPem, leafFingerprintSha256: pinnedFingerprint }
      : undefined;

  const body = {
    pairingCode: code,
    // Send the hostname as `suggestedName` too, not just the diagnostic
    // `hostname` capability. `resolveDeviceName` uses suggestedName as
    // the fallback when the operator minted the code without a name, so
    // an unnamed redeem gets a stable, human-meaningful name and a
    // re-pair reuses the existing device row instead of spawning a fresh
    // `<kind>-<hex>` ghost every time.
    capabilities: {
      hostname: osHostname(),
      suggestedName: osHostname(),
      platform: process.platform,
      // The install being paired is this one, and every @omnesis/*
      // package on a host shares one lockstep version — so the CLI's
      // own version is the device's. Whatever daemon this row ends up
      // being (a collector, say) corrects it on its first hello.
      version: CLI_VERSION,
      // Persisted once per config dir: the gateway adopts the row
      // carrying it on re-pair, so a renamed row keeps this
      // machine's identity.
      installId: getOrCreateInstallId(trustConfigDir),
    },
  };

  // `/devices/pair` is public by design — the pairing code IS the credential —
  // so neither branch sends a bearer token.
  let payload: unknown;
  let failureStatus: number | null = null;
  try {
    if (pinned) {
      payload = await withSpinner("Redeeming pairing code", () =>
        new PinnedGatewayHttpClient(gatewayUrl, "", pinned).postJson("/devices/pair", body),
      );
    } else {
      const res = await withSpinner("Redeeming pairing code", () =>
        fetch(`${gatewayUrl}/devices/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      failureStatus = res.ok ? null : res.status;
      if (res.ok) payload = await res.json();
    }
  } catch (err) {
    if (err instanceof IntegrationHttpError) {
      failureStatus = err.status;
    } else if (isTlsCertError(err)) {
      throw new CliError(
        `${c.red}${pairingTlsFailure(
          gatewayUrl,
          err,
          `Copy its cert to ${pathJoin(trustConfigDir, "tls", "cert.pem")}, or pass ` +
            `--trust-fingerprint sha256:<its SHA-256 fingerprint> and retry.`,
        )}${c.reset}`,
        EXIT_FAILURE,
      );
    } else if (isFetchConnectionError(err)) {
      // The runner's fallback hint names GATEWAY_REQUEST_URL — this machine's
      // own gateway — which during a join is precisely the address that is not
      // being dialled. Pairing holds the real one, so it says that instead.
      throw new CliError(
        `${c.red}Cannot reach the gateway at ${gatewayUrl}. Check that it is running, and ` +
          `that its port is reachable from here — a firewall on the gateway host is the ` +
          `usual cause.${c.reset}`,
        EXIT_GATEWAY_DOWN,
      );
    } else {
      throw err;
    }
  }
  if (failureStatus === 429) {
    throw new CliError(
      `${c.red}Too many pairing attempts from this address — wait a minute and retry.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (failureStatus === 400 || failureStatus === 404 || failureStatus === 410) {
    throw new CliError(
      `${c.red}Invalid or expired pairing code. Mint a fresh one with \`omnesis devices pair\` and redeem it within its TTL.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (failureStatus !== null) {
    throw new CliError(
      `${c.red}Pairing failed with gateway status ${failureStatus}.${c.reset}`,
      pickGatewayExitCode(failureStatus),
    );
  }
  return parseRedeemedPairing(payload);
}

/**
 * The gateway refused an agent pairing code without committing anything, so
 * the connect attempt that carried it may be dropped and retried with a new
 * code.
 */
export class AgentPairingRefusedError extends CliError {}

const HARNESS_NAMES = { openclaw: "OpenClaw", hermes: "Hermes" } as const;

/**
 * What the operator does about a refused reconnect, keyed by the gateway's
 * conflict code. Each answer leads to the portal's Connect an agent card,
 * which can mint the code the situation needs.
 */
function agentPairingConflictMessage(
  code: string | undefined,
  harness: "openclaw" | "hermes",
  suggestedName: string,
): string {
  const card = `Settings → Access → Connect an agent → ${HARNESS_NAMES[harness]} in the portal`;
  switch (code) {
    case "AGENT_DEVICE_EXISTS":
      return (
        `The gateway already has an agent device with the name this pairing asks for — ` +
        `normally this machine's own, ${suggestedName} — and this machine holds no working ` +
        `credential for it, so the gateway cannot tell it is the same installation. In ${card}, ` +
        `choose "Reconnect" for that device, create a pairing code, and run the new command ` +
        `here. The device keeps its watches and history.`
      );
    case "AGENT_DEVICE_ONLINE":
      return (
        `The agent device this pairing code reconnects is still connected, from this machine ` +
        `or another one, and this machine holds no working credential for it. Stop ` +
        `${HARNESS_NAMES[harness]} where it runs, or revoke that device, and run the command ` +
        `again. To add this machine as a separate agent instead, choose "Connect another ` +
        `machine" in ${card} and create a new pairing code.`
      );
    case "AGENT_DEVICE_MISMATCH":
      return (
        `This pairing code reconnects a different agent device than the one this machine is ` +
        `connected as. In ${card}, choose "Reconnect" for the device this machine was paired ` +
        `as, or "Connect another machine", and create a new pairing code.`
      );
    case "AGENT_CREDENTIAL_STALE":
      return (
        `This machine's saved credentials were replaced while it reconnected, most likely by ` +
        `another connect run. Create a new pairing code in ${card} and run the command again.`
      );
    default:
      return (
        `The gateway refused this agent pairing. Create a new pairing code in ${card} and run ` +
        `the command again.`
      );
  }
}

async function gatewayErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exchange one agent-kind pairing code for three separated credentials.
 * The gateway returns all three from one pairing-code redemption; no broad
 * bootstrap token is ever written to the harness.
 *
 * `continuityCredential` is a credential this host still holds for the device
 * it is already connected as. It proves the redemption reconnects that
 * device, which then keeps its id — and every watch bound to it — while its
 * credentials are replaced.
 */
export async function redeemAgentIntegrationPairingCode(
  gatewayUrl: string,
  code: string,
  harness: "openclaw" | "hermes",
  options: {
    idempotencyKey?: string;
    maxConcurrentRuns?: number;
    suggestedName: string;
    continuityCredential?: string;
    tls?: TlsTrust;
  },
): Promise<RedeemedAgentIntegrationPairing> {
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
  const body = {
    pairingCode: code,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.continuityCredential ? { continuityCredential: options.continuityCredential } : {}),
    agentIntegration: { harness },
    capabilities: {
      suggestedName: options.suggestedName,
      agentIntegration: {
        harness,
        // The range the plugin this pairing installs actually speaks. A
        // placeholder here pairs successfully and then fails every wake
        // forever, on a background retry nobody is watching, because the
        // gateway can find no version in common with what the device claimed.
        deliveryProtocolMin: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
        deliveryProtocolMax: AGENT_INTEGRATION_PROTOCOL_VERSION,
        maxConcurrentRuns,
        watchPrivacyPolicyVersion: 1,
      },
    },
  };
  if (!options.tls) {
    await ensureGatewayTrust({ gatewayUrl, configDir: DEFAULT_CONFIG_DIR });
  }
  let responsePayload: unknown;
  let failureStatus: number | null = null;
  let failureCode: string | undefined;
  try {
    if (options.tls) {
      responsePayload = await withSpinner("Provisioning agent integration", () =>
        new PinnedGatewayHttpClient(gatewayUrl, "", options.tls).postJson("/devices/pair", body),
      );
    } else {
      const res = await withSpinner("Provisioning agent integration", () =>
        fetch(`${gatewayUrl}/devices/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      failureStatus = res.ok ? null : res.status;
      if (res.ok) responsePayload = await res.json();
      else failureCode = await gatewayErrorCode(res);
    }
  } catch (err) {
    if (err instanceof IntegrationHttpError) {
      failureStatus = err.status;
      failureCode = err.code;
    } else if (isTlsCertError(err)) {
      throw new CliError(
        `${c.red}${pairingTlsFailure(
          gatewayUrl,
          err,
          `Copy its cert to ${pathJoin(DEFAULT_CONFIG_DIR, "tls", "cert.pem")}, or set ` +
            `OMNESIS_TRUST_FINGERPRINT to its SHA-256 fingerprint and retry.`,
        )}${c.reset}`,
        EXIT_FAILURE,
      );
    } else if (isFetchConnectionError(err)) {
      // The runner's fallback hint names GATEWAY_REQUEST_URL — this machine's
      // own gateway — which during a join is precisely the address that is not
      // being dialled. Pairing holds the real one, so it says that instead.
      throw new CliError(
        `${c.red}Cannot reach the gateway at ${gatewayUrl}. Check that it is running, and ` +
          `that its port is reachable from here — a firewall on the gateway host is the ` +
          `usual cause.${c.reset}`,
        EXIT_GATEWAY_DOWN,
      );
    } else {
      throw err;
    }
  }
  if (failureStatus === 429) {
    throw new CliError(
      `${c.red}Too many pairing attempts from this address — wait a minute and retry.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (failureStatus === 400 || failureStatus === 404 || failureStatus === 410) {
    throw new AgentPairingRefusedError(
      `${c.red}Invalid or expired agent pairing code. Mint a fresh code with ` +
        `\`omnesis devices pair --kind agent\` and redeem it within its TTL.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (failureStatus === 409) {
    throw new AgentPairingRefusedError(
      `${c.red}${agentPairingConflictMessage(failureCode, harness, options.suggestedName)}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (failureStatus !== null) {
    throw new CliError(
      `${c.red}Agent integration provisioning failed with gateway status ${failureStatus}.${c.reset}`,
      pickGatewayExitCode(failureStatus),
    );
  }
  return parseRedeemedAgentIntegrationPairing(responsePayload, harness);
}

const devicesRedeemCommand = defineCommand({
  meta: {
    name: "redeem",
    description: "Redeem a pairing code on this device and obtain its token",
  },
  args: {
    code: {
      type: "positional",
      description: "pairing code from `omnesis devices pair`",
      required: true,
    },
    "gateway-url": {
      type: "string",
      description: "Gateway URL to redeem against (default: the CLI's gateway URL)",
    },
    "trust-fingerprint": {
      type: "string",
      description:
        "Pin the gateway's certificate: verify it against this SHA-256 fingerprint (sha256:… or bare hex) instead of trusting it on sight",
    },
    save: {
      type: "string",
      description: "Write the token to this file (mode 0600) instead of printing it",
    },
    json: {
      type: "boolean",
      description: "Print the full pairing response as JSON",
    },
  },
  async run(ctx) {
    const code = typeof ctx.args.code === "string" ? ctx.args.code.trim() : "";
    if (!code) {
      throw new CliError(
        `${c.red}Usage: provide a pairing code — omnesis pair <code> (or omnesis devices redeem <code>) [--gateway-url <url>] [--trust-fingerprint sha256:…] [--save <path>] [--json]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const urlFlag =
      typeof ctx.args["gateway-url"] === "string" ? ctx.args["gateway-url"] : undefined;
    const gatewayUrl = (urlFlag ?? GATEWAY_URL).replace(/\/+$/, "");

    // Checked here so a typo is a usage error with an exit code that says so,
    // rather than the generic failure the TLS layer would raise for it. An
    // empty value is a typo too: a script whose `--trust-fingerprint "$FP"`
    // lost its variable would otherwise be quietly downgraded to trusting
    // whatever answers, which is the one outcome this flag exists to prevent.
    const fingerprintFlag =
      typeof ctx.args["trust-fingerprint"] === "string" ? ctx.args["trust-fingerprint"] : undefined;
    if (fingerprintFlag !== undefined && normalizeCertFingerprint(fingerprintFlag) === null) {
      throw new CliError(
        `${c.red}--trust-fingerprint is not a SHA-256 certificate fingerprint: ${fingerprintFlag}${c.reset}\n` +
          `${c.dim}Expected 64 hex characters, optionally prefixed with "sha256:".${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    let body: RedeemedPairing;
    try {
      body = await redeemPairingCode(gatewayUrl, code, DEFAULT_CONFIG_DIR, fingerprintFlag);
    } catch (err) {
      // A certificate that fails its pin is the one failure an operator must
      // not be able to shrug past, so it leaves as a refusal carrying both
      // fingerprints rather than as a stack trace.
      if (err instanceof Error && !(err instanceof CliError) && isCertificatePinFailure(err)) {
        throw new CliError(`${c.red}${err.message}${c.reset}`, EXIT_FAILURE);
      }
      throw err;
    }

    const saveFlag = typeof ctx.args.save === "string" ? ctx.args.save : undefined;
    let savedPath: string | undefined;
    if (saveFlag) {
      savedPath = expandHomePath(saveFlag);
      writeSecretTextFileSync(savedPath, `${body.token}\n`, {
        configDir: process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
      });
    }

    if (ctx.args.json) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }

    console.log();
    console.log(
      `Paired as ${c.bold}${body.device.name}${c.reset} (${body.device.kind}) id=${body.device.id}`,
    );
    console.log(`Scopes: ${body.scopes.join(", ")}`);
    if (savedPath) {
      console.log(`Token written to ${savedPath} (mode 0600).`);
    } else {
      console.log(`${c.bold}Token:${c.reset} ${body.token}`);
      console.log(
        `${c.dim}Shown once — store it now, or re-pair and redeem with --save <path>.${c.reset}`,
      );
    }
    console.log();
  },
});

/**
 * Top-level `omnesis pair <code>` — a friendlier alias for `devices redeem`, so
 * the new device runs one obvious command instead of being told to curl the raw
 * public `/devices/pair` endpoint. Same args, same behavior: it reuses the
 * redeem command's argument spec and handler verbatim.
 */
export const pairCommand = defineCommand({
  meta: {
    name: "pair",
    description:
      "Redeem a pairing code on this device and obtain its token (alias of `devices redeem`)",
  },
  args: devicesRedeemCommand.args,
  run: devicesRedeemCommand.run,
});

/** Longest listen `devices discover` accepts, so a typo cannot hang a script. */
const MAX_DISCOVER_TIMEOUT_MS = 60_000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 3000;

/**
 * The `--json` answer, which is a machine contract: the installer's
 * `--collector` role reads `found`, `url` and `fingerprint` out of it by name.
 *
 * `fingerprint` is re-shaped from the bare hex the service record carries into
 * the `sha256:` form every consumer of a fingerprint accepts, so the value can
 * be passed straight to `--trust-fingerprint`. Absent fields are omitted
 * rather than nulled: a gateway too old to advertise its certificate is still
 * a gateway you can confirm by hand.
 */
export function discoveryJson(found: DiscoveredGateway | null): {
  found: boolean;
  url?: string;
  name?: string;
  fingerprint?: string;
} {
  if (!found) return { found: false };
  return {
    found: true,
    url: found.url,
    ...(found.name ? { name: found.name } : {}),
    ...(found.fingerprint ? { fingerprint: `sha256:${found.fingerprint}` } : {}),
  };
}

/**
 * `omnesis devices discover` — browse the LAN for a gateway advertising
 * itself over mDNS.
 *
 * The gateway publishes `_omnesis._tcp` with its scheme, port and the SHA-256
 * of its certificate, which is exactly the triple a second machine needs to
 * dial it and verify what answers. This surfaces that record so an operator
 * (and the installer's `--collector` role, which parses `--json`) can find a
 * gateway without being told its URL. Local, read-only, and token-free: it
 * listens to multicast on this LAN and nothing else.
 *
 * It reports the first gateway that answers, not every one: the LAN
 * essentially always has at most one, and a list would still leave the choice
 * to whoever is reading. Two on one segment means whichever answered first,
 * which is why the name and fingerprint are shown rather than acted on.
 */
const devicesDiscoverCommand = defineCommand({
  meta: {
    name: "discover",
    description: "Browse the LAN for a gateway advertising itself over mDNS",
  },
  args: {
    json: {
      type: "boolean",
      description:
        "Machine-readable JSON: {found, url, name, fingerprint} — fingerprint as sha256:<hex>",
    },
    timeout: {
      type: "string",
      description: `How long to listen, in ms (default: ${DEFAULT_DISCOVER_TIMEOUT_MS}, max: ${MAX_DISCOVER_TIMEOUT_MS})`,
    },
  },
  async run(ctx) {
    const raw = typeof ctx.args.timeout === "string" ? ctx.args.timeout : "";
    const timeoutMs = raw ? Number(raw) : DEFAULT_DISCOVER_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DISCOVER_TIMEOUT_MS) {
      throw new CliError(
        `${c.red}--timeout must be a positive number of milliseconds, at most ${MAX_DISCOVER_TIMEOUT_MS}.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const found = await withSpinner("Browsing the LAN for a gateway", () =>
      discoverGatewayViaMdns({ timeoutMs }),
    );

    if (ctx.args.json) {
      // Not an error when nothing answered: that is a legitimate result, and
      // the `found` field already carries it. Multicast does not cross subnets
      // or a VPN, so a gateway that exists may simply be out of earshot.
      console.log(JSON.stringify(discoveryJson(found)));
      return;
    }

    if (!found) {
      console.log();
      console.log(`No gateway answered on this LAN within ${timeoutMs}ms.`);
      console.log(
        `${c.dim}Multicast does not cross subnets or a VPN — address the gateway directly instead.${c.reset}`,
      );
      console.log();
      return;
    }

    console.log();
    console.log(`${c.bold}${found.name ?? "gateway"}${c.reset} at ${c.cyan}${found.url}${c.reset}`);
    if (found.fingerprint) {
      console.log(`${c.dim}Certificate:${c.reset} sha256:${found.fingerprint}`);
    }
    console.log();
  },
});

const devicesRevokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke a paired device" },
  args: {
    target: {
      type: "positional",
      description: "device id or name",
      required: true,
    },
    forget: {
      type: "boolean",
      description:
        "Permanently delete the device row instead of revoking. Refused while the device still hosts sources.",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip the connection sign-in confirmation and print its consequence summary",
    },
  },
  async run(ctx) {
    const target = ctx.args.target;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: omnesis devices revoke <device-id>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const forget = ctx.args.forget === true;
    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: DeviceListItem[] }>("/admin/devices"),
    );
    const dev = devices.find((d) => d.id === target || d.name === target);
    if (!dev) {
      throw new CliError(`${c.red}No device matching '${target}'${c.reset}`, EXIT_USER_ERROR);
    }
    const safeDeviceName = terminalSafeDeviceRevocationLabel(dev.name);
    const corpusImpact = deviceCorpusCredentialImpact(dev);
    if (
      deviceRevocationNeedsConfirmation({
        forget,
        yes: ctx.args.yes === true,
        corpusCredentialCount: corpusImpact.credentials.length,
        corpusImpactComplete: corpusImpact.complete,
      })
    ) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        const consequence = corpusImpact.complete
          ? corpusImpact.credentials.length === 1
            ? "Revoking this device also revokes its sign-in on an agent connection."
            : "Revoking this device also revokes its sign-ins on agent connections."
          : "This gateway cannot report every connection sign-in this revoke may remove.";
        throw new CliError(`${c.red}${consequence} Re-run with --yes.${c.reset}`, EXIT_USER_ERROR);
      }
      const prompts = await import("@clack/prompts");
      const confirmed = await prompts.confirm({
        message: deviceRevocationConfirmationMessage(dev.name, corpusImpact),
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || confirmed !== true) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
    }
    const headers = await authHeaders();
    const res = await withSpinner(
      forget ? `Forgetting ${safeDeviceName}` : `Revoking ${safeDeviceName}`,
      () =>
        fetch(
          `${GATEWAY_REQUEST_URL}${deviceRevokePath(dev.id, forget, corpusImpact.fingerprint)}`,
          {
            method: "DELETE",
            headers,
          },
        ),
    );
    if (!res.ok) {
      throw new CliError(
        `${c.red}Failed: ${res.status} ${await res.text()}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    if (forget) {
      console.log(`Forgot device ${safeDeviceName} (${dev.id}) — the row is deleted.`);
    } else {
      console.log(`Revoked device ${safeDeviceName} (${dev.id}).`);
      console.log(
        `${c.dim}Its tokens are invalidated; its sources and data stay. Bring it back with \`omnesis devices repair ${dev.id}\`; \`--forget\` deletes the row instead.${c.reset}`,
      );
      if (corpusImpact.credentials.length > 0) {
        console.log("Connection sign-ins revoked for this device:");
        for (const credential of corpusImpact.credentials) {
          console.log(`  ${deviceCorpusCredentialLabel(credential)}`);
        }
      }
      if (!corpusImpact.complete) {
        console.log(
          `${c.yellow}This gateway could not report every connection sign-in; update it before relying on this summary.${c.reset}`,
        );
      }
      if (
        revokedCollectorReRegisters({
          kind: dev.kind,
          deviceHostname: dev.capabilities?.hostname,
          localHostname: osHostname(),
          hasLocalAdminToken: hasAdminTokenFile(),
        })
      ) {
        console.log();
        console.log(
          `${c.yellow}This will not keep ${safeDeviceName} down.${c.reset} It runs beside the gateway and registers itself with the admin token in ${process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR}, so it reclaims this same device on its next start.`,
        );
        console.log(
          `${c.dim}To actually stop it collecting, stop the service: ${c.reset}omnesis service stop collector`,
        );
      }
    }
  },
});

/**
 * Instructions for redeeming a REPAIR code — the code is bound to an
 * existing row, so the wording differs from a first pairing: nothing new is
 * created, and the device comes back with its id, sources and cursors.
 */
export function repairInstructionLines(
  kind: DeviceKind,
  device: { name: string },
  code: string,
  gatewayUrl: string,
): string[] {
  const head = [
    "",
    kind === "integration"
      ? `${c.dim}This code is bound to ${c.reset}${device.name}${c.dim} — redeeming it restores that exact device, on the access level it kept.${c.reset}`
      : `${c.dim}This code is bound to ${c.reset}${device.name}${c.dim} — redeeming it restores that exact device, with its sources, memberships and cursors intact.${c.reset}`,
  ];
  switch (kind) {
    case "integration":
      return [
        ...head,
        ...integrationRedeemLines(code, gatewayUrl).slice(1),
        `${c.dim}(replace ${gatewayUrl} with an address that machine can reach; save over the token file the integration already reads)${c.reset}`,
      ];
    case "collector":
      return [
        ...head,
        `${c.dim}On ${device.name}'s host, save the new token where the collector reads it:${c.reset}`,
        `  omnesis pair ${code} --gateway-url ${gatewayUrl} --save ~/.config/omnesis/collector-token`,
        `${c.dim}(replace ${gatewayUrl} with an address that host can reach; the token path follows OMNESIS_CONFIG_DIR when it sets one)${c.reset}`,
        `${c.dim}then start the collector again (\`omnesis service start collector\`).${c.reset}`,
        // The service unit carries the address the collector dials, and a
        // saved token does not change it: a gateway that moved host or port
        // needs the unit registered again, which the installer does.
        `${c.dim}If the gateway has moved to a new address or port, re-run the installer on that host instead, which also points its service there:${c.reset}`,
        `  curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector --gateway-url ${gatewayUrl} --code ${code}`,
      ];
    case "ios":
    case "android":
      return [
        ...head,
        `${c.dim}Enter the code in the Omnesis app's manual-entry sheet, or scan the QR above.${c.reset}`,
      ];
    case "agent":
      return [
        ...head,
        `${c.dim}On the agent host, re-provision the integration:${c.reset}`,
        `  omnesis connect openclaw --code ${code} --gateway-url ${gatewayUrl}`,
        `${c.dim}(use hermes instead of openclaw when appropriate)${c.reset}`,
      ];
    case "browser":
      // The extension redeems the code from its Options page; it never reads
      // a terminal.
      return [...head, ...browserPairingLines(gatewayUrl, code, { install: false })];
    default:
      return [
        ...head,
        `${c.dim}On ${device.name}, run:${c.reset}`,
        `  omnesis pair ${code} --gateway-url ${gatewayUrl}`,
        `${c.dim}(replace ${gatewayUrl} with an address that device can reach)${c.reset}`,
      ];
  }
}

const devicesRepairCommand = defineCommand({
  meta: {
    name: "repair",
    description:
      "Mint a pairing code bound to an existing device, so re-pairing keeps its identity",
  },
  args: {
    target: { type: "positional", description: "device id or name", required: true },
    "gateway-url": {
      type: "string",
      description: "Gateway URL the repaired device should connect to (overrides auto-discovery)",
    },
  },
  async run(ctx) {
    const target = ctx.args.target;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: omnesis devices repair <device-id-or-name>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: DeviceListItem[] }>("/admin/devices"),
    );
    const dev = devices.find((d) => d.id === target || d.name === target);
    if (!dev) {
      throw new CliError(`${c.red}No device matching '${target}'${c.reset}`, EXIT_USER_ERROR);
    }
    if (dev.kind === "portal") {
      // A portal login exchanges its code for a browser session through its
      // own path, which resolves the row by install identity rather than by
      // the code's repair target — a bound code would not be honoured there.
      throw new CliError(
        `${c.red}A portal session cannot be repaired. Mint a fresh code with \`omnesis devices pair --kind portal\`, and forget the stale row once the browser has logged in.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (dev.online) {
      throw new CliError(
        `${c.red}${dev.name} is still connected. A repair replaces the credentials it is using, so stop or revoke it first.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const result = await withSpinner(`Minting a repair code for ${dev.name}`, () =>
      gatewayJson<{ pairingCode: string; scopes: Scope[]; expiresAt: number }>(
        "/admin/devices/pair",
        {
          method: "POST",
          body: JSON.stringify({ kind: dev.kind, repairDeviceId: dev.id }),
        },
      ),
    );
    const ttlSec = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000));
    console.log();
    if (dev.kind !== "ios" && dev.kind !== "android") {
      console.log(`${c.bold}Repair code:${c.reset} ${c.cyan}${result.pairingCode}${c.reset}`);
    }
    console.log(
      `${c.dim}Expires in ${ttlSec}s. Device: ${dev.name} (${dev.kind}, ${dev.id}). Scopes: ${result.scopes.join(", ")}${c.reset}`,
    );

    // The device being repaired is not this machine, so the printed
    // instructions need an address it can reach. A phone gets its QR code and
    // the gateway's judgement of each address; `--gateway-url` states one for
    // every other kind, whose instructions are a line the operator can edit.
    const gatewayUrlFlag =
      typeof ctx.args["gateway-url"] === "string" ? ctx.args["gateway-url"] : undefined;
    const reachableUrl =
      dev.kind === "ios" || dev.kind === "android"
        ? await showPhonePairing({
            platform: dev.kind,
            pairingCode: result.pairingCode,
            gatewayUrlFlag,
          })
        : (gatewayUrlFlag ?? GATEWAY_URL);

    for (const line of repairInstructionLines(dev.kind, dev, result.pairingCode, reachableUrl)) {
      console.log(line);
    }
    console.log();
  },
});

const devicesRenameCommand = defineCommand({
  meta: { name: "rename", description: "Rename a paired device (display only)" },
  args: {
    target: { type: "positional", description: "device id or current name", required: true },
    name: { type: "positional", description: "new name", required: true },
  },
  async run(ctx) {
    const target = ctx.args.target;
    const newName = typeof ctx.args.name === "string" ? ctx.args.name.trim() : "";
    if (!target || !newName) {
      throw new CliError(
        `${c.red}Usage: omnesis devices rename <device> <new-name>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: DeviceListItem[] }>("/admin/devices"),
    );
    const dev = devices.find((d) => d.id === target || d.name === target);
    if (!dev) {
      throw new CliError(`${c.red}No device matching '${target}'${c.reset}`, EXIT_USER_ERROR);
    }
    const headers = await authHeaders();
    const res = await withSpinner(`Renaming ${dev.name}`, () =>
      fetch(`${GATEWAY_REQUEST_URL}/admin/devices/${dev.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: newName }),
      }),
    );
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { code?: string; error?: string };
        if (parsed.code === "DEVICE_NAME_TAKEN")
          detail = `a device named '${newName}' already exists`;
        else if (parsed.error) detail = parsed.error;
      } catch {
        /* not JSON: show the raw body */
      }
      throw new CliError(
        `${c.red}Failed: ${res.status} ${detail}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    console.log(`Renamed ${dev.name} → ${c.bold}${newName}${c.reset} (${dev.id}).`);
  },
});

/**
 * Stable per-install identity for this config dir, minted once. Sent as
 * `capabilities.installId` at redeem so the gateway adopts the same device
 * row on re-pair regardless of the row's name.
 */
export function getOrCreateInstallId(configDir: string): string {
  const file = pathJoin(configDir, "install-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not minted yet */
  }
  const fresh = randomUUID();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
  } catch {
    /* unwritable config dir: pair without a durable identity */
  }
  return fresh;
}

const devicesSetSelfCommand = defineCommand({
  meta: {
    name: "set-self",
    description: "Annotate a device with its owner's email/phone identifiers",
  },
  args: {
    target: {
      type: "positional",
      description: "device id or name",
      required: true,
    },
    email: {
      type: "string",
      description: "Email belonging to the device owner (repeatable)",
    },
    phone: {
      type: "string",
      description: "E.164 phone number belonging to the device owner (repeatable)",
    },
  },
  async run(ctx) {
    // `omnesis devices set-self <device-id-or-name> [--email a@b.com ...] [--phone +447... ...]`
    // Flag-driven UX: scriptable, easy to retry. Empty patches are
    // rejected by the gateway. To clear, pass an explicit empty list via
    // `--email ""` (filtered out) — explicit clearing is rare enough we
    // don't need a `--clear` flag yet.
    const target = ctx.args.target;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: omnesis devices set-self <device-id-or-name> [--email a@b.com]... [--phone +447700000000]...${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    // citty parses repeated `--email a --email b` as args.email = ["a","b"]
    // at runtime, but its TS types say `string`. Coerce here.
    const emails = (
      Array.isArray(ctx.args.email) ? ctx.args.email : ctx.args.email ? [ctx.args.email] : []
    ) as string[];
    const phones = (
      Array.isArray(ctx.args.phone) ? ctx.args.phone : ctx.args.phone ? [ctx.args.phone] : []
    ) as string[];

    if (emails.length === 0 && phones.length === 0) {
      throw new CliError(
        `${c.red}At least one --email or --phone required.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: DeviceListItem[] }>("/admin/devices"),
    );
    const dev = devices.find((d) => d.id === target || d.name === target);
    if (!dev) {
      throw new CliError(`${c.red}No device matching '${target}'${c.reset}`, EXIT_USER_ERROR);
    }

    const patch: { selfEmails?: string[]; selfPhones?: string[] } = {};
    if (emails.length > 0) patch.selfEmails = emails;
    if (phones.length > 0) patch.selfPhones = phones;

    const headers = await authHeaders();
    const res = await withSpinner(`Updating self info on ${dev.name}`, () =>
      fetch(`${GATEWAY_REQUEST_URL}/admin/devices/${dev.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      }),
    );
    if (!res.ok) {
      const text = await res.text();
      throw new CliError(
        `${c.red}Failed: ${res.status} ${text}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    const body = (await res.json()) as { device: { selfEmails: string[]; selfPhones: string[] } };
    console.log();
    console.log(`Self annotation updated on ${c.bold}${dev.name}${c.reset}:`);
    console.log(`  emails: ${body.device.selfEmails.join(", ") || c.dim + "(none)" + c.reset}`);
    console.log(`  phones: ${body.device.selfPhones.join(", ") || c.dim + "(none)" + c.reset}`);
    console.log();
    console.log(
      `${c.dim}Restart the gateway to bootstrap the canonical self person from this annotation${c.reset}`,
    );
    console.log(`${c.dim}(only takes effect when no canonical self exists yet).${c.reset}`);
  },
});

export const devicesCommand = defineCommand({
  meta: {
    name: "devices",
    description: "Manage paired devices",
  },
  subCommands: {
    list: devicesListCommand,
    discover: devicesDiscoverCommand,
    pair: devicesPairCommand,
    redeem: devicesRedeemCommand,
    repair: devicesRepairCommand,
    revoke: devicesRevokeCommand,
    rename: devicesRenameCommand,
    "set-self": devicesSetSelfCommand,
  },
  // Default to `list` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(devicesListCommand, { rawArgs: [] });
    }
  },
});

/**
 * Whether this config directory holds the gateway's bootstrap admin token.
 * Presence is the whole question — the file is read raw rather than through
 * `readTokenFile` because on a keyring install decrypting it needs the
 * passphrase, and a locked keyring would read as "no token" on the very host
 * where the answer is yes.
 */
function hasAdminTokenFile(): boolean {
  const dir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  try {
    return readFileSync(pathJoin(dir, "token"), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a user-supplied file path: expand a leading `~/` (the shell only
 * expands an unquoted tilde) and absolutize relative paths.
 */
function expandHomePath(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return pathJoin(process.env.HOME ?? "~", p.slice(2));
  }
  return pathResolve(p);
}

/**
 * Parse + validate one comma-separated self-info field for `devices pair`.
 *Splits on commas, trims, drops blanks, then runs each survivor
 * through `validate` (`normalizeEmail` / `normalizePhone`). Returns the
 * normalized list, or a `{ error }` describing the first entry that failed
 * — the caller turns that into a re-prompt (interactive) or a `CliError`
 * (flag-driven). An all-blank / empty input yields an empty list (skip).
 */
export function parseSelfInfoField(
  raw: string,
  validate: (v: string) => string | null,
): { values: string[] } | { error: string } {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const normalized = validate(trimmed);
    if (normalized === null) return { error: trimmed };
    out.push(normalized);
  }
  return { values: Array.from(new Set(out)) };
}

// `normalizeEmail` always returns a string (it can't reject), so wrap it to
// match the `(v) => string | null` validator shape and reject anything that
// doesn't look like `local@domain.tld`. Phones use `normalizePhone` directly
// — it already returns null for an unparseable number.
const validateSelfEmail = (v: string): string | null =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? normalizeEmail(v) : null;
const validateSelfPhone = (v: string): string | null => normalizePhone(v);

/**
 * Collect the optional device-owner self annotation for `devices pair` from the
 * repeatable `--self-email` / `--self-phone` flags (citty surfaces repeated
 * flags as an array).
 *
 * This is a legacy, opt-in convenience: the canonical home for "who you are" is
 * `omnesis self` / `config.self`, and pairing does not prompt for identity.
 * Returns empty lists when no flag is supplied. An invalid entry throws a
 * `CliError` so a bad scripted invocation fails loudly.
 */
function collectSelfInfo(ctx: { args: Record<string, unknown> }): {
  selfEmails: string[];
  selfPhones: string[];
} {
  const flagList = (key: string): string[] => {
    const v = ctx.args[key];
    return Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
  };
  const emailFlags = flagList("self-email");
  const phoneFlags = flagList("self-phone");
  if (emailFlags.length === 0 && phoneFlags.length === 0) {
    return { selfEmails: [], selfPhones: [] };
  }

  const emails = parseSelfInfoField(emailFlags.join(","), validateSelfEmail);
  if ("error" in emails) {
    throw new CliError(
      `${c.red}Invalid --self-email '${emails.error}'.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const phones = parseSelfInfoField(phoneFlags.join(","), validateSelfPhone);
  if ("error" in phones) {
    throw new CliError(
      `${c.red}Invalid --self-phone '${phones.error}' (must be E.164-parseable).${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return { selfEmails: emails.values, selfPhones: phones.values };
}

/**
 * Terminal-redeem guidance for a freshly minted pairing code, one console line
 * per array entry (already colour-coded; a leading blank line spaces it off
 * from the code above). iOS/Android are handled by the caller (they render a
 * scannable QR instead), so this covers only the kinds redeemed from a shell
 * or another app — and crucially tailors the copy so an operator is never told
 * to run a command that doesn't apply to their device kind:
 *   - portal    → paste the code into the portal login screen; the browser
 *                 redeems it into a cookie session (AuthService.login only
 *                 consumes `kind=portal` codes), so there is no command to run.
 *   - browser   → enter the gateway URL + code in the extension's Options page
 *                 (the extension redeems itself; nothing to run here).
 *   - agent     → install and provision with `omnesis connect`.
 *   - collector → self-pairs on first run; save the token by hand otherwise
 *                 (a bare redeem that just prints a token wouldn't wire it up).
 *   - cli       → `omnesis pair <code>`, with a raw curl as a no-CLI fallback.
 */
/** How an integration redeems a pairing or repair code into the token file it reads. */
function integrationRedeemLines(code: string, gatewayUrl: string): string[] {
  return [
    "",
    `${c.dim}On the machine the integration runs on, redeem the code into a token file it reads:${c.reset}`,
    `  omnesis devices redeem ${code} --gateway-url ${gatewayUrl} --save ~/.config/omnesis/integration.token`,
    `${c.dim}No Omnesis CLI there? Redeem the code directly and keep the returned token:${c.reset}`,
    `  ${c.dim}curl -X POST ${gatewayUrl}/devices/pair -H 'Content-Type: application/json' -d '{"pairingCode":"${code}","kind":"integration"}'${c.reset}`,
  ];
}

export function pairInstructionLines(kind: DeviceKind, code: string, gatewayUrl: string): string[] {
  switch (kind) {
    case "portal":
      // The portal redeems the code itself: the operator pastes it into the
      // portal login screen, which exchanges it for a browser session. There
      // is no `omnesis pair` / curl step — those would burn the code for a raw
      // token that the portal login can't use.
      return [
        "",
        `${c.dim}Open the Omnesis portal on the new device and paste this code into its login screen.${c.reset}`,
        `${c.dim}The portal redeems the code itself into a browser session — nothing to run in a terminal.${c.reset}`,
      ];
    case "agent":
      return [
        "",
        `${c.dim}On the external-agent host, install and provision the integration:${c.reset}`,
        `  omnesis connect openclaw --code ${code} --gateway-url ${gatewayUrl}`,
        `${c.dim}(use hermes instead of openclaw when appropriate)${c.reset}`,
      ];
    case "collector":
      // The collector pairs itself on first run (resolveCollectorToken), so a
      // bare curl/redeem that just prints a token doesn't actually wire it up.
      // Point at the file the collector reads instead of a throwaway redeem.
      return [
        "",
        `${c.dim}The collector pairs itself on first run, so you usually don't need this code.${c.reset}`,
        `${c.dim}To pair it by hand, save the token where the collector looks for it:${c.reset}`,
        `  omnesis pair ${code} --gateway-url ${gatewayUrl} --save ~/.config/omnesis/collector-token`,
        `${c.dim}(or export the printed token as OMNESIS_TOKEN; replace ${gatewayUrl} with an address the collector host can reach)${c.reset}`,
      ];
    case "browser":
      // The extension redeems the code itself and stores its own credential —
      // it never reads a terminal, so there is no curl/redeem to show here.
      return ["", ...browserPairingLines(gatewayUrl, code, { install: true })];
    case "integration":
      // A code minted here carries no access level: that is an access decision,
      // made from a portal session. Until it is, the integration's questions
      // are refused — say so now rather than let its first question find out.
      return [
        ...integrationRedeemLines(code, gatewayUrl),
        "",
        `${c.yellow}Its questions are refused until you choose its access level:${c.reset} ${gatewayUrl}/portal/settings/devices`,
        `${c.dim}(or pair it from the portal's Devices page, which chooses the level with the code)${c.reset}`,
      ];
    default:
      // cli — a terminal device with the Omnesis CLI (or a bare curl fallback).
      return [
        "",
        `${c.dim}On the new device, run:${c.reset}`,
        `  omnesis pair ${code} --gateway-url ${gatewayUrl}`,
        `${c.dim}(replace ${gatewayUrl} with an address the new device can reach)${c.reset}`,
        `${c.dim}No Omnesis CLI on that device? Redeem the code directly:${c.reset}`,
        `  ${c.dim}curl -X POST ${gatewayUrl}/devices/pair -H 'Content-Type: application/json' -d '{"pairingCode":"${code}"}'${c.reset}`,
      ];
  }
}

/**
 * The store listing of the browser extension. The portal's Sources card and
 * pairing dialog link the same address from
 * `packages/gateway/portal/js/lib/extension-links.js`; the two are asserted
 * equal by the CLI's tests, since the portal's copy is plain JS the CLI
 * cannot import.
 */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/omnesis-browser-capture/akojepkcdbncipjdonhnnfmjacknplmn";

/**
 * How a browser pairing code is redeemed: in the extension's Options page,
 * never in a terminal. Names where the extension comes from and the one
 * thing its service worker cannot do, which is click through a certificate
 * warning.
 */
function browserPairingLines(
  gatewayUrl: string,
  code: string,
  options: { install: boolean },
): string[] {
  return [
    ...(options.install
      ? [
          `${c.dim}Install Omnesis Browser Capture from the Chrome Web Store:${c.reset} ${CHROME_WEB_STORE_URL}`,
          `${c.dim}In it, open Options and enter:${c.reset}`,
        ]
      : [`${c.dim}In the Omnesis browser extension, open Options and enter:${c.reset}`]),
    `  ${c.dim}Gateway URL:${c.reset}  ${gatewayUrl}`,
    `  ${c.dim}Pairing code:${c.reset} ${code}`,
    ...(options.install
      ? [
          `${c.dim}The extension needs a browser-trusted HTTPS gateway, dialled by a name the certificate covers: https://omnesis.dev/docs/setup#browser-extension${c.reset}`,
        ]
      : []),
  ];
}

async function authHeaders(): Promise<Record<string, string>> {
  const { resolveToken } = await import("@omnesis/core");
  const token = resolveToken();
  if (!token) {
    throw new CliError(`${c.red}No auth token found.${c.reset}`, EXIT_AUTH);
  }
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
