// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Seeding the DNS broker's name registry with the names the relay already granted. The export is
 * taken by the operator at a trusted moment and read straight from the relay's database; the
 * import never replaces a name the broker already binds.
 */
import { createPublicKey } from "node:crypto";
import { open } from "node:fs/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import { gatewayBindingSchema } from "./gateway-binding.js";
import { keyBindingOwnerPublicKey } from "./gateway-key-auth.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { relayOrigin } from "./network.js";
import { readBoundedJson } from "./google-credentials.js";
import {
  registryEntrySchema,
  registryImportSchema,
  relayDomainSchema,
  type RegistryEntry,
} from "./dns-broker-contract.js";

/**
 * Every hosted name with the gateway and owner key it is bound to. Names a gateway proved with a
 * Google identity rather than an owner key, and custom domains, are left out: the broker only
 * brokers a gateway's own derived name, for its owner key.
 */
export function exportGatewayKeys(databaseFile: string, relayDomain: string): RegistryEntry[] {
  const domain = relayDomainSchema.parse(relayDomain);
  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT hostname, binding FROM relay_gateway_bindings ORDER BY hostname")
      .all() as {
      hostname: string;
      binding: string;
    }[];
    const entries: RegistryEntry[] = [];
    for (const row of rows) {
      const binding = gatewayBindingSchema.safeParse(JSON.parse(row.binding));
      if (!binding.success) continue;
      const gatewayId = binding.data.gatewayId.toLowerCase();
      const owner = keyBindingOwnerPublicKey(binding.data);
      if (!owner || row.hostname !== hostedGatewayHostname(gatewayId, domain)) continue;
      entries.push(
        registryEntrySchema.parse({
          hostname: row.hostname,
          gatewayId,
          ownerPublicKey: createPublicKey(owner)
            .export({ type: "spki", format: "der" })
            .toString("base64url"),
        }),
      );
    }
    return entries;
  } finally {
    db.close();
  }
}

export async function readRegistryExport(file: string): Promise<RegistryEntry[]> {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).size > 64 * 1024 * 1024)
      throw new Error("The registry export is too large");
    return z
      .object({ entries: z.array(registryEntrySchema) })
      .strict()
      .parse(JSON.parse(await handle.readFile("utf8"))).entries;
  } finally {
    await handle.close();
  }
}

const importResultSchema = z
  .object({
    imported: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  })
  .strict();
export type RegistryImportResult = z.infer<typeof importResultSchema>;

/** Sends the export in batches with the import token; the totals say what each name became. */
export async function importRegistry(options: {
  brokerUrl: string;
  token: string;
  entries: RegistryEntry[];
  fetch?: typeof fetch;
}): Promise<RegistryImportResult> {
  const broker = relayOrigin(options.brokerUrl);
  const total: RegistryImportResult = { imported: 0, existing: 0, conflicts: 0, invalid: 0 };
  for (let index = 0; index < options.entries.length; index += 500) {
    const batch = registryImportSchema.parse({
      entries: options.entries.slice(index, index + 500),
    });
    const response = await (options.fetch ?? fetch)(new URL("/_dns/v2/import", broker), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("The DNS broker refused the registry import");
    }
    const result = importResultSchema.parse(await readBoundedJson(response));
    for (const key of ["imported", "existing", "conflicts", "invalid"] as const)
      total[key] += result[key];
  }
  return total;
}
