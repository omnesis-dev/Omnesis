// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Commit authors that are a contributor's coding agent rather than a person.
 * CLA Assistant names a commit by its author's GitHub login, or by the author
 * name when no account is linked: Claude Code commits as `Claude` with
 * Anthropic's no-reply address, which GitHub links to the `claude` account.
 */
export const CODING_AGENT_AUTHORS = ["claude", "Claude"];

/** CLA Assistant's own allowlist rule: an exact name, or `*` as a wildcard. */
export function allowlisted(allowlist, name) {
  return allowlist
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .some((pattern) => {
      if (!pattern.includes("*")) return pattern === name;
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("\\*");
      return new RegExp(escaped.join(".*")).test(name);
    });
}

/**
 * The allowlist CLA Assistant runs with for one pull request. When the person
 * who opened it has signed (or is exempt), commits their coding agent authored
 * count as theirs; anyone else's commits still need their own signature.
 */
export function claAllowlist({ base, author, signers }) {
  const signed =
    author !== null &&
    (allowlisted(base, author.login) ||
      signers.some((signer) => signer.id === author.id || signer.name === author.login));
  return signed ? [base, ...CODING_AGENT_AUTHORS].join(",") : base;
}

async function github(path, token, accept = "application/vnd.github+json") {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${path} answered ${response.status}`);
  return response.json();
}

async function main(env) {
  const base = env.BASE_ALLOWLIST;
  if (!base) throw new Error("BASE_ALLOWLIST is required");
  try {
    const pull = env.PR_NUMBER
      ? await github(`repos/${env.REPOSITORY}/pulls/${env.PR_NUMBER}`, env.GITHUB_TOKEN)
      : null;
    // A comment on an issue rather than a pull request has no author to vouch.
    const author = pull ? { login: pull.user.login, id: pull.user.id } : null;
    const file = await github(
      `repos/${env.REPOSITORY}/contents/${env.SIGNATURES_PATH}?ref=${env.SIGNATURES_BRANCH}`,
      env.GITHUB_TOKEN,
      "application/vnd.github.raw+json",
    );
    const signers = file?.signedContributors ?? [];
    return claAllowlist({ base, author, signers });
  } catch (error) {
    // Fall back to the plain allowlist: every committer must then sign as before.
    console.error(`::warning::Coding-agent commits not vouched for: ${error.message}`);
    return base;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const allowlist = await main(process.env);
  console.error(`CLA allowlist: ${allowlist}`);
  console.log(`allowlist=${allowlist}`);
}
