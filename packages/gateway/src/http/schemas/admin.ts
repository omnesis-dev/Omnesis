// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for routes mounted in `routes/admin.ts`.
 *
 * The inferred types are the canonical contract — clients (CLI, collector,
 * iOS, portal) should consume these via `import type {…} from
 * "@omnesis/gateway/http/schemas/admin"` (or the package's barrel) rather
 * than redeclaring the shapes locally.
 */
import { z } from "zod";
import { PERSON_ROLES } from "@omnesis/types";
import { isSafeUrlCanonicalizerPattern } from "../../known-url-pattern-safety.js";
import { accountDescriptorSchema } from "./account-descriptor.js";
import {
  deviceCapabilitySchema,
  deviceKindSchema,
  nonEmptyString,
  scopeArraySchema,
  stringParamsSchema,
  urlPatternRegexSchema,
} from "./common.js";

// POST /admin/devices
// DELETE /admin/devices/:id — revoke by default; `forget=true` hard-deletes.
export const deleteDeviceQuery = z.object({
  forget: z.enum(["true", "false"]).optional(),
  impactFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});

export const createDeviceBody = z.object({
  name: nonEmptyString,
  kind: deviceKindSchema,
  scopes: scopeArraySchema,
  capabilities: deviceCapabilitySchema.optional(),
});
export type CreateDeviceBody = z.infer<typeof createDeviceBody>;

// PATCH /admin/devices/:id
export const patchDeviceBody = z
  .object({
    /** Display rename; unique per gateway, 1–64 chars, no control characters. */
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
    selfEmails: z.array(z.string()).optional(),
    selfPhones: z.array(z.string()).optional(),
  })
  .refine((b) => b.name !== undefined || b.selfEmails !== undefined || b.selfPhones !== undefined, {
    message: "at least one of name / selfEmails / selfPhones required",
  });
export type PatchDeviceBody = z.infer<typeof patchDeviceBody>;

/**
 * POST /devices/update-result — a device's own host reporting an update it
 * ran. A host never claims `installed`: only the device's hello on the
 * version proves that.
 */
export const deviceUpdateResultBody = z.object({
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$/u),
  state: z.enum(["restart-pending", "failed"]),
  detail: z.string().max(2_000).optional(),
});

/**
 * Select devices for an operator-initiated fleet action. Omitting `deviceIds`
 * means every applicable device; an explicit empty array means none.
 */
export const fleetDeviceSelectionBody = z.object({
  deviceIds: z.array(nonEmptyString).max(500).optional(),
});

const fullSourceCommit = z.string().regex(/^[0-9a-f]{40}$/u);
export const fleetCommitPlanBody = z.object({ commit: fullSourceCommit }).strict();
export const fleetUpdateRequestBody = fleetDeviceSelectionBody
  .extend({
    commit: fullSourceCommit.optional(),
    /** Forward the operator's `--allow-rewind` (or `--force`) to each device commanded now. */
    allowRewind: z.boolean().optional(),
  })
  .strict();

