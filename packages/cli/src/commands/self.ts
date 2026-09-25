// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { normalizeEmail, normalizePhone } from "@omnesis/core";
import {
  c,
  gatewayJson,
  gatewayFetch,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";

interface SelfConfig {
  name?: string;
  emails?: string[];
  phones?: string[];
}
interface AdminConfigResponse {
  config: { self?: SelfConfig };
  version?: number | string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const dim = (s: string): string => `${c.dim}${s}${c.reset}`;

// citty surfaces a repeated flag (`--email a --email b`) as an array at runtime
// even though its static type says `string`. Coerce to a list.
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
}

/**
 * Build the `config.self` patch from the `omnesis self set` args. Validates and
 * normalizes emails (lowercased, must be `local@domain.tld`) and phones (E.164
 * via `normalizePhone`); throws a `CliError` on the first invalid entry, or when
 * no field was supplied. Only the supplied fields appear in the patch — the
 * config PATCH deep-merges, so `--email …` leaves any existing name / phones
 * untouched. Exported for unit testing.
 */
export function buildSelfPatch(args: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}): SelfConfig {
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const emailsRaw = asArray(args.email);
  const phonesRaw = asArray(args.phone);

  if (name === undefined && emailsRaw.length === 0 && phonesRaw.length === 0) {
    throw new CliError(
      `${c.red}Nothing to set. Pass --name, --email, and/or --phone.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  const patch: SelfConfig = {};
  if (name !== undefined) patch.name = name;

  if (emailsRaw.length > 0) {
    const emails: string[] = [];
    for (const raw of emailsRaw) {
      const normalized = normalizeEmail(raw.trim());
      if (!EMAIL_SHAPE.test(normalized)) {
        throw new CliError(`${c.red}Invalid --email '${raw}'.${c.reset}`, EXIT_USER_ERROR);
      }
      emails.push(normalized);
    }
    patch.emails = Array.from(new Set(emails));
  }

  if (phonesRaw.length > 0) {
    const phones: string[] = [];
    for (const raw of phonesRaw) {
      const normalized = normalizePhone(raw.trim());
      if (!normalized) {
        throw new CliError(
          `${c.red}Invalid --phone '${raw}' (must be E.164-parseable).${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      phones.push(normalized);
    }
    patch.phones = Array.from(new Set(phones));
  }

  return patch;
}

const selfShowCommand = defineCommand({
  meta: { name: "show", description: "Show your self identity (config.self)" },
  async run() {
    const { config } = await withSpinner("Loading self identity", () =>
      gatewayJson<AdminConfigResponse>("/admin/config"),
    );
    const self = config.self ?? {};
    const hasIdentity = (self.emails?.length ?? 0) > 0 || (self.phones?.length ?? 0) > 0;
    console.log();
    console.log(`${c.bold}Self identity${c.reset} ${dim("(config.self)")}`);
    console.log(`  name:   ${self.name ? self.name : dim("(unset)")}`);
    console.log(`  emails: ${self.emails?.length ? self.emails.join(", ") : dim("(none)")}`);
    console.log(`  phones: ${self.phones?.length ? self.phones.join(", ") : dim("(none)")}`);
    console.log();

    // When identity isn't set yet, offer the account we can already infer from
    // a synced source (the account email IS the source id). Best-effort — a
    // gateway without the endpoint just skips the hint.
    if (!hasIdentity) {
      const candidate = await gatewayJson<{ candidate: { email: string } | null }>(
        "/admin/self/candidate",
      ).catch(() => ({ candidate: null }));
      if (candidate.candidate) {
        console.log(
          `${c.cyan}${candidate.candidate.email}${c.reset} looks like you (from a synced account).`,
        );
        console.log(`Confirm with: omnesis self set --email ${candidate.candidate.email}`);
        console.log();
        return;
      }
    }

    console.log(
      dim('The gateway bootstraps (and enriches) the canonical "self" person from these at boot.'),
    );
    console.log(dim("Set them with: omnesis self set --name <name> --email <you@example.com>."));
    console.log();
  },
});

const selfSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Set your self identity — the name / emails / phones that are yours",
  },
  args: {
    name: { type: "string", description: "Your display name" },
    email: { type: "string", description: "An email address that is yours (repeatable)" },
    phone: { type: "string", description: "An E.164 phone number that is yours (repeatable)" },
  },
  async run(ctx) {
    const patch = buildSelfPatch(ctx.args);

    const res = await withSpinner("Saving self identity", () =>
      gatewayFetch("/admin/config", { method: "PATCH", body: JSON.stringify({ self: patch }) }),
    );
    if (!res.ok) {
      throw new CliError(
        `${c.red}Failed: ${res.status} ${await res.text()}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    console.log();
    console.log("Self identity updated:");
    if (patch.name !== undefined) console.log(`  name:   ${patch.name}`);
    if (patch.emails) console.log(`  emails: ${patch.emails.join(", ")}`);
    if (patch.phones) console.log(`  phones: ${patch.phones.join(", ")}`);
    console.log();
    console.log(dim("Restart the gateway to materialize / enrich the canonical self person."));
    console.log();
  },
});

export const selfCommand = defineCommand({
  meta: {
    name: "self",
    description: "Manage who you are — the identity used to bootstrap the canonical self person",
  },
  subCommands: { show: selfShowCommand, set: selfSetCommand },
  // Default to `show` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(selfShowCommand, { rawArgs: [] });
    }
  },
});
