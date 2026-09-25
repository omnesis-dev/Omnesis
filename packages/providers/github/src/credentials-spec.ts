// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * GitHub personal-access-token credentials spec.
 *
 * The pasted token IS the per-account credential — no client id/secret, no
 * browser redirect. A fine-grained token is the recommended shape: read-only,
 * and its repository selection keeps private access to what the operator
 * named. That selection does not decide what Omnesis indexes, though — a
 * fine-grained token can read every public repository on GitHub — so the
 * source's own `repos` setting is the selection, and the wizard says so.
 *
 * `authFlow()` validates the token against `GET /user` and stores it under
 * `<configDir>/github/<login>/credentials.json`, or `<login>@<label>` when the
 * operator named the connection (a second token for the same person, scoped
 * elsewhere, is a separate account).
 */
export const githubCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "github",
  required: true,
  // The pasted token IS this account's credential, not an app credential
  // shared across accounts — the wizard runs on every add and the value is
  // stored under the account the probe resolves.
  perAccount: true,
  fields: [
    {
      name: "token",
      label: "GitHub personal access token",
      placeholder: "github_pat_... or ghp_...",
      secret: true,
      pattern: "^(github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)$",
      patternHint: "A GitHub token starts with github_pat_ (fine-grained) or ghp_ (classic).",
    },
  ],
  wizard: {
    intro:
      "GitHub needs a personal access token to read your repositories' issues, " +
      "pull requests, discussions, and commits. Create a fine-grained token and " +
      "paste it on the next screen.",
    why:
      "Omnesis reads your GitHub activity through the official API using a " +
      "read-only token — it stays on this machine and is never shared. " +
      "Whatever the token can read is what gets indexed, so the repository " +
      "access you choose while creating it is the setting that decides what " +
      "Omnesis sees.",
    estMinutes: 4,
    steps: [
      {
        kind: "open-url",
        title: "Open GitHub's token settings",
        body: "Fine-grained tokens live under **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.",
        url: "https://github.com/settings/personal-access-tokens/new",
      },
      {
        kind: "instruction",
        title: "Choose which repositories Omnesis may index",
        body:
          "Pick a **Resource owner** — your own account, or an organization whose " +
          "repositories you want indexed. A token belongs to exactly one owner, so " +
          "an organization's private repositories need their own token.\n\n" +
          "Under **Repository access**, choose **Only select repositories** and pick " +
          "the private ones you want — that selection governs private access.\n\n" +
          "It does not narrow the public side: a fine-grained token can read every " +
          "public repository on GitHub, so Omnesis will also index the public " +
          "repositories you own or belong to. To name exactly what gets indexed, use " +
          "this source's **repos** setting after connecting. Omnesis indexes issues, " +
          "pull requests, discussions and commit metadata; it never indexes code.",
      },
      {
        kind: "instruction",
        title: "Grant read-only permissions",
        body:
          "Under **Repository permissions**, grant read-only access to **Metadata**, " +
          "**Contents**, **Issues**, **Pull requests**, and **Discussions** — nothing " +
          "else, and no account permissions. Generate the token and copy it; GitHub " +
          "shows it only once.",
      },
    ],
  },
};