/** Start only the opaque gateway-generated host/fleet transition reviewed by the portal. */
export const hostFleetUpdateStartBody = z
  .object({
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

/** `POST /admin/tls/renew`: `force` renews material that is not yet due. */
export const tlsRenewBody = z.object({
  force: z.boolean().optional(),
});

// Compatibility alias for iOS app builds predating the unified
// push-registration endpoint. It installs the same content-free direct
// transport; the gateway never reconstructs a rich carrier payload from it.
const APNS_HEX_TOKEN = /^[0-9a-f]{64,200}$/i;
const APNS_BUNDLE_ID = /^[a-zA-Z0-9.\-]{3,255}$/;
export const setApnsTokenBody = z.object({
  deviceToken: z
    .string()
    .regex(APNS_HEX_TOKEN, "deviceToken must be a lowercase hex string (64+ chars)"),
  environment: z.enum(["sandbox", "production"]),
  bundleId: z.string().regex(APNS_BUNDLE_ID, "bundleId must look like dev.omnesis.ios"),
});
export type SetApnsTokenBody = z.infer<typeof setApnsTokenBody>;

// POST /admin/devices/pair
//
// `scopes` is optional: omitted, the pairing carries the kind's canonical grant
// (`defaultScopesForDeviceKind`), which every interactive client relies on. A
// caller that wants a narrower or wider grant states it explicitly (the CLI's
// `--scopes`); an empty list is still rejected.
//
// `selfEmails` / `selfPhones` stage the device owner's identifiers
// inline with pairing — applied to the new device at redeem, the same write
// `omnesis devices set-self` / PATCH /admin/devices/:id use. Raw strings here;
// the route validates + normalizes them (normalizeEmail / normalizePhone) at
// the boundary and rejects an unparseable phone before the code is minted.
export const createPairingBody = z.object({
  name: z.string().optional(),
  repairDeviceId: z.string().uuid().optional(),
  kind: deviceKindSchema,
  scopes: scopeArraySchema.optional(),
  ttlMs: z.number().positive().optional(),
  selfEmails: z.array(z.string()).optional(),
  selfPhones: z.array(z.string()).optional(),
  /** Access level an integration paired with this code is put on (portal sessions only). */
  accessLevelId: z.string().uuid().optional(),
});
export type CreatePairingBody = z.infer<typeof createPairingBody>;

// DELETE /admin/devices/pair — keep the short-lived credential in the body so
// request-path and slow-request logs cannot retain it.
export const revokePairingBody = z.object({
  pairingCode: z.string().regex(/^[A-F0-9]{10}$/u),
});
export type RevokePairingBody = z.infer<typeof revokePairingBody>;

// POST /admin/devices/pair-qr — encode a versioned pairing payload
// server-side. Omitted trustMode retains the V2/V3 compatibility path;
// auto selects system trust only for an HTTPS origin configured on the
// gateway's exact allowlist, and otherwise retains the compatibility fallback.
export const pairQrBody = z.object({
  pairingCode: nonEmptyString,
  gatewayUrl: nonEmptyString,
  trustMode: z.enum(["auto", "system", "pinned-leaf"]).optional(),
});
export type PairQrBody = z.infer<typeof pairQrBody>;

// POST /admin/devices/pair-addresses — the addresses the phone behind a pending
// pairing code can be given, judged for that phone. The code travels in the
// body so request-path logs cannot retain it.
export const pairAddressesBody = z.object({
  pairingCode: nonEmptyString,
});
export type PairAddressesBody = z.infer<typeof pairAddressesBody>;

// POST /admin/tokens
export const createTokenBody = z.object({
  deviceId: nonEmptyString,
  scopes: scopeArraySchema,
  name: z.string().nullable().optional(),
  // Optional time-to-live in milliseconds. Omit for a never-expiring token
  // (the default — existing and unscoped tokens never expire). When set, the
  // token's `expires_at` is stamped `ttlMs` into the future and `lookupToken`
  // rejects it past that point.
  ttlMs: z.number().int().positive().optional(),
});
export type CreateTokenBody = z.infer<typeof createTokenBody>;

// POST /admin/credentials/:fileKey
export const setCredentialsBody = z.object({
  deviceId: z.string().optional(),
  fields: z.record(z.string(), z.string()),
});
export type SetCredentialsBody = z.infer<typeof setCredentialsBody>;

// POST /admin/sources/discover
export const sourceDiscoverBody = z.object({
  deviceId: z.string().optional(),
  descriptorId: nonEmptyString,
});
export type SourceDiscoverBody = z.infer<typeof sourceDiscoverBody>;

// POST /admin/sources/resolve-account
export const sourceResolveAccountBody = z.object({
  deviceId: z.string().optional(),
  descriptorId: nonEmptyString,
  params: stringParamsSchema,
});
export type SourceResolveAccountBody = z.infer<typeof sourceResolveAccountBody>;

// POST /admin/sources/validate-param
export const sourceValidateParamBody = z.object({
  deviceId: z.string().optional(),
  descriptorId: nonEmptyString,
  paramName: nonEmptyString,
  value: z.string().optional(),
});
export type SourceValidateParamBody = z.infer<typeof sourceValidateParamBody>;

// POST /admin/sources/add
export const sourceAddBody = z.object({
  deviceId: z.string().optional(),
  descriptorId: nonEmptyString,
  accountIds: z.array(z.string()).min(1),
  params: stringParamsSchema.optional(),
});
export type SourceAddBody = z.infer<typeof sourceAddBody>;

// POST /admin/sources/reauth-finalize
export const sourceReauthFinalizeBody = z.object({
  deviceId: z.string().optional(),
  providerType: nonEmptyString,
  accountId: nonEmptyString,
  /** Optional for compatibility with older CLI clients. */
  sourceType: nonEmptyString.optional(),
});
export type SourceReauthFinalizeBody = z.infer<typeof sourceReauthFinalizeBody>;

// POST /admin/sources
export const createSourceBody = z.object({
  type: nonEmptyString,
  accountId: nonEmptyString,
  deviceId: nonEmptyString,
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export type CreateSourceBody = z.infer<typeof createSourceBody>;

// POST /devices/sources/bulk-upsert
/**
 * What a source declares about one of its accounts.
 *
 * Validated at the boundary like everything else, and deliberately closed: a
 * field this build does not know is dropped rather than stored, so a value
 * nothing can read never becomes a value something has to interpret.
 */

const bulkUpsertSourceShape = {
  id: z.string().optional(),
  type: nonEmptyString,
  accountId: nonEmptyString,
  // What the source declares about this account. Optional, and optional for
  // good: most sources have nothing to say beyond the id, and a collector one
  // version behind sends nothing at all. Both cases leave every consumer where
  // it already is, reading the id.
  account: accountDescriptorSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
};
export const bulkUpsertLegacySourceItem = z
  .object(bulkUpsertSourceShape)
  .passthrough()
  .superRefine((value, ctx) => {
    if (Object.hasOwn(value, "memberConfig")) {
      ctx.addIssue({
        code: "custom",
        path: ["memberConfig"],
        message: "memberConfig requires the member-config bulk endpoint",
      });
    }
  })
  .transform(({ id, type, accountId, account, config, enabled }) => ({
    id,
    type,
    accountId,
    account,
    config,
    enabled,
  }));
export const bulkUpsertLegacySourcesBody = z.object({
  sources: z.array(bulkUpsertLegacySourceItem),
});

export const bulkUpsertSourceItem = z.object({
  ...bulkUpsertSourceShape,
  memberConfig: z.record(z.string(), z.unknown()).optional(),
});
export const bulkUpsertSourcesBody = z.object({
  sources: z.array(bulkUpsertSourceItem),
});
export type BulkUpsertSourcesBody = z.infer<typeof bulkUpsertSourcesBody>;

// POST /admin/sources/:id/members
export const sourceMemberBody = z.object({
  deviceId: nonEmptyString,
  memberConfig: z.record(z.string(), z.unknown()).optional(),
});
export type SourceMemberBody = z.infer<typeof sourceMemberBody>;

// PATCH /admin/sources/:id/members/:deviceId
export const sourceMemberConfigBody = z.object({
  configOverride: z.record(z.string(), z.unknown()),
});
export type SourceMemberConfigBody = z.infer<typeof sourceMemberConfigBody>;

// POST /admin/sources/:id/resync — no device: the whole source starts over;
// a device: that member alone does.
export const sourceResyncBody = z.object({
  deviceId: z.string().optional(),
});
export type SourceResyncBody = z.infer<typeof sourceResyncBody>;

// PATCH /admin/sources/:id
export const patchSourceBody = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  deviceId: z.string().optional(),
  multiDeviceMode: z.enum(["exclusive", "handoff", "replicated", "partitioned"]).optional(),
});
export type PatchSourceBody = z.infer<typeof patchSourceBody>;

// POST /admin/auth-flows
export const authStartBody = z.object({
  sourceType: nonEmptyString,
  deviceId: z.string().optional(),
  accountId: z.string().optional(),
  params: stringParamsSchema.optional(),
  // Fields the user pasted for a `perAccount` credentials spec, carried to the
  // provider's authFlow instead of being written to a shared file first. Bounded
  // deliberately: this ends up serialised onto a single stdin line to the auth
  // subprocess, which — unlike an argv payload — has no kernel-side size limit.
  credentials: z
    .record(z.string().max(64), z.string().max(8192))
    .refine((r) => Object.keys(r).length <= 32, "too many credential fields")
    .optional(),
  // Which challenge kinds this client can draw. A client that omits it is read
  // as the default set, so an older one keeps working; a client that names a
  // narrower set lets a provider refuse at once rather than emitting a
  // challenge nothing renders and waiting out its timeout.
  renders: z.array(z.string().min(1).max(32)).max(16).optional(),
});
export type AuthStartBody = z.infer<typeof authStartBody>;

// POST /admin/auth-flows/:id/code
export const authCodeBody = z.object({
  code: nonEmptyString,
});
export type AuthCodeBody = z.infer<typeof authCodeBody>;

// POST /admin/auth-flows/:id/widget-result — hosted-widget (`link-widget`)
// result delivery. The client posts the opaque widget result token (e.g. a
// Plaid `public_token`) plus optional metadata. Unlike a code, a session may
// deliver several (one per institution), so this endpoint is not a single-use
// latch.
export const authWidgetResultBody = z.object({
  token: nonEmptyString,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// POST /admin/auth-flows/:id/answer — one answer to one typed challenge from
// a flow that declares `authenticate`. The challenge id is required rather
// than implied: a flow may put several questions to the operator, and an
// answer sent after they went back and changed an earlier one must not
// resolve the wait it does not belong to.
// One answered field. The same ceiling the pasted credential fields use, for
// the same reason: this is a channel a client fills, and an answer nobody can
// deliver is a flow that waits until it expires. A nested object is admitted
// only for a widget's metadata, which is the one shape that is not a scalar.
const answerValue = z.union([
  z.string().max(8192),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string().max(64), z.unknown()),
]);

export const authAnswerBody = z.object({
  challengeId: nonEmptyString,
  answer: z
    .record(z.string().min(1).max(64), answerValue)
    .refine((a) => Object.keys(a).length <= 32, {
      message: "an answer may carry at most 32 fields",
    }),
});

// POST /devices/pair (consume pairing code)
export const consumePairingBody = z.object({
  pairingCode: nonEmptyString,
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43,128}$/u)
    .optional(),
  capabilities: deviceCapabilitySchema.optional(),
  agentIntegration: z
    .object({
      harness: z.enum(["openclaw", "hermes"]),
    })
    .strict()
    .optional(),
});
export type ConsumePairingBody = z.infer<typeof consumePairingBody>;

// POST /admin/url-canonicalizers — collector pushes the full list of
// per-source URL canonicalizers at startup. The gateway holds them in
// memory and applies them whenever it normalizes a URL (ingest +
// lookup). Re-posting fully replaces the previous list.
//
// Each spec declares which hostnames it claims plus ordered regex rules
// that rewrite matching URLs onto a canonical form. Kept as data
// (regex strings, not JS functions) so per-source URL knowledge lives
// in each source package while being applied by the gateway.
export const urlCanonicalizersBody = z.object({
  canonicalizers: z
    .array(
      z.object({
        hosts: z.array(z.string().trim().min(1).max(253)).nonempty().max(16),
        rules: z
          .array(
            z.object({
              match: z.string().min(1).max(1_000).refine(isSafeUrlCanonicalizerPattern, {
                message: "must be a supported safe regular expression",
              }),
              replacement: z.string().max(1_000),
            }),
          )
          .nonempty()
          .max(32),
      }),
    )
    .max(64),
});
export type UrlCanonicalizersBody = z.infer<typeof urlCanonicalizersBody>;

// POST /admin/source-prior-defaults — collector pushes the full list of
// per-source-type score priors declared on `defineSource` calls. The
// gateway holds them in memory and merges with the user's
// `search.sourcePriors.weights` from `omnesis.json` (user keys win).
// Re-posting fully replaces the collector-declared layer; gateway
// built-in priors are preserved.
//
// Each entry maps a source-type prefix to an additive search-score
// adjustment — negative downweights, positive upweights, cosine
// differences are often <0.1 so even -0.04 is meaningful.
export const sourcePriorDefaultsBody = z.object({
  entries: z.array(
    z.object({
      sourceIdPrefix: nonEmptyString,
      weight: z.number().finite(),
    }),
  ),
});
export type SourcePriorDefaultsBody = z.infer<typeof sourcePriorDefaultsBody>;

// POST /admin/url-graph-roles — collector atomically pushes the complete
// descriptor-derived URL role sets. All arrays are required so an older or
// partial payload cannot mark target-role metadata ready and accidentally let
// a reference-only document claim an inbound URL.
//
// The graph subgraph walker (`DocumentGraphService`) reads this set to
// drop `url`-typed edges through hub-source documents during BFS —
// keeping per-source hub knowledge inside each source package.
const sourceTypePrefix = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a valid source-type prefix");

const sourceTypePrefixList = z
  .array(sourceTypePrefix)
  .max(256)
  .superRefine((prefixes, ctx) => {
    const seen = new Set<string>();
    prefixes.forEach((prefix, index) => {
      if (!seen.has(prefix)) seen.add(prefix);
      else ctx.addIssue({ code: "custom", path: [index], message: "duplicate source prefix" });
    });
  });

export const urlGraphRolesBody = z
  .object({
    traversalHubPrefixes: sourceTypePrefixList,
    fallbackRepresentationPrefixes: sourceTypePrefixList,
    referenceOnlyPrefixes: sourceTypePrefixList,
  })
  .superRefine((value, ctx) => {
    const fallback = new Set(value.fallbackRepresentationPrefixes);
    for (const prefix of value.referenceOnlyPrefixes) {
      if (!fallback.has(prefix)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["referenceOnlyPrefixes"],
        message: `source prefix ${prefix} cannot be both fallback and reference-only`,
      });
    }
  });
