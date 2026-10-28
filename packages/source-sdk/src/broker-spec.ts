// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { BrokeredCredentials } from "@omnesis/core";

/** One credential a provider can take from the credential broker. */
export interface ProviderBrokerPurpose {
  /** Key in the account's broker binding. `default` for a single-credential provider. */
  id: string;
  /** What the credential is for, as an operator would say it ("Gmail"). */
  label: string;
  /**
   * The broker's provider names whose connections fit this purpose (Nango's
   * `google-mail`, `notion`, `github-pat`, …). Used to explain a link, never to
   * refuse one: an operator may hold the grant under a custom integration.
   */
  brokerProviders: string[];
  /** Whether an account must link this purpose. Defaults to true. */
  required?: boolean;
}

/** A non-secret setting an operator supplies when linking an account. */
export interface ProviderBrokerParam {
  name: string;
  label: string;
  required?: boolean;
  default?: string;
}

/**
 * How an account of this provider can take its credential from the credential
 * broker (see `@omnesis/core` `credential-broker`) instead of signing in here.
 *
 * A provider declaring it promises three things of its account lifecycle: it
 * discovers brokered accounts (`listBrokeredAccountIds`); it builds its client
 * from {@link BrokeredCredentials} when the account has a binding and needs
 * nothing else on disk to do so; and removing such an account removes only the
 * binding, never the grant the broker holds for everyone else.
 */
export interface ProviderBrokerSpec {
  /**
   * The directory under the config directory that holds this provider's
   * accounts (`<configDir>/<fileKey>/<accountId>/`), which is where each
   * account's binding is stored. The same key as the provider's credentials
   * spec, when it has one.
   */
  fileKey: string;
  /** The credentials an account links, in the order an operator is asked for them. */
  purposes: ProviderBrokerPurpose[];
  /** Settings recorded in the binding beside the connections. */
  params?: ProviderBrokerParam[];
  /**
   * Which account the linked credentials belong to, asked of the upstream with
   * them. Returns the account id the binding is stored under, and any settings
   * worth recording with it. `ctx.configDir` is the collector's config
   * directory, for a provider that must check the new account against the
   * accounts it already holds (a connection that would duplicate one).
   */
  resolveAccount(
    credentials: BrokeredCredentials,
    params: Record<string, string>,
    ctx?: { configDir?: string },
  ): Promise<{ accountId: string; params?: Record<string, string> }>;
}
