// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector on the gateway's own machine, after `omnesis tls provision`
 * changed the certificate the gateway serves.
 *
 * `omnesis service install` writes that collector's gateway URL from the
 * certificate it finds: `https://localhost` while the gateway serves a
 * certificate naming localhost (its self-signed one), and nothing — so the
 * address recorded in `.env` applies — for a certificate naming only this
 * host's tailnet name. A unit written before provisioning therefore keeps
 * dialling localhost, which the new certificate does not cover, and the
 * collector waits forever on a certificate it cannot trust. The installer
 * never meets this: it mints the certificate before it writes the unit.
 *
 * So provisioning regenerates the unit through the same rule `omnesis update`
 * applies to an installed unit (`serviceDefinitionUpdater`), and restarts the
 * collector when its unit or the address it reads changed.
 */

import { homedir } from "node:os";

import { c } from "../utils.js";
import { createSupervisor } from "../service/supervisor.js";
import { stableNodeBinDir } from "../service/node-bin-dir.js";
import {
  serviceDefinitionUpdater,
  type ServiceDefinitionUpdater,
} from "../update/service-definitions.js";

export interface LocalCollectorDeps {
  /** Is a collector service installed for this account? */
  installed(): boolean;
  updater: Pick<ServiceDefinitionUpdater, "refresh" | "loadDefinition" | "reload">;
}

function defaultLocalCollectorDeps(): LocalCollectorDeps | null {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const supervisor = createSupervisor();
  return {
    installed: () => supervisor.isInstalled("collector"),
    updater: serviceDefinitionUpdater({
      supervisor,
      homeDir: homedir(),
      nodeBinDir: stableNodeBinDir(process.execPath),
    }),
  };
}

/**
 * Bring the collector on this machine onto the provisioned certificate.
 * `urlChanged`: provisioning recorded a different gateway address in `.env`.
 * Returns the lines to print; never throws — the certificate is provisioned
 * either way, and what is left to do is said.
 */
export async function reconnectLocalCollector(
  urlChanged: boolean,
  deps: LocalCollectorDeps | null = defaultLocalCollectorDeps(),
): Promise<string[]> {
  if (!deps || !deps.installed()) return [];
  try {
    const outcome = await deps.updater.refresh("collector");
    if (outcome.kind === "refused") {
      return [
        `${c.yellow}The collector service on this machine was left as it is${c.reset} (${outcome.reason}).`,
        "If it stops connecting, point it at the gateway's new address: omnesis service install collector",
      ];
    }
    if (outcome.kind === "unchanged" && !urlChanged) return [];
    if (outcome.kind === "replaced") await deps.updater.loadDefinition("collector");
    await deps.updater.reload("collector");
    return [
      outcome.kind === "replaced"
        ? "Restarted the collector on this machine: it now dials the gateway by the name the certificate covers."
        : "Restarted the collector on this machine on the gateway's new address.",
    ];
  } catch (err) {
    return [
      `${c.yellow}Could not restart the collector on this machine${c.reset} (${err instanceof Error ? err.message : String(err)}).`,
      "Restart it: omnesis service restart collector",
    ];
  }
}
