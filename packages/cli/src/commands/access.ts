// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { ensureGatewayTrust, readSecretJsonFileSync } from "@omnesis/core";

import {
  c,
  CliError,
  EXIT_AUTH,
  EXIT_GATEWAY_ERROR,
  EXIT_USER_ERROR,
  gatewayJson,
  isJSON,
  withSpinner,
} from "../utils.js";

type LegacyMcpMode = "answer" | "direct";

type LegacyMcpProfile =
  | { version: 1; gatewayUrl: string; token: string }
  | { version: 2; mode: LegacyMcpMode; gatewayUrl: string; token: string };

interface LegacyMcpProfileTarget {
  mode: LegacyMcpMode;
  configDir: string;
  profilePath: string;
}

export interface LegacyMcpRetirementResult {
  mode: LegacyMcpMode;
  profilePath: string;
  outcome: "revoked" | "missing";
}

const LEGACY_PROFILE_FILE: Record<LegacyMcpMode, string> = {
  answer: "answer-profile.json",
  direct: "direct-profile.json",
};

function defaultLegacyConfigDir(mode: LegacyMcpMode): string {
  return join(homedir(), ".config", mode === "answer" ? "omnesis-mcp" : "omnesis-mcp-direct");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function legacyMcpProfileTarget(
  mode: LegacyMcpMode,
  configDir = defaultLegacyConfigDir(mode),
): LegacyMcpProfileTarget {
  const resolved = resolve(expandHome(configDir));
  return { mode, configDir: resolved, profilePath: join(resolved, LEGACY_PROFILE_FILE[mode]) };
}

function readLegacyMcpProfile(target: LegacyMcpProfileTarget): LegacyMcpProfile {
  const value = readSecretJsonFileSync<unknown>(target.profilePath, {
    configDir: target.configDir,
  });
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const legacyAnswer =
    target.mode === "answer" &&
    record?.version === 1 &&
    !Object.hasOwn(record, "mode") &&
    Object.keys(record).every((key) => ["version", "gatewayUrl", "token"].includes(key));
  const versionTwo =
    record?.version === 2 &&
    record.mode === target.mode &&
    Object.keys(record).every((key) => ["version", "mode", "gatewayUrl", "token"].includes(key));
  if (
    (!legacyAnswer && !versionTwo) ||
    typeof record?.gatewayUrl !== "string" ||
    typeof record.token !== "string" ||
    !record.token
  ) {
    throw new CliError(
      `${target.profilePath} is not a valid legacy Omnesis MCP ${target.mode} profile.`,
      EXIT_USER_ERROR,
    );
  }
  return record as LegacyMcpProfile;
}

export async function retireLegacyMcpProfile(
  target: LegacyMcpProfileTarget,
  deps: {
    trust?: typeof ensureGatewayTrust;
    request?: typeof fetch;
    remove?: (path: string) => void;
  } = {},
): Promise<LegacyMcpRetirementResult> {
  if (!existsSync(target.profilePath)) {
    return { mode: target.mode, profilePath: target.profilePath, outcome: "missing" };
  }
  const profile = readLegacyMcpProfile(target);
  const gatewayUrl = profile.gatewayUrl.replace(/\/+$/u, "");
  await (deps.trust ?? ensureGatewayTrust)({ gatewayUrl, configDir: target.configDir });
  const response = await (deps.request ?? fetch)(`${gatewayUrl}/legacy-mcp/revoke`, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { Authorization: `Bearer ${profile.token}`, "User-Agent": "omnesis" },
  });
  if (response.status !== 200) {
    const detail = await response.text().catch(() => "");
    throw new CliError(
      `Gateway refused to retire the legacy ${target.mode} credential (${response.status})${detail ? `: ${detail}` : "."}`,
      response.status >= 500 || response.status === 404 ? EXIT_GATEWAY_ERROR : EXIT_AUTH,
    );
  }
  (deps.remove ?? ((path: string) => rmSync(path, { force: true })))(target.profilePath);
  return {
    mode: target.mode,
    profilePath: target.profilePath,
    outcome: "revoked",
  };
}

