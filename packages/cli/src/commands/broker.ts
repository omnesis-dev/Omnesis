// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { defineCommand } from "citty";
import {
  BrokeredCredentials,
  DEFAULT_BROKER_PURPOSE,
  DEFAULT_CONFIG_DIR,
  brokerBindingPath,
  hasBrokerBinding,
  listBrokeredAccountIds,
  readBrokerBinding,
  readCredentialBrokerConfig,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  type BrokerBinding,
  type BrokerConnectionRef,
  type CredentialBrokerConfig,
} from "@omnesis/core";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, isJSON } from "../utils.js";
import type { ProviderBrokerSpec, SourceOrProviderDefinition } from "@omnesis/source-sdk";

/**
 * `omnesis broker` — take account credentials from a credential broker.
 *
 *   omnesis broker set --url <url> --key-file <path>   where the broker is
 *   omnesis broker status                               linked accounts, checked
 *   omnesis broker link <provider> <connection>...      link one account
 *   omnesis broker unlink <provider> <account>          forget a link
 *
 * Every subcommand works on this machine's config directory, because the
 * broker configuration and each binding are files the collector reads. Run it
 * on the collector's host, as the collector's user.
 */

function configDir(): string {
  return process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

interface BrokerProvider {
  id: string;
  name: string;
  sourceIds: string[];
  spec: ProviderBrokerSpec;
}

/** The providers whose accounts can take their credential from the broker. */
export function brokerProviders(
  definitions: readonly SourceOrProviderDefinition[],
): BrokerProvider[] {
  const out: BrokerProvider[] = [];
  for (const def of definitions) {
    if (def.type !== "provider" || !def.broker) continue;
    out.push({
      id: def.provider.id,
      name: def.provider.name,
      sourceIds: def.sources.map((s) => s.id),
      spec: def.broker,
    });
  }
  return out;
}

async function loadBrokerProviders(): Promise<BrokerProvider[]> {
  const { allDefinitions } = await import("@omnesis/collector/registry");
  return brokerProviders(allDefinitions);
}

function findProvider(providers: BrokerProvider[], id: string): BrokerProvider {
  const found = providers.find((p) => p.id === id);
  if (found) return found;
  throw new CliError(
    `${c.red}${id} cannot take credentials from the broker.${c.reset} ` +
      `${c.dim}Providers that can: ${providers.map((p) => p.id).join(", ")}${c.reset}`,
    EXIT_USER_ERROR,
  );
}

/**
 * Parse `[purpose=]<integration>/<connection-id>` arguments into a binding's
 * connections. The purpose may be left out only when the provider has one.
 */
export function parseConnectionArgs(
  spec: ProviderBrokerSpec,
  args: readonly string[],
): Record<string, BrokerConnectionRef> {
  const known = new Map(spec.purposes.map((p) => [p.id, p]));
  const connections: Record<string, BrokerConnectionRef> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const purpose =
      eq >= 0 ? arg.slice(0, eq) : spec.purposes.length === 1 ? spec.purposes[0]!.id : undefined;
    if (!purpose) {
      throw new Error(
        `Name what ${arg} is for: ${spec.purposes.map((p) => `${p.id}=<integration>/<connection>`).join(", ")}`,
      );
    }
    if (!known.has(purpose)) {
      throw new Error(
        `Unknown purpose ${purpose}; expected one of ${[...known.keys()].join(", ")}`,
      );
    }
    if (connections[purpose]) throw new Error(`${purpose} is linked twice`);
    const ref = eq >= 0 ? arg.slice(eq + 1) : arg;
    const slash = ref.indexOf("/");
    const providerConfigKey = slash > 0 ? ref.slice(0, slash) : "";
    const connectionId = slash > 0 ? ref.slice(slash + 1) : "";
    if (!providerConfigKey || !connectionId || connectionId.includes("/")) {
      throw new Error(`${arg} is not <integration>/<connection-id>`);
    }
    connections[purpose] = { providerConfigKey, connectionId };
  }
  if (Object.keys(connections).length === 0) throw new Error("Name at least one connection");
  for (const purpose of spec.purposes) {
    if (purpose.required !== false && !connections[purpose.id]) {
      throw new Error(`${purpose.label} (${purpose.id}) must be linked`);
    }
  }
  return connections;
}

