// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderId, AccountId } from "@omnesis/types";

/**
 * A Provider handles authentication for a platform (e.g. Google, Microsoft, Apple).
 * Multiple sources share a single provider instance.
 *
 * Providers support multiple accounts via `accountId`. For example:
 *   - Google provider for jamesbond@example.com → id = "google:jamesbond@example.com"
 *   - WhatsApp provider for +447700000000 → id = "whatsapp:+447700000000"
 */
export interface Provider {
  /** Unique identifier including account (e.g. "google:user@gmail.com") */
  readonly id: ProviderId;

  /** Human-readable name */
  readonly name: string;

  /**
   * Account identifier for this provider instance.
   * Set after authentication (e.g. email address, phone number).
   * Used to namespace source IDs and provider IDs for multi-account support.
   */
  readonly accountId: AccountId | undefined;

  /** Initialize the provider (load stored credentials, etc.) */
  initialize(): Promise<void>;

  /** Run the authentication flow (e.g. OAuth, prompt for API key) */
  authenticate(): Promise<void>;

  /**
   * Whether the provider still holds usable credentials. Answer from the stored
   * credential, never from whether a request succeeded — see the contract on
   * `ProviderDefinition.isAuthenticated` in `define-source.ts`: a live API probe
   * here turns a network blip into a re-auth prompt.
   */
  isAuthenticated(): Promise<boolean>;

  /** Revoke credentials and clean up */
  disconnect(): Promise<void>;
}
