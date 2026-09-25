// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Default ceiling for the one DuckDB operation that cannot be checkpointed:
 * replacing a table so its primary key includes the stream column. A simple
 * two-column table takes roughly 100 ms at this size; wider tables cost more.
 */
export const DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS = 100_000;
