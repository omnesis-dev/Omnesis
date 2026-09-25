// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tell the gateway what this host's update did to an agent harness's plugin.
 *
 * The plugin is refreshed by `omnesis update` on the harness host, and a
 * failure there would otherwise exist only in the scrollback of the terminal
 * that ran it. The report goes out as the harness's own device, with the
 * credential `omnesis connect` saved for it, so it lands on the same row and
 * clears the same way a commanded update's result does: the device's next
 * hello on the version reported.
 */

import { loadIntegrationCredentials, PinnedGatewayHttpClient } from "@omnesis/agent-integration";
import { harnessIntegrationPath } from "./detect.js";

export interface HarnessUpdateResult {
  /** The plugin version this update installed or tried to. */
  version: string;
  state: "installed" | "restart-pending" | "failed";
  /** One line for the operator: the failure, or the restart still owed. */
  detail: string;
}

export async function reportHarnessUpdateResult(
  home: string,
  result: HarnessUpdateResult,
): Promise<void> {
  // The strict loader: a file the plugin could not read has no refresh to
  // report on either (the plan sends such a harness to re-authorize instead).
  const credentials = loadIntegrationCredentials(harnessIntegrationPath(home));
  const client = new PinnedGatewayHttpClient(
    credentials.gatewayUrl,
    credentials.managementToken,
    credentials.tls,
  );
  await client.postJson("/devices/update-result", result);
}
