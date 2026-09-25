// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { toAccountDescriptor } from "@omnesis/source-sdk";
import { tryAccountId } from "@omnesis/types";
import type { AccountDescriptor, DiscoveredAccount } from "@omnesis/source-sdk";

const log = createLogger("collector:sources");

/**
 * Brand what discovery returned, whichever form it took.
 *
 * A source with nothing to say about an account returns its id; one that knows
 * who it belongs to returns a descriptor. Both arrive here as a descriptor
 * whose id has been through the constructor that constrains it — this is the
 * seam where an id stops being an unconstrained string and becomes something
 * that will name a directory.
 *
 * One account a provider cannot name must not blind the host to the rest. A
 * browser profile titled with a space, a directory whose name is not a legal
 * id — discovery returns the whole list at once, so refusing the batch loses
 * every good account alongside the bad one, and the source reads as "not
 * available on this host" rather than "one profile is unusable".
 */
export function brandDiscoveredAccounts(
  found: Array<string | AccountDescriptor>,
): DiscoveredAccount[] {
  return found.flatMap((entry) => {
    const descriptor = toAccountDescriptor(entry);
    const id = tryAccountId(descriptor.id);
    if (id === null) {
      log.warn(
        `Discovery returned an account this host cannot address, skipping it: "${descriptor.id}"`,
      );
      return [];
    }
    return [{ ...descriptor, id }];
  });
}