export type UrlGraphRolesBody = z.infer<typeof urlGraphRolesBody>;

/** Compatibility shape for collectors predating independent URL target roles. */
export const urlHubSourcesBody = z.object({ prefixes: sourceTypePrefixList });

// POST /admin/self-identity-sources — collector pushes the per-source
// self-identity hooks declared by every loaded source's
// `defineSource.selfIdentity`. The gateway holds the set in memory; the
// self-detection pass (`detectSelfFromSourceIds`) reads it to pair a synced
// source account to the self LID alias the source's normalizer emits, without
// branching on a source name. Each push is merged by source type, so a
// collector never clears what a sibling declared.
export const selfIdentitySourcesBody = z.object({
  entries: z.array(
    z.object({
      sourceType: nonEmptyString,
      aliasPrefix: nonEmptyString,
      accountPattern: z.string().optional(),
    }),
  ),
});
export type SelfIdentitySourcesBody = z.infer<typeof selfIdentitySourcesBody>;

// POST /admin/known-url-patterns — collector pushes the url-id patterns
// declared by every KNOWN source type (every loaded source definition's
// `urlPatterns`), not just the ones the user has added. The gateway holds
// the set in memory. Re-posting fully replaces the previous list.
//
// Link extraction (`urlTargetCouldResolve`) reads this superset to keep an
// unresolved `url` link whose target matches a known source type — so a link
// to a not-yet-added source resolves once that source is ingested,
// while truly-external targets are still dropped. Each pattern is an opaque
// regex string; per-source URL knowledge lives in each source package.
export const knownUrlPatternsBody = z.object({
  patterns: z.array(z.object({ regex: urlPatternRegexSchema })).max(50),
});
export type KnownUrlPatternsBody = z.infer<typeof knownUrlPatternsBody>;

