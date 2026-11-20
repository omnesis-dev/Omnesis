// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {
  loadDotEnv,
  parseDotEnv,
  type LoadDotEnvOptions,
  type LoadDotEnvResult,
} from "./dotenv-reader.js";
export { upsertDotEnv, scaffoldDotEnv } from "./dotenv-writer.js";