const retireLegacyMcpCommand = defineCommand({
  meta: {
    name: "retire-legacy-mcp",
    description: "Revoke and remove retired stdio MCP profile credentials",
  },
  args: {
    "answer-config-dir": {
      type: "string",
      description: "Legacy Answer profile directory",
    },
    "direct-config-dir": {
      type: "string",
      description: "Legacy Direct profile directory",
    },
  },
  async run({ args }) {
    const targets = (["answer", "direct"] as const).map((mode) =>
      legacyMcpProfileTarget(
        mode,
        typeof args[`${mode}-config-dir`] === "string"
          ? args[`${mode}-config-dir`]
          : defaultLegacyConfigDir(mode),
      ),
    );
    const results: LegacyMcpRetirementResult[] = [];
    for (const target of targets) results.push(await retireLegacyMcpProfile(target));
    const changed = results.filter((result) => result.outcome !== "missing");
    if (changed.length === 0) {
      console.log("No legacy MCP profiles were found.");
      return;
    }
    for (const result of changed) {
      console.log(
        `Revoked legacy ${result.mode} MCP credential and profile ${result.profilePath}.`,
      );
    }
    console.log(
      `${c.dim}Operational devices and non-MCP CLI credentials were left unchanged.${c.reset}`,
    );
  },
});

export interface AccessAuditEventDto {
  id: string;
  occurredAt: number;
  eventType: string;
  principalId: string | null;
  grantId: string | null;
  grantRevision: number | null;
  credentialId: string | null;
  oauthClientId: string | null;
  actorTokenId: string | null;
  detail: Record<string, unknown>;
}

export interface AccessAuditPageDto {
  items: AccessAuditEventDto[];
  pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
}

export interface AccessAuditQuery {
  limit?: string;
  cursor?: string;
  connection?: string;
  grant?: string;
}

/** The audit route path for one page, with only the filters the caller gave. */
export function accessAuditPath(query: AccessAuditQuery): string {
  const params = new URLSearchParams();
  if (query.limit) params.set("limit", query.limit);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.connection) params.set("principalId", query.connection);
  if (query.grant) params.set("grantId", query.grant);
  const search = params.toString();
  return `/admin/access/audit${search ? `?${search}` : ""}`;
}

const shortId = (value: string | null): string => (value ? value.slice(0, 8) : "-");

/** One line per event: when, what, whose, and the bounded detail the gateway kept. */
export function formatAccessAuditPage(page: AccessAuditPageDto): string[] {
  if (page.items.length === 0) return ["No access events recorded."];
  const lines = [
    `${c.bold}${"WHEN".padEnd(24)} ${"EVENT".padEnd(22)} ${"CONNECTION".padEnd(10)} ${"GRANT".padEnd(9)} ${"REV".padEnd(4)} ${"SIGN-IN".padEnd(10)} DETAIL${c.reset}`,
  ];
  for (const event of page.items) {
    const detail = Object.entries(event.detail)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    lines.push(
      `${new Date(event.occurredAt).toISOString().padEnd(24)} ${event.eventType.padEnd(22)} ${shortId(event.principalId).padEnd(10)} ${shortId(event.grantId).padEnd(9)} ${String(event.grantRevision ?? "-").padEnd(4)} ${shortId(event.credentialId).padEnd(10)} ${detail}`,
    );
  }
  if (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    lines.push("", `${c.dim}More events: --cursor ${page.pageInfo.nextCursor}${c.reset}`);
  }
  return lines;
}

const auditCommand = defineCommand({
  meta: { name: "audit", description: "List the access ledger, newest first" },
  args: {
    limit: { type: "string", description: "Events per page (default 50, max 500)" },
    cursor: { type: "string", description: "Continue from the cursor a previous page printed" },
    connection: {
      type: "string",
      alias: "principal",
      description: "Only events for this connection id",
    },
    grant: { type: "string", description: "Only events for this internal permission record id" },
  },
  async run({ args }) {
    const query: AccessAuditQuery = {
      ...(typeof args.limit === "string" ? { limit: args.limit } : {}),
      ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
      ...(typeof args.connection === "string" ? { connection: args.connection } : {}),
      ...(typeof args.grant === "string" ? { grant: args.grant } : {}),
    };
    const page = await withSpinner("Loading access audit", () =>
      gatewayJson<AccessAuditPageDto>(accessAuditPath(query)),
    );
    if (isJSON) {
      console.log(JSON.stringify(page));
      return;
    }
    for (const line of formatAccessAuditPage(page)) console.log(line);
  },
});