/** One collector generation of every declaration that affects URL linking. */
export const linkDeclarationsBody = urlCanonicalizersBody
  .and(urlGraphRolesBody)
  .and(knownUrlPatternsBody);
export type LinkDeclarationsBody = z.infer<typeof linkDeclarationsBody>;

// POST /admin/owned-web-domains — collector pushes the web hosts owned by
// every KNOWN source type (the union of every loaded source definition's
// `ownedWebDomains`), not just the ones the user has added. The gateway holds
// the set in memory and serves it on the public GET /owned-web-domains route.
// The browser-capture source fetches the union and skips any visited
// host already owned by another source. Each entry is an opaque lowercase
// hostname; per-source ownership lives in each source package.
export const ownedWebDomainsBody = z.object({
  domains: z.array(nonEmptyString),
});
export type OwnedWebDomainsBody = z.infer<typeof ownedWebDomainsBody>;

// POST /admin/source-document-profiles — collector pushes the
// `documentEventProfile` declared by every KNOWN source type (every loaded
// source definition), not just the ones the user has added. The gateway
// PERSISTS the set; subscription compilation reads it to learn what each
// source's documents can be asked about. Re-posting fully replaces the
// previous set.
//
// This schema is a shape gate only. The cross-field invariants (an alias
// pointing at an undeclared value, allowedValues beside canonicalValues, a
// duplicated path) are the source contract, checked by the source-sdk's
// `validateDocumentEventProfile` at the route so both the collector and the
// gateway enforce one definition. Each profile is opaque source-declared
// data — no source name is interpreted here.
const documentMetadataFieldSpecSchema = z.object({
  path: nonEmptyString,
  type: z.enum(["string", "number", "boolean", "string-array"]),
  description: nonEmptyString,
  allowedValues: z.array(nonEmptyString).optional(),
  canonicalValues: z.array(nonEmptyString).optional(),
  valueAliases: z.record(z.string(), z.array(nonEmptyString)).optional(),
  // Only the source knows which of its fields carry identity, and this schema
  // is the only path that knowledge takes to reach the gateway. Omitting the
  // key drops it silently — zod strips what it does not declare — leaving a
  // filter that singles out a person disclosed to the operator as if it named
  // nobody.
  identifiesPeople: z.boolean().optional(),
});
export const sourceDocumentProfilesBody = z.object({
  entries: z.array(
    z.object({
      sourceType: nonEmptyString,
      profile: z.object({
        documentTypes: z.array(nonEmptyString).optional(),
        personRoles: z.array(z.enum(PERSON_ROLES)).optional(),
        metadataFields: z.array(documentMetadataFieldSpecSchema).optional(),
      }),
    }),
  ),
});
export type SourceDocumentProfilesBody = z.infer<typeof sourceDocumentProfilesBody>;

