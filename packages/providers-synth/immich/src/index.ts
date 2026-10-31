// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Immich twin.
 *
 * Spreads the REAL definition, built by `buildImmichProvider` over the
 * simulated server's `fetch`, so a synthetic gateway runs the production
 * client, sync source and normalizer end to end. Only the sign-in is
 * replaced: discovery reports the universe's account, the API-key step is the
 * shared local fake, and the context presents a key the simulated server
 * knows. The state declaration is not inherited; the real source decodes its
 * cursor itself.
 *
 * A universe without `sources/immich/fake-corpus.json` has no Immich account.
 */

import { buildImmichProvider, ImmichClient, IMMICH_PROVIDER_ID } from "@omnesis/provider-immich";
import { defineProvider } from "@omnesis/source-sdk";
import { fakeLocalFlow, preDiscoveredAccounts } from "@omnesis/providers-synth-common";
import {
  registerController,
  selfImmichAccount,
  SIMULATED_API_KEY,
  SIMULATED_BASE_URL,
  simulatedServer,
  universeHasImmichCorpus,
  unregisterController,
} from "./wraps-real.js";
import type { ImmichContext } from "@omnesis/provider-immich";

export {
  getImmichWrapsRealController,
  type ImmichFakeCorpusFixture,
  type ImmichWrapsRealController,
} from "./wraps-real.js";

// The server is resolved per request, not on import: a universe without this
// source must still load the package and discover nothing.
const fetchImpl: typeof fetch = (input, init) => simulatedServer().fetch(input, init);

const real = buildImmichProvider({ fetchImpl });
const { type: _type, ...rest } = real;

export default defineProvider<ImmichContext>({
  ...rest,
  // The real one asks the operator for an address and a key; the twin has its own.
  credentials: undefined,
  discover: () =>
    Promise.resolve(
      universeHasImmichCorpus()
        ? preDiscoveredAccounts(IMMICH_PROVIDER_ID, [selfImmichAccount()])
        : [],
    ),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares is overridden here, or a demo run would reach
  // for a real server.
  authFlow: async () => fakeLocalFlow(IMMICH_PROVIDER_ID, selfImmichAccount()),
  authenticate: undefined,
  cleanupCredentials: undefined,
  createContext: ({ accountId }) =>
    Promise.resolve({
      accountId,
      client: new ImmichClient(SIMULATED_BASE_URL, SIMULATED_API_KEY, { fetchImpl }),
    }),
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  sources: rest.sources.map((source) => ({
    ...source,
    // A double never inherits the real state declaration. The real source
    // decodes its own cursor at the top of sync().
    contract: undefined,
    async create(options, provider) {
      const instance = await source.create!(options, provider);
      const sourceId = String(options.sourceId);
      registerController(sourceId, { server: simulatedServer() });
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