interface AccessLevelRuleDto {
  capability: "answer" | "direct" | "notes";
  sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] };
  release?: { mode: "reviewed"; policyFamilyId: string } | { mode: "unreviewed" };
}

export interface AccessLevelsOverviewDto {
  sources: { id: string; available?: boolean }[];
  policyFamilies: { id: string; name: string }[];
  levels: {
    id: string;
    name: string;
    rules: AccessLevelRuleDto[];
    connectionCount: number;
    devices?: { id: string; name: string }[];
  }[];
}

/**
 * The sources one rule reaches, in the portal's words: all of them, or how
 * many of the connected sources it lets in.
 */
function ruleSources(
  rule: AccessLevelRuleDto,
  sources: AccessLevelsOverviewDto["sources"],
): string {
  const connected = sources
    .filter((source) => source.available !== false)
    .map((source) => source.id);
  const named = new Set(rule.sources.sourceIds);
  if (rule.sources.mode === "all" || (rule.sources.mode === "denylist" && named.size === 0)) {
    return "all sources";
  }
  const allowed = connected.filter((id) =>
    rule.sources.mode === "allowlist" ? named.has(id) : !named.has(id),
  ).length;
  return `${allowed} of ${connected.length} sources`;
}

/**
 * Each access level with what it grants and who uses it: its capabilities,
 * where Answer reads and how its replies are released, then the connections
 * and integrations on it. Changing a level, or the level an integration uses, happens on
 * the portal's Access and Devices pages.
 */
export function formatAccessLevels(overview: AccessLevelsOverviewDto): string[] {
  if (overview.levels.length === 0) return ["No access levels."];
  const policyName = new Map(overview.policyFamilies.map((policy) => [policy.id, policy.name]));
  const lines: string[] = [];
  for (const level of overview.levels) {
    const devices = level.devices ?? [];
    const users = [
      level.connectionCount === 0
        ? "No connections"
        : `${level.connectionCount} connection${level.connectionCount === 1 ? "" : "s"}`,
      ...(devices.length > 0
        ? [`${devices.length} integration${devices.length === 1 ? "" : "s"}`]
        : []),
    ].join(" · ");
    lines.push(`${c.bold}${level.name}${c.reset}  ${c.dim}${users} · ${level.id}${c.reset}`);
    for (const rule of level.rules) {
      const release =
        rule.capability !== "answer" || !rule.release
          ? ""
          : rule.release.mode === "unreviewed"
            ? " · no privacy review"
            : ` · reviewed under “${policyName.get(rule.release.policyFamilyId) ?? "an unavailable policy"}”`;
      const reach =
        rule.capability === "notes" ? "" : ` from ${ruleSources(rule, overview.sources)}`;
      lines.push(`  ${rule.capability}${reach}${release}`);
    }
    if (devices.length > 0) {
      lines.push(
        `  ${c.dim}answers for integrations: ${devices.map((d) => d.name).join(", ")}${c.reset}`,
      );
    }
  }
  lines.push(
    "",
    `${c.dim}Edit levels on the portal's Access page; choose an integration's level on its Devices page.${c.reset}`,
  );
  return lines;
}

const levelsCommand = defineCommand({
  meta: {
    name: "levels",
    description: "List access levels, what each grants, and the connections and integrations on it",
  },
  async run() {
    const overview = await withSpinner("Loading access levels", () =>
      gatewayJson<AccessLevelsOverviewDto>("/admin/access"),
    );
    if (isJSON) {
      console.log(
        JSON.stringify({ levels: overview.levels, policyFamilies: overview.policyFamilies }),
      );
      return;
    }
    for (const line of formatAccessLevels(overview)) console.log(line);
  },
});

export const accessCommand = defineCommand({
  meta: { name: "access", description: "Inspect and migrate delegated MCP access" },
  subCommands: {
    audit: auditCommand,
    levels: levelsCommand,
    "retire-legacy-mcp": retireLegacyMcpCommand,
  },
});