// POST /admin/widget-origins — collector pushes the union of external
// widget-vendor origins declared by every KNOWN source's `widgetOrigins`
// (every loaded `link-widget` source descriptor), not just the added ones.
// The gateway holds the aggregate in memory and folds it into the portal's
// Content-Security-Policy so a source's hosted widget (Plaid Link, …) can load
// its vendor SDK and iframe in the browser. Re-posting fully replaces the
// previous set.
//
// Each entry is a CSP source expression: an `https`/`http` scheme, an optional
// leading `*.` wildcard label, and a host (no path, query, or trailing slash).
// Validated at the boundary so a malformed origin can't widen the policy into
// something the browser silently rejects (or that opens it too far). No source
// name is hardcoded — per-source origin knowledge lives in each source package.
const cspOriginSource = z
  .string()
  .trim()
  .regex(
    /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i,
    "must be an https/http origin (scheme + host, optional leading *. wildcard, no path)",
  );
export const widgetOriginsBody = z.object({
  script: z.array(cspOriginSource).default([]),
  frame: z.array(cspOriginSource).default([]),
  connect: z.array(cspOriginSource).default([]),
});
export type WidgetOriginsBody = z.infer<typeof widgetOriginsBody>;

const widgetKind = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i, "must be an opaque widget kind");

export const widgetRenderersBody = z.object({
  renderers: z
    .array(
      z.object({
        kind: widgetKind,
        modulePath: z
          .string()
          .trim()
          .min(1)
          .refine((p) => p.startsWith("/"), {
            message: "must be an absolute filesystem path",
          })
          .refine((p) => p.endsWith(".js"), {
            message: "must point to a JavaScript module",
          }),
      }),
    )
    .default([]),
});
export type WidgetRenderersBody = z.infer<typeof widgetRenderersBody>;

// POST /admin/sources/:id/import-history — the user-supplied values for a
// source's declared `historyImport.fields`. Generic flat string map; the
// source validates the individual fields. `default({})` lets an empty body
// through; malformed JSON still yields the canonical 400.
export const importHistoryBody = z.object({
  values: z.record(z.string(), z.string()).default({}),
});
export type ImportHistoryBody = z.infer<typeof importHistoryBody>;
