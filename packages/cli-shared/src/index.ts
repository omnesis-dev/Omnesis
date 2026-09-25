// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export { c, disabledColors } from "./colors.js";
export type { Colors } from "./colors.js";
export {
  formatSize,
  formatDateShort,
  formatInterval,
  formatTimeAgo,
  formatTimeAgoMs,
  type FormatTimeAgoMsOptions,
} from "./formatters.js";
export { buildCliFx, iconFor, linkify, makeSourceMetaCache } from "./terminal-fx.js";
export type { CliFx, SourceMeta, SourceMetaCache, FetchSourceMeta } from "./terminal-fx.js";
export { withSpinner } from "./spinner.js";
export type { SpinnerHandle } from "./spinner.js";
export {
  CliError,
  isCittyParseError,
  isFetchConnectionError,
  EXIT_CODES,
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_DOWN,
  EXIT_GATEWAY_ERROR,
  EXIT_PARTIAL,
  EXIT_AUTH,
  EXIT_CANCELLED,
  type ExitCode,
} from "./errors.js";
export { runCli, type RunCliOptions } from "./runner.js";
export * as cliConstants from "./constants.js";
