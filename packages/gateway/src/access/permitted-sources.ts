// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listSources } from "../data/repositories/SourceRepository.js";
import type { Db } from "../data/types.js";
import type { CorpusAuthorization } from "./corpus-authorization.js";

/**
 * The source ids a restricted authorization may read, resolved against the
 * configured sources.
 *
 * A grant's rule names configured sources only, so a denylist means "every
 * configured source except the listed ones" — never "everything not listed".
 * Documents written by the gateway itself (agent transcripts, open-loop
 * mirrors) have no `sources` row, cannot be named in a rule, and are therefore
 * outside every restricted grant. Every read port checks membership in this
 * set rather than the rule alone, so the three restricted tools agree.
 *
 * `null` for an unrestricted authorization: every source is readable and no
 * set needs to be built.
 */
export function permittedSourceIds(
  db: Db,
  authorization: CorpusAuthorization,
): ReadonlySet<string> | null {
  if (!authorization.restricted) return null;
  return new Set(
    listSources(db)
      .filter((source) => authorization.allowsSource(source.id))
      .map((source) => source.id),
  );
}
