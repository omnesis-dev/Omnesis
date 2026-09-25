// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, readConnectionState } from "@omnesis/source-sdk";
import { SourceId } from "@omnesis/types";
import { readProviderAccountOrLegacyCredentials } from "@omnesis/core";
import { GithubClient } from "./client.js";
import {
  ACCOUNT_LABEL_REGEX,
  accountLogin,
  authFlow as githubAuthFlow,
  authenticate as githubAuthenticate,
  cleanupCredentials as githubCleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadToken,
} from "./provider.js";
import { githubCredentialsSpec } from "./credentials-spec.js";
import { githubCommitsDocumentProfile, githubThreadsDocumentProfile } from "./document-profiles.js";
import { githubCommitsIcon, githubThreadsIcon } from "./icons.js";
import { GithubThreadsSource } from "./threads.js";
import { GithubCommitsSource } from "./commits.js";
import { githubCommitsStateSpec, githubThreadsStateSpec } from "./state.js";
import { validateGithubCommitsCursor, validateGithubThreadsCursor } from "./types.js";
import type { GithubContext } from "./types.js";

export { GithubClient } from "./client.js";
export { githubCredentialsSpec } from "./credentials-spec.js";
export { GithubThreadsSource } from "./threads.js";
export { GithubCommitsSource } from "./commits.js";
export {
  commitToDocument,
  discussionToDocument,
  extractMentions,
  isBot,
  parseNoreplyEmail,
  threadToDocument,
  THREADS_RENDER_VERSION,
  COMMITS_RENDER_VERSION,
} from "./normalizer.js";
export { parseRepoFilter, resolveRepoList } from "./repo-selection.js";
export type { GithubContext, GithubThreadsCursor, GithubCommitsCursor } from "./types.js";

/**
 * Connection and repository settings shared by both source entries.
 *
 * The repository list is the selection that matters: a fine-grained token can
 * read every public repository on GitHub, so the repositories a token names
 * govern only its private access, not what ends up indexed.
 */
const REPO_PARAMS = [
  {
    name: "accountLabel",
    label:
      "Connection name — only for a second token for the same GitHub user, such as one " +
      "scoped to an organization. Name it after that scope. It is read when the connection " +
      "is made: to rename one later, remove the source and add it again.",
    type: "string" as const,
    required: false,
    placeholder: "acme-org",
    validate: (value: string) =>
      value.trim() === "" || ACCOUNT_LABEL_REGEX.test(value.trim())
        ? null
        : "Use letters, digits, dashes or underscores — for example the organization name.",
  },
  {
    name: "repos",
    label:
      "Repositories to index (comma-separated owner/repo). Leave empty to index every " +
      "repository this token lists: the ones you own, the ones you were added to as a " +
      "collaborator, and those belonging to organizations you are a member of. Naming " +
      "them indexes exactly those — entries outside that set are skipped, since a " +
      "token's own repository selection governs only its private access.",
    type: "string" as const,
    required: false,
    placeholder: "acme/widgets, acme/docs",
  },
  {
    name: "excludeRepos",
    label:
      "Repositories to skip (comma-separated owner/repo) — removes individual " +
      "repositories, whether the list above is set or left empty.",
    type: "string" as const,
    required: false,
    placeholder: "acme/scratch",
  },
];

/**
 * Thread and commit URLs resolve to documents by regex extraction — the
 * captured group IS the document's external id, which is deliberately the
 * public URL path. A single capture group per pattern: the resolver reads
 * `match[1]` only.
 */
const THREAD_URL_PATTERNS = [
  { regex: "github\\.com/([^/\\s]+/[^/\\s#?]+/(?:issues|pull|discussions)/\\d+)" },
];
const COMMIT_URL_PATTERNS = [{ regex: "github\\.com/([^/\\s]+/[^/\\s#?]+/commit/[0-9a-f]{40})" }];

/**
 * Collapse GitHub's equivalent URL flavours onto the canonical thread/commit
 * form so a URL seen anywhere (a transcript, an email) dedups against the
 * document's own `source_url`. Fragments (`#issuecomment-…`) and tracking
 * params are already stripped by the generic normalization pass; these rules
 * handle path variants and the API-host forms.
 */
const GITHUB_URL_CANONICALIZER = {
  hosts: ["github.com", "www.github.com", "api.github.com"],
  // Rules are first-match-wins, so each is host-tolerant (`(?:www\.)?`) and
  // the bare www-strip rule sits LAST as the residual — otherwise a
  // `www.github.com/o/r/pull/5/files` URL would stop at the www strip and
  // keep its `/files` suffix.
  rules: [
    // API forms → web forms. PRs surface as both `/pulls/N` (the PR API) and
    // `/issues/N` (the shared conversation API); both resolve, `/pulls/N`
    // to the pull path.
    {
      match: "^https://(?:www\\.)?api\\.github\\.com/repos/([^/]+/[^/]+)/pulls/(\\d+)(?:[/?#].*)?$",
      replacement: "https://github.com/$1/pull/$2",
    },
    {
      match:
        "^https://(?:www\\.)?api\\.github\\.com/repos/([^/]+/[^/]+)/issues/(\\d+)(?:[/?#].*)?$",
      replacement: "https://github.com/$1/issues/$2",
    },
    {
      match:
        "^https://(?:www\\.)?api\\.github\\.com/repos/([^/]+/[^/]+)/commits/([0-9a-f]{40})(?:[/?#].*)?$",
      replacement: "https://github.com/$1/commit/$2",
    },
    // Sub-pages, export suffixes, and queries of a thread (`/pull/5/files`,
    // `/pull/5/commits`, `/pull/5.diff`, `/pull/5?w=1`) all mean the thread
    // itself.
    {
      match:
        "^https://(?:www\\.)?github\\.com/([^/]+/[^/]+/(?:pull|issues|discussions)/\\d+)[./?#].*$",
      replacement: "https://github.com/$1",
    },
    // Same for a commit's sub-pages and export suffixes (`.patch`, `.diff`).
    {
      match: "^https://(?:www\\.)?github\\.com/([^/]+/[^/]+/commit/[0-9a-f]{40})[./?#].*$",
      replacement: "https://github.com/$1",
    },
    { match: "^https://www\\.github\\.com/(.*)$", replacement: "https://github.com/$1" },
  ],
};

