// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Descriptors for sources the gateway hosts itself — no collector syncs them.
 *
 * Currently the single entry is the unified Web Pages dataset: its
 * documents arrive via the browser extension's HTTP push, so no collector is
 * involved. Because the descriptor follows the host, the **gateway** advertises
 * these (merged into `/admin/source-descriptors`) and
 * seeds their display identity, while collectors deliberately exclude
 * `gatewayHosted` descriptors from what they advertise (see
 * `collector/src/source-ws-handlers.ts`). Without this, a gateway-hosted
 * source's metadata would parasitically depend on a collector being online.
 *
 * The provider package exports a `SourceDefinition`, which is a structural
 * superset of `SourceDescriptor` for the data fields `serializeDescriptor`
 * reads (it only projects data, never invokes `create`/`authFlow`), so the cast
 * is safe — `hasAuthFlow`/`hasDiscover` fall out as `false` for a push-only
 * source that declares neither.
 */

import webDefinition from "@omnesis/provider-web";
import {
  memberScopedParamNames,
  serializeDescriptor,
  type SerializedDescriptor,
  type SourceDescriptor,
} from "@omnesis/source-sdk";
import { createLogger } from "@omnesis/core";

const log = createLogger("gateway").child("internal-sources");

const GATEWAY_HOSTED_DEFINITIONS = [webDefinition];

/** The definitions this gateway hosts, for a caller comparing against them. */
export function gatewayHostedDefinitions(): typeof GATEWAY_HOSTED_DEFINITIONS {
  return GATEWAY_HOSTED_DEFINITIONS;
}

/**
 * Serialized descriptors for every gateway-hosted source. Fail-loud guard: a
 * definition listed here that forgot `gatewayHosted: true` would be advertised
 * by collectors too (double ownership), so we drop it and warn rather than ship
 * the ambiguity.
 */
export function gatewayHostedDescriptors(): SerializedDescriptor[] {
  const out: SerializedDescriptor[] = [];
  for (const def of GATEWAY_HOSTED_DEFINITIONS) {
    // The cast skips the collector's descriptor builder, so the fields that
    // builder derives have to be derived here too or they are silently
    // absent — and a missing per-machine contract reads to every client as
    // "did not say" rather than "declares none". Derived from the definition
    // for the same reason the collector derives it: a source that grows a
    // host-local setting should not need this file edited to advertise it.
    const serialized = serializeDescriptor({
      ...(def as unknown as SourceDescriptor),
      memberScopedParamNames: memberScopedParamNames(def),
    });
    if (!serialized.gatewayHosted) {
      log.warn(
        `internal source "${serialized.id}" is missing gatewayHosted:true — skipping its gateway-advertised descriptor`,
      );
      continue;
    }
    out.push(serialized);
  }
  return out;
}
