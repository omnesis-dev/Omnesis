// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Telegram twin.
 *
 * Spreads the REAL definition, built by `buildTelegramProvider` over the
 * simulated server's adapter factory, so a synthetic gateway runs the
 * production provider, archive, walk and normalizer end to end. Only the
 * sign-in is replaced: discovery reports the universe's self account once it
 * is paired or its seeded session is on this host, the QR step is the shared
 * fake, and the context seeds the app credential and a session the simulated
 * server accepts before the real context opens. The state declaration is not
 * inherited; the real source decodes its cursor itself.
 *
 * A universe without `sources/telegram-messages/fake-corpus.json` has no
 * Telegram account at all; there is no fixture-replay mode.
 */

import {
  buildTelegramProvider,
  TELEGRAM_PROVIDER_ID,
  type TelegramProvider,
} from "@omnesis/provider-telegram";
import { defineProvider } from "@omnesis/source-sdk";
import {
  fakeQrSession,
  preDiscoveredAccounts,
  selfAccountId,
} from "@omnesis/providers-synth-common";
import {
  registerController,
  simulatedServer,
  universeHasTelegramCorpus,
  unregisterController,
} from "./wraps-real.js";

export {
  getTelegramWrapsRealController,
  type TelegramWrapsRealController,
  type TelegramFakeCorpusFixture,
} from "./wraps-real.js";

const real = buildTelegramProvider(() => Promise.resolve(simulatedServer().factory));
const { type: _type, ...rest } = real;

// Resolved when asked, not on import: a universe without this source must
// still load the package and discover nothing.
const selfAccount = (): string => selfAccountId("extra", "telegramId");

export default defineProvider<TelegramProvider>({
  ...rest,
  // The real one asks for the operator's api_id/api_hash; the twin seeds its own.
  credentials: undefined,
  // Paired once the shared sign-in has run, or once a context has seeded this
  // host's session: the real discovery then finds it on disk, so a collector
  // restarted over a source the gateway already holds still hosts it.
  async discover(ctx) {
    if (!universeHasTelegramCorpus()) return [];
    const self = selfAccount();
    const stored = ctx?.configDir ? await rest.discover!(ctx) : [];
    return stored.some((account) => (typeof account === "string" ? account : account.id) === self)
      ? [self]
      : preDiscoveredAccounts(TELEGRAM_PROVIDER_ID, [self]);
  },
  authenticate: (session) =>
    fakeQrSession(TELEGRAM_PROVIDER_ID, selfAccount(), session, {
      title: "Scan this code with Telegram",
      instructions: "This is a synthetic sign-in; nothing leaves this machine.",
    }),
  cleanupCredentials: undefined,
  async createContext(options) {
    if (!options.host) throw new Error("The synthetic Telegram twin needs a host directory.");
    await simulatedServer().seedAccount(options.host.configDir, Number(options.accountId));
    return rest.createContext!(options);
  },
  sources: rest.sources.map((source) => ({
    ...source,
    // A double never inherits the real state declaration (the isolation test
    // pins it). The real source decodes its own cursor at the top of sync().
    contract: undefined,
    async create(options, provider) {
      const instance = await source.create!(options, provider);
      const sourceId = String(options.sourceId);
      registerController(sourceId, { server: simulatedServer(), provider });
      return {
        ...instance,
        async dispose() {
          unregisterController(sourceId);
          await instance.dispose?.();
        },
      };
    },
  })),
});
