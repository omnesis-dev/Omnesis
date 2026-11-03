// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  HOST_NETWORK_FILE,
  hostNetworkFromText,
  type HostNetwork,
} from "@omnesis/core";

const log = createLogger("gateway:host-network");

/** Larger than any network the launcher records; a file past it is not one. */
const MAX_BYTES = 64 * 1024;

/**
 * The Docker host's network as its launcher last recorded it in
 * `<configDir>/host-network`, or null when there is no such record (a native
 * install, host networking, or a launcher that predates the record). Read on
 * every call, so the next pairing sees what the launcher wrote last.
 */
export function readHostNetwork(configDir: string): HostNetwork | null {
  let text: string;
  try {
    text = readFileSync(join(configDir, HOST_NETWORK_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn(`Could not read ${HOST_NETWORK_FILE}: ${code ?? String(err)}`);
    return null;
  }
  if (text.length > MAX_BYTES) {
    log.warn(`Ignoring ${HOST_NETWORK_FILE}: larger than ${MAX_BYTES} bytes`);
    return null;
  }
  return hostNetworkFromText(text);
}