/** Parse `--param name=value` arguments against the provider's declared params. */
export function parseParamArgs(
  spec: ProviderBrokerSpec,
  args: readonly string[],
): Record<string, string> {
  const declared = new Map((spec.params ?? []).map((p) => [p.name, p]));
  const params: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : "";
    if (!name || !declared.has(name)) {
      throw new Error(
        `Unknown parameter ${name || arg}; ${declared.size ? `expected ${[...declared.keys()].join(", ")}` : "this provider takes none"}`,
      );
    }
    params[name] = arg.slice(eq + 1);
  }
  for (const p of spec.params ?? []) {
    if (params[p.name] === undefined && p.default !== undefined) params[p.name] = p.default;
    if (p.required && !params[p.name])
      throw new Error(`${p.label} (--param ${p.name}=…) is required`);
  }
  return params;
}

/**
 * Link one account: ask the provider which account the connections belong to,
 * then store the binding under that account. Nothing is written unless the
 * provider resolved the account with the brokered credentials.
 */
export async function linkBrokeredAccount(opts: {
  spec: ProviderBrokerSpec;
  config: CredentialBrokerConfig;
  connections: Record<string, BrokerConnectionRef>;
  params: Record<string, string>;
  configDir: string;
  /** Take over an account signed in here, replacing its local credential's role. */
  replace?: boolean;
  fetch?: typeof fetch;
}): Promise<{ accountId: string; binding: BrokerBinding; replaced: boolean }> {
  const probe: BrokerBinding = {
    broker: "nango",
    connections: opts.connections,
    ...(Object.keys(opts.params).length ? { params: opts.params } : {}),
  };
  const credentials = new BrokeredCredentials(probe, opts.config, { fetch: opts.fetch });
  const resolved = await opts.spec.resolveAccount(credentials, opts.params, {
    configDir: opts.configDir,
  });
  if (!resolved.accountId) throw new Error("The provider could not tell which account this is");
  const params = { ...opts.params, ...resolved.params };
  const binding: BrokerBinding = {
    broker: "nango",
    connections: opts.connections,
    ...(Object.keys(params).length ? { params } : {}),
  };
  const path = brokerBindingPath(opts.spec.fileKey, resolved.accountId, opts.configDir);
  const local = existsSync(dirname(path))
    ? readdirSync(dirname(path)).filter((name) => name !== basename(path))
    : [];
  // An account signed in here would flip to the broker, and every source of
  // it the link does not cover would stop: that is the operator's call.
  if (local.length > 0 && !opts.replace) {
    throw new Error(
      `${resolved.accountId} is already signed in here; pass --replace to take its credential from the broker instead`,
    );
  }
  const replaced =
    local.length > 0 || hasBrokerBinding(opts.spec.fileKey, resolved.accountId, opts.configDir);
  await writeBrokerBinding(opts.spec.fileKey, resolved.accountId, binding, opts.configDir);
  return { accountId: resolved.accountId, binding, replaced };
}

/**
 * The key in a file: the file's only line, or — in an env file, which is
 * where a self-hosted Nango keeps its own — the `NANGO_SECRET_KEY` entry (or
 * the one `name` picks).
 */
