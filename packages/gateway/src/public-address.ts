// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's public address (`gateway.publicBaseUrl`, or
 * `OMNESIS_PUBLIC_BASE_URL`) and the MCP resources it implies, as they stand
 * now. Saving a new address takes effect at once: every consumer — MCP OAuth,
 * pairing, source sign-in callbacks, the certificate lifecycle — reads it on
 * each use from one `PublicAddressSource` instead of keeping the value it was
 * given at start.
 */

import { createLogger } from "@omnesis/core";
import { resolvePublicAddress, type ResolvedPublicAddress } from "./runtime-settings.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ConfigStore } from "./config-store.js";

const log = createLogger("gateway:public-address");

export interface PublicAddressSource {
  /** The externally reachable HTTPS base URL (no trailing slash), or undefined when unset. */
  baseUrl(): string | undefined;
  /** The exact MCP protected-resource URLs: `${baseUrl}/mcp` and `gateway.mcpResourceUrls`. */
  mcpResourceUrls(): readonly string[];
  /** Whether `OMNESIS_PUBLIC_BASE_URL` sets the address, so saving one in the config changes nothing. */
  setByEnvironment(): boolean;
}

/** An address that never changes: for tests and for callers with no config store. */
export function fixedPublicAddress(
  baseUrl?: string,
  mcpResourceUrls: readonly string[] = [],
): PublicAddressSource {
  return {
    baseUrl: () => baseUrl,
    mcpResourceUrls: () => mcpResourceUrls,
    setByEnvironment: () => false,
  };
}

/** The settings the address is resolved from; anything else in the config leaves it alone. */
function inputsOf(config: OmnesisConfig | undefined): string {
  return JSON.stringify([config?.gateway?.publicBaseUrl, config?.gateway?.mcpResourceUrls]);
}

/** The live address, resolved again whenever the config it comes from changes. */
export class PublicAddress implements PublicAddressSource {
  #current: ResolvedPublicAddress;
  #inputs: string;

  /** Throws, as the gateway's start should, when the config's MCP resources cannot be served. */
  constructor(config: OmnesisConfig | undefined) {
    this.#current = resolvePublicAddress(config);
    this.#inputs = inputsOf(config);
  }

  /** The address in `store`'s config, kept up to date as the config changes. */
  static following(store: Pick<ConfigStore, "get" | "onChange">): PublicAddress {
    const address = new PublicAddress(store.get());
    store.onChange((_before, after) => address.update(after));
    return address;
  }

  baseUrl(): string | undefined {
    return this.#current.publicBaseUrl;
  }

  mcpResourceUrls(): readonly string[] {
    return this.#current.mcpResourceUrls;
  }

  setByEnvironment(): boolean {
    return this.#current.fromEnvironment;
  }

  /**
   * Takes the address from a changed config. One that cannot be served — the
   * config schema refuses those, so only a hand-edited file gets here — keeps
   * the address in use and says why.
   */
  update(config: OmnesisConfig | undefined): void {
    const inputs = inputsOf(config);
    if (inputs === this.#inputs) return;
    this.#inputs = inputs;
    let next: ResolvedPublicAddress;
    try {
      next = resolvePublicAddress(config);
    } catch (error) {
      log.warn(
        `Keeping the public address in use: the new one cannot be served (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    if (next.publicBaseUrl !== this.#current.publicBaseUrl) {
      log.info(`Public address is now ${next.publicBaseUrl ?? "unset (loopback OAuth only)"}`);
    }
    this.#current = next;
  }
}
