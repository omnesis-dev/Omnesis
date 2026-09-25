// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Barrel re-export of every per-route request-body schema. Clients
 * (`packages/gateway-client/src/http-gateway-client.ts`, `packages/cli/src/`,
 * iOS via the OpenAPI generator if/when it lands) should import the
 * inferred types from here so the contract surface stays single-sourced.
 *
 * Schemas themselves are mounted via `validateJson(schema)` from
 * `../validate.ts` at each route's registration site — see the per-route
 * source files in `routes/`.
 */
export * from "./admin.js";
export * from "./answer.js";
export * from "./backup.js";
export * from "./dev-annotations.js";
export * from "./documents.js";
export * from "./people.js";
export * from "./search.js";
export * from "./analytics.js";
export * from "./model-credentials.js";
export * from "./notes.js";
export * from "./agent-messages.js";
export * from "./portal.js";
export * from "./oauth-access.js";
export * from "./web-capture-policy.js";
