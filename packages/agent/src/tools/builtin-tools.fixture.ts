// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ports wired only enough to build the whole built-in catalog.
 *
 * Test-only. `buildBuiltinTools` skips a tool whose port is missing, so a rig
 * that stubs some ports and not others quietly checks a smaller catalog than it
 * believes it is checking — which is exactly the failure the classification
 * inventory exists to prevent. Nothing here is ever invoked; callers read a
 * handle's `name` and `mutates`.
 */

import type { ToolPorts } from "./types.js";

export function allToolPorts(): ToolPorts {
  const port = new Proxy(
    {},
    {
      get: () => (): never => {
        throw new Error("the built-in catalog fixture never invokes a tool");
      },
    },
  );
  // Every key, including ones that do not exist yet. Listing the thirteen ports
  // by hand would reintroduce the hazard this file exists to remove: almost
  // every field of `ToolPorts` is optional, so a tool added next month behind a
  // *new* port key would be skipped by the catalog, absent from the inventory,
  // and unclassified — with the hand-written list still type-checking.
  return new Proxy({}, { get: () => port }) as ToolPorts;
}
