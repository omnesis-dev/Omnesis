// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis sources describe [type]` — what can be added, and what an add of
 * one source asks for.
 *
 * Without a type it lists the source types the connected collectors offer.
 * With one it prints every key `sources add --set` takes for it, read from the
 * source's descriptor: its settings, and its credential fields when its add
 * signs in. `--json` (or any non-terminal stdout) prints the same as JSON, for
 * an agent writing the add.
 */

import { defineCommand } from "citty";
import { c, CliError, EXIT_USER_ERROR, fetchDescriptors, isJSON, withSpinner } from "../utils.js";
import {
  fetchUnionDescriptors,
  resolveDeviceFlag,
  type UnionDescriptor,
} from "../device-picker.js";
import { setFlagFor, setupKeys, type SetupKey } from "./add-settings.js";
import type { SerializedDescriptor } from "../utils.js";

/** What `describe <type>` reports, also its JSON shape. */
export interface SourceDescription {
  id: string;
  name: string;
  description: string;
  provider: string;
  authType: SerializedDescriptor["authType"];
  experimental: boolean;
  /** Collectors that offer it (all of them, or the one `--device` named). */
  devices: Array<{ id: string; name: string }>;
  /** Whether the collector looks for accounts, which `--account` then chooses among. */
  discoversAccounts: boolean;
  /** Whether the add signs in (a browser, a code, a pasted key). */
  signsIn: boolean;
  keys: SetupKey[];
  /** An add command with every required key, placeholders to replace. */
  example: string;
}

type Describable = Pick<
  SerializedDescriptor,
  | "id"
  | "name"
  | "description"
  | "authType"
  | "experimental"
  | "params"
  | "credentials"
  | "hasAuthFlow"
  | "hasDiscover"
> & { provider: { id: string } };

/** Build the description of one descriptor. Pure: everything comes from the descriptor. */
export function describeSource(
  descriptor: Describable,
  devices: Array<{ id: string; name: string }>,
): SourceDescription {
  const keys = setupKeys(descriptor);
  const deviceFlag =
    devices.length > 1
      ? " --device <name>"
      : devices.length === 1
        ? ` --device ${quote(devices[0]!.name)}`
        : "";
  const required = keys
    .filter((k) => k.required && k.kind !== "provider-credential")
    .map((k) => ` ${setFlagFor(k)}`)
    .join("");
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    provider: descriptor.provider.id,
    authType: descriptor.authType,
    experimental: descriptor.experimental === true,
    devices,
    discoversAccounts: descriptor.hasDiscover === true,
    signsIn: descriptor.hasAuthFlow === true,
    keys,
    example: `omnesis sources add ${descriptor.id}${deviceFlag}${required}`,
  };
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const KIND_HEADINGS: Record<SetupKey["kind"], string> = {
  setting: "Settings",
  "account-credential": "Account credentials (sent to the sign-in, stored under the account)",
  "provider-credential":
    "Application credentials (asked only while the collector has none; saved for every account)",
};

