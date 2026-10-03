// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-local-files";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  materializeSyntheticFiles,
  preDiscoveredAccounts,
  universeAccounts,
} from "@omnesis/providers-synth-common";

const fixtureSchema = z.array(
  z
    .object({ path: z.string().min(1), content: z.string(), modifiedAt: z.string().optional() })
    .strict(),
);
export function loadFiles() {
  return fixtureSchema.parse(
    loadSourceFixtureJson<unknown>(loadActiveUniverse(), "local-files", "files.json"),
  );
}

const { type: _type, ...rest } = realSource;
/** Real parsing/normalization over invented, isolated input files; no default host roots. */
export default defineSource({
  ...rest,
  config: undefined,
  params: undefined,
  resolveAccountId: undefined,
  supportedPlatforms: undefined,
  credentials: undefined,
  authenticate: undefined,
  cleanupCredentials: undefined,
  discover: async () => preDiscoveredAccounts("local-files", universeAccounts("local-files")),
  authFlow: async () =>
    fakeLocalFlow("local-files", universeAccounts("local-files")[0] ?? "synthetic"),
  async create(options) {
    const root = materializeSyntheticFiles(options.host?.stateDir, "local-files", loadFiles());
    return realSource.create!({ ...options, config: { roots: [root], exclude: [] } });
  },
});
