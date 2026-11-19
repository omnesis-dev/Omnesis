// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { decodeSecretTextFileValue, isEncryptedSecretFile } from "@omnesis/core";
import { readBoundedPrivateText } from "./private-inputs.js";

/** Direct gateway TLS keys may be config-scoped envelopes; public certificate PEM is separate. */
export async function readGatewayTlsPrivateKey(
  path: string,
  configDir?: string,
  tooLargeMessage = "Gateway key file is too large",
): Promise<string> {
  const serialized = await readBoundedPrivateText(path, 65_536, tooLargeMessage);
  if (configDir === undefined && isEncryptedSecretFile(serialized))
    throw new Error("Reading an encrypted gateway TLS key requires its configuration directory.");
  return decodeSecretTextFileValue(path, serialized, { configDir });
}