export default defineProvider<GithubContext>({
  provider: { id: "github", name: "GitHub" },
  authType: "api-key",
  credentials: githubCredentialsSpec,

  // An account id here is a login, optionally followed by the name of the
  // organization a second token is scoped to. Both halves are declared rather
  // than left to be parsed back out: the login is who this is, and the label
  // is which world the token can see — a distinction no API the token can call
  // will report, which is why the operator supplies it at connect time.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => {
      const login = accountLogin(String(id));
      const label = String(id).slice(login.length + 1);
      return {
        id: String(id),
        subject: { kind: "handle" as const, value: login },
        ...(label ? { tenant: { id: label } } : {}),
      };
    });
  },

  async authFlow(params, callbacks, ctx) {
    const accountId = await githubAuthFlow(params, callbacks, ctx);
    return String(accountId);
  },

  authenticate: githubAuthenticate,

  async cleanupCredentials(accountId: string, ctx) {
    await githubCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const token = await loadToken(accountId, host?.configDir);
    const client = new GithubClient(token);
    return { client, accountId, dataCutoff, configDir: host?.configDir };
  },

  credentialState(ctx) {
    // Offline: a stored token means authenticated. A network probe here can
    // only add false negatives — an outage or a rate limit would park the
    // source in needs-auth and prompt a re-auth that cannot resolve it. A
    // genuinely revoked token surfaces as SyncError("auth") from the sync.
    // A stored credential is the whole answer, and its absence means this
    // account was never connected rather than that something withdrew it —
    // the remedy differs: one asks the operator to connect, the other to
    // authenticate again.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir))
        return { status: "never-connected" };
      const fields = await readProviderAccountOrLegacyCredentials(
        "github",
        String(ctx.accountId),
        ctx.configDir,
      );
      if (!fields?.token) throw new Error("Unreadable GitHub credential");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "github",
      name: "GitHub",
      description:
        "Issues, pull requests, and discussions from your GitHub repositories — each thread with its comments and reviews as one searchable document",
      unitName: "threads",
      icon: githubThreadsIcon,
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never
        // reaches `sync`.
        state: githubThreadsStateSpec,
        // The version-1 → 2 step ends a snapshot whose accumulated ids can no
        // longer be attributed to a repository. A host that ignored the
        // declaration would hand that version-1 value to a decoder that now
        // refuses it, and the source would re-bootstrap the whole account
        // instead of finishing the cycle it was in.
        apiVersion: 2,
        requires: ["state-envelope", "snapshot-sessions"],
      },
      urlPatterns: THREAD_URL_PATTERNS,
      urlCanonicalizer: GITHUB_URL_CANONICALIZER,
      selfIdentity: { aliasPrefix: "github", accountPattern: "^([^@]+)" },
      documentEventProfile: githubThreadsDocumentProfile,
      defaultSyncInterval: "15m",
      params: REPO_PARAMS,
      async create({ sourceId, providerId, accountId, dataCutoff, sourceConfig }, ctx) {
        const source = new GithubThreadsSource({
          client: ctx.client,
          providerId,
          sourceId,
          commitsSourceId: SourceId(`github-commits:${accountId}`),
          accountId: String(accountId),
          dataCutoff,
          sourceConfig,
        });
        return {
          icon: githubThreadsIcon,
          sync: (cursor) => source.sync(validateGithubThreadsCursor(cursor)),
        };
      },
    },
    {
      id: "github-commits",
      name: "GitHub Commits",
      description:
        "Commits on your repositories' default branches — message, author, stats, and changed-file paths (never the code itself)",
      unitName: "commits",
      icon: githubCommitsIcon,
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never
        // reaches `sync`.
        state: githubCommitsStateSpec,
        // The version-1 → 2 step ends a snapshot whose accumulated ids can no
        // longer be attributed to a repository. A host that ignored the
        // declaration would hand that version-1 value to a decoder that now
        // refuses it, and the source would re-bootstrap the whole account
        // instead of finishing the cycle it was in.
        apiVersion: 2,
        requires: ["state-envelope", "snapshot-sessions"],
      },
      urlPatterns: COMMIT_URL_PATTERNS,
      urlCanonicalizer: GITHUB_URL_CANONICALIZER,
      selfIdentity: { aliasPrefix: "github", accountPattern: "^([^@]+)" },
      documentEventProfile: githubCommitsDocumentProfile,
      defaultSyncInterval: "15m",
      params: REPO_PARAMS,
      async create({ sourceId, providerId, dataCutoff, sourceConfig }, ctx) {
        const source = new GithubCommitsSource({
          client: ctx.client,
          providerId,
          sourceId,
          dataCutoff,
          sourceConfig,
        });
        return {
          icon: githubCommitsIcon,
          sync: (cursor) => source.sync(validateGithubCommitsCursor(cursor)),
        };
      },
    },
  ],
});
