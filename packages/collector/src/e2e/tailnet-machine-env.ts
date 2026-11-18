// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { delimiter } from "node:path";

/** A CLI reads this peer's real local API and reaches only its userspace network. */
export function tailnetMachineEnv(
  binDir: string,
  proxyUrl: string,
  caCertFile: string,
): NodeJS.ProcessEnv {
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "",
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: caCertFile,
  };
}

/** Ambient SDK authentication must never bypass the fixture's local approval. */
export function tailnetFixtureEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith("TS_") || name.startsWith("TSNET_")) delete env[key];
  }
  env.TS_NO_LOGS_NO_SUPPORT = "true";
  return env;
}
