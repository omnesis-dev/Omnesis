// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const oauthRegisterBody = z
  .object({
    client_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), {
        message: "Client name contains unsafe control characters.",
      }),
    redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(12),
    grant_types: z.array(z.string()).max(8).optional(),
    response_types: z.array(z.string()).max(8).optional(),
    token_endpoint_auth_method: z.string().optional(),
    client_uri: z.string().max(2_048).optional(),
  })
  .passthrough();

export const oauthAuthorizationQuery = z
  .object({
    response_type: z.literal("code"),
    client_id: z.string().min(1).max(2_048),
    redirect_uri: z.string().min(1).max(2_048),
    state: z.string().min(1).max(4_096).optional(),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    code_challenge_method: z.literal("S256"),
    resource: z.string().min(1).max(2_048).optional(),
    scope: z.string().min(1).max(256).optional(),
    omnesis_execution_binding: z.string().min(1).max(4_096).optional(),
  })
  .passthrough();

export const oauthAuthorizationHandleQuery = z
  .object({ request: z.string().min(1).max(256) })
  .passthrough();

export const oauthApprovalId = z.string().uuid();

/** RFC 7521 §4.2 client authentication by assertion, accepted at the token and revocation endpoints. */
const clientAssertionFields = {
  client_assertion_type: z.string().min(1).max(256).optional(),
  client_assertion: z.string().min(1).max(8_192).optional(),
};

export const oauthTokenForm = z
  .object({
    grant_type: z.string().min(1).max(128),
    client_id: z.string().min(1).max(2_048).optional(),
    code: z.string().min(1).max(4_096).optional(),
    redirect_uri: z.string().min(1).max(2_048).optional(),
    code_verifier: z.string().min(43).max(128).optional(),
    refresh_token: z.string().min(1).max(4_096).optional(),
    resource: z.string().min(1).max(2_048).optional(),
    ...clientAssertionFields,
  })
  .passthrough();

export const oauthRevokeForm = z
  .object({
    token: z.string().min(1).max(4_096),
    client_id: z.string().min(1).max(2_048).optional(),
    ...clientAssertionFields,
    // RFC 7009 defines this as a hint. Unknown values must not prevent the
    // server from locating and revoking an otherwise valid token.
    token_type_hint: z.string().min(1).max(256).optional(),
  })
  .passthrough();

export const accessLookupBody = z.object({ code: z.string().min(1).max(20) }).strict();

const accessSources = z
  .object({
    mode: z.enum(["all", "allowlist", "denylist"]),
    sourceIds: z.array(z.string().min(1).max(512)).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "allowlist" && value.sourceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["sourceIds"],
        message: "Select at least one source when using selected-sources-only access.",
      });
    }
  });
const accessRules = z
  .array(
    z.discriminatedUnion("capability", [
      z.object({ capability: z.literal("direct"), sources: accessSources }).strict(),
      z
        .object({
          capability: z.literal("notes"),
          sources: z
            .object({ mode: z.literal("all"), sourceIds: z.array(z.string()).length(0) })
            .strict(),
        })
        .strict(),
      z
        .object({
          capability: z.literal("answer"),
          sources: accessSources,
          release: z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("reviewed"), policyFamilyId: z.string().uuid() }).strict(),
            z.object({ mode: z.literal("unreviewed") }).strict(),
          ]),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(3)
  .refine((rules) => new Set(rules.map((rule) => rule.capability)).size === rules.length);

const accessName = z.string().trim().min(1).max(120);

export const accessSelection = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new-principal"),
      principalName: z.string().trim().min(1).max(120),
      grantName: z.string().trim().min(1).max(120),
      rules: accessRules,
      credentialLabel: z.string().trim().min(1).max(160),
      expiresAt: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("new-grant"),
      principalId: z.string().uuid(),
      grantName: z.string().trim().min(1).max(120),
      rules: accessRules,
      credentialLabel: z.string().trim().min(1).max(160),
      expiresAt: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing-grant"),
      grantId: z.string().uuid(),
      credentialLabel: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connect"),
      rules: accessRules,
      credentialLabel: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("new-connection"),
      name: accessName,
      level: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("new"), name: accessName, rules: accessRules }).strict(),
        z
          .object({
            kind: z.literal("existing"),
            levelId: z.string().uuid(),
            expectedLevelRevision: z.number().int().positive(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-connection"),
      connectionId: z.string().uuid(),
      expectedGrantRevision: z.number().int().positive(),
    })
    .strict(),
]);

export const accessDecisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("deny") }).strict(),
  z.object({ decision: z.literal("approve"), selection: accessSelection }).strict(),
]);

export const accessRevokeBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("credential"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("connection"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("profile"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("grant"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("principal"), id: z.string().uuid() }).strict(),
]);

export const accessGrantUpdateBody = z
  .object({ expectedRevision: z.number().int().positive(), rules: accessRules })
  .strict();

export const accessLevelCreateBody = z.object({ name: accessName, rules: accessRules }).strict();

export const accessLevelUpdateBody = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: accessName.optional(),
    rules: accessRules.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.rules !== undefined, {
    message: "Provide a new name, new rules, or both.",
  });

/** Move a connection onto an existing level, or onto a new level copying its current rules. */
export const accessConnectionLevelBody = z.union([
  z
    .object({
      levelId: z.string().uuid(),
      expectedGrantRevision: z.number().int().positive(),
      expectedLevelRevision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      newLevel: z.object({ name: accessName }).strict(),
      expectedGrantRevision: z.number().int().positive(),
    })
    .strict(),
]);

/** Put a device on an access level, or with `levelId: null` on none. */
export const accessDeviceLevelBody = z
  .object({
    levelId: z.string().uuid().nullable(),
    expectedLevelRevision: z.number().int().positive().optional(),
  })
  .strict();

export const accessPrincipalUpdateBody = z.object({ name: accessName }).strict();

export const accessExecutionBindingBody = z
  .object({ clientId: z.string().min(1).max(256), harness: z.enum(["openclaw", "hermes"]) })
  .strict();

/**
 * A device asking to re-key the OAuth credential it already holds. It names
 * only its own OAuth client: audience and scope are copied from the approved
 * authorization request, never taken from the request body.
 */
export const accessExecutionReissueBody = z
  .object({ clientId: z.string().min(1).max(256) })
  .strict();