export function keyFromFile(text: string, name?: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const entries = lines.filter((l) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(l));
  if (entries.length === 0 && !name) return lines.length === 1 ? lines[0] : undefined;
  const wanted = name ?? "NANGO_SECRET_KEY";
  const entry = entries.find((l) => l.replace(/^export\s+/, "").startsWith(`${wanted}=`));
  const value = entry
    ?.slice(entry.indexOf("=") + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  return value || undefined;
}

function readKey(args: { "key-file"?: string; "key-env"?: string; "key-name"?: string }): string {
  if (args["key-file"] && args["key-env"]) {
    throw new CliError(`${c.red}Pass --key-file or --key-env, not both${c.reset}`, EXIT_USER_ERROR);
  }
  if (args["key-file"]) {
    if (!existsSync(args["key-file"])) {
      throw new CliError(`${c.red}${args["key-file"]} does not exist${c.reset}`, EXIT_USER_ERROR);
    }
    const value = keyFromFile(readFileSync(args["key-file"], "utf8"), args["key-name"]);
    if (!value) {
      throw new CliError(
        `${c.red}${args["key-file"]} holds no ${args["key-name"] ?? "key"}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    return value;
  }
  if (args["key-env"]) {
    const value = process.env[args["key-env"]]?.trim();
    if (!value)
      throw new CliError(`${c.red}$${args["key-env"]} is empty${c.reset}`, EXIT_USER_ERROR);
    return value;
  }
  throw new CliError(
    `${c.red}Pass the broker's API key with --key-file <path> or --key-env <VAR>${c.reset} ` +
      `${c.dim}(never on the command line, where it lands in shell history)${c.reset}`,
    EXIT_USER_ERROR,
  );
}

function fail(err: unknown): never {
  // A provider's `AuthFailure` says what to do about it; keep that with the
  // message rather than leaving the operator with only the refusal.
  const remedy = (err as { remedy?: unknown } | null)?.remedy;
  throw new CliError(
    `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}` +
      (typeof remedy === "string" && remedy ? `\n${c.dim}${remedy}${c.reset}` : ""),
    EXIT_FAILURE,
  );
}

const setCommand = defineCommand({
  meta: { name: "set", description: "Configure the credential broker (a self-hosted Nango)" },
  args: {
    url: {
      type: "string",
      description: "The broker's API base URL, e.g. http://127.0.0.1:3003",
      required: true,
    },
    "key-file": {
      type: "string",
      description: "File holding the broker API key: the key alone, or an env file",
    },
    "key-name": {
      type: "string",
      description: "The entry to read from an env file (default NANGO_SECRET_KEY)",
    },
    "key-env": { type: "string", description: "Environment variable holding the broker API key" },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const secretKey = readKey(args);
    try {
      await writeCredentialBrokerConfig({ kind: "nango", url: args.url, secretKey }, configDir());
    } catch (err) {
      fail(err);
    }
    const config = (await readCredentialBrokerConfig(configDir()))!;
    if (isJSON) {
      console.log(JSON.stringify({ ok: true, url: config.url }));
      return;
    }
    console.log(`${c.green}✓${c.reset} Credential broker set to ${config.url}`);
    console.log(
      `${c.dim}Link an account with \`omnesis broker link <provider> <integration>/<connection-id>\`${c.reset}`,
    );
  },
});

const statusCommand = defineCommand({
  meta: { name: "status", description: "List brokered accounts and check each credential" },
  args: {
    offline: { type: "boolean", description: "Do not ask the broker; list bindings only" },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const dir = configDir();
    const config = await readCredentialBrokerConfig(dir).catch((err: unknown) => fail(err));
    const providers = await loadBrokerProviders();
    const accounts: Array<{
      provider: string;
      account: string;
      connections: Array<{
        purpose: string;
        integration: string;
        connection: string;
        ok?: boolean;
        error?: string;
      }>;
    }> = [];
    for (const provider of providers) {
      for (const account of listBrokeredAccountIds(provider.spec.fileKey, dir)) {
        const binding = await readBrokerBinding(provider.spec.fileKey, account, dir);
        if (!binding) continue;
        const credentials =
          config && !args.offline ? new BrokeredCredentials(binding, config) : null;
        const rows = [];
        for (const [purpose, ref] of Object.entries(binding.connections)) {
          const row: (typeof accounts)[number]["connections"][number] = {
            purpose,
            integration: ref.providerConfigKey,
            connection: ref.connectionId,
          };
          if (credentials) {
            try {
              await credentials.get(purpose);
              row.ok = true;
            } catch (err) {
              row.ok = false;
              row.error = err instanceof Error ? err.message : String(err);
            }
          }
          rows.push(row);
        }
        accounts.push({ provider: provider.id, account, connections: rows });
      }
    }
    if (isJSON) {
      console.log(
        JSON.stringify({ broker: config ? { url: config.url } : null, accounts }, null, 2),
      );
      return;
    }
    console.log(
      config
        ? `\n${c.bold}Credential broker${c.reset} ${config.url}\n`
        : `\n${c.yellow}No credential broker is configured.${c.reset} ${c.dim}Run \`omnesis broker set\`.${c.reset}\n`,
    );
    if (accounts.length === 0) {
      console.log(`${c.dim}No accounts are linked.${c.reset}`);
      return;
    }
    for (const a of accounts) {
      console.log(`  ${c.bold}${a.provider}${c.reset} ${a.account}`);
      for (const r of a.connections) {
        const mark =
          r.ok === undefined
            ? `${c.dim}·${c.reset}`
            : r.ok
              ? `${c.green}●${c.reset}`
              : `${c.red}○${c.reset}`;
        const label = r.purpose === DEFAULT_BROKER_PURPOSE ? "" : `${r.purpose}: `;
        console.log(
          `    ${mark} ${label}${r.integration}/${r.connection}${r.error ? ` ${c.red}${r.error}${c.reset}` : ""}`,
        );
      }
    }
    console.log();
  },
});

const linkCommand = defineCommand({
  meta: { name: "link", description: "Link an account to its connections at the broker" },
  args: {
    provider: {
      type: "positional",
      description: "provider id, e.g. notion or google",
      required: true,
    },
    param: { type: "string", description: "A provider setting, name=value (repeatable)" },
    replace: {
      type: "boolean",
      description: "Take over an account already signed in here",
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const dir = configDir();
    const config = await readCredentialBrokerConfig(dir).catch((err: unknown) => fail(err));
    if (!config) {
      throw new CliError(
        `${c.red}No credential broker is configured.${c.reset} ${c.dim}Run \`omnesis broker set\` first.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const provider = findProvider(await loadBrokerProviders(), args.provider);
    const positional = (args._ as string[]).filter((a) => a !== args.provider);
    const rawParams = ([] as string[]).concat((args.param as string | string[] | undefined) ?? []);
    let connections: Record<string, BrokerConnectionRef>;
    let params: Record<string, string>;
    try {
      connections = parseConnectionArgs(provider.spec, positional);
      params = parseParamArgs(provider.spec, rawParams);
    } catch (err) {
      const usage = provider.spec.purposes
        .map(
          (p) =>
            `  ${p.id}=<integration>/<connection-id>  ${c.dim}${p.label}; e.g. a ${p.brokerProviders.join(" or ")} connection${p.required === false ? " (optional)" : ""}${c.reset}`,
        )
        .join("\n");
      throw new CliError(
        `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n${c.dim}Usage: omnesis broker link ${provider.id} <connection>...${c.reset}\n${usage}`,
        EXIT_USER_ERROR,
      );
    }
    const linked = await linkBrokeredAccount({
      spec: provider.spec,
      config,
      connections,
      params,
      configDir: dir,
      replace: Boolean(args.replace),
    }).catch((err: unknown) => fail(err));
    if (isJSON) {
      console.log(
        JSON.stringify({
          ok: true,
          provider: provider.id,
          accountId: linked.accountId,
          replaced: linked.replaced,
        }),
      );
      return;
    }
    console.log(
      `${c.green}✓${c.reset} ${linked.replaced ? "Relinked" : "Linked"} ${provider.name} account ${c.bold}${linked.accountId}${c.reset} to the broker`,
    );
    console.log(
      `${c.dim}Add its sources with \`omnesis sources add <type>\`: ${provider.sourceIds.join(", ")}${c.reset}`,
    );
  },
});

const unlinkCommand = defineCommand({
  meta: { name: "unlink", description: "Forget an account's link to the broker" },
  args: {
    provider: { type: "positional", description: "provider id", required: true },
    account: {
      type: "positional",
      description: "account id, as `omnesis broker status` lists it",
      required: true,
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run({ args }) {
    const provider = findProvider(await loadBrokerProviders(), args.provider);
    const dir = configDir();
    if (!hasBrokerBinding(provider.spec.fileKey, args.account, dir)) {
      throw new CliError(
        `${c.red}${provider.id} account ${args.account} is not linked${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    // Only the binding goes: the grant is the broker's, and other software
    // signed in through it keeps using it. An account directory left empty
    // goes too, so nothing later adopts a shared legacy key into it.
    const path = brokerBindingPath(provider.spec.fileKey, args.account, dir);
    await rm(path, { force: true });
    if (readdirSync(dirname(path)).length === 0) await rmdir(dirname(path));
    if (isJSON) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    console.log(
      `${c.green}✓${c.reset} Unlinked ${provider.name} account ${args.account}; the broker's connection is untouched`,
    );
    console.log(
      `${c.dim}Its sources need attention until it is linked again or removed.${c.reset}`,
    );
  },
});

export const brokerCommand = defineCommand({
  meta: { name: "broker", description: "Take account credentials from a credential broker" },
  subCommands: { set: setCommand, status: statusCommand, link: linkCommand, unlink: unlinkCommand },
});
