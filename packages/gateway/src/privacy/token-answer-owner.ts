// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  answerOwnerScopeDigest,
  type CorpusAuthorization,
} from "../access/corpus-authorization.js";

/**
 * The answer owner for a caller that presents a device token to `/answer`.
 *
 * A token answered from every source under the default privacy policy owns
 * its answers as `token:<tokenId>`. A token whose device is on an access level
 * owns them under that level's Answer scope as well, the digest an OAuth
 * answer owner carries: changing the sources, release mode or policy the
 * device answers under starts a new ownership namespace, so neither a
 * re-posted request id nor a task poll can collect an answer made under the
 * scope it had before.
 */
export function tokenAnswerOwnerId(tokenId: string, authorization?: CorpusAuthorization): string {
  return authorization
    ? `token:${tokenId}:answer-scope:${answerOwnerScopeDigest(authorization)}`
    : `token:${tokenId}`;
}

const TOKEN_OWNER_PATTERN = /^token:([^:]+)(?::answer-scope:[^:]+)?$/;

/** The token id a {@link tokenAnswerOwnerId} owner names, or null for any other owner. */
export function tokenIdOfAnswerOwner(ownerId: string): string | null {
  return TOKEN_OWNER_PATTERN.exec(ownerId)?.[1] ?? null;
}
