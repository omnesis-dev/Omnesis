// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gatewayIdSchema } from "./accounts.js";
import { RelayError } from "./tunnels.js";
import type { GatewayBinding } from "./gateway-binding.js";

export interface GatewayChoice {
  gatewayId: string;
  publicOrigin: string;
  displayName?: string;
}

/** Discovery selects a gateway, never a device credential or an authorization grant. */
export class GatewayDirectory {
  constructor(
    private readonly source: {
      accounts(identity: string): string[];
      binding(account: string): GatewayBinding | undefined;
      name(account: string): string | undefined;
    },
  ) {}

  private entries(identity: string): { choice: GatewayChoice; binding: GatewayBinding }[] {
    const entries = [];
    for (const account of this.source.accounts(identity)) {
      let binding;
      try {
        binding = this.source.binding(account);
      } catch (error) {
        // An independently revoked registration cannot hide other healthy gateways.
        if (error instanceof RelayError && error.status === 403) continue;
        throw error;
      }
      if (!binding) continue;
      const displayName = this.source.name(account);
      entries.push({
        binding,
        choice: {
          gatewayId: binding.gatewayId,
          publicOrigin: binding.publicOrigin,
          ...(displayName === undefined ? {} : { displayName }),
        },
      });
    }
    return entries.sort((a, b) => a.choice.gatewayId.localeCompare(b.choice.gatewayId));
  }

  choices(identity: string): GatewayChoice[] {
    const choices = this.entries(identity).map((entry) => entry.choice);
    if (choices.length > 1000)
      throw new RelayError(413, "Too many gateways; narrow the account directory");
    return choices;
  }

  list(
    identity: string,
    query: URLSearchParams,
  ): { gateways: GatewayChoice[]; nextCursor?: string } {
    if ([...query.keys()].some((key) => key !== "after") || query.getAll("after").length > 1)
      throw new RelayError(400, "Invalid gateway directory query");
    const after = query.has("after") ? parseGatewayId(query.get("after")) : undefined;
    const choices = this.entries(identity).map((entry) => entry.choice);
    const start =
      after === undefined ? 0 : choices.findIndex((choice) => choice.gatewayId === after) + 1;
    if (after !== undefined && start === 0)
      throw new RelayError(409, "Gateway directory changed; refresh the choices");
    const gateways = choices.slice(start, start + 50);
    return {
      gateways,
      ...(start + 50 < choices.length ? { nextCursor: gateways.at(-1)!.gatewayId } : {}),
    };
  }

  select(identity: string, query: URLSearchParams): GatewayBinding {
    if (
      [...query.keys()].some((key) => key !== "gatewayId") ||
      query.getAll("gatewayId").length > 1
    )
      throw new RelayError(400, "Invalid gateway selection");
    const id = query.has("gatewayId") ? parseGatewayId(query.get("gatewayId")) : undefined;
    const entries = this.entries(identity);
    if (id === undefined && entries.length > 1)
      throw new RelayError(409, "Select a gateway before pairing this device");
    const entry =
      id === undefined ? entries[0] : entries.find((entry) => entry.choice.gatewayId === id);
    if (!entry) throw new RelayError(404, "Gateway not registered for this account");
    return entry.binding;
  }
}

function parseGatewayId(value: string | null): string {
  const result = gatewayIdSchema.safeParse(value);
  if (!result.success) throw new RelayError(400, "Invalid gateway identifier");
  return result.data;
}
