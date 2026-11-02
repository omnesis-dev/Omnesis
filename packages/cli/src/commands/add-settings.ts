// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What `omnesis sources add` is told on the command line instead of asked.
 *
 * The add asks for two kinds of thing, and both are declared by the source's
 * descriptor, never by this file: the source's setup settings (`params`, the
 * form the portal renders too) and, for a source whose credential is the
 * account itself, that credential's fields (`credentials.fields`). A provider
 * whose credential is an application client shared by every account (an OAuth
 * client id and secret) declares the same fields; they are asked only when the
 * collector has none yet.
 *
 * `--set key=value` (repeatable) and `--config <json | @file | ->` supply any
 * of them by the key the descriptor gives it. Everything supplied is checked
 * against the descriptor before the add sends anything: a key the source does
 * not declare, a choice outside its options and a value its pattern refuses
 * are refused here, so a typo is never registered as a setting. What the
 * collector knows better — whether a folder exists on its machine — it is
 * still asked, through the same `validate-param` / `resolve-account` / `add`
 * calls the portal and the interactive flow make.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCredentialFields } from "@omnesis/core";
import { c, CliError, EXIT_USER_ERROR, type SerializedDescriptor } from "../utils.js";

/** One answer the add can take up front, as the descriptor declares it. */
export interface SetupKey {
  key: string;
  label: string;
  /**
   * `setting` is stored with the source. `account-credential` is the account
   * being connected and goes to its sign-in. `provider-credential` is the
   * application credential every account of the provider uses, saved on the
   * collector the first time an add needs it.
   */
  kind: "setting" | "account-credential" | "provider-credential";
  type: "string" | "path" | "select" | "secret";
  required: boolean;
  secret: boolean;
  /** For a setting: whether it describes one machine (`member`) or the source. */
  scope?: "source" | "member";
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  pattern?: string;
  patternHint?: string;
}

type DescriptorSetup = Pick<SerializedDescriptor, "params" | "credentials" | "hasAuthFlow">;

/**
 * Every key an add of this source can be given, settings first. Credential
 * fields count only for a source whose add signs in, which is the only add
 * that sends them.
 */
export function setupKeys(descriptor: DescriptorSetup): SetupKey[] {
  const keys: SetupKey[] = (descriptor.params ?? []).map((p) => ({
    key: p.name,
    label: p.label,
    kind: "setting",
    type: p.type,
    required: p.required === true,
    secret: p.type === "secret",
    ...(p.scope ? { scope: p.scope } : {}),
    ...(p.help ? { help: p.help } : {}),
    ...(p.placeholder ? { placeholder: p.placeholder } : {}),
    ...(p.options?.length ? { options: p.options } : {}),
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(p.patternHint ? { patternHint: p.patternHint } : {}),
  }));
  const spec = descriptor.hasAuthFlow ? descriptor.credentials : undefined;
  const taken = new Set(keys.map((k) => k.key));
  for (const field of spec?.fields ?? []) {
    if (taken.has(field.name)) continue;
    keys.push({
      key: field.name,
      label: field.label,
      kind: spec?.perAccount ? "account-credential" : "provider-credential",
      type: field.secret ? "secret" : "string",
      required: field.required !== false,
      secret: field.secret === true,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.pattern ? { pattern: field.pattern } : {}),
      ...(field.patternHint ? { patternHint: field.patternHint } : {}),
    });
  }
  return keys;
}

/**
 * Every value given for a repeatable flag, in order.
 *
 * Read from the raw arguments because the parser keeps only the last value of
 * a repeated string flag. `--flag value` and `--flag=value` both count; a
 * value may itself start with a dash, since the parser hands it to the flag.
 */
export function collectFlagValues(rawArgs: readonly string[], flag: string): string[] {
  const long = `--${flag}`;
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]!;
    if (arg === "--") break;
    if (arg === long) {
      if (i + 1 < rawArgs.length) out.push(rawArgs[i + 1]!);
      i += 1;
    } else if (arg.startsWith(`${long}=`)) {
      out.push(arg.slice(long.length + 1));
    }
  }
  return out;
}

function refuse(message: string): never {
  throw new CliError(`${c.red}${message}${c.reset}`, EXIT_USER_ERROR);
}

/** `--set key=value` occurrences as a record. The first `=` splits; the value may hold more. */
export function parseSetFlags(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values) {
    const eq = item.indexOf("=");
    const key = eq > 0 ? item.slice(0, eq).trim() : "";
    if (!key)
      refuse(`--set takes key=value, not "${item}". For example: --set vaultPath=/path/to/vault`);
    const value = item.slice(eq + 1);
    if (Object.hasOwn(out, key) && out[key] !== value) {
      refuse(`--set ${key} is given twice, with different values.`);
    }
    out[key] = value;
  }
  return out;
}

/** Where `--config` reads from besides its own text. */
export interface ConfigSourceIo {
  readFile(path: string): string;
  readStdin(): string;
}

const defaultConfigIo: ConfigSourceIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  readStdin: () => readFileSync(0, "utf8"),
};

