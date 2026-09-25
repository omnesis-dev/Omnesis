// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realGithub from "@omnesis/provider-github";
import { defineProvider } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import {
  loadCommitEntries,
  loadThreadEntries,
  mapCommit,
  mapThread,
  mapThreadEdges,
} from "./fixtures.js";
import type { ProviderSourceEntry } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realGithub;

// The GitHub account id IS the login, so it comes from the cast like every
// other synth identity — the universe manifest, discover() and the fixture
// actors then all agree on one person.
const accountId = selfAccountId("extra", "githubLogin");

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts("github", [accountId]),
  // An api-key source has no browser leg — a local pair shim stands in.
  authFlow: async () => fakeLocalFlow("github", accountId),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  // A double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick
  // after the first one and park the source.
  contract: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  // The real provider parametrises its sources on GithubContext (an HTTP
  // client). The synth createContext hands back an empty context instead, so
  // each entry is re-typed rather than round-tripped through that parameter.
  sources: rest.sources.map((s): ProviderSourceEntry<Record<string, never>> => {
    const generic = s as unknown as ProviderSourceEntry<Record<string, never>>;
    if (s.id === "github") {
      return {
        ...generic,
        // The double drives its own cursor; the real source's decoder does
        // not know it. Inheriting the declaration refuses it on the next tick.
        contract: undefined,
        async create({ sourceId, providerId, accountId: account }) {
          const entries = loadThreadEntries();
          const ctx = { sourceId, providerId };
          const commitsSourceId = `github-commits:${account}`;
          return {
            async sync(cursor) {
              return syncFromFixture(
                entries,
                cursor as SynthCursor | null,
                (e) => mapThread(e, ctx),
                { sourceId, mapEdges: (e) => mapThreadEdges(e, { ...ctx, commitsSourceId }) },
              );
            },
          };
        },
      };
    }
    if (s.id === "github-commits") {
      return {
        ...generic,
        // The double drives its own cursor; the real source's decoder does
        // not know it. Inheriting the declaration refuses it on the next tick.
        contract: undefined,
        async create({ sourceId, providerId }) {
          const entries = loadCommitEntries();
          const ctx = { sourceId, providerId };
          return {
            async sync(cursor) {
              return syncFromFixture(
                entries,
                cursor as SynthCursor | null,
                (e) => mapCommit(e, ctx),
                { sourceId },
              );
            },
          };
        },
      };
    }
    return generic;
  }),
});