/** The text form of a description. */
export function renderDescription(d: SourceDescription): string[] {
  const lines = [
    `${c.bold}${d.name}${c.reset} ${c.dim}(${d.id})${d.experimental ? " experimental" : ""}${c.reset}`,
    d.description,
  ];
  if (d.devices.length > 0) {
    lines.push(`${c.dim}Offered by: ${d.devices.map((x) => x.name).join(", ")}${c.reset}`);
  }
  for (const kind of Object.keys(KIND_HEADINGS) as SetupKey["kind"][]) {
    const keys = d.keys.filter((k) => k.kind === kind);
    if (keys.length === 0) continue;
    lines.push("", `${c.bold}${KIND_HEADINGS[kind]}${c.reset}`);
    for (const k of keys) {
      const traits = [
        k.type,
        k.required ? "required" : "optional",
        ...(k.secret && k.type !== "secret" ? ["secret"] : []),
        ...(k.scope === "member" ? ["this machine's own"] : []),
      ].join(", ");
      lines.push(`  ${c.cyan}${k.key}${c.reset}  ${k.label} ${c.dim}(${traits})${c.reset}`);
      if (k.help) lines.push(`      ${c.dim}${k.help}${c.reset}`);
      if (k.options) {
        lines.push(`      ${c.dim}one of: ${k.options.map((o) => o.value).join(", ")}${c.reset}`);
      }
      if (k.placeholder) lines.push(`      ${c.dim}e.g. ${k.placeholder}${c.reset}`);
    }
  }
  if (d.keys.length === 0) lines.push("", `${c.dim}It asks for no settings.${c.reset}`);
  if (d.discoversAccounts) {
    lines.push(
      "",
      `${c.dim}The collector looks for accounts. When it finds several, choose with --account <id> (repeatable).${c.reset}`,
    );
  }
  if (d.signsIn) {
    lines.push(
      `${c.dim}Adding it signs in: the command prints what to open or scan and waits for it.${c.reset}`,
    );
  }
  lines.push("", `${c.bold}Add it${c.reset}`, `  ${d.example}`);
  return lines;
}

function matches(union: readonly UnionDescriptor[], name: string): UnionDescriptor[] {
  const byId = union.filter((d) => d.id === name);
  if (byId.length > 0) return byId;
  return union.filter((d) => (d.provider as { id?: string } | undefined)?.id === name);
}

export const describeSourceCommand = defineCommand({
  meta: {
    name: "describe",
    description:
      "List the source types you can add, or show the keys `sources add --set` takes for one",
  },
  args: {
    source: {
      type: "positional",
      description: "source type (e.g. obsidian-notes) or provider; omit to list them",
      required: false,
    },
    device: {
      type: "string",
      description: "Describe the source as this collector (name or id) offers it",
    },
  },
  async run(ctx) {
    const name = typeof ctx.args.source === "string" ? ctx.args.source : undefined;
    const deviceFlag = typeof ctx.args.device === "string" ? ctx.args.device : undefined;
    const device = deviceFlag ? await resolveDeviceFlag(deviceFlag) : null;
    const union: UnionDescriptor[] = await withSpinner("Loading available sources", async () => {
      if (!device) return fetchUnionDescriptors();
      const snap = await fetchDescriptors(device.id);
      return snap.items.map((d) => ({ ...d, devices: [device] })) as unknown as UnionDescriptor[];
    });

    if (!name) {
      const rows = union.map((d) => ({
        id: d.id,
        name: typeof d.name === "string" ? d.name : d.id,
        experimental: d.experimental === true,
        devices: d.devices,
      }));
      if (isJSON) {
        console.log(JSON.stringify({ items: rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(`${c.dim}No collector is online, so there is nothing to add.${c.reset}`);
        return;
      }
      const width = Math.max(...rows.map((r) => r.id.length));
      for (const r of rows) {
        const exp = r.experimental ? ` ${c.dim}(experimental)${c.reset}` : "";
        const on =
          r.devices.length > 0
            ? ` ${c.dim}on ${r.devices.map((x) => x.name).join(", ")}${c.reset}`
            : "";
        console.log(`  ${r.id.padEnd(width)}  ${r.name}${exp}${on}`);
      }
      console.log(`\n${c.dim}What one asks for: omnesis sources describe <type>${c.reset}`);
      return;
    }

    const found = matches(union, name);
    if (found.length === 0) {
      throw new CliError(
        `${c.red}No connected collector offers ${name}.${c.reset}\n` +
          `Sources: ${union.map((d) => d.id).join(", ") || "(no collector is online)"}`,
        EXIT_USER_ERROR,
      );
    }
    const descriptions = found.map((d) => describeSource(d as unknown as Describable, d.devices));
    if (isJSON) {
      console.log(
        JSON.stringify(
          descriptions.length === 1 ? descriptions[0] : { items: descriptions },
          null,
          2,
        ),
      );
      return;
    }
    console.log(descriptions.map((d) => renderDescription(d).join("\n")).join("\n\n"));
  },
});
