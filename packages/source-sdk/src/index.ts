// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@omnesis/source-sdk` — `defineSource` / `defineProvider` /
 * `defineStructuredSource` API + the runtime + types every provider
 * package consumes.
 *
 * This is the **source contract surface**: the gateway and collector
 * reason about every source through the shapes here. Provider
 * packages depend on it to declare what they implement; the gateway
 * depends on it to instantiate sources at runtime.
 *
 * The `GatewayClient` interface ships from this package too —
 * `defineSource` hands a `GatewayClient` to source `sync` callbacks,
 * so the contract belongs alongside `Source`. The actual HTTP/WS
 * implementation lives in `@omnesis/gateway-client`
 * (`packages/gateway-client/src/http-gateway-client.ts`).
 *
 * `@omnesis/core` re-exports every symbol here for back-compat;
 * consumers that already `import { … } from "@omnesis/core"` keep
 * working unchanged.
 */

export * from "./snapshot.js";
export * from "./source.js";
export * from "./structured-source.js";
export * from "./table-write.js";
export * from "./row-key.js";
export type * from "./source-meta.js";
export * from "./source-descriptor.js";
export type * from "./provider.js";
export * from "./cursor-validator.js";
export * from "./source-state.js";
export * from "./source-contract.js";
export * from "./connection-state.js";
export * from "./account-descriptor.js";
export * from "./execution-mode.js";
export * from "./auth-session.js";
export * from "./state-runtime.js";
export type * from "./source-host.js";
export * as config from "./config-schema.js";
export {
  formatConfigIssues,
  toSourceParams,
  isDerivedFromSchema,
  hostConfigIssues,
  resolveDeclaredPaths,
  fieldValidator,
  type PathProbe,
} from "./config-schema.js";
export { nodePathProbe, expandHostPath } from "./path-probe-node.js";
export type {
  ConfigSchema,
  ConfigField,
  ConfigScope,
  ConfigIssue,
  ConfigParseResult,
  InferConfig,
} from "./config-schema.js";
export * from "./define-source.js";
export * from "./gateway-client.js";
export type { PendingStructuredPage, PrepareStructuredPage } from "./pending-source-page.js";
export * from "./read-access.js";
export * from "./read-access-tree.js";
