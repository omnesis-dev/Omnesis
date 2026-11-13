// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realGithub, { REPOSITORY_FIELD } from "@omnesis/provider-github";
import { defineProvider, withFilterLists } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { GithubAccount, registerAccount, unregisterAccount } from "./account.js";
import {
  loadCommitEntries,
  loadCommitRepos,
  loadThreadEntries,
  loadThreadRepos,
  mapCommit,
  mapThread,
  mapThreadEdges,
} from "./fixtures.js";
import type { RepoRow } from "./fixtures.js";
import type { ProviderSourceEntry, SourceInstance } from "@omnesis/source-sdk";

export { getGithubAccount, type GithubAccount } from "./account.js";

const { type: _type, ...rest } = realGithub;

// The GitHub account id IS the login, so it comes from the cast like every
// other synth identity — the universe manifest, discover() and the fixture
// actors then all agree on one person.
// Resolved when a source asks, not on import: a universe that does not carry
// this source must still load the package, and its discover() then reports no
// account instead of failing the provider load.
const selfAccount = (): string => selfAccountId("extra", "githubLogin");

/**
 * Give a fixture-paging source the list the live source publishes: the owners
 * and repositories of the account, read from an in-memory listing a test can
 * change between syncs.
 */
function withRepositoryList(
  sourceId: string,
  repos: RepoRow[],
  sync: SourceInstance["sync"],
): SourceInstance {
  const account = new GithubAccount(repos);
  registerAccount(sourceId, account);
  return withFilterLists(
    { sync, dispose: async () => unregisterAccount(sourceId) },
    { [REPOSITORY_FIELD]: () => account.list() },
  );
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts("github", [selfAccount()]),
  // An api-key source has no browser leg — a local pair shim stands in.
  authFlow: async () => fakeLocalFlow("github", selfAccount()),
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
        // It writes what the real source writes, so it keeps that source's
        // output revision.
        contract: { outputRevision: s.contract?.outputRevision },
        async create({ sourceId, providerId, accountId: account }) {
          const entries = loadThreadEntries();
          const ctx = { sourceId, providerId };
          const commitsSourceId = `github-commits:${account}`;
          return withRepositoryList(String(sourceId), loadThreadRepos(), async (cursor) =>
            syncFromFixture(entries, cursor as SynthCursor | null, (e) => mapThread(e, ctx), {
              sourceId,
              mapEdges: (e) => mapThreadEdges(e, { ...ctx, commitsSourceId }),
            }),
          );
        },
      };
    }
    if (s.id === "github-commits") {
      return {
        ...generic,
        // The double drives its own cursor; the real source's decoder does
        // not know it. Inheriting the declaration refuses it on the next tick.
        // It writes what the real source writes, so it keeps that source's
        // output revision.
        contract: { outputRevision: s.contract?.outputRevision },
        async create({ sourceId, providerId }) {
          const entries = loadCommitEntries();
          const ctx = { sourceId, providerId };
          return withRepositoryList(String(sourceId), loadCommitRepos(), async (cursor) =>
            syncFromFixture(entries, cursor as SynthCursor | null, (e) => mapCommit(e, ctx), {
              sourceId,
            }),
          );
        },
      };
    }
    return generic;
  }),
});