/**
 * `--config` as a record: a JSON object given inline, read from a file
 * (`@path`) or from standard input (`-`). Values are text, as every setting
 * and credential field is; a number or a boolean is taken as its text, and
 * `null` as not given. Anything nested is refused rather than flattened.
 */
export function parseConfigFlag(
  raw: string,
  io: ConfigSourceIo = defaultConfigIo,
): Record<string, string> {
  let text: string;
  let origin: string;
  if (raw === "-") {
    origin = "standard input";
    text = io.readStdin();
  } else if (raw.startsWith("@")) {
    const path = resolve(raw.slice(1));
    origin = path;
    try {
      text = io.readFile(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      refuse(
        `--config could not read ${path}: ${reason}\n` +
          "The file is read where this command runs. On a Docker install that is the container, " +
          "so pipe the file in instead: --config - < settings.json",
      );
    }
  } else {
    origin = "--config";
    text = raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    refuse(`--config from ${origin} is not JSON: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(`--config from ${origin} must be a JSON object of key: value pairs.`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else
      refuse(`--config ${key} must be text, not ${Array.isArray(value) ? "a list" : "an object"}.`);
  }
  return out;
}

/** Everything the command line supplies: `--config` first, `--set` over it. */
export function readSuppliedSettings(
  rawArgs: readonly string[],
  io: ConfigSourceIo = defaultConfigIo,
): Record<string, string> {
  const configs = collectFlagValues(rawArgs, "config");
  if (configs.length > 1) refuse("--config is given more than once. Merge them into one object.");
  const fromConfig = configs.length === 1 ? parseConfigFlag(configs[0]!, io) : {};
  return { ...fromConfig, ...parseSetFlags(collectFlagValues(rawArgs, "set")) };
}

/** What was supplied, sorted by where it goes. */
export interface SortedSettings {
  params: Record<string, string>;
  credentials: Record<string, string>;
}

/** The flag that supplies `key`, with a placeholder value to replace. */
export function setFlagFor(key: SetupKey): string {
  const example = key.options?.[0]?.value ?? key.placeholder ?? `<${key.label.toLowerCase()}>`;
  const quoted = /[\s'"$`\\]/u.test(example) ? `'${example.replaceAll("'", `'\\''`)}'` : example;
  return `--set ${key.key}=${quoted}`;
}

function keyList(keys: readonly SetupKey[]): string {
  return keys.length > 0 ? keys.map((k) => k.key).join(", ") : "(none)";
}

/**
 * Check what was supplied against the descriptor and sort it into settings
 * and credential fields. Refused: a key the source does not declare, a choice
 * outside a select's options, a value its declared pattern does not match,
 * and a credential field set that is incomplete or malformed.
 */
export function sortSuppliedSettings(
  descriptor: DescriptorSetup & Pick<SerializedDescriptor, "id">,
  supplied: Readonly<Record<string, string>>,
): SortedSettings {
  const keys = setupKeys(descriptor);
  const byKey = new Map(keys.map((k) => [k.key, k]));
  const sorted: SortedSettings = { params: {}, credentials: {} };
  for (const [name, value] of Object.entries(supplied)) {
    const key = byKey.get(name);
    if (!key) {
      refuse(
        `${descriptor.id} has no setting named "${name}". It takes: ${keyList(keys)}.\n` +
          `See them with: omnesis sources describe ${descriptor.id}`,
      );
    }
    if (key.kind !== "setting") {
      sorted.credentials[name] = value;
      continue;
    }
    if (key.options && value !== "" && !key.options.some((o) => o.value === value)) {
      refuse(
        `${name} must be one of: ${key.options.map((o) => o.value).join(", ")} (got "${value}").`,
      );
    }
    if (key.pattern && value !== "" && !new RegExp(key.pattern, "u").test(value)) {
      refuse(`${name}: ${key.patternHint ?? `${key.label} has an invalid format`}`);
    }
    sorted.params[name] = value;
  }
  if (Object.keys(sorted.credentials).length > 0 && descriptor.credentials) {
    const checked = validateCredentialFields(sorted.credentials, descriptor.credentials);
    if (!checked.ok) refuse(checked.error);
    sorted.credentials = checked.cleaned;
  }
  return sorted;
}

/**
 * The refusal for answers this run has no terminal to ask for: each missing
 * key and the flag that supplies it, so the next run can be written from the
 * message alone.
 */
export function missingSettingsRefusal(
  descriptorId: string,
  missing: readonly SetupKey[],
  why = "this run has no terminal to ask for them",
): string {
  const lines = missing.map((k) => `  ${setFlagFor(k)}    ${c.dim}${k.label}${c.reset}`);
  const secret = missing.some((k) => k.secret);
  return (
    `${c.red}${descriptorId} needs ${missing.length === 1 ? "a value" : "values"} that ${why}.${c.reset}\n` +
    `Supply ${missing.length === 1 ? "it" : "them"} on the command line:\n${lines.join("\n")}\n` +
    (secret
      ? `${c.dim}A secret is better kept off the command line: put the keys in a JSON object and pass --config @file, or --config - to read it from standard input.${c.reset}\n`
      : "") +
    `${c.dim}Every key it takes: omnesis sources describe ${descriptorId}${c.reset}`
  );
}
