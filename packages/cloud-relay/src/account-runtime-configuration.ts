// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname, join } from "node:path";
import { z } from "zod";
import { loadAccountEnrollmentAuthority } from "./account-authority-key.js";
import { AppAssociations } from "./app-associations.js";
import { readPrivateJson } from "./google-credentials.js";
import { bindingOrigin } from "./gateway-binding.js";
import { signupPolicySchema } from "./gateway-signup.js";
import { configuredConnectShortUrl } from "./connect-short-url.js";
import { InviteVerifier } from "./invites.js";
import type { AccountSignInConfiguration } from "./account-services.js";
import type { IdentityProvider } from "./identity.js";

/** Settings an older relay read, which now must not quietly stop applying. */
const RETIRED_SIGNUP_SETTINGS = [
  "OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE",
  "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP",
  "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE",
  "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL",
] as const;

/** Account coordination keeps its signing key independent from the routing session root. */
export async function accountRuntimeConfiguration(options: {
  env: NodeJS.ProcessEnv;
  origin?: string;
  database: string;
  nativeGoogleIdentity?: IdentityProvider;
}): Promise<AccountSignInConfiguration | undefined> {
  for (const name of RETIRED_SIGNUP_SETTINGS)
    if (options.env[name] !== undefined)
      throw new Error(
        `${name} is no longer supported: new accounts need an invite. Remove it and set OMNESIS_CLOUD_RELAY_INVITE_KEYS`,
      );
  // A routing-only relay does not need an account authority or a browser origin.
  if (options.origin === undefined) {
    if (
      options.env.OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_SIGNUP_POLICY !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_INVITE_KEYS !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL !== undefined
    )
      throw new Error("Account sign-in requires the relay's public HTTPS origin");
    return undefined;
  }
  const origin = bindingOrigin(options.origin).origin;
  const paths = z
    .object({
      OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: z.string().trim().min(1).optional(),
      OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE: z.string().trim().min(1).optional(),
      OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: signupPolicySchema.optional(),
      OMNESIS_CLOUD_RELAY_INVITE_KEYS: z.string().trim().min(1).optional(),
    })
    .parse(options.env);
  const inviteKeys = paths.OMNESIS_CLOUD_RELAY_INVITE_KEYS?.split(",").map((key) => key.trim());
  // Invite keys alone make the relay invite-only; without them nobody new may sign up.
  const policy = paths.OMNESIS_CLOUD_RELAY_SIGNUP_POLICY ?? (inviteKeys ? "invite" : "closed");
  if (policy === "invite" && !inviteKeys)
    throw new Error("The invite signup policy requires OMNESIS_CLOUD_RELAY_INVITE_KEYS");
  if (policy !== "invite" && inviteKeys)
    throw new Error("OMNESIS_CLOUD_RELAY_INVITE_KEYS requires the invite signup policy");
  let invites: InviteVerifier | undefined;
  if (inviteKeys)
    try {
      invites = new InviteVerifier(origin, inviteKeys);
    } catch {
      throw new Error(
        "OMNESIS_CLOUD_RELAY_INVITE_KEYS must list one to eight base64url Ed25519 public keys, separated by commas",
      );
    }
  const connectShortUrl = configuredConnectShortUrl(
    options.env.OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL,
  );
  const associations = paths.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE
    ? new AppAssociations(await readPrivateJson(paths.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE))
    : undefined;
  const enrollmentAuthority = await loadAccountEnrollmentAuthority(
    origin,
    paths.OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE ??
      join(dirname(options.database), "account-authority.pem"),
  );
  return {
    associations,
    enrollmentAuthority,
    nativeGoogleIdentity: options.nativeGoogleIdentity,
    ...(connectShortUrl ? { connectShortUrl } : {}),
    signup: { policy, ...(invites ? { invites } : {}) },
  };
}
