// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The gateway settings a search eval run applies, and the `--variants` that override them. */

/** Recall is measured over the first hundred results; the default pool is 50. */
export const RESULT_DEPTH = 100;

/**
 * The settings a run changes from the gateway's defaults. The temporal lane is
 * off because it reads a question's dates against today's date and the
 * passages' one shared date, which would make a score depend on the day of the
 * run.
 */
const GATEWAY_CONFIG = {
  search: { params: { candidateLimit: RESULT_DEPTH }, temporal: { enabled: false } },
  // A hybrid run embeds every passage; the default of one batch in flight
  // leaves a local embedding server mostly idle.
  indexer: { embedConcurrency: 8 },
};

export type SearchParamOverrides = Record<string, number>;

/** The run's gateway settings with some `search.params` overridden. */
export function gatewayConfig(overrides: SearchParamOverrides): typeof GATEWAY_CONFIG {
  return {
    ...GATEWAY_CONFIG,
    search: {
      ...GATEWAY_CONFIG.search,
      params: { ...GATEWAY_CONFIG.search.params, ...overrides },
    },
  };
}

/** A `--variants` file's text: a JSON object of label → numeric `search.params` overrides. */
export function parseVariants(text: string): Array<[string, SearchParamOverrides]> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--variants takes a JSON object of label → search.params overrides");
  }
  return Object.entries(parsed).map(([label, params]) => {
    const valid =
      /^[a-z0-9][a-z0-9-]*$/.test(label) &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      Object.values(params).every((v) => typeof v === "number" && Number.isFinite(v));
    if (!valid) throw new Error(`Variant "${label}" must map a lowercase label to numbers`);
    return [label, params as SearchParamOverrides];
  });
}
